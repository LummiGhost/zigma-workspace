import * as crypto from "node:crypto";
import type Database from "better-sqlite3";
import type {
  IntegrateWorkspaceInput,
  IntegrateWorkspaceResult,
  IntegrateConflictResult,
  AbortIntegrationInput,
  AbortIntegrationResult,
  OperationJournalRow,
} from "../types/index.js";
import { ZigmaError } from "../types/index.js";
import { getWorkspaceById, updateWorkspaceStatus } from "../db/queries.js";
import {
  getIdempotencyRecord,
  insertIdempotencyRecord,
  insertOperationJournal,
  updateOperationJournalStatus,
  updateWorkspaceHead,
} from "../db/queries.js";
import { emitWorkspaceEvent } from "./events.js";
import { transition } from "./state-machine.js";
import {
  getHeadCommit,
  fetchMirror,
  isAncestor,
  mergeOrConflict,
  resetHard,
  getChangedFiles,
} from "../git/index.js";
import { getRepositoryCacheByUrl } from "../db/queries.js";
import {
  acquireIntegrationLock,
  releaseIntegrationLock,
} from "./integration-lock.js";
import { assertChangedPathsAllowed, assertWorkspaceBoundary, assertWritable, configForWorkspaceDatabase } from "./isolation-policy.js";

function now(): string {
  return new Date().toISOString();
}

function hashInput(input: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(input), "utf-8").digest("hex");
}

/**
 * Integrate a source Job workspace commit into a target Run workspace.
 *
 * - Acquires integration lock on target before merging.
 * - Uses target expectedHead to prevent uncontrolled concurrent writes.
 * - On success: returns source commit, previous target HEAD, resulting commit.
 * - On conflict: aborts merge, restores target to pre-integration state,
 *   returns structured conflict files, preserves source workspace and commit.
 * - Duplicate calls (same operationId) do not produce duplicate merge commits.
 */
export function integrateWorkspace(
  db: Database.Database,
  input: IntegrateWorkspaceInput,
): IntegrateWorkspaceResult | IntegrateConflictResult {
  const {
    operationId,
    sourceWorkspaceId,
    targetWorkspaceId,
    expectedHead,
    lockOwner,
    lockExpiresAt,
  } = input;

  // Check idempotency
  const inputHash = hashInput(input);
  const idempotent = getIdempotencyRecord(db, operationId);
  if (idempotent) {
    if (idempotent.input_hash !== inputHash) {
      throw new ZigmaError(
        "OPERATION_ID_CONFLICT",
        `Operation ${operationId} already executed with different input`,
        { operationId, command: idempotent.command },
      );
    }
    const cached = JSON.parse(idempotent.result_json);
    return cached as IntegrateWorkspaceResult | IntegrateConflictResult;
  }

  const sourceRow = getWorkspaceById(db, sourceWorkspaceId);
  if (!sourceRow) {
    throw new ZigmaError("WORKSPACE_NOT_FOUND", `Source workspace ${sourceWorkspaceId} not found`, { workspaceId: sourceWorkspaceId });
  }

  const targetRow = getWorkspaceById(db, targetWorkspaceId);
  if (!targetRow) {
    throw new ZigmaError("WORKSPACE_NOT_FOUND", `Target workspace ${targetWorkspaceId} not found`, { workspaceId: targetWorkspaceId });
  }
  const sourceManifest = assertWorkspaceBoundary(configForWorkspaceDatabase(db, sourceRow.path), sourceRow);
  const targetManifest = assertWorkspaceBoundary(configForWorkspaceDatabase(db, targetRow.path), targetRow);
  assertWritable(targetRow);
  const sourceChangedFiles = getChangedFiles(sourceRow.path, sourceRow.base_commit);
  assertChangedPathsAllowed(sourceRow, sourceManifest, sourceChangedFiles);
  assertChangedPathsAllowed(targetRow, targetManifest, sourceChangedFiles);

  const sourceCommit = getHeadCommit(sourceRow.path);
  if (!sourceCommit) {
    throw new ZigmaError(
      "WORKSPACE_OPERATION_INCOMPLETE",
      `Source workspace ${sourceWorkspaceId} has no HEAD commit`,
      { workspaceId: sourceWorkspaceId },
    );
  }

  const previousTargetHead = getHeadCommit(targetRow.path);
  if (!previousTargetHead) {
    throw new ZigmaError(
      "WORKSPACE_OPERATION_INCOMPLETE",
      `Target workspace ${targetWorkspaceId} has no HEAD commit`,
      { workspaceId: targetWorkspaceId },
    );
  }

  // Validate expected head
  if (expectedHead && previousTargetHead !== expectedHead) {
    throw new ZigmaError(
      "WORKSPACE_HEAD_CONFLICT",
      `Expected target HEAD ${expectedHead}, got ${previousTargetHead}`,
      { workspaceId: targetWorkspaceId, expected: expectedHead, actual: previousTargetHead },
    );
  }

  // Check if source commit is already an ancestor (already merged)
  if (isAncestor(targetRow.path, sourceCommit, previousTargetHead)) {
    const result: IntegrateWorkspaceResult = {
      operationId,
      sourceWorkspaceId,
      targetWorkspaceId,
      sourceCommit,
      previousTargetHead,
      resultingCommit: previousTargetHead,
      merged: false,
    };

    const resultJson = JSON.stringify(result);
    insertIdempotencyRecord(db, {
      operation_id: operationId,
      command: "integrate",
      input_hash: inputHash,
      result_json: resultJson,
      created_at: now(),
    });

    return result;
  }

  // Ensure mirror is up-to-date
  const cacheRow = getRepositoryCacheByUrl(db, targetRow.repository_url);
  if (cacheRow) {
    fetchMirror(cacheRow.mirror_path);
  }

  const ts = now();

  // Record operation started
  const journalRow: OperationJournalRow = {
    operation_id: operationId,
    workspace_id: targetWorkspaceId,
    command: "integrate",
    status: "started",
    input_hash: inputHash,
    result_json: null,
    created_at: ts,
    updated_at: ts,
  };
  insertOperationJournal(db, journalRow);

  // Acquire integration lock
  acquireIntegrationLock(db, targetWorkspaceId, lockOwner, lockExpiresAt);

  try {
    // Transition target to MERGING
    updateWorkspaceStatus(db, targetWorkspaceId, transition(targetRow.status as never, "MERGING"), now());

    const mergeResult = mergeOrConflict(
      targetRow.path,
      sourceCommit,
      `zigma-integrate: merge ${sourceWorkspaceId} commit ${sourceCommit.slice(0, 8)}`,
    );

    if (mergeResult.success) {
      const resultingCommit = mergeResult.commit;

      // Update target's base_commit
      updateWorkspaceHead(db, targetWorkspaceId, resultingCommit, now());

      // Transition to MERGED
      updateWorkspaceStatus(db, targetWorkspaceId, transition("MERGING", "MERGED"), now());

      const result: IntegrateWorkspaceResult = {
        operationId,
        sourceWorkspaceId,
        targetWorkspaceId,
        sourceCommit,
        previousTargetHead,
        resultingCommit,
        merged: true,
      };

      const resultJson = JSON.stringify(result);
      updateOperationJournalStatus(db, operationId, targetWorkspaceId, "completed", resultJson, now());
      insertIdempotencyRecord(db, {
        operation_id: operationId,
        command: "integrate",
        input_hash: inputHash,
        result_json: resultJson,
        created_at: ts,
      });

      emitWorkspaceEvent(db, targetWorkspaceId, "workspace.bound", {
        task_id: null,
        flow_run_id: null,
      });

      return result;
    }

    // Unreachable — mergeOrConflict throws on failure
    throw new ZigmaError("INTERNAL_ERROR", "Unexpected merge result", { operationId });
  } catch (err) {
    // On conflict, target is already restored (mergeOrConflict aborts merge)
    const isGitError =
      err instanceof Error && err.message.includes("Merge conflict");

    if (isGitError) {
      // Transition to CONFLICT
      updateWorkspaceStatus(db, targetWorkspaceId, transition("MERGING", "CONFLICT"), now());

      const conflictResult: IntegrateConflictResult = {
        operationId,
        sourceWorkspaceId,
        targetWorkspaceId,
        sourceCommit,
        conflictFiles: [],
        message: err instanceof Error ? err.message : String(err),
      };

      const resultJson = JSON.stringify(conflictResult);
      updateOperationJournalStatus(db, operationId, targetWorkspaceId, "failed", resultJson, now());
      insertIdempotencyRecord(db, {
        operation_id: operationId,
        command: "integrate",
        input_hash: inputHash,
        result_json: resultJson,
        created_at: ts,
      });

      releaseIntegrationLock(db, targetWorkspaceId, lockOwner);
      return conflictResult;
    }

    // Other errors: record failure and rethrow
    const errorJson = JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
      code: err instanceof ZigmaError ? err.code : "INTERNAL_ERROR",
    });
    updateOperationJournalStatus(db, operationId, targetWorkspaceId, "failed", errorJson, now());

    // Try to restore target state
    try {
      resetHard(targetRow.path, previousTargetHead);
    } catch {
      // Best effort
    }

    releaseIntegrationLock(db, targetWorkspaceId, lockOwner);
    throw err;
  }
}

/**
 * Abort an integration operation, releasing locks and cleaning up state.
 * This is a best-effort operation that resets the workspace state.
 */
export function abortIntegration(
  db: Database.Database,
  input: AbortIntegrationInput,
): AbortIntegrationResult {
  const { operationId, workspaceId, reason } = input;

  const row = getWorkspaceById(db, workspaceId);
  if (!row) {
    throw new ZigmaError("WORKSPACE_NOT_FOUND", `Workspace ${workspaceId} not found`, { workspaceId });
  }

  const ts = now();

  // Record operation
  const inputHash = hashInput(input);
  const journalRow: OperationJournalRow = {
    operation_id: operationId,
    workspace_id: workspaceId,
    command: "abort_integration",
    status: "started",
    input_hash: inputHash,
    result_json: null,
    created_at: ts,
    updated_at: ts,
  };
  insertOperationJournal(db, journalRow);

  const message = reason ?? "Integration aborted";

  // If in MERGING or CONFLICT state, reset to RUNNING
  if (row.status === "MERGING" || row.status === "CONFLICT") {
    try {
      updateWorkspaceStatus(
        db,
        workspaceId,
        transition(row.status as never, "RUNNING"),
        now(),
      );
    } catch {
      // If transition fails, just record it
    }
  }

  const result: AbortIntegrationResult = {
    operationId,
    workspaceId,
    aborted: true,
    message,
  };

  const resultJson = JSON.stringify(result);
  updateOperationJournalStatus(db, operationId, workspaceId, "completed", resultJson, now());

  return result;
}

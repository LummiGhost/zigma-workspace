import * as fs from "node:fs";
import * as crypto from "node:crypto";
import type Database from "better-sqlite3";
import type {
  CommitWorkspaceInput,
  CommitWorkspaceResult,
  OperationJournalRow,
} from "../types/index.js";
import { ZigmaError } from "../types/index.js";
import { getWorkspaceById } from "../db/queries.js";
import {
  getIdempotencyRecord,
  insertIdempotencyRecord,
  insertOperationJournal,
  updateOperationJournalStatus,
} from "../db/queries.js";
import { emitWorkspaceEvent } from "./events.js";
import {
  stageAll,
  createCommit,
  getHeadCommit,
  getCommitFiles,
  getFullStatus,
  getStatusFiles,
} from "../git/index.js";
import { assertChangedPathsAllowed, assertWorkspaceBoundary, assertWritable, configForWorkspaceDatabase } from "./isolation-policy.js";

function now(): string {
  return new Date().toISOString();
}

function hashInput(input: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(input), "utf-8").digest("hex");
}

/**
 * Commit all changes (tracked, untracked, rename, delete, binary) in a workspace.
 *
 * - Uses `git add --all` to capture every change.
 * - Returns no-op if no changes exist.
 * - Returns baseCommit, headCommit, changed files, and evidence digest.
 * - Same operation ID + same input returns first result (idempotent).
 * - Different input with same operation ID returns conflict error.
 * - Expected state/head are validated before committing.
 */
export function commitWorkspace(
  db: Database.Database,
  input: CommitWorkspaceInput,
): CommitWorkspaceResult {
  const { operationId, workspaceId, message, expectedState, expectedHead } = input;

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
    return JSON.parse(idempotent.result_json) as CommitWorkspaceResult;
  }

  const row = getWorkspaceById(db, workspaceId);
  if (!row) {
    throw new ZigmaError("WORKSPACE_NOT_FOUND", `Workspace ${workspaceId} not found`, { workspaceId });
  }

  // Validate expected state
  if (expectedState && row.status !== expectedState) {
    throw new ZigmaError(
      "WORKSPACE_STATE_CONFLICT",
      `Expected workspace ${workspaceId} state ${expectedState}, got ${row.status}`,
      { workspaceId, expected: expectedState, actual: row.status },
    );
  }

  // Validate expected head
  if (expectedHead) {
    const actualHead = getHeadCommit(row.path);
    if (actualHead !== expectedHead) {
      throw new ZigmaError(
        "WORKSPACE_HEAD_CONFLICT",
        `Expected HEAD ${expectedHead}, got ${actualHead ?? "unknown"}`,
        { workspaceId, expected: expectedHead, actual: actualHead },
      );
    }
  }

  if (!fs.existsSync(row.path)) {
    throw new ZigmaError(
      "WORKSPACE_DIRECTORY_NOT_FOUND",
      `Workspace directory does not exist: ${row.path}`,
      { workspaceId, path: row.path },
    );
  }

  const config = configForWorkspaceDatabase(db, row.path);
  const manifest = assertWorkspaceBoundary(config, row);
  assertWritable(row);
  assertChangedPathsAllowed(row, manifest, getStatusFiles(row.path));

  const commitMsg = message ?? "zigma-workspace: automated commit";
  const ts = now();

  // Record operation started
  const journalRow: OperationJournalRow = {
    operation_id: operationId,
    workspace_id: workspaceId,
    command: "commit",
    status: "started",
    input_hash: inputHash,
    result_json: null,
    created_at: ts,
    updated_at: ts,
  };
  insertOperationJournal(db, journalRow);

  try {
    const baseCommit = row.base_commit;
    const statusBefore = getFullStatus(row.path);

    // Check if there's anything to commit
    if (!statusBefore.trim()) {
      // No-op: nothing changed
      const headCommit = getHeadCommit(row.path) ?? baseCommit;
      const result: CommitWorkspaceResult = {
        operationId,
        workspaceId,
        baseCommit,
        headCommit,
        changedFiles: [],
        evidenceDigest: crypto.createHash("sha256").update("no-op", "utf-8").digest("hex"),
        noOp: true,
      };

      // Record completed
      const resultJson = JSON.stringify(result);
      updateOperationJournalStatus(db, operationId, workspaceId, "completed", resultJson, now());

      // Insert idempotency record
      insertIdempotencyRecord(db, {
        operation_id: operationId,
        command: "commit",
        input_hash: inputHash,
        result_json: resultJson,
        created_at: ts,
      });

      return result;
    }

    // Stage all (includes untracked, rename, delete, binary)
    stageAll(row.path);

    // Create commit
    const headCommit = createCommit(row.path, commitMsg);

    // Get changed files
    const changedFiles = getCommitFiles(row.path, baseCommit, headCommit);

    // Compute evidence digest (SHA-256 of changed file list + status text)
    const evidenceContent = JSON.stringify({
      changedFiles,
      statusText: getFullStatus(row.path),
      baseCommit,
      headCommit,
    });
    const evidenceDigest = crypto.createHash("sha256").update(evidenceContent, "utf-8").digest("hex");

    const result: CommitWorkspaceResult = {
      operationId,
      workspaceId,
      baseCommit,
      headCommit,
      changedFiles,
      evidenceDigest,
      noOp: false,
    };

    // Record completed
    const resultJson = JSON.stringify(result);
    updateOperationJournalStatus(db, operationId, workspaceId, "completed", resultJson, now());

    // Insert idempotency record
    insertIdempotencyRecord(db, {
      operation_id: operationId,
      command: "commit",
      input_hash: inputHash,
      result_json: resultJson,
      created_at: ts,
    });

    emitWorkspaceEvent(db, workspaceId, "workspace.bound", {
      task_id: null,
      flow_run_id: null,
    });

    return result;
  } catch (err) {
    // Record failure
    const errorJson = JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
      code: err instanceof ZigmaError ? err.code : "INTERNAL_ERROR",
    });
    updateOperationJournalStatus(db, operationId, workspaceId, "failed", errorJson, now());
    throw err;
  }
}

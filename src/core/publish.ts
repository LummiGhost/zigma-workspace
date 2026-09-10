import * as crypto from "node:crypto";
import type Database from "better-sqlite3";
import type {
  PublishWorkspaceInput,
  PublishWorkspaceResult,
  OperationJournalRow,
} from "../types/index.js";
import { ZigmaError } from "../types/index.js";
import { getWorkspaceById } from "../db/queries.js";
import {
  getIdempotencyRecord,
  insertIdempotencyRecord,
  insertOperationJournal,
  updateOperationJournalStatus,
  getRepositoryCacheByUrl,
} from "../db/queries.js";
import { emitWorkspaceEvent } from "./events.js";
import {
  getHeadCommit,
  pushBranch,
  fetchRef,
  branchExists,
  isWorkingTreeDirty,
  resolveRef,
  getChangedFiles,
  generatePatch,
  diffCommits,
  getCommitsDiffFiles,
} from "../git/index.js";
import { assertChangedPathsAllowed, assertWorkspaceBoundary, assertWritable, configForWorkspaceDatabase } from "./isolation-policy.js";
import { writeEvidenceArtifact } from "./evidence.js";

function now(): string {
  return new Date().toISOString();
}

function hashInput(input: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(input), "utf-8").digest("hex");
}

/**
 * Publish a workspace's changes to a target ref.
 *
 * - First version supports the "branch" strategy (push to a remote branch).
 * - Verifies expected target HEAD when updating ref.
 * - Refuses to operate on a dirty working tree.
 * - Returns resulting ref and commit.
 */
export function publishWorkspace(
  db: Database.Database,
  input: PublishWorkspaceInput,
): PublishWorkspaceResult {
  const { operationId, workspaceId, strategy, targetRef, expectedHead } = input;

  const canonicalInput = {
    operationId,
    workspaceId,
    strategy,
    targetRef,
    expectedHead: expectedHead ?? null,
  };

  // Check idempotency
  const inputHash = hashInput(canonicalInput);
  const idempotent = getIdempotencyRecord(db, operationId);
  if (idempotent) {
    if (idempotent.input_hash !== inputHash) {
      throw new ZigmaError(
        "OPERATION_ID_CONFLICT",
        `Operation ${operationId} already executed with different input`,
        { operationId, command: idempotent.command },
      );
    }
    return JSON.parse(idempotent.result_json) as PublishWorkspaceResult;
  }

  const row = getWorkspaceById(db, workspaceId);
  if (!row) {
    throw new ZigmaError("WORKSPACE_NOT_FOUND", `Workspace ${workspaceId} not found`, { workspaceId });
  }
  const manifest = assertWorkspaceBoundary(configForWorkspaceDatabase(db, row.path), row);
  assertWritable(row);
  assertChangedPathsAllowed(row, manifest, getChangedFiles(row.path, row.base_commit));

  // Refuse to publish from a dirty working tree
  if (isWorkingTreeDirty(row.path)) {
    throw new ZigmaError(
      "WORKSPACE_STATE_CONFLICT",
      `Cannot publish workspace ${workspaceId}: working tree is dirty`,
      { workspaceId },
    );
  }

  // Verify expected HEAD
  const headCommit = getHeadCommit(row.path);
  if (!headCommit) {
    throw new ZigmaError(
      "WORKSPACE_OPERATION_INCOMPLETE",
      `Workspace ${workspaceId} has no HEAD commit`,
      { workspaceId },
    );
  }

  if (expectedHead && headCommit !== expectedHead) {
    throw new ZigmaError(
      "WORKSPACE_HEAD_CONFLICT",
      `Expected HEAD ${expectedHead}, got ${headCommit}`,
      { workspaceId, expected: expectedHead, actual: headCommit },
    );
  }

  const cacheRow = getRepositoryCacheByUrl(db, row.repository_url);
  if (!cacheRow) {
    throw new ZigmaError(
      "INTERNAL_ERROR",
      `No repository cache found for workspace ${workspaceId}`,
      { workspaceId, repositoryUrl: row.repository_url },
    );
  }

  const ts = now();

  // Record operation started
  const journalRow: OperationJournalRow = {
    operation_id: operationId,
    workspace_id: workspaceId,
    command: "publish",
    status: "started",
    input_hash: inputHash,
    result_json: null,
    created_at: ts,
    updated_at: ts,
  };
  insertOperationJournal(db, journalRow);

  try {
    let resultingRef: string | null;
    let previousRef: string | undefined;
    let changedFiles: string[] | undefined;
    let patch: string;

    switch (strategy) {
      case "none": {
        // No ref update; record the run evidence only. The manifest keeps
        // the creation base commit, while row.base_commit advances with
        // each integrate.
        resultingRef = null;
        changedFiles = getChangedFiles(row.path, manifest.base_commit);
        patch = generatePatch(row.path, manifest.base_commit);
        break;
      }
      case "branch": {
        resultingRef = `refs/heads/${targetRef}`;

        // Check if target branch exists and get its current commit
        try {
          fetchRef(cacheRow.mirror_path, `refs/heads/${targetRef}:refs/heads/${targetRef}`);
          if (branchExists(cacheRow.mirror_path, targetRef)) {
            previousRef = resolveRef(cacheRow.mirror_path, targetRef);
          }
        } catch {
          // Branch doesn't exist yet — that's fine
          previousRef = undefined;
        }

        // Push the workspace branch to the target ref
        pushBranch(cacheRow.mirror_path, row.branch, targetRef);

        // Evidence between the previous target ref (or the workspace's
        // creation base, which the manifest preserves) and the published
        // commit. row.base_commit cannot be used here: integrate advances
        // it, so it equals headCommit after the first merge.
        const evidenceBase = previousRef ?? manifest.base_commit;
        changedFiles = getCommitsDiffFiles(cacheRow.mirror_path, evidenceBase, headCommit);
        patch = diffCommits(cacheRow.mirror_path, evidenceBase, headCommit);
        break;
      }
      case "merge":
      case "fast-forward":
        throw new ZigmaError(
          "INVALID_INPUT",
          `Publish strategy "${strategy}" is not yet supported`,
          { workspaceId, strategy },
        );
      default:
        throw new ZigmaError(
          "INVALID_INPUT",
          `Unknown publish strategy: ${strategy}`,
          { workspaceId, strategy },
        );
    }

    const artifact = writeEvidenceArtifact(configForWorkspaceDatabase(db, row.path), workspaceId, operationId, patch);

    const result: PublishWorkspaceResult = {
      operationId,
      workspaceId,
      strategy,
      resultingRef,
      resultingCommit: headCommit,
      previousRef,
      changedFiles,
      artifact,
    };

    const resultJson = JSON.stringify(result);
    updateOperationJournalStatus(db, operationId, workspaceId, "completed", resultJson, now());
    insertIdempotencyRecord(db, {
      operation_id: operationId,
      command: "publish",
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
    const errorJson = JSON.stringify({
      error: err instanceof Error ? err.message : String(err),
      code: err instanceof ZigmaError ? err.code : "INTERNAL_ERROR",
    });
    updateOperationJournalStatus(db, operationId, workspaceId, "failed", errorJson, now());
    throw err;
  }
}

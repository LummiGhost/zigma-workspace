import * as fs from "node:fs";
import type Database from "better-sqlite3";
import type {
  ReconcileWorkspaceInput,
  ReconcileWorkspaceResult,
  ReconciledOperation,
  ReconciledStatus,
} from "../types/index.js";
import { ZigmaError } from "../types/index.js";
import { getWorkspaceById } from "../db/queries.js";
import { listOperationJournalForWorkspace } from "../db/queries.js";
import { getHeadCommit } from "../git/index.js";

/**
 * Reconcile a workspace's actual state against the registry, filesystem,
 * git HEAD, and operation journal.
 *
 * Determines whether operations completed, are incomplete, or left the
 * workspace in an orphaned/inconsistent state. Provides a recommendation
 * for how to proceed.
 */
export function reconcileWorkspace(
  db: Database.Database,
  input: ReconcileWorkspaceInput,
): ReconcileWorkspaceResult {
  const { workspaceId } = input;

  const row = getWorkspaceById(db, workspaceId);

  const registryStatus = row?.status ?? "UNKNOWN";
  const directoryExists = row ? fs.existsSync(row.path) : false;
  const gitHead = row && directoryExists ? getHeadCommit(row.path) ?? null : null;
  const manifestExists = row && directoryExists
    ? fs.existsSync(`${row.path}/.zigma-workspace.json`)
    : false;

  // Get operation journal entries
  const journalRows = listOperationJournalForWorkspace(db, workspaceId);
  const operations: ReconciledOperation[] = journalRows.map((j) => ({
    operationId: j.operation_id,
    command: j.command as ReconciledOperation["command"],
    status: j.status as ReconciledOperation["status"],
    inputHash: j.input_hash,
    resultJson: j.result_json,
    createdAt: j.created_at,
    updatedAt: j.updated_at,
  }));

  // Determine reconciled status
  let reconciledStatus: ReconciledStatus = "incomplete";
  let recommendation = "";

  if (!row) {
    // Not in registry at all
    reconciledStatus = "orphaned";
    recommendation = "No registry entry exists. If a worktree directory exists, it may be an orphan from a failed create. Use detectOrphanWorktrees to find and clean up.";
  } else if (registryStatus === "CLEANED") {
    // Registry says cleaned
    if (directoryExists) {
      reconciledStatus = "inconsistent";
      recommendation = "Registry says CLEANED but directory still exists. Re-run cleanup or manually remove the directory.";
    } else {
      reconciledStatus = "complete";
      recommendation = "Workspace is fully cleaned.";
    }
  } else if (!directoryExists) {
    // Registry has a record but directory is missing
    reconciledStatus = "orphaned";
    const pendingOps = operations.filter((o) => o.status === "started");
    if (pendingOps.length > 0) {
      recommendation = `Directory is missing but registry entry exists with ${pendingOps.length} in-progress operations. The workspace was likely interrupted during: ${pendingOps.map((o) => `${o.command}(${o.operationId})`).join(", ")}. Consider re-creating or cleaning up the registry record.`;
    } else {
      recommendation = "Directory is missing but registry entry exists. Consider cleaning up the registry record or re-creating the workspace.";
    }
  } else {
    // Registry and directory both exist — check operations
    const pendingOps = operations.filter((o) => o.status === "started");
    const failedOps = operations.filter((o) => o.status === "failed");

    if (pendingOps.length > 0) {
      reconciledStatus = "incomplete";
      recommendation = `Workspace has ${pendingOps.length} in-progress operations: ${pendingOps.map((o) => `${o.command}(${o.operationId})`).join(", ")}. These may need retry or manual intervention.`;
    } else if (failedOps.length > 0 && operations.every((o) => o.status !== "completed")) {
      reconciledStatus = "inconsistent";
      recommendation = `All operations have failed. The workspace is in an inconsistent state. Consider cleaning up or re-creating.`;
    } else if (operations.length === 0) {
      reconciledStatus = "incomplete";
      recommendation = "No operations recorded. The workspace was created but never used. It can be adopted or cleaned up.";
    } else {
      const allCompleted = operations.every((o) => o.status === "completed");
      if (allCompleted) {
        reconciledStatus = "complete";
        recommendation = "All operations completed successfully. The workspace is ready for cleanup or further use.";
      } else {
        reconciledStatus = "inconsistent";
        recommendation = `Mixed operation statuses: ${operations.map((o) => `${o.command}=${o.status}`).join(", ")}. Review individual operations and retry or clean up.`;
      }
    }
  }

  return {
    workspaceId,
    registryStatus,
    directoryExists,
    gitHead,
    manifestExists,
    operations,
    reconciledStatus,
    recommendation,
  };
}

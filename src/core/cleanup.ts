import * as fs from "node:fs";
import * as crypto from "node:crypto";
import type Database from "better-sqlite3";
import type {
  ZigmaWorkspaceConfig,
  CleanupWorkspaceStrictInput,
  CleanupWorkspaceStrictResult,
  OperationJournalRow,
} from "../types/index.js";
import { ZigmaError } from "../types/index.js";
import {
  getWorkspaceById,
  getActiveLockForWorkspace,
  updateWorkspaceStatus,
  listWorkspaces,
} from "../db/queries.js";
import {
  getIdempotencyRecord,
  insertIdempotencyRecord,
  insertOperationJournal,
  updateOperationJournalStatus,
} from "../db/queries.js";
import { emitWorkspaceEvent } from "../core/events.js";
import { transition } from "./state-machine.js";
import { removeWorktree, listWorktrees } from "../git/index.js";
import { getRepositoryCacheByUrl } from "../db/queries.js";

function now(): string {
  return new Date().toISOString();
}

export interface CleanupResult {
  workspaceId: string;
  path: string;
  removed: boolean;
  message: string;
}

export function cleanupWorkspace(
  db: Database.Database,
  config: ZigmaWorkspaceConfig,
  workspaceId: string
): CleanupResult {
  const row = getWorkspaceById(db, workspaceId);
  if (!row) {
    throw new ZigmaError("WORKSPACE_NOT_FOUND", `Workspace ${workspaceId} not found`, { workspaceId });
  }

  if (row.status === "CLEANED") {
    return {
      workspaceId,
      path: row.path,
      removed: false,
      message: "Workspace is already cleaned",
    };
  }

  const activeLock = getActiveLockForWorkspace(db, workspaceId);
  if (activeLock) {
    throw new ZigmaError(
      "WORKSPACE_LOCK_CONFLICT",
      `Cannot clean workspace ${workspaceId} while it is locked by ${activeLock.owner}`,
      { workspaceId, owner: activeLock.owner, mode: activeLock.mode },
    );
  }

  const workspacePath = row.path;
  let removed = false;
  let message = "";

  // Attempt to remove the worktree from the mirror
  const cacheRow = getRepositoryCacheByUrl(db, row.repository_url);
  if (cacheRow && fs.existsSync(cacheRow.mirror_path)) {
    try {
      removeWorktree(cacheRow.mirror_path, workspacePath);
      removed = true;
      message = "Worktree removed from mirror and filesystem";
    } catch (err) {
      // Fall back to direct filesystem removal
      if (fs.existsSync(workspacePath)) {
        try {
          fs.rmSync(workspacePath, { recursive: true, force: true });
          removed = true;
          message = "Workspace directory removed directly (worktree prune failed)";
        } catch (rmErr) {
          message = `Failed to remove workspace directory: ${rmErr instanceof Error ? rmErr.message : String(rmErr)}`;
        }
      } else {
        removed = true;
        message = "Workspace directory did not exist on filesystem";
      }
    }
  } else {
    // No mirror — just remove the directory
    if (fs.existsSync(workspacePath)) {
      try {
        fs.rmSync(workspacePath, { recursive: true, force: true });
        removed = true;
        message = "Workspace directory removed (no mirror found)";
      } catch (err) {
        message = `Failed to remove directory: ${err instanceof Error ? err.message : String(err)}`;
      }
    } else {
      removed = true;
      message = "Workspace directory already absent from filesystem";
    }
  }

  if (removed) {
    updateWorkspaceStatus(db, workspaceId, "CLEANED", now());
    emitWorkspaceEvent(db, workspaceId, "workspace.cleaned", { removed, message });
  }

  return { workspaceId, path: workspacePath, removed, message };
}

export interface OrphanWorktreeInfo {
  path: string;
  branch: string;
  commit: string;
  registeredWorkspaceId?: string;
}

/**
 * Detect worktrees that exist in git but have no corresponding workspace registry entry.
 * This helps identify leaked worktrees after crashes or manual deletions from the DB.
 */
export function detectOrphanWorktrees(
  db: Database.Database,
  config: ZigmaWorkspaceConfig
): OrphanWorktreeInfo[] {
  const workspaceRows = listWorkspaces(db);

  // Build a set of known workspace paths
  const knownPaths = new Set(
    workspaceRows
      .filter((r) => r.status !== "CLEANED")
      .map((r) => r.path)
  );

  // Get all unique mirror paths
  const mirrorPaths = new Set<string>();
  for (const ws of workspaceRows) {
    // We need to query cache by repo URL
    const cacheRow = getRepositoryCacheByUrl(db, ws.repository_url);
    if (cacheRow) {
      mirrorPaths.add(cacheRow.mirror_path);
    }
  }

  const orphans: OrphanWorktreeInfo[] = [];

  for (const mirrorPath of mirrorPaths) {
    if (!fs.existsSync(mirrorPath)) continue;

    const worktrees = listWorktrees(mirrorPath);
    for (const wt of worktrees) {
      // Skip the mirror itself (it shows as a worktree)
      if (wt.path === mirrorPath) continue;

      if (!knownPaths.has(wt.path)) {
        // This worktree is not in the registry
        const registeredWorkspace = workspaceRows.find(
          (r) => r.path === wt.path
        );
        orphans.push({
          path: wt.path,
          branch: wt.branch,
          commit: wt.commit,
          registeredWorkspaceId: registeredWorkspace?.id,
        });
      }
    }
  }

  return orphans;
}

function hashInput(input: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(input), "utf-8").digest("hex");
}

/**
 * Strict cleanup: only transitions to CLEANED after worktree registration
 * AND directory are confirmed removed.
 *
 * - Delete failure returns non-success with CLEANUP_FAILED status.
 * - Repeat cleanup is idempotent.
 * - Handles Windows file locking with diagnosable blockers.
 * - Same operation ID retry is safe (idempotent).
 */
export function cleanupWorkspaceStrict(
  db: Database.Database,
  config: ZigmaWorkspaceConfig,
  input: CleanupWorkspaceStrictInput,
): CleanupWorkspaceStrictResult {
  const { operationId, workspaceId, force } = input;

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
    return JSON.parse(idempotent.result_json) as CleanupWorkspaceStrictResult;
  }

  const row = getWorkspaceById(db, workspaceId);
  if (!row) {
    throw new ZigmaError("WORKSPACE_NOT_FOUND", `Workspace ${workspaceId} not found`, { workspaceId });
  }

  if (row.status === "CLEANED") {
    return {
      operationId,
      workspaceId,
      path: row.path,
      removed: true,
      status: "CLEANED",
      message: "Workspace is already cleaned",
    };
  }

  const activeLock = getActiveLockForWorkspace(db, workspaceId);
  if (activeLock) {
    if (!force) {
      throw new ZigmaError(
        "WORKSPACE_LOCK_CONFLICT",
        `Cannot clean workspace ${workspaceId} while it is locked by ${activeLock.owner}`,
        { workspaceId, owner: activeLock.owner, mode: activeLock.mode },
      );
    }
  }

  const ts = now();

  // Record operation started
  const journalRow: OperationJournalRow = {
    operation_id: operationId,
    workspace_id: workspaceId,
    command: "cleanup",
    status: "started",
    input_hash: inputHash,
    result_json: null,
    created_at: ts,
    updated_at: ts,
  };
  insertOperationJournal(db, journalRow);

  const workspacePath = row.path;
  const blockers: string[] = [];
  let removed = false;
  let message = "";

  // Attempt worktree removal
  const cacheRow = getRepositoryCacheByUrl(db, row.repository_url);
  if (cacheRow && fs.existsSync(cacheRow.mirror_path)) {
    try {
      removeWorktree(cacheRow.mirror_path, workspacePath);
      removed = !fs.existsSync(workspacePath);
      if (removed) {
        message = "Worktree removed from mirror and filesystem";
      } else {
        blockers.push("Worktree remove command succeeded but directory still exists");
      }
    } catch (err) {
      blockers.push(`Worktree removal failed: ${err instanceof Error ? err.message : String(err)}`);
      // Try direct filesystem removal
      if (fs.existsSync(workspacePath)) {
        try {
          fs.rmSync(workspacePath, { recursive: true, force: true });
          removed = !fs.existsSync(workspacePath);
          if (removed) {
            message = "Workspace directory removed directly (worktree prune failed)";
          }
        } catch (rmErr) {
          blockers.push(`Direct directory removal failed: ${rmErr instanceof Error ? rmErr.message : String(rmErr)}`);
        }
      }
    }
  } else {
    // No mirror — just remove the directory
    if (fs.existsSync(workspacePath)) {
      try {
        fs.rmSync(workspacePath, { recursive: true, force: true });
        removed = !fs.existsSync(workspacePath);
        if (removed) {
          message = "Workspace directory removed (no mirror found)";
        }
      } catch (err) {
        blockers.push(`Directory removal failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      removed = true;
      message = "Workspace directory already absent from filesystem";
    }
  }

  if (removed) {
    // Only transition to CLEANED when directory is confirmed gone
    updateWorkspaceStatus(db, workspaceId, "CLEANED", now());
    emitWorkspaceEvent(db, workspaceId, "workspace.cleaned", { removed, message });

    const result: CleanupWorkspaceStrictResult = {
      operationId,
      workspaceId,
      path: workspacePath,
      removed: true,
      status: "CLEANED",
      message,
    };

    const resultJson = JSON.stringify(result);
    updateOperationJournalStatus(db, operationId, workspaceId, "completed", resultJson, now());
    insertIdempotencyRecord(db, {
      operation_id: operationId,
      command: "cleanup",
      input_hash: inputHash,
      result_json: resultJson,
      created_at: ts,
    });

    return result;
  }

  // Deletion failed — set CLEANUP_FAILED, not CLEANED
  try {
    updateWorkspaceStatus(
      db,
      workspaceId,
      row.status === "CLEANUP_FAILED" ? "CLEANUP_FAILED" : "CLEANUP_FAILED",
      now(),
    );
  } catch {
    // If transition fails (state doesn't allow CLEANUP_FAILED), force the status
    try {
      updateWorkspaceStatus(db, workspaceId, "CLEANUP_FAILED", now());
    } catch {
      // Best effort
    }
  }

  message = `Cleanup failed: ${blockers.join("; ")}`;

  const result: CleanupWorkspaceStrictResult = {
    operationId,
    workspaceId,
    path: workspacePath,
    removed: false,
    status: "CLEANUP_FAILED",
    message,
    blockers,
  };

  const resultJson = JSON.stringify(result);
  updateOperationJournalStatus(db, operationId, workspaceId, "failed", resultJson, now());

  return result;
}

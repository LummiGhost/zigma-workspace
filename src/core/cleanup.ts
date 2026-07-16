import * as fs from "node:fs";
import { v4 as uuidv4 } from "uuid";
import type Database from "better-sqlite3";
import type { ZigmaWorkspaceConfig } from "../types/index.js";
import {
  getWorkspaceById,
  updateWorkspaceStatus,
  listWorkspaces,
  insertWorkspaceEvent,
} from "../db/queries.js";
import { removeWorktree, listWorktrees } from "../git/index.js";
import { getRepositoryCacheByUrl } from "../db/queries.js";

function now(): string {
  return new Date().toISOString();
}

function emitEvent(
  db: Database.Database,
  workspaceId: string,
  event: string,
  data?: unknown
): void {
  insertWorkspaceEvent(db, {
    id: `evt_${uuidv4()}`,
    workspace_id: workspaceId,
    event,
    data: data ? JSON.stringify(data) : null,
    created_at: now(),
  });
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
    throw new Error(`Workspace ${workspaceId} not found`);
  }

  if (row.status === "cleaned") {
    return {
      workspaceId,
      path: row.path,
      removed: false,
      message: "Workspace is already cleaned",
    };
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

  // Update status regardless of filesystem result
  updateWorkspaceStatus(db, workspaceId, "cleaned", now());
  emitEvent(db, workspaceId, "workspace.cleaned", { removed, message });

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
      .filter((r) => r.status !== "cleaned")
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

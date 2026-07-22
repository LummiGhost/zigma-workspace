import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import type Database from "better-sqlite3";
import type { WorkspaceDiff, ZigmaWorkspaceConfig } from "../types/index.js";
import { ZigmaError } from "../types/index.js";
import { getWorkspaceById, insertWorkspaceEvent } from "../db/queries.js";
import {
  getStatus,
  getChangedFiles,
  getUntrackedFiles,
  getDiffStat,
  generatePatch,
  getHeadCommit,
} from "../git/index.js";

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

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content, "utf-8").digest("hex");
}

export function collectDiff(
  db: Database.Database,
  config: ZigmaWorkspaceConfig,
  workspaceId: string,
  patchOutPath?: string
): WorkspaceDiff {
  const row = getWorkspaceById(db, workspaceId);
  if (!row) {
    throw new ZigmaError("WORKSPACE_NOT_FOUND", `Workspace ${workspaceId} not found`, { workspaceId });
  }

  if (!fs.existsSync(row.path)) {
    throw new ZigmaError("WORKSPACE_DIRECTORY_NOT_FOUND", `Workspace directory does not exist: ${row.path}`, { workspaceId, path: row.path });
  }

  const baseCommit = row.base_commit;
  const workspacePath = row.path;

  const statusText = getStatus(workspacePath);
  const changedFiles = getChangedFiles(workspacePath, baseCommit);
  const untrackedFiles = getUntrackedFiles(workspacePath);
  const diffStat = getDiffStat(workspacePath, baseCommit);
  const headCommit = getHeadCommit(workspacePath);
  const patch = generatePatch(workspacePath, baseCommit);

  // Build summary
  const totalChanged = changedFiles.length;
  const totalUntracked = untrackedFiles.length;
  const isDirty = statusText.trim().length > 0;

  let summary = `workspace: ${workspaceId}\n`;
  summary += `base: ${baseCommit}\n`;
  summary += `head: ${headCommit ?? "unknown"}\n`;
  summary += `changed files: ${totalChanged}\n`;
  summary += `untracked files: ${totalUntracked}\n`;
  summary += `dirty: ${isDirty}\n`;
  if (diffStat) {
    summary += `\ndiff stat:\n${diffStat}\n`;
  }

  // Determine patch path and digest
  let resolvedPatchPath: string | undefined;
  let patchDigest: string | undefined;

  if (patch.trim()) {
    patchDigest = sha256(patch);
    if (patchOutPath) {
      resolvedPatchPath = patchOutPath;
    } else {
      const patchFileName = `${workspaceId}-${Date.now()}.patch`;
      resolvedPatchPath = path.join(config.snapshotsDir, patchFileName);
    }
  } else if (patchOutPath) {
    resolvedPatchPath = patchOutPath;
  }

  if (resolvedPatchPath && patch) {
    fs.mkdirSync(path.dirname(resolvedPatchPath), { recursive: true });
    fs.writeFileSync(resolvedPatchPath, patch, "utf-8");
  }

  emitEvent(db, workspaceId, "workspace.diff.collected", {
    changedFiles: totalChanged,
    untrackedFiles: totalUntracked,
    patchPath: resolvedPatchPath,
    patchChecksum: patchDigest ?? null,
  });

  return {
    workspaceId,
    baseCommit,
    headCommit,
    changedFiles,
    untrackedFiles,
    statusText,
    patchPath: resolvedPatchPath,
    patchDigest,
    summary,
  };
}

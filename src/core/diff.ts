import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type Database from "better-sqlite3";
import type { WorkspaceDiff, ZigmaWorkspaceConfig } from "../types/index.js";
import { ZigmaError } from "../types/index.js";
import { getWorkspaceById } from "../db/queries.js";
import { emitWorkspaceEvent } from "../core/events.js";
import { createIgnoreMatcher } from "./ignore-matcher.js";
import {
  getStatus,
  getChangedFiles,
  getUntrackedFiles,
  getDiffStat,
  generatePatch,
  getHeadCommit,
  getStatusFiles,
} from "../git/index.js";
import { assertCapacityAvailable, assertChangedPathsContained, assertPathWithin, assertWorkspaceBoundary } from "./isolation-policy.js";

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content, "utf-8").digest("hex");
}

export interface PathFilter {
  allowedPaths?: string[];
  deniedPaths?: string[];
}

function normalizeRepositoryPath(file: string): string | null {
  const normalized = path.posix.normalize(file.replace(/\\/g, "/")).replace(/^\.\//, "");
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized)
  ) {
    return null;
  }
  return normalized === "." ? "" : normalized;
}

function normalizeFilterPath(candidate: string): string | null {
  const normalized = path.posix.normalize(candidate.replace(/\\/g, "/"))
    .replace(/^\.\//, "")
    .replace(/\/$/, "");
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized)
  ) {
    return null;
  }
  return normalized === "." ? "" : normalized;
}

export function filterFiles(files: string[], filter: PathFilter): string[] {
  let result = files;

  if (filter.allowedPaths && filter.allowedPaths.length > 0) {
    const allowed = filter.allowedPaths
      .map(normalizeFilterPath)
      .filter((candidate): candidate is string => candidate !== null);
    result = result.filter((file) => {
      const normalized = normalizeRepositoryPath(file);
      if (normalized === null) return false;
      return allowed.some((prefix) =>
        prefix === "" || normalized === prefix || normalized.startsWith(`${prefix}/`),
      );
    });
  }

  if (filter.deniedPaths && filter.deniedPaths.length > 0) {
    const matcher = createIgnoreMatcher(filter.deniedPaths);
    result = result.filter((f) => !matcher.matches(f));
  }

  return result;
}

export function readWorkspacePathFilter(workspacePath: string): PathFilter | undefined {
  const manifestPath = path.join(workspacePath, ".zigma-workspace.json");
  if (!fs.existsSync(manifestPath)) return undefined;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as {
      allowed_paths?: unknown;
      denied_paths?: unknown;
    };
    return {
      allowedPaths: Array.isArray(manifest.allowed_paths)
        ? manifest.allowed_paths.filter((value): value is string => typeof value === "string")
        : undefined,
      deniedPaths: Array.isArray(manifest.denied_paths)
        ? manifest.denied_paths.filter((value): value is string => typeof value === "string")
        : undefined,
    };
  } catch {
    return undefined;
  }
}

function filterStatusText(statusText: string, filter: PathFilter): string {
  return statusText
    .split("\n")
    .filter((line) => {
      if (!line.trim()) return false;
      const pathPart = line.slice(3).split(" -> ").pop()?.trim() ?? "";
      return filterFiles([pathPart], filter).length > 0;
    })
    .join("\n");
}

export function collectDiff(
  db: Database.Database,
  config: ZigmaWorkspaceConfig,
  workspaceId: string,
  patchOutPath?: string,
  pathFilter?: PathFilter,
): WorkspaceDiff {
  const row = getWorkspaceById(db, workspaceId);
  if (!row) {
    throw new ZigmaError("WORKSPACE_NOT_FOUND", `Workspace ${workspaceId} not found`, { workspaceId });
  }

  if (!fs.existsSync(row.path)) {
    throw new ZigmaError("WORKSPACE_DIRECTORY_NOT_FOUND", `Workspace directory does not exist: ${row.path}`, { workspaceId, path: row.path });
  }

  assertWorkspaceBoundary(config, row);
  assertChangedPathsContained(row, getStatusFiles(row.path));

  const baseCommit = row.base_commit;
  const workspacePath = row.path;

  const rawStatusText = getStatus(workspacePath);
  let changedFiles = getChangedFiles(workspacePath, baseCommit);
  let untrackedFiles = getUntrackedFiles(workspacePath);
  const effectiveFilter = pathFilter ?? readWorkspacePathFilter(workspacePath);
  if (effectiveFilter) {
    changedFiles = filterFiles(changedFiles, effectiveFilter);
    untrackedFiles = filterFiles(untrackedFiles, effectiveFilter);
  }
  const diffStat = getDiffStat(workspacePath, baseCommit, effectiveFilter ? changedFiles : undefined);
  const headCommit = getHeadCommit(workspacePath);
  const patch = effectiveFilter && changedFiles.length === 0
    ? ""
    : generatePatch(workspacePath, baseCommit, effectiveFilter ? changedFiles : undefined);
  const statusText = effectiveFilter ? filterStatusText(rawStatusText, effectiveFilter) : rawStatusText;

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
      if (!path.isAbsolute(patchOutPath)) {
        throw new ZigmaError("WORKSPACE_PATH_POLICY_VIOLATION", "Patch output path must be absolute", { patchOutPath });
      }
      assertPathWithin(config.snapshotsDir, patchOutPath, "Patch output path");
      resolvedPatchPath = patchOutPath;
    } else {
      const patchFileName = `${workspaceId}-${Date.now()}.patch`;
      resolvedPatchPath = path.join(config.snapshotsDir, patchFileName);
      assertPathWithin(config.snapshotsDir, resolvedPatchPath, "Patch output path");
    }
  }

  if (resolvedPatchPath && patch) {
    assertCapacityAvailable(config, Buffer.byteLength(patch, "utf-8"));
    fs.mkdirSync(path.dirname(resolvedPatchPath), { recursive: true });
    fs.writeFileSync(resolvedPatchPath, patch, "utf-8");
  }

  emitWorkspaceEvent(db, workspaceId, "workspace.diff.collected", {
    changed_files: totalChanged,
    untracked_files: totalUntracked,
    patch_path: resolvedPatchPath ?? null,
    patch_checksum: patchDigest ?? null,
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

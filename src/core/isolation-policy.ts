import * as fs from "node:fs";
import * as path from "node:path";
import type Database from "better-sqlite3";
import type { WorkspaceCapacityStatus, WorkspaceManifest, WorkspaceRow, ZigmaWorkspaceConfig } from "../types/index.js";
import { ZigmaError } from "../types/index.js";
import { createIgnoreMatcher } from "./ignore-matcher.js";

function comparable(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function realPathWithMissingLeaf(value: string): string {
  let cursor = path.resolve(value);
  const missing: string[] = [];
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }
  const base = fs.existsSync(cursor) ? fs.realpathSync.native(cursor) : cursor;
  return path.join(base, ...missing);
}

export function assertPathWithin(root: string, candidate: string, label: string): string {
  if (!path.isAbsolute(root) || !path.isAbsolute(candidate)) {
    throw new ZigmaError("WORKSPACE_PATH_POLICY_VIOLATION", `${label} must be absolute`, { root, candidate });
  }
  const canonicalRoot = comparable(realPathWithMissingLeaf(root));
  const canonicalCandidate = comparable(realPathWithMissingLeaf(candidate));
  if (canonicalCandidate !== canonicalRoot && !canonicalCandidate.startsWith(`${canonicalRoot}${path.sep}`)) {
    throw new ZigmaError("WORKSPACE_PATH_POLICY_VIOLATION", `${label} escapes configured root`, {
      root: canonicalRoot, candidate: canonicalCandidate,
    });
  }
  return canonicalCandidate;
}

function normalizeManifestPath(value: string): string {
  const normalized = path.posix.normalize(value.replace(/\\/g, "/")).replace(/^\.\//, "").replace(/\/$/, "");
  if (!value || path.isAbsolute(value) || path.win32.isAbsolute(value) || normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
    throw new ZigmaError("WORKSPACE_PATH_POLICY_VIOLATION", `Invalid manifest path policy entry: ${value}`, { path: value });
  }
  return normalized === "." ? "" : normalized;
}

export function readAndValidateManifest(row: WorkspaceRow): WorkspaceManifest {
  const manifestPath = path.join(row.path, ".zigma-workspace.json");
  assertPathWithin(row.path, manifestPath, "Workspace manifest");
  let manifest: WorkspaceManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as WorkspaceManifest;
  } catch (error) {
    throw new ZigmaError("WORKSPACE_PATH_POLICY_VIOLATION", "Workspace manifest is missing or invalid", {
      workspaceId: row.id, error: error instanceof Error ? error.message : String(error),
    });
  }
  if (
    manifest.workspace_id !== row.id
    || typeof manifest.path !== "string"
    || !path.isAbsolute(manifest.path)
    || comparable(manifest.path) !== comparable(row.path)
    || manifest.mode !== row.mode
  ) {
    throw new ZigmaError("WORKSPACE_PATH_POLICY_VIOLATION", "Workspace manifest identity does not match registry", { workspaceId: row.id });
  }
  validateManifestPathPolicy(manifest.allowed_paths, manifest.denied_paths, row.id);
  return manifest;
}

export function validateManifestPathPolicy(allowedPaths: unknown, deniedPaths: unknown, workspaceId?: string): void {
  if (!Array.isArray(allowedPaths) || !Array.isArray(deniedPaths)) {
    throw new ZigmaError("WORKSPACE_PATH_POLICY_VIOLATION", "Workspace manifest path policy must contain arrays", { workspaceId });
  }
  const aliases = new Map<string, string>();
  for (const entry of [...allowedPaths, ...deniedPaths]) {
    if (typeof entry !== "string") {
      throw new ZigmaError("WORKSPACE_PATH_POLICY_VIOLATION", "Workspace manifest path entries must be strings", { workspaceId });
    }
    const normalized = normalizeManifestPath(entry);
    const alias = normalized.toLowerCase();
    const previous = aliases.get(alias);
    if (process.platform === "win32" && previous !== undefined && previous !== normalized) {
      throw new ZigmaError("WORKSPACE_PATH_POLICY_VIOLATION", "Manifest contains case-fold path aliases", { workspaceId, path: entry });
    }
    aliases.set(process.platform === "win32" ? alias : normalized, normalized);
  }
}

export function assertWorkspaceRootBoundary(config: ZigmaWorkspaceConfig, row: WorkspaceRow): void {
  assertPathWithin(config.stateDir, config.workspacesDir, "Workspace root");
  assertPathWithin(config.workspacesDir, row.path, "Workspace path");
  if (path.basename(row.path).toLowerCase() !== row.id.toLowerCase()) {
    throw new ZigmaError("WORKSPACE_PATH_POLICY_VIOLATION", "Workspace path does not match workspace id", { workspaceId: row.id, path: row.path });
  }
}

export function assertWorkspaceBoundary(config: ZigmaWorkspaceConfig, row: WorkspaceRow): WorkspaceManifest {
  assertWorkspaceRootBoundary(config, row);
  return readAndValidateManifest(row);
}

export function assertWritable(row: WorkspaceRow): void {
  if (row.mode !== "writable") {
    throw new ZigmaError("WORKSPACE_READ_ONLY", `Workspace ${row.id} is read-only`, { workspaceId: row.id, mode: row.mode });
  }
}

export function assertChangedPathsAllowed(row: WorkspaceRow, manifest: WorkspaceManifest, files: string[]): void {
  const allowed = manifest.allowed_paths.map(normalizeManifestPath);
  const denied = createIgnoreMatcher(manifest.denied_paths);
  for (const file of files) {
    const normalized = normalizeManifestPath(file);
    const permitted = allowed.length === 0 || allowed.some((prefix) => prefix === "" || normalized === prefix || normalized.startsWith(`${prefix}/`));
    if (!permitted || denied.matches(normalized)) {
      throw new ZigmaError("WORKSPACE_PATH_POLICY_VIOLATION", `Changed path is outside manifest policy: ${file}`, { workspaceId: row.id, path: file });
    }
    const absolute = path.join(row.path, ...normalized.split("/"));
    assertPathWithin(row.path, absolute, "Changed path");
  }
}

export function assertChangedPathsContained(row: WorkspaceRow, files: string[]): void {
  for (const file of files) {
    const normalized = normalizeManifestPath(file);
    const absolute = path.join(row.path, ...normalized.split("/"));
    assertPathWithin(row.path, absolute, "Changed path");
  }
}

function directorySize(root: string): number {
  if (!fs.existsSync(root)) return 0;
  let total = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) pending.push(candidate);
      else total += stat.size;
    }
  }
  return total;
}

export function getCapacityStatus(config: ZigmaWorkspaceConfig): WorkspaceCapacityStatus {
  const usedBytes = directorySize(config.stateDir);
  const maxBytes = config.maxDiskBytes ?? 50 * 1024 * 1024 * 1024;
  return {
    usedBytes,
    maxBytes,
    availableBytes: Math.max(0, maxBytes - usedBytes),
    exceeded: usedBytes >= maxBytes,
    retainFailedDays: config.retainFailedDays ?? 7,
  };
}

export function assertCapacityAvailable(config: ZigmaWorkspaceConfig, additionalBytes = 0): void {
  const capacity = getCapacityStatus(config);
  if (capacity.exceeded || additionalBytes > capacity.availableBytes) {
    throw new ZigmaError("WORKSPACE_CAPACITY_EXCEEDED", "Workspace state directory capacity is exhausted", { ...capacity, additionalBytes });
  }
}

export function configForWorkspaceDatabase(db: Database.Database, workspacePath: string): ZigmaWorkspaceConfig {
  const databaseName = (db as Database.Database & { name?: string }).name;
  const stateDir = databaseName && databaseName !== ":memory:" ? path.dirname(databaseName) : path.dirname(path.dirname(workspacePath));
  return {
    stateDir,
    repoCacheDir: path.join(stateDir, "repo-cache"),
    workspacesDir: path.join(stateDir, "workspaces"),
    snapshotsDir: path.join(stateDir, "snapshots"),
    logsDir: path.join(stateDir, "logs"),
    dbPath: databaseName ?? ":memory:",
    maxDiskBytes: Number.MAX_SAFE_INTEGER,
    retainFailedDays: 7,
  };
}

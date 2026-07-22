import * as fs from "node:fs";
import * as path from "node:path";
import { v4 as uuidv4 } from "uuid";
import type Database from "better-sqlite3";
import type {
  Workspace,
  CreateWorkspaceInput,
  BindWorkspaceRunInput,
  WorkspaceManifest,
  ZigmaWorkspaceConfig,
  WorkspaceRow,
  RepositoryCacheRow,
} from "../types/index.js";
import { ZigmaError } from "../types/index.js";
import {
  insertWorkspace,
  getWorkspaceById,
  listWorkspaces,
  updateWorkspaceStatus,
  updateWorkspaceBindings,
  insertRepositoryCache,
  getRepositoryCacheByUrl,
  updateRepositoryCacheFetched,
  insertWorkspaceEvent,
} from "../db/queries.js";
import {
  checkGitAvailable,
  hashRepoUrl,
  cloneMirror,
  fetchMirror,
  resolveRef,
  createWorktree,
  getDefaultBranch,
  configureWorktreeMode,
} from "../git/index.js";

function now(): string {
  return new Date().toISOString();
}

function rowToWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    projectId: row.project_id ?? undefined,
    taskId: row.task_id ?? undefined,
    flowRunId: row.flow_run_id ?? undefined,
    repositoryUrl: row.repository_url,
    baseRef: row.base_ref,
    baseCommit: row.base_commit,
    branch: row.branch,
    path: row.path,
    mode: row.mode as "read-only" | "writable",
    status: row.status as Workspace["status"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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

/**
 * Ensure a repository mirror exists and is up-to-date.
 * Returns the cache record.
 */
function ensureRepositoryCache(
  db: Database.Database,
  config: ZigmaWorkspaceConfig,
  repoUrl: string
): RepositoryCacheRow {
  let cacheRow = getRepositoryCacheByUrl(db, repoUrl);

  if (!cacheRow) {
    const cacheId = `cache_${uuidv4()}`;
    const urlHash = hashRepoUrl(repoUrl);
    const mirrorPath = path.join(config.repoCacheDir, urlHash);

    cacheRow = {
      id: cacheId,
      repository_url: repoUrl,
      mirror_path: mirrorPath,
      last_fetched_at: null,
      default_branch: null,
      status: "ready",
    };
    insertRepositoryCache(db, cacheRow);
  }

  const mirrorPath = cacheRow.mirror_path;

  // Clone if not present
  if (!fs.existsSync(mirrorPath)) {
    cloneMirror(repoUrl, mirrorPath);
  } else {
    // Fetch latest
    fetchMirror(mirrorPath);
  }

  const defaultBranch = getDefaultBranch(mirrorPath) ?? null;
  const fetchedAt = now();
  updateRepositoryCacheFetched(db, cacheRow.id, fetchedAt, defaultBranch, "ready");

  return {
    ...cacheRow,
    last_fetched_at: fetchedAt,
    default_branch: defaultBranch,
    status: "ready",
  };
}

export function createWorkspace(
  db: Database.Database,
  config: ZigmaWorkspaceConfig,
  input: CreateWorkspaceInput
): Workspace {
  checkGitAvailable();

  const { repositoryUrl, baseRef, branch, mode = "writable" } = input;

  // Ensure mirror cache
  const cache = ensureRepositoryCache(db, config, repositoryUrl);

  // Resolve base commit
  const baseCommit = resolveRef(cache.mirror_path, baseRef);

  // Workspace ID and path
  const wsId = `ws_${uuidv4()}`;
  const workspacePath = path.join(config.workspacesDir, wsId);

  // Create worktree
  createWorktree(cache.mirror_path, workspacePath, branch, baseCommit);

  // Configure mode
  configureWorktreeMode(workspacePath, mode);

  const ts = now();

  const row: WorkspaceRow = {
    id: wsId,
    project_id: input.projectId ?? null,
    task_id: input.taskId ?? null,
    flow_run_id: input.flowRunId ?? null,
    repository_url: repositoryUrl,
    base_ref: baseRef,
    base_commit: baseCommit,
    branch,
    path: workspacePath,
    mode,
    status: "created",
    created_at: ts,
    updated_at: ts,
  };

  insertWorkspace(db, row);

  // Write manifest
  const manifest: WorkspaceManifest = {
    workspace_id: wsId,
    project_id: input.projectId ?? null,
    task_id: input.taskId ?? null,
    flow_run_id: input.flowRunId ?? null,
    repo: repositoryUrl,
    base_ref: baseRef,
    base_commit: baseCommit,
    branch,
    path: workspacePath,
    mode,
    allowed_paths: ["."],
    denied_paths: [".env", ".zigma-workspace.json"],
  };

  const manifestPath = path.join(workspacePath, ".zigma-workspace.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

  // Mark as prepared
  updateWorkspaceStatus(db, wsId, "prepared", now());
  emitEvent(db, wsId, "workspace.created", { branch, baseCommit });

  const finalRow = getWorkspaceById(db, wsId);
  if (!finalRow) throw new ZigmaError("INTERNAL_ERROR", `Failed to retrieve workspace ${wsId} after creation`, { workspaceId: wsId });

  return rowToWorkspace(finalRow);
}

export function bindRun(
  db: Database.Database,
  input: BindWorkspaceRunInput
): Workspace {
  const row = getWorkspaceById(db, input.workspaceId);
  if (!row) {
    throw new ZigmaError("WORKSPACE_NOT_FOUND", `Workspace ${input.workspaceId} not found`, { workspaceId: input.workspaceId });
  }

  const ts = now();
  updateWorkspaceBindings(
    db,
    input.workspaceId,
    input.taskId ?? row.task_id,
    input.flowRunId ?? row.flow_run_id,
    ts
  );
  updateWorkspaceStatus(db, input.workspaceId, "active", ts);

  emitEvent(db, input.workspaceId, "workspace.bound", {
    taskId: input.taskId,
    flowRunId: input.flowRunId,
  });

  // Update manifest on disk
  const manifestPath = path.join(row.path, ".zigma-workspace.json");
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(
        fs.readFileSync(manifestPath, "utf-8")
      ) as WorkspaceManifest;
      manifest.task_id = input.taskId ?? manifest.task_id;
      manifest.flow_run_id = input.flowRunId ?? manifest.flow_run_id;
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
    } catch {
      // Non-fatal: manifest update failed
    }
  }

  const updated = getWorkspaceById(db, input.workspaceId);
  if (!updated) throw new ZigmaError("INTERNAL_ERROR", `Workspace ${input.workspaceId} disappeared after bind`, { workspaceId: input.workspaceId });

  return rowToWorkspace(updated);
}

export function getWorkspace(
  db: Database.Database,
  workspaceId: string
): Workspace {
  const row = getWorkspaceById(db, workspaceId);
  if (!row) throw new ZigmaError("WORKSPACE_NOT_FOUND", `Workspace ${workspaceId} not found`, { workspaceId });
  return rowToWorkspace(row);
}

export function listAllWorkspaces(db: Database.Database): Workspace[] {
  return listWorkspaces(db).map(rowToWorkspace);
}

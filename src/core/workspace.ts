import * as fs from "node:fs";
import * as path from "node:path";
import { v4 as uuidv4 } from "uuid";
import type Database from "better-sqlite3";
import type {
  Workspace,
  CreateWorkspaceInput,
  BindWorkspaceRunInput,
  WorkspaceManifest,
  WorkspaceRetention,
  ZigmaWorkspaceConfig,
  WorkspaceRow,
  RepositoryCacheRow,
} from "../types/index.js";
import { ZigmaError } from "../types/index.js";
import { isWorkspaceState, migrateLegacyStatus, transition } from "./state-machine.js";
import {
  insertWorkspace,
  getWorkspaceById,
  listWorkspaces,
  updateWorkspaceStatus,
  updateWorkspaceBindings,
  insertRepositoryCache,
  getRepositoryCacheByUrl,
  updateRepositoryCacheFetched,
} from "../db/queries.js";
import { emitWorkspaceEvent } from "../core/events.js";
import {
  checkGitAvailable,
  hashRepoUrl,
  cloneMirror,
  fetchMirror,
  resolveRef,
  createWorktree,
  getDefaultBranch,
  configureWorktreeMode,
  addWorktreeExclude,
  GitError,
} from "../git/index.js";
import {
  assertCapacityAvailable,
  assertPathWithin,
  assertWorkspaceBoundary,
  configForWorkspaceDatabase,
  validateManifestPathPolicy,
} from "./isolation-policy.js";

function now(): string {
  return new Date().toISOString();
}

function rowToWorkspace(row: WorkspaceRow): Workspace {
  const status = isWorkspaceState(row.status)
    ? row.status
    : migrateLegacyStatus(row.status);
  return {
    id: row.id,
    projectId: row.project_id ?? undefined,
    taskId: row.task_id ?? undefined,
    flowRunId: row.flow_run_id ?? undefined,
    workflowRunId: row.workflow_run_id ?? undefined,
    jobId: row.job_id ?? undefined,
    stepId: row.step_id ?? undefined,
    agentId: row.agent_id ?? undefined,
    repositoryUrl: row.repository_url,
    baseRef: row.base_ref,
    baseCommit: row.base_commit,
    branch: row.branch,
    path: row.path,
    mode: row.mode as "read-only" | "writable",
    status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    retention: retentionFromRow(row),
  };
}

export function retentionFromRow(row: WorkspaceRow): WorkspaceRetention | undefined {
  if (
    row.retention_success === null
    && row.retention_failure === null
    && row.retention_blocked === null
  ) return undefined;
  return {
    ...(row.retention_success !== null ? { success: row.retention_success as "cleanup" | "retain" } : {}),
    ...(row.retention_failure !== null ? { failure: row.retention_failure as "cleanup" | "retain" } : {}),
    ...(row.retention_blocked !== null ? { blocked: row.retention_blocked as "cleanup" | "retain" } : {}),
  };
}

/**
 * Ensure a repository mirror exists and is up-to-date.
 * Returns the cache record.
 */
export function ensureRepositoryCache(
  db: Database.Database,
  config: ZigmaWorkspaceConfig,
  repoUrl: string
): RepositoryCacheRow {
  let cacheRow = getRepositoryCacheByUrl(db, repoUrl);

  if (!cacheRow) {
    const candidate: RepositoryCacheRow = {
      id: `cache_${uuidv4()}`,
      repository_url: repoUrl,
      mirror_path: path.join(config.repoCacheDir, hashRepoUrl(repoUrl)),
      last_fetched_at: null,
      default_branch: null,
      status: "ready",
    };
    try {
      insertRepositoryCache(db, candidate);
      cacheRow = candidate;
    } catch (err) {
      // repository_url is UNIQUE: a concurrent prepare-run won the insert.
      // Adopt its row; any other failure propagates.
      const winner = getRepositoryCacheByUrl(db, repoUrl);
      if (!winner) throw err;
      cacheRow = winner;
    }
  }

  const mirrorPath = cacheRow.mirror_path;
  assertPathWithin(config.repoCacheDir, mirrorPath, "Repository cache path");

  // Clone if not present. Concurrent prepare-runs share the mirror; git's
  // per-ref locks can transiently fail a fetch, so retry lock contention
  // briefly before surfacing it.
  for (let attempt = 0; ; attempt++) {
    try {
      if (!fs.existsSync(mirrorPath)) {
        cloneMirror(repoUrl, mirrorPath);
      } else {
        // Fetch latest
        fetchMirror(mirrorPath);
      }
      break;
    } catch (err) {
      const lockContention = err instanceof GitError && /lock/i.test(`${err.message} ${err.stderr}`);
      if (!lockContention || attempt >= 4) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 50);
    }
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
  assertPathWithin(config.stateDir, config.repoCacheDir, "Repository cache root");
  assertPathWithin(config.stateDir, config.workspacesDir, "Workspace root");
  assertPathWithin(config.stateDir, config.snapshotsDir, "Snapshot root");
  assertCapacityAvailable(config);

  const { repositoryUrl, baseRef, branch, mode = "writable" } = input;
  const allowedPaths = input.allowedPaths ?? ["."];
  const deniedPaths = [...new Set([...(input.deniedPaths ?? [".env"]), ".zigma-workspace.json"])];
  validateManifestPathPolicy(allowedPaths, deniedPaths);

  const branchKey = process.platform === "win32" ? branch.toLowerCase() : branch;
  const branchOwner = listWorkspaces(db).find((workspace) =>
    workspace.repository_url === repositoryUrl
    && (process.platform === "win32" ? workspace.branch.toLowerCase() : workspace.branch) === branchKey
  );
  if (branchOwner) {
    throw new ZigmaError("WORKSPACE_STATE_CONFLICT", `Branch ${branch} already belongs to workspace ${branchOwner.id}`, {
      workspaceId: branchOwner.id, branch, repositoryUrl,
    });
  }

  // Ensure mirror cache
  const cache = ensureRepositoryCache(db, config, repositoryUrl);

  // Resolve base commit
  const baseCommit = resolveRef(cache.mirror_path, baseRef);

  // Workspace ID and path
  const wsId = `ws_${uuidv4()}`;
  const workspacePath = path.join(config.workspacesDir, wsId);
  assertPathWithin(config.workspacesDir, workspacePath, "Workspace path");

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
    workflow_run_id: input.workflowRunId ?? null,
    job_id: input.jobId ?? null,
    step_id: input.stepId ?? null,
    agent_id: input.agentId ?? null,
    repository_url: repositoryUrl,
    base_ref: baseRef,
    base_commit: baseCommit,
    branch,
    path: workspacePath,
    mode,
    status: "CREATED",
    created_at: ts,
    updated_at: ts,
    retention_success: input.retention?.success ?? null,
    retention_failure: input.retention?.failure ?? null,
    retention_blocked: input.retention?.blocked ?? null,
  };

  insertWorkspace(db, row);

  // Write manifest
  const manifest: WorkspaceManifest = {
    workspace_id: wsId,
    project_id: input.projectId ?? null,
    task_id: input.taskId ?? null,
    flow_run_id: input.flowRunId ?? null,
    workflow_run_id: input.workflowRunId ?? null,
    job_id: input.jobId ?? null,
    step_id: input.stepId ?? null,
    agent_id: input.agentId ?? null,
    repo: repositoryUrl,
    base_ref: baseRef,
    base_commit: baseCommit,
    branch,
    path: workspacePath,
    mode,
    allowed_paths: allowedPaths,
    denied_paths: deniedPaths,
  };

  const manifestPath = path.join(workspacePath, ".zigma-workspace.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

  // The manifest is always denied by path policy, so exclude it from git
  // staging per worktree: commitWorkspace would otherwise reject every
  // change set that includes the untracked manifest.
  addWorktreeExclude(workspacePath, ".zigma-workspace.json");

  // Advance the lifecycle only after the worktree and manifest are ready.
  updateWorkspaceStatus(db, wsId, transition("CREATED", "PREPARING"), now());
  updateWorkspaceStatus(db, wsId, transition("PREPARING", "READY"), now());
  emitWorkspaceEvent(db, wsId, "workspace.created", { branch, base_commit: baseCommit });

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
  assertWorkspaceBoundary(configForWorkspaceDatabase(db, row.path), row);

  const ts = now();
  if (row.status !== "READY" && row.status !== "RUNNING") {
    throw new ZigmaError(
      "INVALID_INPUT",
      `Workspace ${input.workspaceId} cannot be bound from status ${row.status}`,
      { workspaceId: input.workspaceId, status: row.status },
    );
  }

  updateWorkspaceBindings(
    db,
    input.workspaceId,
    input.taskId ?? row.task_id,
    input.flowRunId ?? row.flow_run_id,
    input.workflowRunId ?? row.workflow_run_id,
    input.jobId ?? row.job_id,
    input.stepId ?? row.step_id,
    input.agentId ?? row.agent_id,
    ts
  );

  if (row.status === "READY") {
    updateWorkspaceStatus(db, input.workspaceId, transition("READY", "RUNNING"), ts);
  }

  emitWorkspaceEvent(db, input.workspaceId, "workspace.bound", {
    task_id: input.taskId ?? row.task_id ?? null,
    flow_run_id: input.flowRunId ?? row.flow_run_id ?? null,
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
      manifest.workflow_run_id = input.workflowRunId ?? manifest.workflow_run_id;
      manifest.job_id = input.jobId ?? manifest.job_id;
      manifest.step_id = input.stepId ?? manifest.step_id;
      manifest.agent_id = input.agentId ?? manifest.agent_id;
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

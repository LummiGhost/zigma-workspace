export interface Workspace {
  id: string;
  projectId?: string;
  taskId?: string;
  flowRunId?: string;
  repositoryUrl: string;
  baseRef: string;
  baseCommit: string;
  branch: string;
  path: string;
  mode: "read-only" | "writable";
  status:
    | "created"
    | "prepared"
    | "locked"
    | "active"
    | "archived"
    | "cleaned"
    | "failed";
  createdAt: string;
  updatedAt: string;
}

export interface RepositoryCache {
  id: string;
  repositoryUrl: string;
  mirrorPath: string;
  lastFetchedAt?: string;
  defaultBranch?: string;
  status: "ready" | "fetching" | "failed";
}

export interface WorkspaceLock {
  id: string;
  workspaceId: string;
  mode: "read" | "write";
  owner: string;
  expiresAt?: string;
  acquiredAt: string;
}

export interface WorkspaceDiff {
  workspaceId: string;
  baseCommit: string;
  headCommit?: string;
  changedFiles: string[];
  untrackedFiles: string[];
  statusText: string;
  patchPath?: string;
  patchDigest?: string;
  summary: string;
}

export interface WorkspaceSnapshot {
  id: string;
  workspaceId: string;
  kind: "manifest" | "diff" | "archive" | "metadata-only";
  path?: string;
  checksum?: string;
  createdAt: string;
}

export interface WorkspaceManifest {
  workspace_id: string;
  project_id: string | null;
  task_id: string | null;
  flow_run_id: string | null;
  repo: string;
  base_ref: string;
  base_commit: string;
  branch: string;
  path: string;
  mode: "read-only" | "writable";
  allowed_paths: string[];
  denied_paths: string[];
}

export interface CreateWorkspaceInput {
  repositoryUrl: string;
  baseRef: string;
  branch: string;
  mode?: "read-only" | "writable";
  projectId?: string;
  taskId?: string;
  flowRunId?: string;
}

export interface BindWorkspaceRunInput {
  workspaceId: string;
  taskId?: string;
  flowRunId?: string;
}

export interface ZigmaWorkspaceConfig {
  stateDir: string;
  repoCacheDir: string;
  workspacesDir: string;
  snapshotsDir: string;
  logsDir: string;
  dbPath: string;
}

export interface WorkspaceRow {
  id: string;
  project_id: string | null;
  task_id: string | null;
  flow_run_id: string | null;
  repository_url: string;
  base_ref: string;
  base_commit: string;
  branch: string;
  path: string;
  mode: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface RepositoryCacheRow {
  id: string;
  repository_url: string;
  mirror_path: string;
  last_fetched_at: string | null;
  default_branch: string | null;
  status: string;
}

export interface WorkspaceLockRow {
  id: string;
  workspace_id: string;
  mode: string;
  owner: string;
  expires_at: string | null;
  acquired_at: string;
}

export interface WorkspaceSnapshotRow {
  id: string;
  workspace_id: string;
  kind: string;
  path: string | null;
  checksum: string | null;
  created_at: string;
}

export interface WorkspaceEventRow {
  id: string;
  workspace_id: string;
  event: string;
  data: string | null;
  created_at: string;
}

// ── Contract types ───────────────────────────────────────────────────────────

export const CONTRACT_VERSION = 1 as const;

export type ZigmaErrorCode =
  | "WORKSPACE_NOT_FOUND"
  | "WORKSPACE_LOCK_CONFLICT"
  | "WORKSPACE_DIRECTORY_NOT_FOUND"
  | "GIT_ERROR"
  | "INVALID_INPUT"
  | "OPERATION_ID_CONFLICT"
  | "INTERNAL_ERROR";

export class ZigmaError extends Error {
  readonly code: ZigmaErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ZigmaErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ZigmaError";
    this.code = code;
    this.details = details;
  }
}

export interface JsonOkResponse<T = unknown> {
  contract_version: typeof CONTRACT_VERSION;
  ok: true;
  data: T;
}

export interface JsonErrorResponse {
  contract_version: typeof CONTRACT_VERSION;
  ok: false;
  error: {
    code: ZigmaErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

export type JsonResponse<T = unknown> = JsonOkResponse<T> | JsonErrorResponse;

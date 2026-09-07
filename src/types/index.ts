export interface Workspace {
  id: string;
  projectId?: string;
  taskId?: string;
  flowRunId?: string;
  workflowRunId?: string;
  jobId?: string;
  stepId?: string;
  agentId?: string;
  repositoryUrl: string;
  baseRef: string;
  baseCommit: string;
  branch: string;
  path: string;
  mode: "read-only" | "writable";
  status:
    | "CREATED"
    | "PREPARING"
    | "READY"
    | "RUNNING"
    | "WAIT_REVIEW"
    | "MERGING"
    | "CONFLICT"
    | "MERGED"
    | "CLEANED"
    | "CLEANUP_FAILED"
    | "FAILED"
    | "ARCHIVED";
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
  lastHeartbeat?: string;
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

// ── Artifact ─────────────────────────────────────────────────────────────────

export const ARTIFACT_KINDS = [
  "metadata",
  "patch",
  "log",
  "report",
  "generated-file",
] as const;

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export interface Artifact {
  id: string;
  snapshotId: string;
  kind: ArtifactKind;
  path: string;
  checksum: string;
  mediaType: string;
  createdAt: string;
}

export interface ArtifactRow {
  id: string;
  snapshot_id: string;
  kind: string;
  path: string;
  checksum: string;
  media_type: string;
  created_at: string;
}

// ── WorkspaceSnapshot ───────────────────────────────────────────────────────

export interface WorkspaceSnapshot {
  id: string;
  workspaceId: string;
  kind: "manifest" | "diff" | "archive" | "metadata-only";
  createdAt: string;
}

export interface WorkspaceManifest {
  workspace_id: string;
  project_id: string | null;
  task_id: string | null;
  flow_run_id: string | null;
  workflow_run_id: string | null;
  job_id: string | null;
  step_id: string | null;
  agent_id: string | null;
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
  workflowRunId?: string;
  jobId?: string;
  stepId?: string;
  agentId?: string;
}

export interface BindWorkspaceRunInput {
  workspaceId: string;
  taskId?: string;
  flowRunId?: string;
  workflowRunId?: string;
  jobId?: string;
  stepId?: string;
  agentId?: string;
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
  workflow_run_id: string | null;
  job_id: string | null;
  step_id: string | null;
  agent_id: string | null;
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
  last_heartbeat: string | null;
}

export interface WorkspaceSnapshotRow {
  id: string;
  workspace_id: string;
  kind: string;
  created_at: string;
}

export interface WorkspaceEventRow {
  id: string;
  workspace_id: string;
  event: string;
  data: string | null;
  actor?: string | null;
  created_at: string;
}

// ── Standardized event types ────────────────────────────────────────────────

export const WORKSPACE_EVENT_NAMES = [
  "workspace.created",
  "workspace.bound",
  "workspace.locked",
  "workspace.unlocked",
  "workspace.snapshot.created",
  "workspace.diff.collected",
  "workspace.cleaned",
] as const;

export type WorkspaceEventName = (typeof WORKSPACE_EVENT_NAMES)[number];

export interface WorkspaceCreatedPayload {
  branch: string;
  base_commit: string;
}

export interface WorkspaceBoundPayload {
  task_id: string | null;
  flow_run_id: string | null;
}

export interface WorkspaceLockedPayload {
  mode: "read" | "write";
  owner: string;
}

export interface WorkspaceUnlockedPayload {
  previous_owner: string;
}

export interface WorkspaceSnapshotCreatedPayload {
  snapshot_id: string;
  kind: string;
  patch_path: string | null;
  checksum: string | null;
}

export interface WorkspaceDiffCollectedPayload {
  changed_files: number;
  untracked_files: number;
  patch_path: string | null;
  patch_checksum: string | null;
}

export interface WorkspaceCleanedPayload {
  removed: boolean;
  message: string;
}

export type WorkspaceEventPayload =
  | WorkspaceCreatedPayload
  | WorkspaceBoundPayload
  | WorkspaceLockedPayload
  | WorkspaceUnlockedPayload
  | WorkspaceSnapshotCreatedPayload
  | WorkspaceDiffCollectedPayload
  | WorkspaceCleanedPayload;

export interface WorkspaceEvent {
  id: string;
  workspace_id: string;
  event: WorkspaceEventName;
  data: WorkspaceEventPayload | null;
  actor?: string | null;
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
  | "OPERATION_PENDING"
  | "INTERNAL_ERROR"
  | "WORKSPACE_STATE_CONFLICT"
  | "WORKSPACE_HEAD_CONFLICT"
  | "WORKSPACE_INTEGRATION_CONFLICT"
  | "WORKSPACE_CLEANUP_FAILED"
  | "WORKSPACE_OPERATION_INCOMPLETE"
  | "WORKSPACE_LOCK_OWNER_MISMATCH"
  | "WORKSPACE_LOCK_EXPIRED";

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

// ── Operation journal ────────────────────────────────────────────────────────

export const OPERATION_COMMANDS = [
  "create",
  "commit",
  "integrate",
  "publish",
  "cleanup",
  "abort_integration",
] as const;

export type OperationCommand = (typeof OPERATION_COMMANDS)[number];

export type OperationStatus = "started" | "completed" | "failed";

export interface OperationJournalRow {
  operation_id: string;
  workspace_id: string;
  command: OperationCommand;
  status: OperationStatus;
  input_hash: string;
  result_json: string | null;
  created_at: string;
  updated_at: string;
}

// ── Integration lock ─────────────────────────────────────────────────────────

export interface IntegrationLock {
  id: string;
  workspaceId: string;
  owner: string;
  expiresAt: string | null;
  acquiredAt: string;
  lastHeartbeat: string;
}

export interface IntegrationLockRow {
  id: string;
  workspace_id: string;
  owner: string;
  expires_at: string | null;
  acquired_at: string;
  last_heartbeat: string;
}

// ── Commit ───────────────────────────────────────────────────────────────────

export interface CommitWorkspaceInput {
  operationId: string;
  workspaceId: string;
  message?: string;
  expectedState?: string;
  expectedHead?: string;
}

export interface CommitWorkspaceResult {
  operationId: string;
  workspaceId: string;
  baseCommit: string;
  headCommit: string;
  changedFiles: string[];
  evidenceDigest: string;
  noOp: boolean;
}

// ── Integrate ────────────────────────────────────────────────────────────────

export interface IntegrateWorkspaceInput {
  operationId: string;
  sourceWorkspaceId: string;
  targetWorkspaceId: string;
  expectedHead?: string;
  lockOwner: string;
  lockExpiresAt?: string;
}

export interface IntegrateWorkspaceResult {
  operationId: string;
  sourceWorkspaceId: string;
  targetWorkspaceId: string;
  sourceCommit: string;
  previousTargetHead: string;
  resultingCommit: string;
  merged: boolean;
}

export interface IntegrateConflictResult {
  operationId: string;
  sourceWorkspaceId: string;
  targetWorkspaceId: string;
  sourceCommit: string;
  conflictFiles: string[];
  message: string;
}

// ── Publish ──────────────────────────────────────────────────────────────────

export type PublishStrategy = "branch" | "merge" | "fast-forward";

export interface PublishWorkspaceInput {
  operationId: string;
  workspaceId: string;
  strategy: PublishStrategy;
  targetRef: string;
  expectedHead?: string;
}

export interface PublishWorkspaceResult {
  operationId: string;
  workspaceId: string;
  strategy: PublishStrategy;
  resultingRef: string;
  resultingCommit: string;
  previousRef?: string;
}

// ── Abort ────────────────────────────────────────────────────────────────────

export interface AbortIntegrationInput {
  operationId: string;
  workspaceId: string;
  reason?: string;
}

export interface AbortIntegrationResult {
  operationId: string;
  workspaceId: string;
  aborted: boolean;
  message: string;
}

// ── Reconcile ────────────────────────────────────────────────────────────────

export type ReconciledStatus = "complete" | "incomplete" | "orphaned" | "inconsistent";

export interface ReconciledOperation {
  operationId: string;
  command: OperationCommand;
  status: OperationStatus;
  inputHash: string;
  resultJson: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReconcileWorkspaceInput {
  workspaceId: string;
}

export interface ReconcileWorkspaceResult {
  workspaceId: string;
  registryStatus: string;
  directoryExists: boolean;
  gitHead: string | null;
  manifestExists: boolean;
  operations: ReconciledOperation[];
  reconciledStatus: ReconciledStatus;
  recommendation: string;
}

// ── Cleanup strict ───────────────────────────────────────────────────────────

export interface CleanupWorkspaceStrictInput {
  operationId: string;
  workspaceId: string;
  force?: boolean;
}

export interface CleanupWorkspaceStrictResult {
  operationId: string;
  workspaceId: string;
  path: string;
  removed: boolean;
  status: "CLEANED" | "CLEANUP_FAILED";
  message: string;
  blockers?: string[];
}

/**
 * zigma-workspace public API surface.
 *
 * Import these types and constants when consuming zigma-workspace as an
 * in-process library rather than via the CLI. The CLI and library share the
 * same schemas and error semantics.
 */

export {
  CONTRACT_VERSION,
  ZigmaError,
  ARTIFACT_KINDS,
} from "../types/index.js";

export type {
  ZigmaErrorCode,
  JsonOkResponse,
  JsonErrorResponse,
  JsonResponse,
  Workspace,
  WorkspaceLock,
  WorkspaceDiff,
  WorkspaceSnapshot,
  WorkspaceManifest,
  WorkspaceEventRow,
  WorkspaceEventName,
  WorkspaceEvent,
  WorkspaceEventPayload,
  WorkspaceCreatedPayload,
  WorkspaceBoundPayload,
  WorkspaceLockedPayload,
  WorkspaceUnlockedPayload,
  WorkspaceSnapshotCreatedPayload,
  WorkspaceDiffCollectedPayload,
  WorkspaceCleanedPayload,
  CreateWorkspaceInput,
  BindWorkspaceRunInput,
  ZigmaWorkspaceConfig,
  Artifact,
  ArtifactKind,
  ArtifactRow,
} from "../types/index.js";

export { WORKSPACE_EVENT_NAMES } from "../types/index.js";

export { createWorkspace, bindRun, getWorkspace, listAllWorkspaces } from "../core/workspace.js";
export { lockWorkspace, unlockWorkspace, getLock, heartbeat } from "../core/lock.js";
export { collectDiff } from "../core/diff.js";
export { createSnapshot, listSnapshots } from "../core/snapshot.js";
export { createArtifact, getArtifactsForSnapshot } from "../core/artifact.js";
export { cleanupWorkspace, cleanupWorkspaceStrict, detectOrphanWorktrees } from "../core/cleanup.js";
export { commitWorkspace } from "../core/commit.js";
export { integrateWorkspace, abortIntegration } from "../core/integrate.js";
export { publishWorkspace } from "../core/publish.js";
export { reconcileWorkspace } from "../core/reconcile.js";
export { prepareRun, prepareJob } from "../core/provider.js";
export {
  ABANDON_DAYS,
  sweepExpiredLocks,
  planGarbageCollection,
  garbageCollect,
} from "../core/gc.js";

// Flow-oriented aliases matching the zigma-flow WorkspaceProvider port.
export {
  integrateWorkspace as integrateJob,
} from "../core/integrate.js";
export {
  publishWorkspace as publishRun,
} from "../core/publish.js";
export {
  acquireIntegrationLock,
  releaseIntegrationLock,
  takeoverIntegrationLock,
  heartbeatIntegrationLock,
  getIntegrationLockState,
} from "../core/integration-lock.js";
export { emitWorkspaceEvent } from "../core/events.js";
export { getConfig, ensureStateDirs, loadConfigFile } from "../config/index.js";
export { openDb, closeDb } from "../db/index.js";

// ── v0.2: YAML workspace definition types ──────────────────────────────────

export type {
  WorkspaceDefinition,
  WorkspaceMetadata,
  WorktreeSpec,
  DockerSpec,
  WorkspaceSpec,
  VolumeMount,
  WorkspaceType,
} from "../schema/definition.js";

export {
  validateDefinition,
  validateWorktreeSpec,
  validateDockerSpec,
  validateWorkspaceSpec,
} from "../schema/validator.js";

export type {
  ValidationError,
  ValidationResult,
} from "../schema/validator.js";

// ── v0.2: Ignore matcher ───────────────────────────────────────────────────

export { createIgnoreMatcher, matchesPattern } from "../core/ignore-matcher.js";
export type { IgnoreMatcher } from "../core/ignore-matcher.js";

// ── v0.2: Plugins ──────────────────────────────────────────────────────────

export { loadPlugin, loadPlugins } from "../core/plugin.js";
export type {
  Plugin,
  PluginValidationResult,
  PluginLoadResult,
} from "../core/plugin.js";

// ── v0.2: Adapters ─────────────────────────────────────────────────────────

export {
  createWorktree,
  cleanupWorktree,
  getWorktreeStatus,
} from "../core/adapters/worktree.js";
export type {
  CreateWorktreeInput,
  CreateWorktreeOutput,
} from "../core/adapters/worktree.js";

export {
  createDockerWorkspace,
  cleanupDockerWorkspace,
  getDockerStatus,
} from "../core/adapters/docker.js";
export type {
  CreateDockerInput,
  CreateDockerOutput,
} from "../core/adapters/docker.js";

export {
  createChildWorkspace,
  cleanupChildWorkspace,
  resolveWorkspaceRef,
} from "../core/adapters/workspace.js";
export type {
  CreateChildWorkspaceInput,
  CreateChildWorkspaceOutput,
} from "../core/adapters/workspace.js";

// ── v0.3: Integration, recovery, and strict cleanup ─────────────────────────

export type {
  CommitWorkspaceInput,
  CommitWorkspaceResult,
  IntegrateWorkspaceInput,
  IntegrateWorkspaceResult,
  IntegrateConflictResult,
  PublishWorkspaceInput,
  PublishWorkspaceResult,
  PublishStrategy,
  AbortIntegrationInput,
  AbortIntegrationResult,
  ReconcileWorkspaceInput,
  ReconcileWorkspaceResult,
  ReconciledOperation,
  ReconciledStatus,
  CleanupWorkspaceStrictInput,
  CleanupWorkspaceStrictResult,
  GcCandidateClass,
  GcLockSweepResult,
  GcReconcileSummary,
  GcPlanItem,
  GcOrphanItem,
  GcPlanResult,
  GcApplyItem,
  GcApplyResult,
  GarbageCollectResult,
  IntegrationLock,
  IntegrationLockRow,
  OperationJournalRow,
  OperationCommand,
  OperationStatus,
  ArtifactDescriptor,
  PrepareRunInput,
  RunWorkspaceHandle,
  PrepareJobInput,
  JobWorkspaceHandle,
} from "../types/index.js";

// Flow-oriented aliases matching the zigma-flow WorkspaceProvider port.
export type {
  IntegrateWorkspaceInput as IntegrateJobInput,
  IntegrateWorkspaceResult as IntegrationResult,
  PublishWorkspaceInput as PublishRunInput,
  PublishWorkspaceResult as PublishResult,
} from "../types/index.js";

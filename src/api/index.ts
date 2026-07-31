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
  CreateWorkspaceInput,
  BindWorkspaceRunInput,
  ZigmaWorkspaceConfig,
} from "../types/index.js";

export { createWorkspace, bindRun, getWorkspace, listAllWorkspaces } from "../core/workspace.js";
export { lockWorkspace, unlockWorkspace, getLock } from "../core/lock.js";
export { collectDiff } from "../core/diff.js";
export { createSnapshot, listSnapshots } from "../core/snapshot.js";
export { cleanupWorkspace, detectOrphanWorktrees } from "../core/cleanup.js";
export { getConfig, ensureStateDirs } from "../config/index.js";
export { openDb } from "../db/index.js";

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

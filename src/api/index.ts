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

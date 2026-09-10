import * as crypto from "node:crypto";
import type Database from "better-sqlite3";
import type {
  JobWorkspaceHandle,
  OperationCommand,
  OperationJournalRow,
  PrepareJobInput,
  PrepareRunInput,
  RunWorkspaceHandle,
  WorkspaceRow,
  ZigmaWorkspaceConfig,
} from "../types/index.js";
import { ZigmaError } from "../types/index.js";
import {
  getIdempotencyRecord,
  insertIdempotencyRecord,
  insertOperationJournal,
  getOperationJournal,
  updateOperationJournalStatus,
  updateOperationJournalWorkspace,
  listWorkspaces,
  getWorkspaceById,
} from "../db/queries.js";
import { createWorkspace, bindRun, ensureRepositoryCache } from "./workspace.js";
import { checkGitAvailable, getHeadCommit, isAncestor, resolveRef } from "../git/index.js";

const BRANCH_SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const FULL_SHA = /^[0-9a-f]{40}$/i;

function now(): string {
  return new Date().toISOString();
}

function hashInput(input: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(input), "utf-8").digest("hex");
}

function branchKey(branch: string): string {
  return process.platform === "win32" ? branch.toLowerCase() : branch;
}

function checkIdempotency<T>(
  db: Database.Database,
  operationId: string,
  command: OperationCommand,
  inputHash: string,
): T | undefined {
  const existing = getIdempotencyRecord(db, operationId);
  if (!existing) return undefined;
  if (existing.input_hash !== inputHash) {
    throw new ZigmaError(
      "OPERATION_ID_CONFLICT",
      `Operation ${operationId} already executed with different input`,
      { operationId, command: existing.command },
    );
  }
  return JSON.parse(existing.result_json) as T;
}

function recordCompleted(
  db: Database.Database,
  operationId: string,
  workspaceId: string,
  command: OperationCommand,
  inputHash: string,
  result: unknown,
  ts: string,
): void {
  const resultJson = JSON.stringify(result);
  updateOperationJournalStatus(db, operationId, workspaceId, "completed", resultJson, now());
  insertIdempotencyRecord(db, {
    operation_id: operationId,
    command,
    input_hash: inputHash,
    result_json: resultJson,
    created_at: ts,
  });
}

function startJournal(
  db: Database.Database,
  operationId: string,
  workspaceId: string,
  command: OperationCommand,
  inputHash: string,
  ts: string,
): void {
  // A crash between journal insertion and idempotency recording leaves a
  // 'started' row behind; a retry must reuse it instead of violating the
  // (operation_id, workspace_id) primary key.
  if (getOperationJournal(db, operationId, workspaceId)) return;
  const journalRow: OperationJournalRow = {
    operation_id: operationId,
    workspace_id: workspaceId,
    command,
    status: "started",
    input_hash: inputHash,
    result_json: null,
    created_at: ts,
    updated_at: ts,
  };
  insertOperationJournal(db, journalRow);
}

function failJournal(
  db: Database.Database,
  operationId: string,
  workspaceId: string,
  err: unknown,
): void {
  const errorJson = JSON.stringify({
    error: err instanceof Error ? err.message : String(err),
    code: err instanceof ZigmaError ? err.code : "INTERNAL_ERROR",
  });
  updateOperationJournalStatus(db, operationId, workspaceId, "failed", errorJson, now());
}

function findWorkspaceByBranch(
  db: Database.Database,
  repositoryUrl: string,
  branch: string,
): WorkspaceRow | undefined {
  const key = branchKey(branch);
  return listWorkspaces(db).find(
    (ws) => ws.repository_url === repositoryUrl && branchKey(ws.branch) === key,
  );
}

function rowToRunHandle(row: WorkspaceRow, operationId: string, runId: string): RunWorkspaceHandle {
  return {
    operationId,
    runId,
    workspaceId: row.id,
    path: row.path,
    branch: row.branch,
    baseRef: row.base_ref,
    baseCommit: row.base_commit,
    mode: row.mode as "read-only" | "writable",
    status: row.status as RunWorkspaceHandle["status"],
    createdAt: row.created_at,
  };
}

function rowToJobHandle(
  row: WorkspaceRow,
  operationId: string,
  runId: string,
  runWorkspaceId: string,
  jobId: string,
  attempt: number,
): JobWorkspaceHandle {
  return {
    operationId,
    runId,
    runWorkspaceId,
    jobId,
    attempt,
    workspaceId: row.id,
    path: row.path,
    branch: row.branch,
    baseCommit: row.base_commit,
    mode: row.mode as "read-only" | "writable",
    status: row.status as JobWorkspaceHandle["status"],
    createdAt: row.created_at,
  };
}

/**
 * Prepare (or adopt) the Run workspace for a flow run.
 *
 * The Run workspace uses branch `flow/<runId>` and is the integration
 * baseline for the run. Retrying with the same operationId replays the
 * first result; retrying after a crash adopts the existing workspace when
 * one already owns the branch.
 */
export function prepareRun(
  db: Database.Database,
  config: ZigmaWorkspaceConfig,
  input: PrepareRunInput,
): RunWorkspaceHandle {
  const { operationId, runId, repositoryUrl, baseRef } = input;

  if (!operationId || !runId || !repositoryUrl || !baseRef) {
    throw new ZigmaError("INVALID_INPUT", "prepareRun requires operationId, runId, repositoryUrl, and baseRef", {
      operationId, runId, repositoryUrl, baseRef,
    });
  }
  if (!BRANCH_SAFE_ID.test(runId)) {
    throw new ZigmaError(
      "INVALID_INPUT",
      `runId "${runId}" is not safe for use in a git branch name`,
      { runId },
    );
  }

  const canonicalInput = {
    operationId,
    runId,
    repositoryUrl,
    baseRef,
    mode: input.mode ?? "writable",
    expectedBaseCommit: input.expectedBaseCommit ?? null,
    allowedPaths: input.allowedPaths ?? null,
    deniedPaths: input.deniedPaths ?? null,
  };
  const inputHash = hashInput(canonicalInput);

  const cached = checkIdempotency<RunWorkspaceHandle>(db, operationId, "prepare_run", inputHash);
  if (cached) return cached;

  checkGitAvailable();

  const branch = `flow/${runId}`;
  const existing = findWorkspaceByBranch(db, repositoryUrl, branch);
  if (existing) {
    // Deterministic adoption: the branch is already owned (previous run or
    // crash between worktree creation and journal completion).
    const handle = rowToRunHandle(existing, operationId, runId);
    startJournal(db, operationId, existing.id, "prepare_run", inputHash, now());
    recordCompleted(db, operationId, existing.id, "prepare_run", inputHash, handle, now());
    return handle;
  }

  // Resolve the base before creating anything so a CAS mismatch leaves no
  // partial state behind.
  const cache = ensureRepositoryCache(db, config, repositoryUrl);
  const resolvedBase = resolveRef(cache.mirror_path, baseRef);
  if (input.expectedBaseCommit && resolvedBase !== input.expectedBaseCommit) {
    throw new ZigmaError(
      "WORKSPACE_HEAD_CONFLICT",
      `Expected base commit ${input.expectedBaseCommit}, resolved ${resolvedBase}`,
      { runId, expected: input.expectedBaseCommit, actual: resolvedBase },
    );
  }

  startJournal(db, operationId, "", "prepare_run", inputHash, now());

  try {
    const workspace = createWorkspace(db, config, {
      repositoryUrl,
      baseRef,
      branch,
      mode: input.mode ?? "writable",
      flowRunId: runId,
      allowedPaths: input.allowedPaths,
      deniedPaths: input.deniedPaths,
    });

    bindRun(db, { workspaceId: workspace.id, flowRunId: runId });
    const row = getWorkspaceById(db, workspace.id);
    if (!row) {
      throw new ZigmaError("INTERNAL_ERROR", `Workspace ${workspace.id} disappeared after prepareRun`, { workspaceId: workspace.id });
    }

    updateOperationJournalWorkspace(db, operationId, workspace.id);
    const handle = rowToRunHandle(row, operationId, runId);
    recordCompleted(db, operationId, workspace.id, "prepare_run", inputHash, handle, now());
    return handle;
  } catch (err) {
    // If a workspace was partially created before the failure, point the
    // journal at it so reconcile can see the failed operation.
    try {
      const partial = findWorkspaceByBranch(db, repositoryUrl, branch);
      const targetId = partial?.id ?? "";
      if (partial) updateOperationJournalWorkspace(db, operationId, partial.id);
      failJournal(db, operationId, targetId, err);
    } catch {
      // Journal absent — nothing to record
    }
    throw err;
  }
}

/**
 * Prepare (or adopt) a Job attempt workspace.
 *
 * The attempt workspace uses branch `job/<runId>/<jobId>/a<attempt>` and is
 * created from the exact expected Run HEAD, which must still be in the Run
 * workspace history. Retrying with the same operationId replays the first
 * result; retrying after a crash adopts the existing workspace.
 */
export function prepareJob(
  db: Database.Database,
  config: ZigmaWorkspaceConfig,
  input: PrepareJobInput,
): JobWorkspaceHandle {
  const { operationId, runId, runWorkspaceId, jobId, attempt, expectedRunHead } = input;

  if (!operationId || !runId || !runWorkspaceId || !jobId || !expectedRunHead) {
    throw new ZigmaError(
      "INVALID_INPUT",
      "prepareJob requires operationId, runId, runWorkspaceId, jobId, and expectedRunHead",
      { operationId, runId, runWorkspaceId, jobId, expectedRunHead },
    );
  }
  if (!BRANCH_SAFE_ID.test(runId) || !BRANCH_SAFE_ID.test(jobId)) {
    throw new ZigmaError(
      "INVALID_INPUT",
      `runId "${runId}" or jobId "${jobId}" is not safe for use in a git branch name`,
      { runId, jobId },
    );
  }
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new ZigmaError("INVALID_INPUT", `attempt must be a positive integer, got ${attempt}`, { attempt });
  }
  if (!FULL_SHA.test(expectedRunHead)) {
    throw new ZigmaError(
      "INVALID_INPUT",
      `expectedRunHead must be a full 40-character commit SHA, got "${expectedRunHead}"`,
      { expectedRunHead },
    );
  }

  const canonicalInput = {
    operationId,
    runId,
    runWorkspaceId,
    jobId,
    attempt,
    expectedRunHead,
    allowedPaths: input.allowedPaths ?? null,
    deniedPaths: input.deniedPaths ?? null,
  };
  const inputHash = hashInput(canonicalInput);

  const cached = checkIdempotency<JobWorkspaceHandle>(db, operationId, "prepare_job", inputHash);
  if (cached) return cached;

  checkGitAvailable();

  const runRow = getWorkspaceById(db, runWorkspaceId);
  if (!runRow) {
    throw new ZigmaError("WORKSPACE_NOT_FOUND", `Run workspace ${runWorkspaceId} not found`, { workspaceId: runWorkspaceId });
  }
  if (runRow.flow_run_id !== runId) {
    throw new ZigmaError(
      "INVALID_INPUT",
      `Run workspace ${runWorkspaceId} belongs to flow run "${runRow.flow_run_id}", not "${runId}"`,
      { runWorkspaceId, runId, actualFlowRunId: runRow.flow_run_id },
    );
  }

  const runHead = getHeadCommit(runRow.path);
  if (!runHead) {
    throw new ZigmaError(
      "WORKSPACE_OPERATION_INCOMPLETE",
      `Run workspace ${runWorkspaceId} has no HEAD commit`,
      { workspaceId: runWorkspaceId },
    );
  }
  if (!isAncestor(runRow.path, expectedRunHead, runHead)) {
    throw new ZigmaError(
      "WORKSPACE_HEAD_CONFLICT",
      `Expected Run HEAD ${expectedRunHead} is not in the history of current Run HEAD ${runHead}`,
      { runWorkspaceId, expected: expectedRunHead, actual: runHead },
    );
  }

  // Git forbids a branch and a branch-directory with the same name
  // (refs/heads/flow/<runId> vs refs/heads/flow/<runId>/...), so attempt
  // branches live under the sibling job/ namespace while the Run branch
  // keeps the literal flow/<runId> form.
  const branch = `job/${runId}/${jobId}/a${attempt}`;
  const existing = findWorkspaceByBranch(db, runRow.repository_url, branch);
  if (existing) {
    if (existing.base_commit !== expectedRunHead) {
      throw new ZigmaError(
        "WORKSPACE_HEAD_CONFLICT",
        `Workspace ${existing.id} already owns branch ${branch} but was created from ${existing.base_commit}, expected ${expectedRunHead}`,
        { workspaceId: existing.id, branch, expected: expectedRunHead, actual: existing.base_commit },
      );
    }
    const handle = rowToJobHandle(existing, operationId, runId, runWorkspaceId, jobId, attempt);
    startJournal(db, operationId, existing.id, "prepare_job", inputHash, now());
    recordCompleted(db, operationId, existing.id, "prepare_job", inputHash, handle, now());
    return handle;
  }

  const cache = ensureRepositoryCache(db, config, runRow.repository_url);
  // The exact commit must exist in the shared object database.
  try {
    resolveRef(cache.mirror_path, expectedRunHead);
  } catch {
    throw new ZigmaError(
      "WORKSPACE_HEAD_CONFLICT",
      `Expected Run HEAD ${expectedRunHead} does not exist in the repository`,
      { runWorkspaceId, expected: expectedRunHead },
    );
  }

  startJournal(db, operationId, "", "prepare_job", inputHash, now());

  try {
    const workspace = createWorkspace(db, config, {
      repositoryUrl: runRow.repository_url,
      baseRef: expectedRunHead,
      branch,
      mode: "writable",
      flowRunId: runId,
      jobId,
      allowedPaths: input.allowedPaths,
      deniedPaths: input.deniedPaths,
    });

    bindRun(db, { workspaceId: workspace.id, flowRunId: runId, jobId });
    const row = getWorkspaceById(db, workspace.id);
    if (!row) {
      throw new ZigmaError("INTERNAL_ERROR", `Workspace ${workspace.id} disappeared after prepareJob`, { workspaceId: workspace.id });
    }
    if (row.base_commit !== expectedRunHead) {
      throw new ZigmaError(
        "WORKSPACE_HEAD_CONFLICT",
        `Job workspace was created from ${row.base_commit}, expected ${expectedRunHead}`,
        { workspaceId: workspace.id, expected: expectedRunHead, actual: row.base_commit },
      );
    }

    updateOperationJournalWorkspace(db, operationId, workspace.id);
    const handle = rowToJobHandle(row, operationId, runId, runWorkspaceId, jobId, attempt);
    recordCompleted(db, operationId, workspace.id, "prepare_job", inputHash, handle, now());
    return handle;
  } catch (err) {
    try {
      const partial = findWorkspaceByBranch(db, runRow.repository_url, branch);
      const targetId = partial?.id ?? "";
      if (partial) updateOperationJournalWorkspace(db, operationId, partial.id);
      failJournal(db, operationId, targetId, err);
    } catch {
      // Journal absent — nothing to record
    }
    throw err;
  }
}

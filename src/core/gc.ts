import * as fs from "node:fs";
import type Database from "better-sqlite3";
import type {
  GarbageCollectResult,
  GcApplyItem,
  GcApplyResult,
  GcCandidateClass,
  GcLockSweepResult,
  GcOrphanItem,
  GcPlanItem,
  GcPlanResult,
  WorkspaceRow,
  ZigmaWorkspaceConfig,
} from "../types/index.js";
import { ZigmaError } from "../types/index.js";
import {
  getActiveLockForWorkspace,
  getIntegrationLock,
  getWorkspaceById,
  listExpiredIntegrationLocks,
  listExpiredWorkspaceLocks,
  deleteExpiredIntegrationLocks,
  deleteExpiredWorkspaceLocks,
  listOperationJournalForWorkspace,
  listWorkspaces,
} from "../db/queries.js";
import { reconcileWorkspace } from "./reconcile.js";
import { cleanupWorkspaceStrict, detectOrphanWorktrees } from "./cleanup.js";
import { canonicalizePath, isWorktreeRegistered, removeWorktree } from "../git/index.js";

/**
 * Workspaces whose status is a non-terminal lifecycle state and whose
 * updated_at is older than this many days, with no active lock, are
 * considered abandoned. Deliberately hardcoded: the only configurable
 * retention knob is retainFailedDays.
 */
export const ABANDON_DAYS = 14;

const NEVER_STATUSES = new Set(["ARCHIVED", "CLEANED"]);
const FAILED_STATUSES = new Set(["FAILED", "CONFLICT", "CLEANUP_FAILED"]);
const STALE_STATUSES = new Set([
  "CREATED",
  "PREPARING",
  "READY",
  "RUNNING",
  "WAIT_REVIEW",
  "MERGING",
  "MERGED",
]);

const DAY_MS = 24 * 60 * 60 * 1000;

function ageDays(updatedAt: string, nowIso: string): number {
  const diff = Date.parse(nowIso) - Date.parse(updatedAt);
  return Number.isFinite(diff) ? Math.max(0, Math.floor(diff / DAY_MS)) : 0;
}

/**
 * Delete expired collaboration and integration lock rows across all
 * workspaces. Expired rows are already invisible to the expiry-filtered
 * readers, so this reclaims ownership records without disturbing any active
 * owner (heartbeats keep live leases in the future).
 */
export function sweepExpiredLocks(
  db: Database.Database,
  nowIso: string,
): GcLockSweepResult {
  const workspaceIds = new Set<string>();
  for (const row of listExpiredWorkspaceLocks(db, nowIso)) {
    workspaceIds.add(row.workspace_id);
  }
  for (const row of listExpiredIntegrationLocks(db, nowIso)) {
    workspaceIds.add(row.workspace_id);
  }
  const workspaceLocksDeleted = deleteExpiredWorkspaceLocks(db, nowIso);
  const integrationLocksDeleted = deleteExpiredIntegrationLocks(db, nowIso);
  return {
    workspaceLocksDeleted,
    integrationLocksDeleted,
    workspaceIds: [...workspaceIds],
  };
}

function classifyWorkspace(
  db: Database.Database,
  config: ZigmaWorkspaceConfig,
  row: WorkspaceRow,
  nowIso: string,
): GcPlanItem {
  const age = ageDays(row.updated_at, nowIso);
  let cls: GcCandidateClass;
  let action: "cleanup" | "skip";
  let reason: string;

  if (NEVER_STATUSES.has(row.status)) {
    cls = "never";
    action = "skip";
    reason = `status ${row.status} is never collected`;
  } else {
    const activeLock = getActiveLockForWorkspace(db, row.id);
    const integrationLock = getIntegrationLock(db, row.id);
    if (activeLock) {
      cls = "blocked";
      action = "skip";
      reason = `active lock held by ${activeLock.owner}`;
    } else if (integrationLock) {
      cls = "blocked";
      action = "skip";
      reason = `active integration lock held by ${integrationLock.owner}`;
    } else if (FAILED_STATUSES.has(row.status)) {
      const hasGcAttempt = listOperationJournalForWorkspace(db, row.id).some(
        (j) => j.operation_id.startsWith("gc:"),
      );
      if (hasGcAttempt && row.status === "CLEANUP_FAILED") {
        cls = "failed";
        action = "cleanup";
        reason = "retry of failed gc cleanup";
      } else if (age >= (config.retainFailedDays ?? 0)) {
        cls = "failed";
        action = "cleanup";
        reason = `status ${row.status} older than retain_failed_days (${config.retainFailedDays ?? 0})`;
      } else {
        cls = "retained";
        action = "skip";
        reason = `status ${row.status} retained for ${Math.max(0, (config.retainFailedDays ?? 0) - age)} more day(s)`;
      }
    } else if (STALE_STATUSES.has(row.status)) {
      if (age >= ABANDON_DAYS) {
        cls = "abandoned";
        action = "cleanup";
        reason = `no active lock and older than ${ABANDON_DAYS} days`;
      } else {
        cls = "active";
        action = "skip";
        reason = `within ${ABANDON_DAYS}-day abandon threshold`;
      }
    } else {
      cls = "unclassified";
      action = "skip";
      reason = `status ${row.status} is not covered by the gc policy`;
    }
  }

  const item: GcPlanItem = {
    workspaceId: row.id,
    status: row.status,
    class: cls,
    action,
    reason,
    ageDays: age,
    updatedAt: row.updated_at,
  };

  if (action === "cleanup") {
    const rec = reconcileWorkspace(db, { workspaceId: row.id }, config);
    item.reconcile = {
      reconciledStatus: rec.reconciledStatus,
      directoryExists: rec.directoryExists,
      recommendation: rec.recommendation,
    };
  }
  return item;
}

function evaluateCandidates(
  db: Database.Database,
  config: ZigmaWorkspaceConfig,
  nowIso: string,
): GcPlanItem[] {
  return listWorkspaces(db).map((row) =>
    classifyWorkspace(db, config, row, nowIso),
  );
}

/**
 * Deterministic cleanup operation id for gc. cleanupWorkspaceStrict replays
 * the cached result for a repeated operation id, so a fixed id would replay
 * a CLEANUP_FAILED result forever. Each recorded gc attempt advances the
 * suffix, making the next run a real attempt.
 */
function nextGcCleanupOperationId(
  db: Database.Database,
  workspaceId: string,
): string {
  const base = `gc:${workspaceId}:cleanup`;
  const attempts = listOperationJournalForWorkspace(db, workspaceId).filter(
    (j) => j.operation_id.startsWith("gc:"),
  ).length;
  return attempts === 0 ? base : `${base}:${attempts}`;
}

/**
 * Evaluate retention and produce a read-only collection plan. No lock rows,
 * registry rows, directories, or worktree registrations are touched.
 */
export function planGarbageCollection(
  db: Database.Database,
  config: ZigmaWorkspaceConfig,
): GcPlanResult {
  const nowIso = new Date().toISOString();
  const workspaceIds = new Set<string>();
  const workspaceLockRows = listExpiredWorkspaceLocks(db, nowIso);
  const integrationLockRows = listExpiredIntegrationLocks(db, nowIso);
  for (const row of workspaceLockRows) {
    workspaceIds.add(row.workspace_id);
  }
  for (const row of integrationLockRows) {
    workspaceIds.add(row.workspace_id);
  }
  return {
    applied: false,
    sweptLocks: {
      // Report-only: the counts apply would delete.
      workspaceLocksDeleted: workspaceLockRows.length,
      integrationLocksDeleted: integrationLockRows.length,
      workspaceIds: [...workspaceIds],
    },
    candidates: evaluateCandidates(db, config, nowIso),
    orphanWorktrees: detectOrphanWorktrees(db, config).map((o) => ({
      ...o,
    })),
  };
}

function removeOrphans(
  db: Database.Database,
  config: ZigmaWorkspaceConfig,
): GcOrphanItem[] {
  const items: GcOrphanItem[] = [];
  for (const orphan of detectOrphanWorktrees(db, config)) {
    // Defense in depth: a mirror misclassified as an orphan (e.g. via an
    // unexpanded 8.3 alias or junction) must never be removed. Removing a
    // repository mirror would be catastrophic and unrecoverable.
    if (canonicalizePath(orphan.path) === canonicalizePath(orphan.mirrorPath)) {
      continue;
    }
    const item: GcOrphanItem = { ...orphan };
    const blockers: string[] = [];
    try {
      removeWorktree(orphan.mirrorPath, orphan.path);
    } catch (err) {
      blockers.push(err instanceof Error ? err.message : String(err));
    }
    item.removed =
      !fs.existsSync(orphan.path) &&
      !isWorktreeRegistered(orphan.mirrorPath, orphan.path);
    if (blockers.length > 0) {
      item.blockers = blockers;
    }
    items.push(item);
  }
  return items;
}

/**
 * Execute garbage collection: sweep expired locks, strict-clean eligible
 * workspaces, and reclaim orphan worktrees. Registry rows, operation
 * journal, idempotency records, and events are preserved as audit evidence.
 */
export function garbageCollect(
  db: Database.Database,
  config: ZigmaWorkspaceConfig,
  input: { apply: boolean },
): GarbageCollectResult {
  if (!input.apply) {
    return planGarbageCollection(db, config);
  }

  const nowIso = new Date().toISOString();
  const sweptLocks = sweepExpiredLocks(db, nowIso);

  const results: GcApplyItem[] = [];
  for (const candidate of evaluateCandidates(db, config, nowIso)) {
    if (candidate.action !== "cleanup") continue;

    const freshRow = getWorkspaceById(db, candidate.workspaceId);
    if (!freshRow) {
      results.push({
        workspaceId: candidate.workspaceId,
        action: "skipped",
        reason: "no_longer_eligible",
      });
      continue;
    }
    const fresh = classifyWorkspace(db, config, freshRow, nowIso);
    if (fresh.action !== "cleanup") {
      results.push({
        workspaceId: freshRow.id,
        action: "skipped",
        reason: `no_longer_eligible: ${fresh.reason}`,
      });
      continue;
    }

    const rec = reconcileWorkspace(db, { workspaceId: freshRow.id }, config);
    const operationId = nextGcCleanupOperationId(db, freshRow.id);
    try {
      const cleanupResult = cleanupWorkspaceStrict(db, config, {
        operationId,
        workspaceId: freshRow.id,
        force: false,
      });
      results.push({
        workspaceId: freshRow.id,
        action:
          cleanupResult.status === "CLEANED" ? "cleaned" : "cleanup_failed",
        operationId,
        removed: cleanupResult.removed,
        status: cleanupResult.status,
        blockers: cleanupResult.blockers,
        reconciledStatus: rec.reconciledStatus,
      });
    } catch (err) {
      if (err instanceof ZigmaError && err.code === "WORKSPACE_LOCK_CONFLICT") {
        results.push({
          workspaceId: freshRow.id,
          action: "skipped",
          reason: "lock_conflict",
          reconciledStatus: rec.reconciledStatus,
        });
      } else {
        results.push({
          workspaceId: freshRow.id,
          action: "cleanup_failed",
          operationId,
          reason: err instanceof Error ? err.message : String(err),
          blockers: [err instanceof Error ? err.message : String(err)],
          reconciledStatus: rec.reconciledStatus,
        });
      }
    }
  }

  return {
    applied: true,
    sweptLocks,
    results,
    orphanWorktrees: removeOrphans(db, config),
  };
}

import { v4 as uuidv4 } from "uuid";
import type Database from "better-sqlite3";
import type { WorkspaceLock } from "../types/index.js";
import { ZigmaError } from "../types/index.js";
import {
  getWorkspaceById,
  insertWorkspaceLock,
  getActiveLockForWorkspace,
  getLockById,
  deleteLockForWorkspace,
  renewLock as renewLockQuery,
  reclaimExpiredLocks as reclaimExpiredLocksQuery,
  updateWorkspaceStatus,
} from "../db/queries.js";
import { WorkspaceEventType } from "../types/index.js";
import { emitWorkspaceEvent } from "./events.js";

const DEFAULT_LOCK_TTL_MS = 5 * 60 * 1000; // 5 minutes

function now(): string {
  return new Date().toISOString();
}

export function lockWorkspace(
  db: Database.Database,
  workspaceId: string,
  mode: "read" | "write",
  owner: string,
  expiresAt?: string
): WorkspaceLock {
  const wsRow = getWorkspaceById(db, workspaceId);
  if (!wsRow) {
    throw new ZigmaError("WORKSPACE_NOT_FOUND", `Workspace ${workspaceId} not found`, { workspaceId });
  }

  // Reclaim expired locks before checking for conflicts
  const reclaimed = reclaimExpiredLocksQuery(db, now());
  if (reclaimed > 0) {
    emitWorkspaceEvent(db, workspaceId, WorkspaceEventType.LOCK_RECLAIMED, { reclaimedCount: reclaimed });
  }

  // Check for existing non-expired lock
  const existingLock = getActiveLockForWorkspace(db, workspaceId);
  if (existingLock) {
    throw new ZigmaError(
      "WORKSPACE_LOCK_CONFLICT",
      `Workspace ${workspaceId} is already locked by ${existingLock.owner} (mode: ${existingLock.mode}, acquired: ${existingLock.acquired_at})`,
      { workspaceId, owner: existingLock.owner, mode: existingLock.mode, acquiredAt: existingLock.acquired_at }
    );
  }

  const lockId = `lock_${uuidv4()}`;
  const acquiredAt = now();
  const leaseExpiresAt = expiresAt ?? new Date(Date.now() + DEFAULT_LOCK_TTL_MS).toISOString();

  insertWorkspaceLock(db, {
    id: lockId,
    workspace_id: workspaceId,
    mode,
    owner,
    expires_at: leaseExpiresAt,
    last_heartbeat: acquiredAt,
    acquired_at: acquiredAt,
  });

  updateWorkspaceStatus(db, workspaceId, "locked", acquiredAt);
  emitWorkspaceEvent(db, workspaceId, WorkspaceEventType.LOCK_ACQUIRED, { mode, expiresAt: leaseExpiresAt }, owner);

  return {
    id: lockId,
    workspaceId,
    mode,
    owner,
    expiresAt: leaseExpiresAt,
    lastHeartbeat: acquiredAt,
    acquiredAt,
  };
}

export function unlockWorkspace(
  db: Database.Database,
  workspaceId: string
): void {
  const wsRow = getWorkspaceById(db, workspaceId);
  if (!wsRow) {
    throw new ZigmaError("WORKSPACE_NOT_FOUND", `Workspace ${workspaceId} not found`, { workspaceId });
  }

  const existingLock = getActiveLockForWorkspace(db, workspaceId);
  if (!existingLock) {
    // Already unlocked — not an error, just a no-op with a note
    return;
  }

  deleteLockForWorkspace(db, workspaceId);

  // Restore status to active if it was locked
  if (wsRow.status === "locked") {
    updateWorkspaceStatus(db, workspaceId, "active", now());
  }

  emitWorkspaceEvent(
    db,
    workspaceId,
    WorkspaceEventType.LOCK_RELEASED,
    { previousOwner: existingLock.owner }
  );
}

export function renewLock(
  db: Database.Database,
  lockId: string,
  ttlMs?: number
): WorkspaceLock {
  const ttl = ttlMs ?? DEFAULT_LOCK_TTL_MS;
  const lockRow = getLockById(db, lockId);
  if (!lockRow) {
    throw new ZigmaError("WORKSPACE_NOT_FOUND", `Lock ${lockId} not found`, { lockId });
  }

  const heartbeat = now();
  const newExpiresAt = new Date(Date.now() + ttl).toISOString();

  renewLockQuery(db, lockId, heartbeat, newExpiresAt);

  emitWorkspaceEvent(
    db,
    lockRow.workspace_id,
    WorkspaceEventType.LOCK_RENEWED,
    { expiresAt: newExpiresAt },
    lockRow.owner
  );

  return {
    id: lockRow.id,
    workspaceId: lockRow.workspace_id,
    mode: lockRow.mode as "read" | "write",
    owner: lockRow.owner,
    expiresAt: newExpiresAt,
    lastHeartbeat: heartbeat,
    acquiredAt: lockRow.acquired_at,
  };
}

export function reclaimExpiredLocks(
  db: Database.Database
): number {
  const count = reclaimExpiredLocksQuery(db, now());
  return count;
}

export function getLock(
  db: Database.Database,
  workspaceId: string
): WorkspaceLock | null {
  const row = getActiveLockForWorkspace(db, workspaceId);
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    mode: row.mode as "read" | "write",
    owner: row.owner,
    expiresAt: row.expires_at ?? undefined,
    lastHeartbeat: row.last_heartbeat ?? undefined,
    acquiredAt: row.acquired_at,
  };
}

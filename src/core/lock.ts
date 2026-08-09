import { v4 as uuidv4 } from "uuid";
import type Database from "better-sqlite3";
import type { WorkspaceLock } from "../types/index.js";
import { ZigmaError } from "../types/index.js";
import {
  getWorkspaceById,
  insertWorkspaceLock,
  getActiveLockForWorkspace,
  releaseLockForWorkspace,
  updateWorkspaceStatus,
  insertWorkspaceEvent,
  updateLockHeartbeat,
  deleteExpiredLocksForWorkspace,
} from "../db/queries.js";

function now(): string {
  return new Date().toISOString();
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

function isExpired(expiresAt: string | null): boolean {
  if (expiresAt === null) return false;
  return expiresAt <= now();
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

  const acquire = db.transaction((): WorkspaceLock => {
    const existingLock = getActiveLockForWorkspace(db, workspaceId);
    if (existingLock && !isExpired(existingLock.expires_at)) {
      throw new ZigmaError(
        "WORKSPACE_LOCK_CONFLICT",
        `Workspace ${workspaceId} is already locked by ${existingLock.owner} (mode: ${existingLock.mode}, acquired: ${existingLock.acquired_at})`,
        { workspaceId, owner: existingLock.owner, mode: existingLock.mode, acquiredAt: existingLock.acquired_at }
      );
    }
    const acquiredAt = now();
    deleteExpiredLocksForWorkspace(db, workspaceId, acquiredAt);
    const lockId = `lock_${uuidv4()}`;
    insertWorkspaceLock(db, {
      id: lockId,
      workspace_id: workspaceId,
      mode,
      owner,
      expires_at: expiresAt ?? null,
      acquired_at: acquiredAt,
      last_heartbeat: acquiredAt,
    });
    updateWorkspaceStatus(db, workspaceId, "locked", acquiredAt);
    emitEvent(db, workspaceId, "workspace.locked", { mode, owner });
    return {
      id: lockId,
      workspaceId,
      mode,
      owner,
      expiresAt,
      acquiredAt,
      lastHeartbeat: acquiredAt,
    };
  });
  return acquire.immediate();
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
    return;
  }

  releaseLockForWorkspace(db, workspaceId, now());

  if (wsRow.status === "locked") {
    updateWorkspaceStatus(db, workspaceId, "active", now());
  }

  emitEvent(db, workspaceId, "workspace.unlocked", {
    previousOwner: existingLock.owner,
  });
}

export function heartbeat(
  db: Database.Database,
  workspaceId: string,
  owner: string
): WorkspaceLock {
  const wsRow = getWorkspaceById(db, workspaceId);
  if (!wsRow) {
    throw new ZigmaError("WORKSPACE_NOT_FOUND", `Workspace ${workspaceId} not found`, { workspaceId });
  }

  const activeLock = getActiveLockForWorkspace(db, workspaceId);
  if (!activeLock) {
    throw new ZigmaError(
      "WORKSPACE_LOCK_CONFLICT",
      `No active lock found for workspace ${workspaceId}`,
      { workspaceId }
    );
  }

  if (activeLock.owner !== owner) {
    throw new ZigmaError(
      "WORKSPACE_LOCK_CONFLICT",
      `Lock owner mismatch for workspace ${workspaceId}: expected ${owner}, got ${activeLock.owner}`,
      { workspaceId, expectedOwner: owner, actualOwner: activeLock.owner }
    );
  }

  const heartbeatTime = now();
  if (!updateLockHeartbeat(db, workspaceId, heartbeatTime)) {
    throw new ZigmaError(
      "WORKSPACE_LOCK_CONFLICT",
      `Lock expired before heartbeat for workspace ${workspaceId}`,
      { workspaceId },
    );
  }

  return {
    id: activeLock.id,
    workspaceId: activeLock.workspace_id,
    mode: activeLock.mode as "read" | "write",
    owner: activeLock.owner,
    expiresAt: activeLock.expires_at ?? undefined,
    acquiredAt: activeLock.acquired_at,
    lastHeartbeat: heartbeatTime,
  };
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
    acquiredAt: row.acquired_at,
    lastHeartbeat: row.last_heartbeat ?? undefined,
  };
}

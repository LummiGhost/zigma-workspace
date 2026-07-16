import { v4 as uuidv4 } from "uuid";
import type Database from "better-sqlite3";
import type { WorkspaceLock } from "../types/index.js";
import {
  getWorkspaceById,
  insertWorkspaceLock,
  getActiveLockForWorkspace,
  deleteLockForWorkspace,
  updateWorkspaceStatus,
  insertWorkspaceEvent,
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

export function lockWorkspace(
  db: Database.Database,
  workspaceId: string,
  mode: "read" | "write",
  owner: string,
  expiresAt?: string
): WorkspaceLock {
  const wsRow = getWorkspaceById(db, workspaceId);
  if (!wsRow) {
    throw new Error(`Workspace ${workspaceId} not found`);
  }

  // Check for existing lock
  const existingLock = getActiveLockForWorkspace(db, workspaceId);
  if (existingLock) {
    throw new Error(
      `Workspace ${workspaceId} is already locked by ${existingLock.owner} ` +
        `(mode: ${existingLock.mode}, acquired: ${existingLock.acquired_at})`
    );
  }

  const lockId = `lock_${uuidv4()}`;
  const acquiredAt = now();

  insertWorkspaceLock(db, {
    id: lockId,
    workspace_id: workspaceId,
    mode,
    owner,
    expires_at: expiresAt ?? null,
    acquired_at: acquiredAt,
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
  };
}

export function unlockWorkspace(
  db: Database.Database,
  workspaceId: string
): void {
  const wsRow = getWorkspaceById(db, workspaceId);
  if (!wsRow) {
    throw new Error(`Workspace ${workspaceId} not found`);
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

  emitEvent(db, workspaceId, "workspace.unlocked", {
    previousOwner: existingLock.owner,
  });
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
  };
}

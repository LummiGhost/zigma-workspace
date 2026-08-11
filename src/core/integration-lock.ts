import { v4 as uuidv4 } from "uuid";
import type Database from "better-sqlite3";
import type { IntegrationLock } from "../types/index.js";
import { ZigmaError } from "../types/index.js";
import { getWorkspaceById } from "../db/queries.js";
import {
  getIntegrationLock,
  getIntegrationLockExpired,
  insertIntegrationLock,
  deleteIntegrationLock,
  deleteExpiredIntegrationLock,
  updateIntegrationLockHeartbeat,
} from "../db/queries.js";

function now(): string {
  return new Date().toISOString();
}

function isExpired(expiresAt: string | null): boolean {
  return expiresAt !== null && expiresAt <= now();
}

/**
 * Acquire an exclusive integration lock on a target Run workspace.
 * Atomic compare-and-acquire: if an active lock exists and the caller
 * is not the owner, and the lock is not expired, acquisition fails.
 *
 * If the existing lock is expired, it is taken over.
 * If the existing lock is owned by the same owner, acquisition succeeds
 * (re-entrant — extends the lease).
 */
export function acquireIntegrationLock(
  db: Database.Database,
  workspaceId: string,
  owner: string,
  expiresAt?: string,
): IntegrationLock {
  const wsRow = getWorkspaceById(db, workspaceId);
  if (!wsRow) {
    throw new ZigmaError("WORKSPACE_NOT_FOUND", `Workspace ${workspaceId} not found`, { workspaceId });
  }

  const acquire = db.transaction((): IntegrationLock => {
    const acquiredAt = now();

    // Clean expired locks first
    deleteExpiredIntegrationLock(db, workspaceId, acquiredAt);

    const existing = getIntegrationLock(db, workspaceId);

    if (existing) {
      // Same owner: extend the lease (re-entrant)
      if (existing.owner === owner) {
        const heartbeatTime = now();
        updateIntegrationLockHeartbeat(db, workspaceId, owner, heartbeatTime);
        return {
          id: existing.id,
          workspaceId: existing.workspace_id,
          owner: existing.owner,
          expiresAt: existing.expires_at,
          acquiredAt: existing.acquired_at,
          lastHeartbeat: heartbeatTime,
        };
      }

      // Different owner with active lock: conflict
      throw new ZigmaError(
        "WORKSPACE_LOCK_CONFLICT",
        `Integration lock for workspace ${workspaceId} is held by ${existing.owner}`,
        { workspaceId, currentOwner: existing.owner, acquiredAt: existing.acquired_at },
      );
    }

    // Check for an expired-but-not-cleaned lock for takeover
    const expired = getIntegrationLockExpired(db, workspaceId);
    if (expired && expired.owner !== owner) {
      // Take over the expired lock
      deleteIntegrationLock(db, workspaceId, expired.owner);
    }

    const lockId = `ilock_${uuidv4()}`;
    insertIntegrationLock(db, {
      id: lockId,
      workspace_id: workspaceId,
      owner,
      expires_at: expiresAt ?? null,
      acquired_at: acquiredAt,
      last_heartbeat: acquiredAt,
    });

    return {
      id: lockId,
      workspaceId,
      owner,
      expiresAt: expiresAt ?? null,
      acquiredAt,
      lastHeartbeat: acquiredAt,
    };
  });

  return acquire();
}

/**
 * Release an integration lock. Verifies owner before releasing.
 * Idempotent: releasing an already-released lock is a no-op.
 */
export function releaseIntegrationLock(
  db: Database.Database,
  workspaceId: string,
  owner: string,
): void {
  const wsRow = getWorkspaceById(db, workspaceId);
  if (!wsRow) {
    throw new ZigmaError("WORKSPACE_NOT_FOUND", `Workspace ${workspaceId} not found`, { workspaceId });
  }

  const release = db.transaction(() => {
    const existing = getIntegrationLock(db, workspaceId);

    if (!existing) {
      // Check for expired lock too (in case we need to clean up)
      const expired = getIntegrationLockExpired(db, workspaceId);
      if (expired && expired.owner === owner) {
        deleteIntegrationLock(db, workspaceId, owner);
      }
      return; // Already released — idempotent
    }

    if (existing.owner !== owner) {
      throw new ZigmaError(
        "WORKSPACE_LOCK_OWNER_MISMATCH",
        `Integration lock for workspace ${workspaceId} is held by ${existing.owner}, not ${owner}`,
        { workspaceId, expectedOwner: owner, actualOwner: existing.owner },
      );
    }

    deleteIntegrationLock(db, workspaceId, owner);
  });

  release();
}

/**
 * Take over an expired integration lock regardless of owner.
 * Only succeeds if the lock is actually expired.
 */
export function takeoverIntegrationLock(
  db: Database.Database,
  workspaceId: string,
  newOwner: string,
  expiresAt?: string,
): IntegrationLock {
  const wsRow = getWorkspaceById(db, workspaceId);
  if (!wsRow) {
    throw new ZigmaError("WORKSPACE_NOT_FOUND", `Workspace ${workspaceId} not found`, { workspaceId });
  }

  const takeover = db.transaction((): IntegrationLock => {
    const existing = getIntegrationLock(db, workspaceId);

    if (existing) {
      throw new ZigmaError(
        "WORKSPACE_LOCK_CONFLICT",
        `Cannot take over active integration lock for workspace ${workspaceId} held by ${existing.owner}`,
        { workspaceId, currentOwner: existing.owner },
      );
    }

    // Check for expired lock
    const expired = getIntegrationLockExpired(db, workspaceId);
    if (expired) {
      deleteIntegrationLock(db, workspaceId, expired.owner);
    }

    const acquiredAt = now();
    const lockId = `ilock_${uuidv4()}`;
    insertIntegrationLock(db, {
      id: lockId,
      workspace_id: workspaceId,
      owner: newOwner,
      expires_at: expiresAt ?? null,
      acquired_at: acquiredAt,
      last_heartbeat: acquiredAt,
    });

    return {
      id: lockId,
      workspaceId,
      owner: newOwner,
      expiresAt: expiresAt ?? null,
      acquiredAt,
      lastHeartbeat: acquiredAt,
    };
  });

  return takeover();
}

/**
 * Send a heartbeat to extend the integration lock lease.
 * Verifies owner. Returns updated lock on success.
 */
export function heartbeatIntegrationLock(
  db: Database.Database,
  workspaceId: string,
  owner: string,
): IntegrationLock {
  const wsRow = getWorkspaceById(db, workspaceId);
  if (!wsRow) {
    throw new ZigmaError("WORKSPACE_NOT_FOUND", `Workspace ${workspaceId} not found`, { workspaceId });
  }

  const existing = getIntegrationLock(db, workspaceId);
  if (!existing) {
    // Check for expired lock
    const expired = getIntegrationLockExpired(db, workspaceId);
    if (expired) {
      throw new ZigmaError(
        "WORKSPACE_LOCK_EXPIRED",
        `Integration lock for workspace ${workspaceId} has expired (held by ${expired.owner})`,
        { workspaceId, expiredOwner: expired.owner, expiredAt: expired.expires_at },
      );
    }
    throw new ZigmaError(
      "WORKSPACE_LOCK_CONFLICT",
      `No integration lock found for workspace ${workspaceId}`,
      { workspaceId },
    );
  }

  if (existing.owner !== owner) {
    // Check if the lock is expired (shouldn't be returned by getIntegrationLock)
    if (isExpired(existing.expires_at)) {
      throw new ZigmaError(
        "WORKSPACE_LOCK_EXPIRED",
        `Integration lock for workspace ${workspaceId} has expired`,
        { workspaceId, expiredAt: existing.expires_at },
      );
    }
    throw new ZigmaError(
      "WORKSPACE_LOCK_OWNER_MISMATCH",
      `Integration lock owner mismatch for workspace ${workspaceId}: expected ${owner}, got ${existing.owner}`,
      { workspaceId, expectedOwner: owner, actualOwner: existing.owner },
    );
  }

  const heartbeatTime = now();
  const updated = updateIntegrationLockHeartbeat(db, workspaceId, owner, heartbeatTime);
  if (!updated) {
    throw new ZigmaError(
      "WORKSPACE_LOCK_EXPIRED",
      `Integration lock expired before heartbeat for workspace ${workspaceId}`,
      { workspaceId },
    );
  }

  return {
    id: existing.id,
    workspaceId: existing.workspace_id,
    owner: existing.owner,
    expiresAt: existing.expires_at,
    acquiredAt: existing.acquired_at,
    lastHeartbeat: heartbeatTime,
  };
}

/**
 * Get the current integration lock state, or null if none exists.
 */
export function getIntegrationLockState(
  db: Database.Database,
  workspaceId: string,
): IntegrationLock | null {
  const row = getIntegrationLock(db, workspaceId);
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    owner: row.owner,
    expiresAt: row.expires_at,
    acquiredAt: row.acquired_at,
    lastHeartbeat: row.last_heartbeat,
  };
}

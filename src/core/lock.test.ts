import { describe, it, expect, vi, beforeEach } from "vitest";
import type Database from "better-sqlite3";

vi.mock("../db/queries.js", () => ({
  getWorkspaceById: vi.fn(),
  insertWorkspaceLock: vi.fn(),
  getActiveLockForWorkspace: vi.fn(),
  deleteLockForWorkspace: vi.fn(),
  updateWorkspaceStatus: vi.fn(),
  insertWorkspaceEvent: vi.fn(),
  updateLockHeartbeat: vi.fn(),
}));

import * as queries from "../db/queries.js";
import { lockWorkspace, unlockWorkspace, getLock, heartbeat } from "./lock.js";
import { ZigmaError } from "../types/index.js";

let db: Database.Database;

beforeEach(() => {
  vi.clearAllMocks();
  db = {} as Database.Database;
});

// ── lockWorkspace ───────────────────────────────────────────────────────────

describe("lockWorkspace", () => {
  describe("happy path", () => {
    it("should acquire a write lock when workspace exists and no conflicting lock", () => {
      vi.mocked(queries.getWorkspaceById).mockReturnValue({ id: "ws_1", status: "active" } as any);
      vi.mocked(queries.getActiveLockForWorkspace).mockReturnValue(undefined);

      const result = lockWorkspace(db, "ws_1", "write", "owner-1", "2026-01-01T00:00:00Z");

      expect(result.workspaceId).toBe("ws_1");
      expect(result.mode).toBe("write");
      expect(result.owner).toBe("owner-1");
      expect(result.expiresAt).toBe("2026-01-01T00:00:00Z");
      expect(result.lastHeartbeat).toBeDefined();
      expect(queries.insertWorkspaceLock).toHaveBeenCalledTimes(1);
      const insertedRow = vi.mocked(queries.insertWorkspaceLock).mock.calls[0][1] as any;
      expect(insertedRow.last_heartbeat).toBeDefined();
    });

    it("should acquire a read lock when workspace exists and no conflicting lock", () => {
      vi.mocked(queries.getWorkspaceById).mockReturnValue({ id: "ws_1", status: "active" } as any);
      vi.mocked(queries.getActiveLockForWorkspace).mockReturnValue(undefined);

      const result = lockWorkspace(db, "ws_1", "read", "reader-1");

      expect(result.mode).toBe("read");
      expect(result.owner).toBe("reader-1");
      expect(result.expiresAt).toBeUndefined();
      expect(result.lastHeartbeat).toBeDefined();
    });

    it("should set last_heartbeat to the current time on lock acquisition", () => {
      vi.mocked(queries.getWorkspaceById).mockReturnValue({ id: "ws_1", status: "active" } as any);
      vi.mocked(queries.getActiveLockForWorkspace).mockReturnValue(undefined);

      const before = new Date().toISOString();
      const result = lockWorkspace(db, "ws_1", "write", "owner-1");
      const after = new Date().toISOString();

      expect(result.lastHeartbeat).toBeDefined();
      expect(result.lastHeartbeat! >= before).toBe(true);
      expect(result.lastHeartbeat! <= after).toBe(true);
    });
  });

  describe("lease reclamation", () => {
    it("should reclaim an expired lock and acquire a new one", () => {
      vi.mocked(queries.getWorkspaceById).mockReturnValue({ id: "ws_1", status: "locked" } as any);

      const expiredAt = new Date(Date.now() - 3600000).toISOString(); // 1 hour ago
      vi.mocked(queries.getActiveLockForWorkspace).mockReturnValue({
        id: "lock_old",
        workspace_id: "ws_1",
        mode: "write",
        owner: "stale-owner",
        expires_at: expiredAt,
        acquired_at: new Date(Date.now() - 7200000).toISOString(),
        last_heartbeat: new Date(Date.now() - 7200000).toISOString(),
      });

      const result = lockWorkspace(db, "ws_1", "write", "new-owner", "2026-06-01T00:00:00Z");

      expect(result.owner).toBe("new-owner");
      expect(queries.insertWorkspaceLock).toHaveBeenCalledTimes(1);
    });

    it("should reclaim a lock that has exceeded its expiry even with recent heartbeat", () => {
      vi.mocked(queries.getWorkspaceById).mockReturnValue({ id: "ws_1", status: "locked" } as any);

      const expiredAt = new Date(Date.now() - 60000).toISOString(); // 1 minute ago
      vi.mocked(queries.getActiveLockForWorkspace).mockReturnValue({
        id: "lock_stale",
        workspace_id: "ws_1",
        mode: "write",
        owner: "stale-owner",
        expires_at: expiredAt,
        acquired_at: new Date(Date.now() - 3600000).toISOString(),
        last_heartbeat: new Date(Date.now() - 30000).toISOString(), // heartbeat is recent
      });

      const result = lockWorkspace(db, "ws_1", "write", "new-owner");

      expect(result.owner).toBe("new-owner");
      expect(queries.insertWorkspaceLock).toHaveBeenCalledTimes(1);
    });
  });

  describe("error paths", () => {
    it("should throw WORKSPACE_NOT_FOUND when workspace does not exist", () => {
      vi.mocked(queries.getWorkspaceById).mockReturnValue(undefined);

      expect(() => lockWorkspace(db, "ws_none", "write", "owner-1")).toThrow(ZigmaError);
      expect(() => lockWorkspace(db, "ws_none", "write", "owner-1")).toThrow(
        /Workspace ws_none not found/
      );
      try {
        lockWorkspace(db, "ws_none", "write", "owner-1");
      } catch (e) {
        expect((e as ZigmaError).code).toBe("WORKSPACE_NOT_FOUND");
      }
    });

    it("should throw WORKSPACE_LOCK_CONFLICT when a non-expired lock exists", () => {
      vi.mocked(queries.getWorkspaceById).mockReturnValue({ id: "ws_1", status: "locked" } as any);

      const futureExpiry = new Date(Date.now() + 3600000).toISOString(); // 1 hour from now
      vi.mocked(queries.getActiveLockForWorkspace).mockReturnValue({
        id: "lock_active",
        workspace_id: "ws_1",
        mode: "write",
        owner: "existing-owner",
        expires_at: futureExpiry,
        acquired_at: new Date().toISOString(),
        last_heartbeat: new Date().toISOString(),
      });

      expect(() => lockWorkspace(db, "ws_1", "write", "new-owner")).toThrow(ZigmaError);
      try {
        lockWorkspace(db, "ws_1", "write", "new-owner");
      } catch (e) {
        expect((e as ZigmaError).code).toBe("WORKSPACE_LOCK_CONFLICT");
      }
    });

    it("should throw WORKSPACE_LOCK_CONFLICT when a lock with no expiry exists (never expires)", () => {
      vi.mocked(queries.getWorkspaceById).mockReturnValue({ id: "ws_1", status: "locked" } as any);

      vi.mocked(queries.getActiveLockForWorkspace).mockReturnValue({
        id: "lock_permanent",
        workspace_id: "ws_1",
        mode: "write",
        owner: "permanent-owner",
        expires_at: null,
        acquired_at: new Date().toISOString(),
        last_heartbeat: new Date().toISOString(),
      });

      expect(() => lockWorkspace(db, "ws_1", "write", "new-owner")).toThrow(ZigmaError);
      try {
        lockWorkspace(db, "ws_1", "write", "new-owner");
      } catch (e) {
        expect((e as ZigmaError).code).toBe("WORKSPACE_LOCK_CONFLICT");
      }
    });
  });

  describe("status transitions", () => {
    it("should update workspace status to locked on acquisition", () => {
      vi.mocked(queries.getWorkspaceById).mockReturnValue({ id: "ws_1", status: "active" } as any);
      vi.mocked(queries.getActiveLockForWorkspace).mockReturnValue(undefined);

      lockWorkspace(db, "ws_1", "write", "owner-1");

      expect(queries.updateWorkspaceStatus).toHaveBeenCalledWith(
        db,
        "ws_1",
        "locked",
        expect.any(String)
      );
    });

    it("should emit workspace.locked event on acquisition", () => {
      vi.mocked(queries.getWorkspaceById).mockReturnValue({ id: "ws_1", status: "active" } as any);
      vi.mocked(queries.getActiveLockForWorkspace).mockReturnValue(undefined);

      lockWorkspace(db, "ws_1", "write", "owner-1");

      expect(queries.insertWorkspaceEvent).toHaveBeenCalledWith(
        db,
        expect.objectContaining({ event: "workspace.locked" })
      );
    });
  });
});

// ── unlockWorkspace ─────────────────────────────────────────────────────────

describe("unlockWorkspace", () => {
  describe("happy path", () => {
    it("should release an active lock", () => {
      vi.mocked(queries.getWorkspaceById).mockReturnValue({ id: "ws_1", status: "locked" } as any);
      vi.mocked(queries.getActiveLockForWorkspace).mockReturnValue({
        id: "lock_1",
        workspace_id: "ws_1",
        mode: "write",
        owner: "owner-1",
        expires_at: "2026-01-01T00:00:00Z",
        acquired_at: new Date().toISOString(),
        last_heartbeat: new Date().toISOString(),
      });

      unlockWorkspace(db, "ws_1");

      // With lease-based locking, release should be a soft-delete (not DELETE)
      expect(queries.deleteLockForWorkspace).not.toHaveBeenCalled();
    });

    it("should restore workspace status to active after unlock", () => {
      vi.mocked(queries.getWorkspaceById).mockReturnValue({ id: "ws_1", status: "locked" } as any);
      vi.mocked(queries.getActiveLockForWorkspace).mockReturnValue({
        id: "lock_1",
        workspace_id: "ws_1",
        mode: "write",
        owner: "owner-1",
        expires_at: null,
        acquired_at: new Date().toISOString(),
        last_heartbeat: new Date().toISOString(),
      });

      unlockWorkspace(db, "ws_1");

      expect(queries.updateWorkspaceStatus).toHaveBeenCalledWith(
        db,
        "ws_1",
        "active",
        expect.any(String)
      );
    });

    it("should emit workspace.unlocked event", () => {
      vi.mocked(queries.getWorkspaceById).mockReturnValue({ id: "ws_1", status: "locked" } as any);
      vi.mocked(queries.getActiveLockForWorkspace).mockReturnValue({
        id: "lock_1",
        workspace_id: "ws_1",
        mode: "write",
        owner: "owner-1",
        expires_at: null,
        acquired_at: new Date().toISOString(),
        last_heartbeat: new Date().toISOString(),
      });

      unlockWorkspace(db, "ws_1");

      expect(queries.insertWorkspaceEvent).toHaveBeenCalledWith(
        db,
        expect.objectContaining({ event: "workspace.unlocked" })
      );
    });
  });

  describe("no-op cases", () => {
    it("should be a no-op when no active lock exists", () => {
      vi.mocked(queries.getWorkspaceById).mockReturnValue({ id: "ws_1", status: "active" } as any);
      vi.mocked(queries.getActiveLockForWorkspace).mockReturnValue(undefined);

      expect(() => unlockWorkspace(db, "ws_1")).not.toThrow();
      expect(queries.deleteLockForWorkspace).not.toHaveBeenCalled();
      expect(queries.updateWorkspaceStatus).not.toHaveBeenCalled();
    });

    it("should be a no-op when only an expired lock exists", () => {
      vi.mocked(queries.getWorkspaceById).mockReturnValue({ id: "ws_1", status: "locked" } as any);

      // getActiveLockForWorkspace filters expired locks, so it returns undefined
      vi.mocked(queries.getActiveLockForWorkspace).mockReturnValue(undefined);

      expect(() => unlockWorkspace(db, "ws_1")).not.toThrow();
      expect(queries.deleteLockForWorkspace).not.toHaveBeenCalled();
    });
  });

  describe("error paths", () => {
    it("should throw WORKSPACE_NOT_FOUND when workspace does not exist", () => {
      vi.mocked(queries.getWorkspaceById).mockReturnValue(undefined);

      expect(() => unlockWorkspace(db, "ws_none")).toThrow(ZigmaError);
      try {
        unlockWorkspace(db, "ws_none");
      } catch (e) {
        expect((e as ZigmaError).code).toBe("WORKSPACE_NOT_FOUND");
      }
    });
  });
});

// ── getLock ─────────────────────────────────────────────────────────────────

describe("getLock", () => {
  it("should return the lock when an active non-expired lock exists", () => {
    vi.mocked(queries.getActiveLockForWorkspace).mockReturnValue({
      id: "lock_1",
      workspace_id: "ws_1",
      mode: "write",
      owner: "owner-1",
      expires_at: "2026-06-01T00:00:00Z",
      acquired_at: "2025-01-01T00:00:00Z",
      last_heartbeat: "2025-01-01T00:00:00Z",
    });

    const result = getLock(db, "ws_1");

    expect(result).not.toBeNull();
    expect(result!.workspaceId).toBe("ws_1");
    expect(result!.mode).toBe("write");
  });

  it("should return null when no lock exists for the workspace", () => {
    vi.mocked(queries.getActiveLockForWorkspace).mockReturnValue(undefined);

    const result = getLock(db, "ws_1");

    expect(result).toBeNull();
  });

  it("should return null when the lock exists but is expired", () => {
    // getActiveLockForWorkspace should filter expired locks, so returning
    // undefined here simulates the lease-based filter in action
    vi.mocked(queries.getActiveLockForWorkspace).mockReturnValue(undefined);

    const result = getLock(db, "ws_1");

    expect(result).toBeNull();
  });

  it("should preserve all lock fields including lastHeartbeat in the returned object", () => {
    vi.mocked(queries.getActiveLockForWorkspace).mockReturnValue({
      id: "lock_full",
      workspace_id: "ws_2",
      mode: "read",
      owner: "reader-1",
      expires_at: "2026-12-31T23:59:59Z",
      acquired_at: "2025-06-15T12:00:00Z",
      last_heartbeat: "2025-06-15T12:30:00Z",
    });

    const result = getLock(db, "ws_2");

    expect(result).toEqual({
      id: "lock_full",
      workspaceId: "ws_2",
      mode: "read",
      owner: "reader-1",
      expiresAt: "2026-12-31T23:59:59Z",
      acquiredAt: "2025-06-15T12:00:00Z",
      lastHeartbeat: "2025-06-15T12:30:00Z",
    });
  });
});

// ── heartbeat ───────────────────────────────────────────────────────────────

describe("heartbeat", () => {
  describe("happy path", () => {
    it("should update last_heartbeat for an active lock", () => {
      vi.mocked(queries.getWorkspaceById).mockReturnValue({ id: "ws_1", status: "locked" } as any);
      vi.mocked(queries.getActiveLockForWorkspace).mockReturnValue({
        id: "lock_1",
        workspace_id: "ws_1",
        mode: "write",
        owner: "owner-1",
        expires_at: "2026-06-01T00:00:00Z",
        acquired_at: "2025-01-01T00:00:00Z",
        last_heartbeat: "2025-01-01T00:00:00Z",
      });

      const result = heartbeat(db, "ws_1", "owner-1");

      expect(queries.updateLockHeartbeat).toHaveBeenCalledWith(
        db,
        "ws_1",
        expect.any(String)
      );
      expect(result.lastHeartbeat).toBeDefined();
      expect(result.owner).toBe("owner-1");
    });

    it("should return the updated lock with new lastHeartbeat timestamp", () => {
      vi.mocked(queries.getWorkspaceById).mockReturnValue({ id: "ws_1", status: "locked" } as any);
      vi.mocked(queries.getActiveLockForWorkspace).mockReturnValue({
        id: "lock_1",
        workspace_id: "ws_1",
        mode: "read",
        owner: "reader-1",
        expires_at: null,
        acquired_at: "2025-01-01T00:00:00Z",
        last_heartbeat: "2025-01-01T00:00:00Z",
      });

      const before = new Date().toISOString();
      const result = heartbeat(db, "ws_1", "reader-1");
      const after = new Date().toISOString();

      expect(result.lastHeartbeat).toBeDefined();
      expect(result.lastHeartbeat! >= before).toBe(true);
      expect(result.lastHeartbeat! <= after).toBe(true);
    });

    it("should allow multiple heartbeats to extend the lease", () => {
      vi.mocked(queries.getWorkspaceById).mockReturnValue({ id: "ws_1", status: "locked" } as any);
      vi.mocked(queries.getActiveLockForWorkspace).mockReturnValue({
        id: "lock_1",
        workspace_id: "ws_1",
        mode: "write",
        owner: "owner-1",
        expires_at: "2026-06-01T00:00:00Z",
        acquired_at: "2025-01-01T00:00:00Z",
        last_heartbeat: "2025-06-01T00:00:00Z",
      });

      heartbeat(db, "ws_1", "owner-1");
      const second = heartbeat(db, "ws_1", "owner-1");

      expect(queries.updateLockHeartbeat).toHaveBeenCalledTimes(2);
      expect(second.lastHeartbeat).toBeDefined();
    });
  });

  describe("error paths", () => {
    it("should throw WORKSPACE_NOT_FOUND when workspace does not exist", () => {
      vi.mocked(queries.getWorkspaceById).mockReturnValue(undefined);

      expect(() => heartbeat(db, "ws_none", "owner-1")).toThrow(ZigmaError);
      try {
        heartbeat(db, "ws_none", "owner-1");
      } catch (e) {
        expect((e as ZigmaError).code).toBe("WORKSPACE_NOT_FOUND");
      }
    });

    it("should throw WORKSPACE_LOCK_CONFLICT when no active lock exists", () => {
      vi.mocked(queries.getWorkspaceById).mockReturnValue({ id: "ws_1", status: "active" } as any);
      vi.mocked(queries.getActiveLockForWorkspace).mockReturnValue(undefined);

      expect(() => heartbeat(db, "ws_1", "owner-1")).toThrow(ZigmaError);
      try {
        heartbeat(db, "ws_1", "owner-1");
      } catch (e) {
        expect((e as ZigmaError).code).toBe("WORKSPACE_LOCK_CONFLICT");
      }
    });

    it("should throw WORKSPACE_LOCK_CONFLICT when owner does not match", () => {
      vi.mocked(queries.getWorkspaceById).mockReturnValue({ id: "ws_1", status: "locked" } as any);
      vi.mocked(queries.getActiveLockForWorkspace).mockReturnValue({
        id: "lock_1",
        workspace_id: "ws_1",
        mode: "write",
        owner: "owner-1",
        expires_at: "2026-06-01T00:00:00Z",
        acquired_at: "2025-01-01T00:00:00Z",
        last_heartbeat: "2025-01-01T00:00:00Z",
      });

      expect(() => heartbeat(db, "ws_1", "intruder")).toThrow(ZigmaError);
      try {
        heartbeat(db, "ws_1", "intruder");
      } catch (e) {
        expect((e as ZigmaError).code).toBe("WORKSPACE_LOCK_CONFLICT");
      }
    });

    it("should throw WORKSPACE_LOCK_CONFLICT when lock is expired", () => {
      vi.mocked(queries.getWorkspaceById).mockReturnValue({ id: "ws_1", status: "locked" } as any);

      // getActiveLockForWorkspace filters expired locks → undefined
      vi.mocked(queries.getActiveLockForWorkspace).mockReturnValue(undefined);

      expect(() => heartbeat(db, "ws_1", "owner-1")).toThrow(ZigmaError);
      try {
        heartbeat(db, "ws_1", "owner-1");
      } catch (e) {
        expect((e as ZigmaError).code).toBe("WORKSPACE_LOCK_CONFLICT");
      }
    });
  });
});

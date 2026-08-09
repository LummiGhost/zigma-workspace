import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import {
  insertWorkspaceLock,
  getActiveLockForWorkspace,
  deleteLockForWorkspace,
  updateLockHeartbeat,
} from "./queries.js";
import type { WorkspaceLockRow } from "../types/index.js";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS workspace_locks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  owner TEXT NOT NULL,
  expires_at TEXT,
  acquired_at TEXT NOT NULL,
  last_heartbeat TEXT
);
`;

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
});

afterEach(() => {
  db.close();
});

function makeLockRow(overrides: Partial<WorkspaceLockRow> = {}): WorkspaceLockRow {
  return {
    id: "lock_test",
    workspace_id: "ws_test",
    mode: "write",
    owner: "test-owner",
    expires_at: null,
    acquired_at: "2025-01-01T00:00:00Z",
    last_heartbeat: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

// ── getActiveLockForWorkspace ───────────────────────────────────────────────

describe("getActiveLockForWorkspace", () => {
  it("should return the active lock when it exists and is not expired", () => {
    const now = new Date();
    const futureExpiry = new Date(now.getTime() + 3600000).toISOString(); // +1 hour
    const row = makeLockRow({ expires_at: futureExpiry });
    insertWorkspaceLock(db, row);

    const result = getActiveLockForWorkspace(db, "ws_test");

    expect(result).toBeDefined();
    expect(result!.id).toBe("lock_test");
    expect(result!.owner).toBe("test-owner");
  });

  it("should return undefined when the only lock is expired", () => {
    const now = new Date();
    const pastExpiry = new Date(now.getTime() - 3600000).toISOString(); // -1 hour
    const row = makeLockRow({ expires_at: pastExpiry });
    insertWorkspaceLock(db, row);

    const result = getActiveLockForWorkspace(db, "ws_test");

    expect(result).toBeUndefined();
  });

  it("should return undefined when no lock exists for the workspace", () => {
    const result = getActiveLockForWorkspace(db, "ws_none");

    expect(result).toBeUndefined();
  });

  it("should return the most recent non-expired lock when multiple locks exist", () => {
    const now = new Date();
    const futureExpiry = new Date(now.getTime() + 3600000).toISOString();
    const pastExpiry = new Date(now.getTime() - 3600000).toISOString();

    // Insert an older expired lock
    insertWorkspaceLock(
      db,
      makeLockRow({
        id: "lock_old",
        expires_at: pastExpiry,
        acquired_at: "2025-01-01T00:00:00Z",
      })
    );

    // Insert a newer non-expired lock
    insertWorkspaceLock(
      db,
      makeLockRow({
        id: "lock_new",
        expires_at: futureExpiry,
        acquired_at: "2025-06-01T00:00:00Z",
      })
    );

    const result = getActiveLockForWorkspace(db, "ws_test");

    expect(result).toBeDefined();
    expect(result!.id).toBe("lock_new");
  });

  it("should return a lock with null expires_at as never-expired", () => {
    const row = makeLockRow({ expires_at: null });
    insertWorkspaceLock(db, row);

    const result = getActiveLockForWorkspace(db, "ws_test");

    expect(result).toBeDefined();
    expect(result!.id).toBe("lock_test");
  });
});

// ── updateLockHeartbeat ─────────────────────────────────────────────────────

describe("updateLockHeartbeat", () => {
  it("should update the last_heartbeat for a workspace lock", () => {
    const row = makeLockRow({ last_heartbeat: "2025-01-01T00:00:00Z" });
    insertWorkspaceLock(db, row);

    const newHeartbeat = "2025-06-15T12:00:00Z";
    expect(updateLockHeartbeat(db, "ws_test", newHeartbeat)).toBe(true);

    const result = db
      .prepare("SELECT last_heartbeat FROM workspace_locks WHERE workspace_id = ?")
      .get("ws_test") as { last_heartbeat: string } | undefined;

    expect(result).toBeDefined();
    expect(result!.last_heartbeat).toBe(newHeartbeat);
  });

  it("should report when no active lock was updated", () => {
    expect(updateLockHeartbeat(db, "ws_none", "2025-06-15T12:00:00Z")).toBe(false);
  });
});

// ── insertWorkspaceLock ─────────────────────────────────────────────────────

describe("insertWorkspaceLock", () => {
  it("should persist last_heartbeat when provided", () => {
    const row = makeLockRow({ last_heartbeat: "2025-03-01T12:00:00Z" });
    insertWorkspaceLock(db, row);

    const result = db
      .prepare("SELECT last_heartbeat FROM workspace_locks WHERE id = ?")
      .get("lock_test") as { last_heartbeat: string } | undefined;

    expect(result).toBeDefined();
    expect(result!.last_heartbeat).toBe("2025-03-01T12:00:00Z");
  });

  it("should persist a lock with all required fields", () => {
    const row = makeLockRow();
    insertWorkspaceLock(db, row);

    const result = db
      .prepare("SELECT * FROM workspace_locks WHERE id = ?")
      .get("lock_test") as WorkspaceLockRow | undefined;

    expect(result).toBeDefined();
    expect(result!.id).toBe("lock_test");
    expect(result!.workspace_id).toBe("ws_test");
    expect(result!.mode).toBe("write");
    expect(result!.owner).toBe("test-owner");
  });
});

// ── deleteLockForWorkspace ──────────────────────────────────────────────────

describe("deleteLockForWorkspace", () => {
  it("should delete the lock for a workspace", () => {
    insertWorkspaceLock(db, makeLockRow());
    expect(getActiveLockForWorkspace(db, "ws_test")).toBeDefined();

    deleteLockForWorkspace(db, "ws_test");

    expect(getActiveLockForWorkspace(db, "ws_test")).toBeUndefined();
  });

  it("should not throw when no lock exists for the workspace", () => {
    expect(() => deleteLockForWorkspace(db, "ws_none")).not.toThrow();
  });
});

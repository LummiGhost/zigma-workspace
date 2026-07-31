import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import {
  insertWorkspaceEvent,
  listEventsForWorkspace,
} from "./queries.js";
import type { WorkspaceEventRow } from "../types/index.js";

// ── Test helpers ────────────────────────────────────────────────────────────

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_events (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      event TEXT NOT NULL,
      actor TEXT,
      data TEXT,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

function now(): string {
  return new Date().toISOString();
}

// ── WorkspaceEventRow with actor field ──────────────────────────────────────

describe("WorkspaceEventRow (updated schema)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("should insert an event with an actor field", () => {
    const wsId = `ws_${uuidv4()}`;
    const row: WorkspaceEventRow = {
      id: `evt_${uuidv4()}`,
      workspace_id: wsId,
      event: "workspace.created",
      actor: "agent-42",
      data: JSON.stringify({ branch: "feat/x", base_commit: "abc123" }),
      created_at: now(),
    };

    expect(() => insertWorkspaceEvent(db, row)).not.toThrow();
  });

  it("should insert an event with a null actor (backward compatible)", () => {
    const wsId = `ws_${uuidv4()}`;
    const row: WorkspaceEventRow = {
      id: `evt_${uuidv4()}`,
      workspace_id: wsId,
      event: "workspace.created",
      actor: null,
      data: JSON.stringify({ branch: "feat/x", base_commit: "abc123" }),
      created_at: now(),
    };

    expect(() => insertWorkspaceEvent(db, row)).not.toThrow();
  });

  it("should persist and retrieve the actor field", () => {
    const wsId = `ws_${uuidv4()}`;
    const row: WorkspaceEventRow = {
      id: `evt_${uuidv4()}`,
      workspace_id: wsId,
      event: "workspace.locked",
      actor: "scheduler-v2",
      data: JSON.stringify({ mode: "write", owner: "job-1" }),
      created_at: now(),
    };

    insertWorkspaceEvent(db, row);

    const events = listEventsForWorkspace(db, wsId);
    expect(events).toHaveLength(1);
    expect(events[0].actor).toBe("scheduler-v2");
  });

  it("should persist null actor correctly", () => {
    const wsId = `ws_${uuidv4()}`;
    const row: WorkspaceEventRow = {
      id: `evt_${uuidv4()}`,
      workspace_id: wsId,
      event: "workspace.cleaned",
      actor: null,
      data: null,
      created_at: now(),
    };

    insertWorkspaceEvent(db, row);

    const events = listEventsForWorkspace(db, wsId);
    expect(events).toHaveLength(1);
    expect(events[0].actor).toBeNull();
  });
});

// ── insertWorkspaceEvent function ───────────────────────────────────────────

describe("insertWorkspaceEvent", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("should insert an event row and make it retrievable", () => {
    const wsId = `ws_${uuidv4()}`;
    const ts = now();
    const row: WorkspaceEventRow = {
      id: `evt_${uuidv4()}`,
      workspace_id: wsId,
      event: "workspace.created",
      actor: null,
      data: JSON.stringify({ branch: "main", base_commit: "def456" }),
      created_at: ts,
    };

    insertWorkspaceEvent(db, row);

    const events = listEventsForWorkspace(db, wsId);
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe(row.id);
    expect(events[0].workspace_id).toBe(wsId);
    expect(events[0].event).toBe("workspace.created");
    expect(events[0].actor).toBeNull();
    expect(events[0].data).toBe(row.data);
    expect(events[0].created_at).toBe(ts);
  });

  it("should allow inserting multiple events for the same workspace", () => {
    const wsId = `ws_${uuidv4()}`;

    insertWorkspaceEvent(db, {
      id: `evt_${uuidv4()}`,
      workspace_id: wsId,
      event: "workspace.created",
      actor: null,
      data: null,
      created_at: now(),
    });

    insertWorkspaceEvent(db, {
      id: `evt_${uuidv4()}`,
      workspace_id: wsId,
      event: "workspace.locked",
      actor: "agent-1",
      data: JSON.stringify({ mode: "write", owner: "job-1" }),
      created_at: now(),
    });

    insertWorkspaceEvent(db, {
      id: `evt_${uuidv4()}`,
      workspace_id: wsId,
      event: "workspace.unlocked",
      actor: "agent-1",
      data: JSON.stringify({ previous_owner: "job-1" }),
      created_at: now(),
    });

    const events = listEventsForWorkspace(db, wsId);
    expect(events).toHaveLength(3);
  });
});

// ── listEventsForWorkspace function ─────────────────────────────────────────

describe("listEventsForWorkspace", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("should return an empty array for a workspace with no events", () => {
    const events = listEventsForWorkspace(db, "ws_nonexistent");
    expect(events).toEqual([]);
  });

  it("should return events ordered by created_at ascending", () => {
    const wsId = `ws_${uuidv4()}`;

    // Insert events out of chronological order
    insertWorkspaceEvent(db, {
      id: `evt_3`,
      workspace_id: wsId,
      event: "workspace.cleaned",
      actor: null,
      data: null,
      created_at: "2024-01-03T00:00:00.000Z",
    });

    insertWorkspaceEvent(db, {
      id: `evt_1`,
      workspace_id: wsId,
      event: "workspace.created",
      actor: null,
      data: null,
      created_at: "2024-01-01T00:00:00.000Z",
    });

    insertWorkspaceEvent(db, {
      id: `evt_2`,
      workspace_id: wsId,
      event: "workspace.locked",
      actor: null,
      data: null,
      created_at: "2024-01-02T00:00:00.000Z",
    });

    const events = listEventsForWorkspace(db, wsId);
    expect(events).toHaveLength(3);
    expect(events[0].id).toBe("evt_1");
    expect(events[1].id).toBe("evt_2");
    expect(events[2].id).toBe("evt_3");
  });

  it("should only return events for the specified workspace", () => {
    const wsIdA = `ws_a`;
    const wsIdB = `ws_b`;

    insertWorkspaceEvent(db, {
      id: `evt_a1`,
      workspace_id: wsIdA,
      event: "workspace.created",
      actor: null,
      data: null,
      created_at: now(),
    });

    insertWorkspaceEvent(db, {
      id: `evt_b1`,
      workspace_id: wsIdB,
      event: "workspace.created",
      actor: null,
      data: null,
      created_at: now(),
    });

    const eventsA = listEventsForWorkspace(db, wsIdA);
    expect(eventsA).toHaveLength(1);
    expect(eventsA[0].id).toBe("evt_a1");

    const eventsB = listEventsForWorkspace(db, wsIdB);
    expect(eventsB).toHaveLength(1);
    expect(eventsB[0].id).toBe("evt_b1");
  });

  it("should preserve all existing WorkspaceEventRow fields", () => {
    const wsId = `ws_${uuidv4()}`;
    const row: WorkspaceEventRow = {
      id: `evt_${uuidv4()}`,
      workspace_id: wsId,
      event: "workspace.created",
      actor: "test-runner",
      data: JSON.stringify({ branch: "feat/x", base_commit: "abc" }),
      created_at: now(),
    };

    insertWorkspaceEvent(db, row);

    const [event] = listEventsForWorkspace(db, wsId);

    // All original fields must be present
    expect(event).toHaveProperty("id");
    expect(event).toHaveProperty("workspace_id");
    expect(event).toHaveProperty("event");
    expect(event).toHaveProperty("data");
    expect(event).toHaveProperty("created_at");

    // New actor field must be present
    expect(event).toHaveProperty("actor");

    // No unexpected fields removed — check count
    const keys = Object.keys(event).sort();
    expect(keys).toEqual(
      ["actor", "created_at", "data", "event", "id", "workspace_id"].sort()
    );
  });
});

// ── Data payload: snake_case convention ─────────────────────────────────────

describe("event data JSON payload (snake_case convention)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("workspace.created event data should use snake_case keys", () => {
    const wsId = `ws_${uuidv4()}`;
    const data = { branch: "feat/x", base_commit: "abc123" };

    insertWorkspaceEvent(db, {
      id: `evt_${uuidv4()}`,
      workspace_id: wsId,
      event: "workspace.created",
      actor: null,
      data: JSON.stringify(data),
      created_at: now(),
    });

    const [event] = listEventsForWorkspace(db, wsId);
    const parsed = JSON.parse(event.data!);
    expect(parsed).toHaveProperty("branch");
    expect(parsed).toHaveProperty("base_commit");
    expect(parsed).not.toHaveProperty("baseCommit");
  });

  it("workspace.bound event data should use snake_case keys", () => {
    const wsId = `ws_${uuidv4()}`;
    const data = { task_id: "task-1", flow_run_id: "run-1" };

    insertWorkspaceEvent(db, {
      id: `evt_${uuidv4()}`,
      workspace_id: wsId,
      event: "workspace.bound",
      actor: "scheduler",
      data: JSON.stringify(data),
      created_at: now(),
    });

    const [event] = listEventsForWorkspace(db, wsId);
    const parsed = JSON.parse(event.data!);
    expect(parsed).toHaveProperty("task_id");
    expect(parsed).toHaveProperty("flow_run_id");
    expect(parsed).not.toHaveProperty("taskId");
    expect(parsed).not.toHaveProperty("flowRunId");
  });

  it("workspace.unlocked event data should use snake_case keys", () => {
    const wsId = `ws_${uuidv4()}`;
    const data = { previous_owner: "agent-1" };

    insertWorkspaceEvent(db, {
      id: `evt_${uuidv4()}`,
      workspace_id: wsId,
      event: "workspace.unlocked",
      actor: "agent-1",
      data: JSON.stringify(data),
      created_at: now(),
    });

    const [event] = listEventsForWorkspace(db, wsId);
    const parsed = JSON.parse(event.data!);
    expect(parsed).toHaveProperty("previous_owner");
    expect(parsed).not.toHaveProperty("previousOwner");
  });

  it("workspace.snapshot.created event data should use snake_case keys", () => {
    const wsId = `ws_${uuidv4()}`;
    const data = {
      snapshot_id: "snap_1",
      kind: "diff",
      patch_path: "/tmp/patches/ws.patch",
      checksum: "sha256abc",
    };

    insertWorkspaceEvent(db, {
      id: `evt_${uuidv4()}`,
      workspace_id: wsId,
      event: "workspace.snapshot.created",
      actor: null,
      data: JSON.stringify(data),
      created_at: now(),
    });

    const [event] = listEventsForWorkspace(db, wsId);
    const parsed = JSON.parse(event.data!);
    expect(parsed).toHaveProperty("snapshot_id");
    expect(parsed).toHaveProperty("patch_path");
    expect(parsed).not.toHaveProperty("snapshotId");
    expect(parsed).not.toHaveProperty("patchPath");
  });

  it("workspace.diff.collected event data should use snake_case keys", () => {
    const wsId = `ws_${uuidv4()}`;
    const data = {
      changed_files: 5,
      untracked_files: 2,
      patch_path: "/tmp/patches/ws.patch",
      patch_checksum: "sha256def",
    };

    insertWorkspaceEvent(db, {
      id: `evt_${uuidv4()}`,
      workspace_id: wsId,
      event: "workspace.diff.collected",
      actor: null,
      data: JSON.stringify(data),
      created_at: now(),
    });

    const [event] = listEventsForWorkspace(db, wsId);
    const parsed = JSON.parse(event.data!);
    expect(parsed).toHaveProperty("changed_files");
    expect(parsed).toHaveProperty("untracked_files");
    expect(parsed).toHaveProperty("patch_path");
    expect(parsed).toHaveProperty("patch_checksum");
    expect(parsed).not.toHaveProperty("changedFiles");
    expect(parsed).not.toHaveProperty("untrackedFiles");
    expect(parsed).not.toHaveProperty("patchChecksum");
  });

  it("workspace.locked event data should use snake_case keys", () => {
    const wsId = `ws_${uuidv4()}`;
    const data = { mode: "write", owner: "job-1" };

    insertWorkspaceEvent(db, {
      id: `evt_${uuidv4()}`,
      workspace_id: wsId,
      event: "workspace.locked",
      actor: "scheduler",
      data: JSON.stringify(data),
      created_at: now(),
    });

    const [event] = listEventsForWorkspace(db, wsId);
    const parsed = JSON.parse(event.data!);
    expect(parsed).toHaveProperty("mode");
    expect(parsed).toHaveProperty("owner");
  });

  it("workspace.cleaned event data should use snake_case keys", () => {
    const wsId = `ws_${uuidv4()}`;
    const data = { removed: true, message: "worktree removed" };

    insertWorkspaceEvent(db, {
      id: `evt_${uuidv4()}`,
      workspace_id: wsId,
      event: "workspace.cleaned",
      actor: null,
      data: JSON.stringify(data),
      created_at: now(),
    });

    const [event] = listEventsForWorkspace(db, wsId);
    const parsed = JSON.parse(event.data!);
    expect(parsed).toHaveProperty("removed");
    expect(parsed).toHaveProperty("message");
  });

  it("null data should be preserved as null", () => {
    const wsId = `ws_${uuidv4()}`;

    insertWorkspaceEvent(db, {
      id: `evt_${uuidv4()}`,
      workspace_id: wsId,
      event: "workspace.created",
      actor: null,
      data: null,
      created_at: now(),
    });

    const [event] = listEventsForWorkspace(db, wsId);
    expect(event.data).toBeNull();
  });
});

// ── Centralized emitEvent function ──────────────────────────────────────────

describe("emitEvent (centralized)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("should be importable from src/core/events.js", async () => {
    // This verifies the centralized emitEvent module exists
    const mod = await import("../core/events.js");
    expect(mod).toHaveProperty("emitEvent");
    expect(typeof mod.emitEvent).toBe("function");
  });

  it("should emit an event and make it retrievable via listEventsForWorkspace", async () => {
    const { emitEvent } = await import("../core/events.js");
    const wsId = `ws_${uuidv4()}`;

    emitEvent(db, wsId, "workspace.created", {
      branch: "feat/x",
      base_commit: "abc123",
    });

    const events = listEventsForWorkspace(db, wsId);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("workspace.created");
    expect(events[0].workspace_id).toBe(wsId);
    expect(events[0].id).toMatch(/^evt_/);
  });

  it("should accept an optional actor parameter", async () => {
    const { emitEvent } = await import("../core/events.js");
    const wsId = `ws_${uuidv4()}`;

    emitEvent(db, wsId, "workspace.locked", { mode: "write", owner: "job-1" }, "scheduler-v2");

    const events = listEventsForWorkspace(db, wsId);
    expect(events).toHaveLength(1);
    expect(events[0].actor).toBe("scheduler-v2");
  });

  it("should default actor to null when not provided", async () => {
    const { emitEvent } = await import("../core/events.js");
    const wsId = `ws_${uuidv4()}`;

    emitEvent(db, wsId, "workspace.created", { branch: "main", base_commit: "def" });

    const events = listEventsForWorkspace(db, wsId);
    expect(events).toHaveLength(1);
    expect(events[0].actor).toBeNull();
  });

  it("should serialize data to JSON with snake_case keys", async () => {
    const { emitEvent } = await import("../core/events.js");
    const wsId = `ws_${uuidv4()}`;

    emitEvent(db, wsId, "workspace.bound", {
      task_id: "task-1",
      flow_run_id: "run-1",
    });

    const events = listEventsForWorkspace(db, wsId);
    const parsed = JSON.parse(events[0].data!);
    expect(parsed).toEqual({ task_id: "task-1", flow_run_id: "run-1" });
  });

  it("should generate unique IDs for each event", async () => {
    const { emitEvent } = await import("../core/events.js");
    const wsId = `ws_${uuidv4()}`;

    emitEvent(db, wsId, "workspace.created", { branch: "main", base_commit: "abc" });
    emitEvent(db, wsId, "workspace.locked", { mode: "write", owner: "job-1" });

    const events = listEventsForWorkspace(db, wsId);
    expect(events).toHaveLength(2);
    expect(events[0].id).not.toBe(events[1].id);
  });
});

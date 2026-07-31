import Database from "better-sqlite3";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { emitWorkspaceEvent } from "./events.js";
import { listEventsForWorkspace } from "../db/queries.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspace_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  event TEXT NOT NULL,
  data TEXT,
  actor TEXT,
  created_at TEXT NOT NULL
);
`;

describe("emitWorkspaceEvent", () => {
  let db: Database.Database;
  const workspaceId = "ws_test-001";

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.exec(SCHEMA);
  });

  afterEach(() => {
    db.close();
  });

  it("should insert an event row into the database", () => {
    emitWorkspaceEvent(db, workspaceId, "workspace.created", {
      branch: "feat/x",
      base_commit: "abc123",
    });

    const events = listEventsForWorkspace(db, workspaceId);
    expect(events).toHaveLength(1);
  });

  it("should store the correct workspace_id", () => {
    emitWorkspaceEvent(db, workspaceId, "workspace.created", {
      branch: "feat/x",
      base_commit: "abc123",
    });

    const events = listEventsForWorkspace(db, workspaceId);
    expect(events[0].workspace_id).toBe(workspaceId);
  });

  it("should store the correct event name", () => {
    emitWorkspaceEvent(db, workspaceId, "workspace.locked", {
      mode: "write",
      owner: "ci-runner",
    });

    const events = listEventsForWorkspace(db, workspaceId);
    expect(events[0].event).toBe("workspace.locked");
  });

  it("should serialize data payload as JSON", () => {
    emitWorkspaceEvent(db, workspaceId, "workspace.created", {
      branch: "feat/x",
      base_commit: "def456",
    });

    const events = listEventsForWorkspace(db, workspaceId);
    const parsed = JSON.parse(events[0].data!);
    expect(parsed).toEqual({ branch: "feat/x", base_commit: "def456" });
  });

  it("should store data with snake_case keys matching the DB convention", () => {
    emitWorkspaceEvent(db, workspaceId, "workspace.bound", {
      task_id: "t-1",
      flow_run_id: "fr-1",
    });

    const events = listEventsForWorkspace(db, workspaceId);
    const parsed = JSON.parse(events[0].data!);
    expect(parsed).toHaveProperty("task_id");
    expect(parsed).toHaveProperty("flow_run_id");
    expect(parsed).not.toHaveProperty("taskId");
    expect(parsed).not.toHaveProperty("flowRunId");
  });

  it("should store actor when provided", () => {
    emitWorkspaceEvent(
      db,
      workspaceId,
      "workspace.created",
      { branch: "feat/x", base_commit: "abc" },
      "ci-bot"
    );

    const events = listEventsForWorkspace(db, workspaceId);
    expect(events[0].actor).toBe("ci-bot");
  });

  it("should store null actor when not provided", () => {
    emitWorkspaceEvent(db, workspaceId, "workspace.created", {
      branch: "feat/x",
      base_commit: "abc",
    });

    const events = listEventsForWorkspace(db, workspaceId);
    expect(events[0].actor).toBeNull();
  });

  it("should handle null data payload (events with no associated data)", () => {
    emitWorkspaceEvent(db, workspaceId, "workspace.cleaned");

    const events = listEventsForWorkspace(db, workspaceId);
    expect(events[0].data).toBeNull();
  });

  it("should generate unique IDs for each event", () => {
    emitWorkspaceEvent(db, "ws_a", "workspace.created", {
      branch: "a",
      base_commit: "1",
    });
    emitWorkspaceEvent(db, "ws_b", "workspace.created", {
      branch: "b",
      base_commit: "2",
    });

    const eventsA = listEventsForWorkspace(db, "ws_a");
    const eventsB = listEventsForWorkspace(db, "ws_b");
    expect(eventsA[0].id).not.toBe(eventsB[0].id);
  });

  it("should generate IDs with evt_ prefix", () => {
    emitWorkspaceEvent(db, workspaceId, "workspace.created", {
      branch: "x",
      base_commit: "1",
    });

    const events = listEventsForWorkspace(db, workspaceId);
    expect(events[0].id).toMatch(/^evt_/);
  });

  it("should set created_at to an ISO 8601 timestamp", () => {
    const before = new Date().toISOString();
    emitWorkspaceEvent(db, workspaceId, "workspace.created", {
      branch: "x",
      base_commit: "1",
    });
    const after = new Date().toISOString();

    const events = listEventsForWorkspace(db, workspaceId);
    expect(events[0].created_at).toBeTruthy();
    expect(events[0].created_at >= before).toBe(true);
    expect(events[0].created_at <= after).toBe(true);
  });

  it("should list events ordered by created_at ascending", () => {
    emitWorkspaceEvent(db, workspaceId, "workspace.created", {
      branch: "first",
      base_commit: "1",
    });
    emitWorkspaceEvent(db, workspaceId, "workspace.locked", {
      mode: "write",
      owner: "test",
    });

    const events = listEventsForWorkspace(db, workspaceId);
    expect(events).toHaveLength(2);
    expect(events[0].event).toBe("workspace.created");
    expect(events[1].event).toBe("workspace.locked");
  });

  it("should scope events to the correct workspace", () => {
    emitWorkspaceEvent(db, workspaceId, "workspace.created", {
      branch: "x",
      base_commit: "1",
    });

    const otherEvents = listEventsForWorkspace(db, "ws_other");
    expect(otherEvents).toHaveLength(0);
  });

  const eventCases: Array<{
    name: "workspace.created" | "workspace.bound" | "workspace.locked" | "workspace.unlocked" | "workspace.snapshot.created" | "workspace.diff.collected" | "workspace.cleaned";
    data: Record<string, unknown>;
  }> = [
    { name: "workspace.created", data: { branch: "feat/x", base_commit: "abc" } },
    { name: "workspace.bound", data: { task_id: "t-1", flow_run_id: "fr-1" } },
    { name: "workspace.locked", data: { mode: "write", owner: "ci" } },
    { name: "workspace.unlocked", data: { previous_owner: "ci" } },
    { name: "workspace.snapshot.created", data: { snapshot_id: "snap_1", kind: "diff", patch_path: null, checksum: null } },
    { name: "workspace.diff.collected", data: { changed_files: 3, untracked_files: 1, patch_path: null, patch_checksum: null } },
    { name: "workspace.cleaned", data: { removed: true, message: "done" } },
  ];

  for (const { name, data } of eventCases) {
    it(`should accept and store event type "${name}"`, () => {
      emitWorkspaceEvent(db, workspaceId, name, data as never);

      const events = listEventsForWorkspace(db, workspaceId);
      expect(events).toHaveLength(1);
      expect(events[0].event).toBe(name);
      const parsed = JSON.parse(events[0].data!);
      expect(parsed).toEqual(data);
    });
  }
});

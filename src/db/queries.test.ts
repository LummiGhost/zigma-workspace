import Database from "better-sqlite3";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { insertWorkspaceEvent, listEventsForWorkspace } from "../db/queries.js";
import type { WorkspaceEventRow } from "../types/index.js";

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

describe("insertWorkspaceEvent", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.exec(SCHEMA);
  });

  afterEach(() => {
    db.close();
  });

  it("should store actor field when provided", () => {
    const row: WorkspaceEventRow = {
      id: "evt_test-1",
      workspace_id: "ws_test-1",
      event: "workspace.created",
      data: JSON.stringify({ branch: "feat/x", base_commit: "abc" }),
      actor: "ci-bot",
      created_at: new Date().toISOString(),
    };

    insertWorkspaceEvent(db, row);

    const events = listEventsForWorkspace(db, "ws_test-1");
    expect(events).toHaveLength(1);
    expect(events[0].actor).toBe("ci-bot");
  });

  it("should store null actor when not provided", () => {
    const row: WorkspaceEventRow = {
      id: "evt_test-2",
      workspace_id: "ws_test-2",
      event: "workspace.cleaned",
      data: null,
      actor: null,
      created_at: new Date().toISOString(),
    };

    insertWorkspaceEvent(db, row);

    const events = listEventsForWorkspace(db, "ws_test-2");
    expect(events).toHaveLength(1);
    expect(events[0].actor).toBeNull();
  });

  it("should return events in ascending created_at order", () => {
    const base: Omit<WorkspaceEventRow, "id" | "created_at"> = {
      workspace_id: "ws_test-3",
      event: "workspace.created",
      data: null,
      actor: null,
    };

    insertWorkspaceEvent(db, {
      ...base,
      id: "evt_first",
      created_at: "2024-01-01T00:00:00.000Z",
    });
    insertWorkspaceEvent(db, {
      ...base,
      id: "evt_second",
      created_at: "2024-01-01T01:00:00.000Z",
    });
    insertWorkspaceEvent(db, {
      ...base,
      id: "evt_third",
      created_at: "2024-01-01T02:00:00.000Z",
    });

    const events = listEventsForWorkspace(db, "ws_test-3");
    expect(events).toHaveLength(3);
    expect(events[0].id).toBe("evt_first");
    expect(events[1].id).toBe("evt_second");
    expect(events[2].id).toBe("evt_third");
  });

  it("should persist and retrieve complex data payloads", () => {
    const data = JSON.stringify({
      changed_files: 5,
      untracked_files: 2,
      patch_path: "/tmp/patch.diff",
      patch_checksum: "sha256:abc123",
    });

    const row: WorkspaceEventRow = {
      id: "evt_test-4",
      workspace_id: "ws_test-4",
      event: "workspace.diff.collected",
      data,
      actor: "diff-runner",
      created_at: new Date().toISOString(),
    };

    insertWorkspaceEvent(db, row);

    const events = listEventsForWorkspace(db, "ws_test-4");
    expect(events).toHaveLength(1);
    const parsed = JSON.parse(events[0].data!);
    expect(parsed.changed_files).toBe(5);
    expect(parsed.patch_checksum).toBe("sha256:abc123");
  });
});

import { describe, it, expect } from "vitest";
import {
  WORKSPACE_EVENT_NAMES,
  type WorkspaceEventName,
  type WorkspaceEvent,
  type WorkspaceEventRow,
  type WorkspaceCreatedPayload,
  type WorkspaceBoundPayload,
  type WorkspaceLockedPayload,
  type WorkspaceUnlockedPayload,
  type WorkspaceCleanedPayload,
  type WorkspaceSnapshotCreatedPayload,
  type WorkspaceDiffCollectedPayload,
  type WorkspaceEventPayload,
} from "./index.js";

// ── Event name constants ────────────────────────────────────────────────────

describe("WORKSPACE_EVENT_NAMES", () => {
  it("should contain exactly 7 event names", () => {
    expect(WORKSPACE_EVENT_NAMES).toHaveLength(7);
  });

  it("should include workspace.created", () => {
    expect(WORKSPACE_EVENT_NAMES).toContain("workspace.created");
  });

  it("should include workspace.bound", () => {
    expect(WORKSPACE_EVENT_NAMES).toContain("workspace.bound");
  });

  it("should include workspace.locked", () => {
    expect(WORKSPACE_EVENT_NAMES).toContain("workspace.locked");
  });

  it("should include workspace.unlocked", () => {
    expect(WORKSPACE_EVENT_NAMES).toContain("workspace.unlocked");
  });

  it("should include workspace.cleaned", () => {
    expect(WORKSPACE_EVENT_NAMES).toContain("workspace.cleaned");
  });

  it("should include workspace.snapshot.created", () => {
    expect(WORKSPACE_EVENT_NAMES).toContain("workspace.snapshot.created");
  });

  it("should include workspace.diff.collected", () => {
    expect(WORKSPACE_EVENT_NAMES).toContain("workspace.diff.collected");
  });

  it("should have no duplicate event names", () => {
    const unique = new Set(WORKSPACE_EVENT_NAMES);
    expect(unique.size).toBe(WORKSPACE_EVENT_NAMES.length);
  });

  it("should be a readonly const array", () => {
    expect(Array.isArray(WORKSPACE_EVENT_NAMES)).toBe(true);
    // All entries should be strings starting with "workspace."
    for (const name of WORKSPACE_EVENT_NAMES) {
      expect(typeof name).toBe("string");
      expect(name.startsWith("workspace.")).toBe(true);
    }
  });
});

// ── WorkspaceEventRow (with actor field) ────────────────────────────────────

describe("WorkspaceEventRow", () => {
  it("should include all original fields: id, workspace_id, event, data, created_at", () => {
    const row: WorkspaceEventRow = {
      id: "evt_1",
      workspace_id: "ws_1",
      event: "workspace.created",
      data: null,
      actor: null,
      created_at: "2024-01-01T00:00:00.000Z",
    };
    expect(row.id).toBe("evt_1");
    expect(row.workspace_id).toBe("ws_1");
    expect(row.event).toBe("workspace.created");
    expect(row.data).toBeNull();
    expect(row.created_at).toBe("2024-01-01T00:00:00.000Z");
  });

  it("should include the new actor field", () => {
    const row: WorkspaceEventRow = {
      id: "evt_1",
      workspace_id: "ws_1",
      event: "workspace.created",
      data: null,
      actor: "scheduler-v2",
      created_at: "2024-01-01T00:00:00.000Z",
    };
    expect(row.actor).toBe("scheduler-v2");
  });

  it("should allow actor to be null", () => {
    const row: WorkspaceEventRow = {
      id: "evt_1",
      workspace_id: "ws_1",
      event: "workspace.created",
      data: null,
      actor: null,
      created_at: "2024-01-01T00:00:00.000Z",
    };
    expect(row.actor).toBeNull();
  });

  it("should have exactly 6 fields (no fields removed)", () => {
    const keys = Object.keys({
      id: "",
      workspace_id: "",
      event: "",
      data: null,
      actor: null,
      created_at: "",
    } satisfies WorkspaceEventRow).sort();
    expect(keys).toEqual(
      ["actor", "created_at", "data", "event", "id", "workspace_id"].sort()
    );
  });
});

// ── WorkspaceEvent interface ────────────────────────────────────────────────

describe("WorkspaceEvent", () => {
  it("should have id, workspace_id, event, data, actor, created_at fields", () => {
    const ev: WorkspaceEvent = {
      id: "evt_1",
      workspace_id: "ws_1",
      event: "workspace.created",
      data: { branch: "feat/x", base_commit: "abc123" },
      actor: "agent-1",
      created_at: "2024-01-01T00:00:00.000Z",
    };
    expect(ev.id).toBe("evt_1");
    expect(ev.workspace_id).toBe("ws_1");
    expect(ev.event).toBe("workspace.created");
    expect(ev.actor).toBe("agent-1");
    expect(ev.data).toEqual({ branch: "feat/x", base_commit: "abc123" });
    expect(ev.created_at).toBe("2024-01-01T00:00:00.000Z");
  });

  it("should allow actor to be null", () => {
    const ev: WorkspaceEvent = {
      id: "evt_1",
      workspace_id: "ws_1",
      event: "workspace.cleaned",
      data: null,
      actor: null,
      created_at: "2024-01-01T00:00:00.000Z",
    };
    expect(ev.actor).toBeNull();
    expect(ev.data).toBeNull();
  });

  it("should allow data to be null", () => {
    const ev: WorkspaceEvent = {
      id: "evt_1",
      workspace_id: "ws_1",
      event: "workspace.created",
      data: null,
      actor: null,
      created_at: "2024-01-01T00:00:00.000Z",
    };
    expect(ev.data).toBeNull();
  });
});

// ── Per-event payload: snake_case key convention ────────────────────────────

describe("payload types use snake_case keys", () => {
  it("WorkspaceCreatedPayload should use base_commit (not baseCommit)", () => {
    const p: WorkspaceCreatedPayload = { branch: "feat/x", base_commit: "abc" };
    expect(Object.keys(p)).toEqual(["branch", "base_commit"]);
    expect("baseCommit" in p).toBe(false);
  });

  it("WorkspaceBoundPayload should use task_id and flow_run_id (not camelCase)", () => {
    const p: WorkspaceBoundPayload = { task_id: "t1", flow_run_id: "r1" };
    expect(Object.keys(p).sort()).toEqual(["flow_run_id", "task_id"].sort());
    expect("taskId" in p).toBe(false);
    expect("flowRunId" in p).toBe(false);
  });

  it("WorkspaceBoundPayload should allow null values", () => {
    const p: WorkspaceBoundPayload = { task_id: null, flow_run_id: null };
    expect(p.task_id).toBeNull();
    expect(p.flow_run_id).toBeNull();
  });

  it("WorkspaceLockedPayload should use mode and owner", () => {
    const p: WorkspaceLockedPayload = { mode: "write", owner: "agent-1" };
    expect(Object.keys(p).sort()).toEqual(["mode", "owner"].sort());
  });

  it("WorkspaceUnlockedPayload should use previous_owner (not previousOwner)", () => {
    const p: WorkspaceUnlockedPayload = { previous_owner: "agent-1" };
    expect(Object.keys(p)).toEqual(["previous_owner"]);
    expect("previousOwner" in p).toBe(false);
  });

  it("WorkspaceCleanedPayload should use removed and message", () => {
    const p: WorkspaceCleanedPayload = { removed: true, message: "cleaned" };
    expect(Object.keys(p).sort()).toEqual(["message", "removed"].sort());
  });

  it("WorkspaceSnapshotCreatedPayload should use snake_case keys", () => {
    const p: WorkspaceSnapshotCreatedPayload = {
      snapshot_id: "snap_1",
      kind: "diff",
      patch_path: "/tmp/p.patch",
      checksum: "abc",
    };
    expect(Object.keys(p).sort()).toEqual(
      ["checksum", "kind", "patch_path", "snapshot_id"].sort()
    );
    expect("snapshotId" in p).toBe(false);
    expect("patchPath" in p).toBe(false);
  });

  it("WorkspaceSnapshotCreatedPayload should allow null patch_path and checksum", () => {
    const p: WorkspaceSnapshotCreatedPayload = {
      snapshot_id: "snap_2",
      kind: "metadata-only",
      patch_path: null,
      checksum: null,
    };
    expect(p.patch_path).toBeNull();
    expect(p.checksum).toBeNull();
  });

  it("WorkspaceDiffCollectedPayload should use snake_case keys", () => {
    const p: WorkspaceDiffCollectedPayload = {
      changed_files: 5,
      untracked_files: 2,
      patch_path: "/tmp/p.patch",
      patch_checksum: "abc",
    };
    expect(Object.keys(p).sort()).toEqual(
      ["changed_files", "patch_checksum", "patch_path", "untracked_files"].sort()
    );
    expect("changedFiles" in p).toBe(false);
    expect("untrackedFiles" in p).toBe(false);
    expect("patchChecksum" in p).toBe(false);
  });

  it("WorkspaceDiffCollectedPayload should allow null patch_path and patch_checksum", () => {
    const p: WorkspaceDiffCollectedPayload = {
      changed_files: 0,
      untracked_files: 0,
      patch_path: null,
      patch_checksum: null,
    };
    expect(p.patch_path).toBeNull();
    expect(p.patch_checksum).toBeNull();
  });

  it("all payload types should be assignable to WorkspaceEventPayload", () => {
    const created: WorkspaceEventPayload = { branch: "main", base_commit: "abc" };
    const bound: WorkspaceEventPayload = { task_id: "t1", flow_run_id: null };
    const locked: WorkspaceEventPayload = { mode: "read", owner: "u1" };
    const unlocked: WorkspaceEventPayload = { previous_owner: "u1" };
    const cleaned: WorkspaceEventPayload = { removed: false, message: "ok" };
    const snap: WorkspaceEventPayload = {
      snapshot_id: "s1",
      kind: "diff",
      patch_path: null,
      checksum: null,
    };
    const diff: WorkspaceEventPayload = {
      changed_files: 1,
      untracked_files: 0,
      patch_path: null,
      patch_checksum: null,
    };

    // All should compile and have the discriminant tellable by keys
    expect("branch" in created).toBe(true);
    expect("task_id" in bound).toBe(true);
    expect("mode" in locked).toBe(true);
    expect("previous_owner" in unlocked).toBe(true);
    expect("removed" in cleaned).toBe(true);
    expect("snapshot_id" in snap).toBe(true);
    expect("changed_files" in diff).toBe(true);
  });
});

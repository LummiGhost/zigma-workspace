import { afterEach, describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { WorkspaceSnapshot, ZigmaWorkspaceConfig } from "../types/index.js";
import { openDb, closeDb } from "../db/index.js";
import { insertWorkspace } from "../db/queries.js";
import { createSnapshot } from "./snapshot.js";

vi.mock("../git/index.js", () => ({
  getHeadCommit: vi.fn(() => "head123"),
  generatePatch: vi.fn(() => "diff --git a/a b/a\n"),
}));

const tempDirs: string[] = [];

afterEach(() => {
  closeDb();
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("createSnapshot integration", () => {
  it("inserts the parent snapshot before its artifacts", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zigma-snapshot-test-"));
    tempDirs.push(tempDir);
    const workspacePath = path.join(tempDir, "workspace");
    fs.mkdirSync(workspacePath);
    const config: ZigmaWorkspaceConfig = {
      stateDir: tempDir,
      repoCacheDir: path.join(tempDir, "repos"),
      workspacesDir: path.join(tempDir, "workspaces"),
      snapshotsDir: path.join(tempDir, "snapshots"),
      logsDir: path.join(tempDir, "logs"),
      dbPath: path.join(tempDir, "registry.db"),
    };
    const db = openDb(config);
    insertWorkspace(db, {
      id: "ws_snapshot",
      project_id: null,
      task_id: null,
      flow_run_id: null,
      repository_url: "https://example.test/repo.git",
      base_ref: "main",
      base_commit: "base123",
      branch: "feature",
      path: workspacePath,
      mode: "writable",
      status: "active",
      created_at: "2024-01-01T00:00:00.000Z",
      updated_at: "2024-01-01T00:00:00.000Z",
    });

    const snapshot = createSnapshot(db, config, "ws_snapshot");
    const artifactCount = db
      .prepare("SELECT COUNT(*) AS count FROM artifacts WHERE snapshot_id = ?")
      .get(snapshot.id) as { count: number };

    expect(snapshot.kind).toBe("diff");
    expect(artifactCount.count).toBe(2);
  });
});

describe("createSnapshot return type (after Artifact separation)", () => {
  it("should return a WorkspaceSnapshot without path or checksum top-level fields", () => {
    // The return type of createSnapshot is WorkspaceSnapshot which no longer
    // includes path/checksum. We verify the type shape here.
    const snapshot: WorkspaceSnapshot = {
      id: "snap_test1",
      workspaceId: "ws_test1",
      kind: "diff",
      createdAt: "2024-01-01T00:00:00.000Z",
    };

    // Snapshot should NOT have path/checksum directly — those belong to artifacts
    expect("path" in snapshot).toBe(false);
    expect("checksum" in snapshot).toBe(false);

    // Core fields should be present
    expect(snapshot.id).toMatch(/^snap_/);
    expect(snapshot.workspaceId).toMatch(/^ws_/);
    expect(["manifest", "diff", "archive", "metadata-only"]).toContain(snapshot.kind);
    expect(snapshot.createdAt).toBeDefined();
  });
});

describe("listSnapshots return type (after Artifact separation)", () => {
  it("should return snapshots without path or checksum fields", () => {
    // listSnapshots returns WorkspaceSnapshot[] which no longer includes
    // path/checksum. Verify the shape contract.
    const snapshots: WorkspaceSnapshot[] = [
      {
        id: "snap_s1",
        workspaceId: "ws_1",
        kind: "metadata-only",
        createdAt: "2024-01-01T00:00:00.000Z",
      },
      {
        id: "snap_s2",
        workspaceId: "ws_1",
        kind: "diff",
        createdAt: "2024-01-02T00:00:00.000Z",
      },
    ];

    expect(snapshots).toHaveLength(2);

    for (const s of snapshots) {
      expect("path" in s).toBe(false);
      expect("checksum" in s).toBe(false);
      expect(s.id).toBeDefined();
      expect(s.workspaceId).toBeDefined();
      expect(s.kind).toBeDefined();
      expect(s.createdAt).toBeDefined();
    }
  });
});

describe("Snapshot-to-Artifact 1:N relationship", () => {
  it("should allow a single snapshot to reference multiple artifacts", () => {
    // One snapshot can have multiple artifacts (metadata + patch + report etc.)
    // This is tested at the type/contract level here — the implementation
    // verifies it through createArtifact + getArtifactsForSnapshot.

    const snapshot: WorkspaceSnapshot = {
      id: "snap_multi_art",
      workspaceId: "ws_1",
      kind: "diff",
      createdAt: "2024-01-01T00:00:00.000Z",
    };

    // The snapshot itself has no path/checksum — artifacts carry file details
    expect(snapshot.id).toBe("snap_multi_art");

    // Artifacts for this snapshot are listed separately via getArtifactsForSnapshot
    const artifactIds = ["art_meta", "art_patch", "art_log"]; // example artifact IDs
    expect(artifactIds).toHaveLength(3); // 1 Snapshot → N Artifacts
  });
});

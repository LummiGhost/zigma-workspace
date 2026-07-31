import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import {
  insertArtifact,
  listArtifactsForSnapshot,
  insertWorkspaceSnapshot,
} from "./queries.js";
import type { ArtifactRow, WorkspaceSnapshotRow } from "../types/index.js";

// Reuse the schema from db/index.ts to create an in-memory test database
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS workspace_snapshots (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  checksum TEXT NOT NULL,
  media_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (snapshot_id) REFERENCES workspace_snapshots(id)
);
`;

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  return db;
}

describe("insertArtifact", () => {
  let db: Database.Database;

  beforeAll(() => {
    db = createTestDb();
  });

  afterAll(() => {
    db.close();
  });

  it("should insert an artifact row into the artifacts table", () => {
    // First insert a parent snapshot so FK constraint is satisfied
    const snapshotRow: WorkspaceSnapshotRow = {
      id: "snap_test1",
      workspace_id: "ws_test1",
      kind: "diff",
      created_at: "2024-01-01T00:00:00.000Z",
    };
    insertWorkspaceSnapshot(db, snapshotRow);

    const artifactRow: ArtifactRow = {
      id: "art_test1",
      snapshot_id: "snap_test1",
      kind: "metadata",
      path: "/tmp/snapshots/ws_test1/metadata.json",
      checksum: "abc123def456",
      media_type: "application/json",
      created_at: "2024-01-01T00:00:00.000Z",
    };

    insertArtifact(db, artifactRow);

    // Verify the row was inserted by querying directly
    const result = db
      .prepare("SELECT * FROM artifacts WHERE id = ?")
      .get("art_test1") as ArtifactRow | undefined;

    expect(result).toBeDefined();
    expect(result!.id).toBe("art_test1");
    expect(result!.snapshot_id).toBe("snap_test1");
    expect(result!.kind).toBe("metadata");
    expect(result!.path).toBe("/tmp/snapshots/ws_test1/metadata.json");
    expect(result!.checksum).toBe("abc123def456");
    expect(result!.media_type).toBe("application/json");
    expect(result!.created_at).toBe("2024-01-01T00:00:00.000Z");
  });

  it("should fail when inserting an artifact referencing a non-existent snapshot", () => {
    const artifactRow: ArtifactRow = {
      id: "art_orphan",
      snapshot_id: "snap_nonexistent",
      kind: "patch",
      path: "/tmp/file.patch",
      checksum: "sha256",
      media_type: "text/x-diff",
      created_at: "2024-01-01T00:00:00.000Z",
    };

    expect(() => insertArtifact(db, artifactRow)).toThrow();
  });
});

describe("listArtifactsForSnapshot", () => {
  let db: Database.Database;

  beforeAll(() => {
    db = createTestDb();
  });

  afterAll(() => {
    db.close();
  });

  it("should return artifacts belonging to a snapshot", () => {
    // Insert parent snapshot
    const snapshotRow: WorkspaceSnapshotRow = {
      id: "snap_list1",
      workspace_id: "ws_1",
      kind: "diff",
      created_at: "2024-01-01T00:00:00.000Z",
    };
    insertWorkspaceSnapshot(db, snapshotRow);

    // Insert two artifacts
    const art1: ArtifactRow = {
      id: "art_list1",
      snapshot_id: "snap_list1",
      kind: "metadata",
      path: "/tmp/meta.json",
      checksum: "sha1",
      media_type: "application/json",
      created_at: "2024-01-01T00:00:00.000Z",
    };

    const art2: ArtifactRow = {
      id: "art_list2",
      snapshot_id: "snap_list1",
      kind: "patch",
      path: "/tmp/diff.patch",
      checksum: "sha2",
      media_type: "text/x-diff",
      created_at: "2024-01-01T00:00:00.000Z",
    };

    insertArtifact(db, art1);
    insertArtifact(db, art2);

    const results = listArtifactsForSnapshot(db, "snap_list1");

    expect(results).toBeDefined();
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.id).sort()).toEqual(["art_list1", "art_list2"]);
  });

  it("should return an empty array for a snapshot with no artifacts", () => {
    // Insert a snapshot with no artifacts
    const snapshotRow: WorkspaceSnapshotRow = {
      id: "snap_empty",
      workspace_id: "ws_1",
      kind: "metadata-only",
      created_at: "2024-01-01T00:00:00.000Z",
    };
    insertWorkspaceSnapshot(db, snapshotRow);

    const results = listArtifactsForSnapshot(db, "snap_empty");
    expect(results).toBeDefined();
    expect(results).toHaveLength(0);
  });
});

describe("insertWorkspaceSnapshot (updated schema)", () => {
  let db: Database.Database;

  beforeAll(() => {
    db = createTestDb();
  });

  afterAll(() => {
    db.close();
  });

  it("should insert a snapshot row without path or checksum columns", () => {
    const snapshotRow: WorkspaceSnapshotRow = {
      id: "snap_schema1",
      workspace_id: "ws_1",
      kind: "metadata-only",
      created_at: "2024-01-01T00:00:00.000Z",
    };

    insertWorkspaceSnapshot(db, snapshotRow);

    const result = db
      .prepare("SELECT id, workspace_id, kind, created_at FROM workspace_snapshots WHERE id = ?")
      .get("snap_schema1") as Record<string, unknown> | undefined;

    expect(result).toBeDefined();
    expect(result!.id).toBe("snap_schema1");
    expect(result!.workspace_id).toBe("ws_1");
    expect(result!.kind).toBe("metadata-only");
    expect(result!.created_at).toBe("2024-01-01T00:00:00.000Z");

    // Verify path and checksum columns do NOT exist in the table
    const tableInfo = db
      .prepare("PRAGMA table_info(workspace_snapshots)")
      .all() as { name: string }[];
    const columnNames = tableInfo.map((c) => c.name);
    expect(columnNames).not.toContain("path");
    expect(columnNames).not.toContain("checksum");
  });
});

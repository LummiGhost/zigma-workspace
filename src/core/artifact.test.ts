import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import Database from "better-sqlite3";
import { createArtifact, getArtifactsForSnapshot } from "./artifact.js";
import { insertWorkspaceSnapshot } from "../db/queries.js";
import type { ZigmaWorkspaceConfig, ArtifactKind } from "../types/index.js";

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

function setupTestEnv(): { db: Database.Database; config: ZigmaWorkspaceConfig; tempDir: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zigma-artifact-test-"));
  const config: ZigmaWorkspaceConfig = {
    stateDir: tempDir,
    repoCacheDir: path.join(tempDir, "repo-cache"),
    workspacesDir: path.join(tempDir, "workspaces"),
    snapshotsDir: path.join(tempDir, "snapshots"),
    logsDir: path.join(tempDir, "logs"),
    dbPath: path.join(tempDir, "registry.db"),
  };

  for (const dir of [config.snapshotsDir, config.logsDir, config.workspacesDir, config.repoCacheDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(config.dbPath);
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);

  return { db, config, tempDir };
}

function cleanupTestEnv(tempDir: string): void {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

describe("createArtifact", () => {
  let db: Database.Database;
  let config: ZigmaWorkspaceConfig;
  let tempDir: string;

  beforeAll(() => {
    const env = setupTestEnv();
    db = env.db;
    config = env.config;
    tempDir = env.tempDir;
  });

  afterAll(() => {
    db.close();
    cleanupTestEnv(tempDir);
  });

  it("should create a metadata artifact and return it with a SHA-256 checksum", () => {
    // Insert parent snapshot
    insertWorkspaceSnapshot(db, {
      id: "snap_art1",
      workspace_id: "ws_art1",
      kind: "metadata-only",
      created_at: "2024-01-01T00:00:00.000Z",
    });

    const content = JSON.stringify({ key: "value" });
    const artifact = createArtifact(
      db,
      config,
      "snap_art1",
      "ws_art1",
      "metadata" as ArtifactKind,
      content,
      "metadata.json",
    );

    // Verify returned artifact shape
    expect(artifact.id).toMatch(/^art_/);
    expect(artifact.snapshotId).toBe("snap_art1");
    expect(artifact.kind).toBe("metadata");
    expect(artifact.mediaType).toBe("application/json");
    expect(artifact.checksum).toBeDefined();
    expect(artifact.checksum).toHaveLength(64); // SHA-256 hex = 64 chars
    expect(artifact.path).toBeDefined();
    expect(artifact.createdAt).toBeDefined();

    // Verify file was written to disk
    expect(fs.existsSync(artifact.path)).toBe(true);
    const fileContent = fs.readFileSync(artifact.path, "utf-8");
    expect(fileContent).toBe(content);
  });

  it("should create a patch artifact with text/x-diff media type", () => {
    insertWorkspaceSnapshot(db, {
      id: "snap_art2",
      workspace_id: "ws_art2",
      kind: "diff",
      created_at: "2024-01-01T00:00:00.000Z",
    });

    const patchContent = "diff --git a/file.txt b/file.txt\n+added line";
    const artifact = createArtifact(
      db,
      config,
      "snap_art2",
      "ws_art2",
      "patch" as ArtifactKind,
      patchContent,
      "snap_art2.patch",
    );

    expect(artifact.kind).toBe("patch");
    expect(artifact.mediaType).toBe("text/x-diff");
    expect(artifact.snapshotId).toBe("snap_art2");

    const fileContent = fs.readFileSync(artifact.path, "utf-8");
    expect(fileContent).toBe(patchContent);
  });

  it("should store artifacts in the correct directory under snapshotsDir/<workspaceId>/", () => {
    insertWorkspaceSnapshot(db, {
      id: "snap_dir1",
      workspace_id: "ws_dir1",
      kind: "metadata-only",
      created_at: "2024-01-01T00:00:00.000Z",
    });

    const artifact = createArtifact(
      db,
      config,
      "snap_dir1",
      "ws_dir1",
      "metadata" as ArtifactKind,
      "content",
      "test.json",
    );

    const expectedDir = path.join(config.snapshotsDir, "ws_dir1");
    expect(artifact.path).toContain(expectedDir);
  });

  it("should write the artifact file to disk and persist the row", () => {
    insertWorkspaceSnapshot(db, {
      id: "snap_persist",
      workspace_id: "ws_persist",
      kind: "diff",
      created_at: "2024-01-01T00:00:00.000Z",
    });

    const artifact = createArtifact(
      db,
      config,
      "snap_persist",
      "ws_persist",
      "metadata" as ArtifactKind,
      "persisted content",
      "data.json",
    );

    // Verify DB row exists
    const row = db
      .prepare("SELECT * FROM artifacts WHERE id = ?")
      .get(artifact.id) as Record<string, unknown> | undefined;

    expect(row).toBeDefined();
    expect(row!.id).toBe(artifact.id);
    expect(row!.snapshot_id).toBe("snap_persist");
    expect(row!.path).toBe(artifact.path);
    expect(row!.checksum).toBe(artifact.checksum);
  });
});

describe("getArtifactsForSnapshot", () => {
  let db: Database.Database;
  let config: ZigmaWorkspaceConfig;
  let tempDir: string;

  beforeAll(() => {
    const env = setupTestEnv();
    db = env.db;
    config = env.config;
    tempDir = env.tempDir;
  });

  afterAll(() => {
    db.close();
    cleanupTestEnv(tempDir);
  });

  it("should return all artifacts for a given snapshot, ordered newest first", () => {
    const snapshotId = "snap_list_ordered";

    insertWorkspaceSnapshot(db, {
      id: snapshotId,
      workspace_id: "ws_ordered",
      kind: "diff",
      created_at: "2024-01-01T00:00:00.000Z",
    });

    // Create metadata first, then patch
    createArtifact(db, config, snapshotId, "ws_ordered", "metadata" as ArtifactKind, "{}", "meta.json");
    createArtifact(db, config, snapshotId, "ws_ordered", "patch" as ArtifactKind, "diff", "patch.diff");

    const artifacts = getArtifactsForSnapshot(db, snapshotId);
    expect(artifacts).toHaveLength(2);

    // All artifacts should have the correct snapshotId
    for (const art of artifacts) {
      expect(art.snapshotId).toBe(snapshotId);
    }
  });

  it("should return an empty array when a snapshot has no artifacts", () => {
    insertWorkspaceSnapshot(db, {
      id: "snap_no_artifacts",
      workspace_id: "ws_noart",
      kind: "metadata-only",
      created_at: "2024-01-01T00:00:00.000Z",
    });

    const artifacts = getArtifactsForSnapshot(db, "snap_no_artifacts");
    expect(artifacts).toEqual([]);
  });

  it("should not return artifacts belonging to a different snapshot", () => {
    insertWorkspaceSnapshot(db, {
      id: "snap_isolation_a",
      workspace_id: "ws_iso",
      kind: "diff",
      created_at: "2024-01-01T00:00:00.000Z",
    });
    insertWorkspaceSnapshot(db, {
      id: "snap_isolation_b",
      workspace_id: "ws_iso",
      kind: "diff",
      created_at: "2024-01-01T00:00:00.000Z",
    });

    createArtifact(db, config, "snap_isolation_a", "ws_iso", "metadata" as ArtifactKind, "{}", "a.json");

    const results = getArtifactsForSnapshot(db, "snap_isolation_b");
    expect(results).toHaveLength(0);
  });
});

describe("Artifact media type mapping", () => {
  let db: Database.Database;
  let config: ZigmaWorkspaceConfig;
  let tempDir: string;

  beforeAll(() => {
    const env = setupTestEnv();
    db = env.db;
    config = env.config;
    tempDir = env.tempDir;
  });

  afterAll(() => {
    db.close();
    cleanupTestEnv(tempDir);
  });

  it("should map metadata kind to application/json", () => {
    insertWorkspaceSnapshot(db, {
      id: "snap_media1",
      workspace_id: "ws_media",
      kind: "metadata-only",
      created_at: "2024-01-01T00:00:00.000Z",
    });

    const artifact = createArtifact(
      db,
      config,
      "snap_media1",
      "ws_media",
      "metadata" as ArtifactKind,
      "{}",
      "file.json",
    );

    expect(artifact.mediaType).toBe("application/json");
  });

  it("should map patch kind to text/x-diff", () => {
    insertWorkspaceSnapshot(db, {
      id: "snap_media2",
      workspace_id: "ws_media",
      kind: "diff",
      created_at: "2024-01-01T00:00:00.000Z",
    });

    const artifact = createArtifact(
      db,
      config,
      "snap_media2",
      "ws_media",
      "patch" as ArtifactKind,
      "diff content",
      "file.patch",
    );

    expect(artifact.mediaType).toBe("text/x-diff");
  });
});

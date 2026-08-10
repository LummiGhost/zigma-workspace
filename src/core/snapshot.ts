import * as fs from "node:fs";
import { v4 as uuidv4 } from "uuid";
import type Database from "better-sqlite3";
import type { WorkspaceSnapshot, ZigmaWorkspaceConfig } from "../types/index.js";
import { ZigmaError } from "../types/index.js";
import {
  getWorkspaceById,
  insertWorkspaceSnapshot,
  listSnapshotsForWorkspace,
} from "../db/queries.js";
import { emitWorkspaceEvent } from "../core/events.js";
import { generatePatch, getChangedFiles, getHeadCommit } from "../git/index.js";
import { createArtifact } from "./artifact.js";
import { filterFiles, readWorkspacePathFilter } from "./diff.js";

function now(): string {
  return new Date().toISOString();
}

export function createSnapshot(
  db: Database.Database,
  config: ZigmaWorkspaceConfig,
  workspaceId: string
): WorkspaceSnapshot {
  const row = getWorkspaceById(db, workspaceId);
  if (!row) {
    throw new ZigmaError("WORKSPACE_NOT_FOUND", `Workspace ${workspaceId} not found`, { workspaceId });
  }

  const snapId = `snap_${uuidv4()}`;
  const ts = now();
  const headCommit = getHeadCommit(row.path);
  const pathFilter = readWorkspacePathFilter(row.path);

  // Collect the patch before inserting anything so the snapshot kind is final.
  let snapshotKind: WorkspaceSnapshot["kind"] = "metadata-only";
  let patch: string | null = null;
  if (fs.existsSync(row.path)) {
    const changedFiles = getChangedFiles(row.path, row.base_commit);
    const filteredFiles = pathFilter ? filterFiles(changedFiles, pathFilter) : changedFiles;
    const generatedPatch = filteredFiles.length > 0
      ? generatePatch(row.path, row.base_commit, filteredFiles)
      : "";
    if (generatedPatch.trim()) {
      patch = generatedPatch;
      snapshotKind = "diff";
    }
  }

  // The parent snapshot must exist before artifacts because artifacts.snapshot_id
  // is protected by a foreign key.
  insertWorkspaceSnapshot(db, {
    id: snapId,
    workspace_id: workspaceId,
    kind: snapshotKind,
    created_at: ts,
  });

  // Collect metadata as a metadata artifact
  const metadata = {
    snapshot_id: snapId,
    workspace_id: workspaceId,
    created_at: ts,
    head_commit: headCommit,
    base_commit: row.base_commit,
    base_ref: row.base_ref,
    branch: row.branch,
    repository_url: row.repository_url,
    mode: row.mode,
    status: row.status,
    path: row.path,
  };

  createArtifact(
    db,
    config,
    snapId,
    workspaceId,
    "metadata",
    JSON.stringify(metadata, null, 2),
    `${snapId}.metadata.json`,
  );

  let patchArtifact: ReturnType<typeof createArtifact> | undefined;
  if (patch !== null) {
    patchArtifact = createArtifact(
      db,
      config,
      snapId,
      workspaceId,
      "patch",
      patch,
      `${snapId}.patch`,
    );
  }

  emitWorkspaceEvent(db, workspaceId, "workspace.snapshot.created", {
    snapshot_id: snapId,
    kind: snapshotKind,
    patch_path: patchArtifact?.path ?? null,
    checksum: patchArtifact?.checksum ?? null,
  });

  return {
    id: snapId,
    workspaceId,
    kind: snapshotKind,
    createdAt: ts,
  };
}

export function listSnapshots(
  db: Database.Database,
  workspaceId: string
): WorkspaceSnapshot[] {
  const rows = listSnapshotsForWorkspace(db, workspaceId);
  return rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspace_id,
    kind: r.kind as WorkspaceSnapshot["kind"],
    createdAt: r.created_at,
  }));
}

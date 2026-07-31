import * as fs from "node:fs";
import { v4 as uuidv4 } from "uuid";
import type Database from "better-sqlite3";
import type { WorkspaceSnapshot, ZigmaWorkspaceConfig } from "../types/index.js";
import { ZigmaError } from "../types/index.js";
import {
  getWorkspaceById,
  insertWorkspaceSnapshot,
  insertWorkspaceEvent,
  listSnapshotsForWorkspace,
} from "../db/queries.js";
import { generatePatch, getHeadCommit } from "../git/index.js";
import { createArtifact } from "./artifact.js";

function now(): string {
  return new Date().toISOString();
}

function emitEvent(
  db: Database.Database,
  workspaceId: string,
  event: string,
  data?: unknown
): void {
  insertWorkspaceEvent(db, {
    id: `evt_${uuidv4()}`,
    workspace_id: workspaceId,
    event,
    data: data ? JSON.stringify(data) : null,
    created_at: now(),
  });
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

  // Collect diff as a patch artifact
  let snapshotKind: WorkspaceSnapshot["kind"] = "metadata-only";

  if (fs.existsSync(row.path)) {
    const patch = generatePatch(row.path, row.base_commit);
    if (patch.trim()) {
      createArtifact(
        db,
        config,
        snapId,
        workspaceId,
        "patch",
        patch,
        `${snapId}.patch`,
      );
      snapshotKind = "diff";
    }
  }

  insertWorkspaceSnapshot(db, {
    id: snapId,
    workspace_id: workspaceId,
    kind: snapshotKind,
    created_at: ts,
  });

  emitEvent(db, workspaceId, "workspace.snapshot.created", {
    snapshotId: snapId,
    kind: snapshotKind,
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

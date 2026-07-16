import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import type Database from "better-sqlite3";
import type { WorkspaceSnapshot, ZigmaWorkspaceConfig } from "../types/index.js";
import {
  getWorkspaceById,
  insertWorkspaceSnapshot,
  insertWorkspaceEvent,
  listSnapshotsForWorkspace,
} from "../db/queries.js";
import { generatePatch, getHeadCommit } from "../git/index.js";

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

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content, "utf-8").digest("hex");
}

export function createSnapshot(
  db: Database.Database,
  config: ZigmaWorkspaceConfig,
  workspaceId: string
): WorkspaceSnapshot {
  const row = getWorkspaceById(db, workspaceId);
  if (!row) {
    throw new Error(`Workspace ${workspaceId} not found`);
  }

  const snapId = `snap_${uuidv4()}`;
  const ts = now();
  const snapshotDir = path.join(config.snapshotsDir, workspaceId);
  fs.mkdirSync(snapshotDir, { recursive: true });

  const headCommit = getHeadCommit(row.path);

  // Collect metadata snapshot
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

  const metadataPath = path.join(snapshotDir, `${snapId}.metadata.json`);
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), "utf-8");

  // Collect diff snapshot
  let patchPath: string | undefined;
  let checksum: string | undefined;
  let snapshotKind: WorkspaceSnapshot["kind"] = "metadata-only";

  if (fs.existsSync(row.path)) {
    const patch = generatePatch(row.path, row.base_commit);
    if (patch.trim()) {
      patchPath = path.join(snapshotDir, `${snapId}.patch`);
      fs.writeFileSync(patchPath, patch, "utf-8");
      checksum = sha256(patch);
      snapshotKind = "diff";
    }
  }

  const snapshotRow = {
    id: snapId,
    workspace_id: workspaceId,
    kind: snapshotKind,
    path: patchPath ?? metadataPath,
    checksum: checksum ?? null,
    created_at: ts,
  };

  insertWorkspaceSnapshot(db, snapshotRow);

  emitEvent(db, workspaceId, "workspace.snapshot.created", {
    snapshotId: snapId,
    kind: snapshotKind,
    patchPath,
    checksum,
  });

  return {
    id: snapId,
    workspaceId,
    kind: snapshotKind,
    path: patchPath ?? metadataPath,
    checksum,
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
    path: r.path ?? undefined,
    checksum: r.checksum ?? undefined,
    createdAt: r.created_at,
  }));
}

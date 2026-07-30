import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import type Database from "better-sqlite3";
import type { WorkspaceSnapshot, Artifact, ZigmaWorkspaceConfig } from "../types/index.js";
import { ZigmaError } from "../types/index.js";
import {
  getWorkspaceById,
  insertWorkspaceSnapshot,
  insertArtifact,
  getArtifactById,
  listSnapshotsForWorkspace,
  listArtifactsByWorkspace,
  listArtifactsBySnapshot,
} from "../db/queries.js";
import { WorkspaceEventType } from "../types/index.js";
import { emitWorkspaceEvent } from "./events.js";
import { generatePatch, getHeadCommit } from "../git/index.js";

function now(): string {
  return new Date().toISOString();
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
    throw new ZigmaError("WORKSPACE_NOT_FOUND", `Workspace ${workspaceId} not found`, { workspaceId });
  }

  const snapId = `snap_${uuidv4()}`;
  const ts = now();
  const snapshotDir = path.join(config.snapshotsDir, workspaceId);
  fs.mkdirSync(snapshotDir, { recursive: true });

  const headCommit = getHeadCommit(row.path);

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

  const artifactIds: string[] = [];

  // Store metadata as an Artifact
  const metadataArtifactId = `art_${uuidv4()}`;
  insertArtifact(db, {
    id: metadataArtifactId,
    workspace_id: workspaceId,
    snapshot_id: snapId,
    kind: "file",
    name: `${snapId}.metadata.json`,
    content: JSON.stringify(metadata, null, 2),
    created_at: ts,
  });
  artifactIds.push(metadataArtifactId);

  // Collect and store diff as an Artifact
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

      const diffArtifactId = `art_${uuidv4()}`;
      insertArtifact(db, {
        id: diffArtifactId,
        workspace_id: workspaceId,
        snapshot_id: snapId,
        kind: "diff",
        name: `${snapId}.patch`,
        content: patch,
        created_at: ts,
      });
      artifactIds.push(diffArtifactId);
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

  emitWorkspaceEvent(db, workspaceId, WorkspaceEventType.SNAPSHOT_CREATED, {
    snapshotId: snapId,
    kind: snapshotKind,
    patchPath,
    checksum,
    artifactIds,
  });

  return {
    id: snapId,
    workspaceId,
    kind: snapshotKind,
    path: patchPath ?? metadataPath,
    checksum,
    artifactIds,
    createdAt: ts,
  };
}

export function listSnapshots(
  db: Database.Database,
  workspaceId: string
): WorkspaceSnapshot[] {
  const rows = listSnapshotsForWorkspace(db, workspaceId);
  return rows.map((r) => {
    const artifacts = listArtifactsBySnapshot(db, r.id);
    return {
      id: r.id,
      workspaceId: r.workspace_id,
      kind: r.kind as WorkspaceSnapshot["kind"],
      path: r.path ?? undefined,
      checksum: r.checksum ?? undefined,
      artifactIds: artifacts.map((a) => a.id),
      createdAt: r.created_at,
    };
  });
}

export function getSnapshotArtifacts(
  db: Database.Database,
  snapshotId: string
): Artifact[] {
  const rows = listArtifactsBySnapshot(db, snapshotId);
  return rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspace_id,
    snapshotId: r.snapshot_id ?? undefined,
    kind: r.kind as Artifact["kind"],
    name: r.name,
    content: r.content,
    createdAt: r.created_at,
  }));
}

export function getArtifact(
  db: Database.Database,
  artifactId: string
): Artifact {
  const row = getArtifactById(db, artifactId);
  if (!row) {
    throw new ZigmaError("INVALID_INPUT", `Artifact ${artifactId} not found`, { artifactId });
  }
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    snapshotId: row.snapshot_id ?? undefined,
    kind: row.kind as Artifact["kind"],
    name: row.name,
    content: row.content,
    createdAt: row.created_at,
  };
}

export function listWorkspaceArtifacts(
  db: Database.Database,
  workspaceId: string
): Artifact[] {
  const rows = listArtifactsByWorkspace(db, workspaceId);
  return rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspace_id,
    snapshotId: r.snapshot_id ?? undefined,
    kind: r.kind as Artifact["kind"],
    name: r.name,
    content: r.content,
    createdAt: r.created_at,
  }));
}

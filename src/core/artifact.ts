import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import type Database from "better-sqlite3";
import type { Artifact, ArtifactKind, ZigmaWorkspaceConfig } from "../types/index.js";
import { insertArtifact, listArtifactsForSnapshot } from "../db/queries.js";
import { assertCapacityAvailable, assertPathWithin } from "./isolation-policy.js";
import { ZigmaError } from "../types/index.js";

function mediaTypeForKind(kind: ArtifactKind): string {
  return kind === "patch" ? "text/x-diff" : "application/json";
}

export function createArtifact(
  db: Database.Database,
  config: ZigmaWorkspaceConfig,
  snapshotId: string,
  workspaceId: string,
  kind: ArtifactKind,
  content: string,
  filename: string,
): Artifact {
  if (path.basename(filename) !== filename || filename === "." || filename === "..") {
    throw new ZigmaError("WORKSPACE_PATH_POLICY_VIOLATION", `Invalid artifact filename: ${filename}`, { filename });
  }
  assertCapacityAvailable(config, Buffer.byteLength(content, "utf-8"));
  const id = `art_${uuidv4()}`;
  const ts = new Date().toISOString();
  const artifactDir = path.join(config.snapshotsDir, workspaceId);
  assertPathWithin(config.snapshotsDir, artifactDir, "Artifact directory");
  fs.mkdirSync(artifactDir, { recursive: true });
  const artifactPath = path.join(artifactDir, filename);
  assertPathWithin(config.snapshotsDir, artifactPath, "Artifact path");
  fs.writeFileSync(artifactPath, content, "utf-8");
  const checksum = crypto.createHash("sha256").update(content, "utf-8").digest("hex");
  const mediaType = mediaTypeForKind(kind);

  insertArtifact(db, {
    id,
    snapshot_id: snapshotId,
    kind,
    path: artifactPath,
    checksum,
    media_type: mediaType,
    created_at: ts,
  });

  return {
    id,
    snapshotId,
    kind,
    path: artifactPath,
    checksum,
    mediaType,
    createdAt: ts,
  };
}

export function getArtifactsForSnapshot(
  db: Database.Database,
  snapshotId: string,
): Artifact[] {
  const rows = listArtifactsForSnapshot(db, snapshotId);
  return rows.map((r) => ({
    id: r.id,
    snapshotId: r.snapshot_id,
    kind: r.kind as ArtifactKind,
    path: r.path,
    checksum: r.checksum,
    mediaType: r.media_type,
    createdAt: r.created_at,
  }));
}

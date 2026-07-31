import type Database from "better-sqlite3";
import type { Artifact, ArtifactKind, ZigmaWorkspaceConfig } from "../types/index.js";

export function createArtifact(
  _db: Database.Database,
  _config: ZigmaWorkspaceConfig,
  _snapshotId: string,
  _workspaceId: string,
  _kind: ArtifactKind,
  _content: string,
  _filename: string,
): Artifact {
  throw new Error("not implemented");
}

export function getArtifactsForSnapshot(
  _db: Database.Database,
  _snapshotId: string,
): Artifact[] {
  throw new Error("not implemented");
}

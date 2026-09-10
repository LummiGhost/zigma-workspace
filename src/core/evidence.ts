import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import type { ArtifactDescriptor, ZigmaWorkspaceConfig } from "../types/index.js";
import { assertCapacityAvailable, assertPathWithin } from "./isolation-policy.js";

/**
 * Write an evidence patch under the snapshots root and return a portable
 * artifact descriptor. Returns undefined when there is no evidence content.
 */
export function writeEvidenceArtifact(
  config: ZigmaWorkspaceConfig,
  workspaceId: string,
  operationId: string,
  content: string,
): ArtifactDescriptor | undefined {
  if (!content.trim()) {
    return undefined;
  }
  assertCapacityAvailable(config, Buffer.byteLength(content, "utf-8"));

  const dir = path.join(config.snapshotsDir, workspaceId);
  assertPathWithin(config.snapshotsDir, dir, "Evidence artifact directory");
  fs.mkdirSync(dir, { recursive: true });

  // operationId is caller-controlled (may contain ':' or other path-hostile
  // characters); use a short hash to keep the filename deterministic.
  const idHash = crypto.createHash("sha256").update(operationId, "utf-8").digest("hex").slice(0, 16);
  const filename = `${idHash}.patch`;
  const artifactPath = path.join(dir, filename);
  assertPathWithin(config.snapshotsDir, artifactPath, "Evidence artifact path");
  fs.writeFileSync(artifactPath, content, "utf-8");

  const digest = `sha256:${crypto.createHash("sha256").update(content, "utf-8").digest("hex")}`;
  return {
    uri: pathToFileURL(artifactPath).href,
    mediaType: "text/x-diff",
    digest,
  };
}

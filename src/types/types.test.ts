import { describe, it, expect } from "vitest";
import {
  ARTIFACT_KINDS,
  CONTRACT_VERSION,
  ZigmaError,
} from "./index.js";
import type {
  Artifact,
  ArtifactKind,
  ArtifactRow,
  WorkspaceSnapshot,
  ZigmaErrorCode,
} from "./index.js";

// ── Artifact Kinds ──────────────────────────────────────────────────────────

describe("ARTIFACT_KINDS", () => {
  it("should contain exactly five artifact kind values", () => {
    expect(ARTIFACT_KINDS).toHaveLength(5);
  });

  it("should include metadata kind", () => {
    expect(ARTIFACT_KINDS).toContain("metadata");
  });

  it("should include patch kind", () => {
    expect(ARTIFACT_KINDS).toContain("patch");
  });

  it("should include log kind", () => {
    expect(ARTIFACT_KINDS).toContain("log");
  });

  it("should include report kind", () => {
    expect(ARTIFACT_KINDS).toContain("report");
  });

  it("should include generated-file kind", () => {
    expect(ARTIFACT_KINDS).toContain("generated-file");
  });
});

// ── Artifact interface ──────────────────────────────────────────────────────

describe("Artifact", () => {
  it("should allow constructing a valid artifact object with all required fields", () => {
    const artifact: Artifact = {
      id: "art_abc123",
      snapshotId: "snap_xyz789",
      kind: "metadata",
      path: "/tmp/snapshots/ws_1/metadata.json",
      checksum: "abc123def456",
      mediaType: "application/json",
      createdAt: "2024-01-15T10:30:00.000Z",
    };

    expect(artifact.id).toBe("art_abc123");
    expect(artifact.snapshotId).toBe("snap_xyz789");
    expect(artifact.kind).toBe("metadata");
    expect(artifact.path).toBe("/tmp/snapshots/ws_1/metadata.json");
    expect(artifact.checksum).toBe("abc123def456");
    expect(artifact.mediaType).toBe("application/json");
    expect(artifact.createdAt).toBe("2024-01-15T10:30:00.000Z");
  });

  it("should accept all valid artifact kinds", () => {
    const kinds: ArtifactKind[] = [
      "metadata",
      "patch",
      "log",
      "report",
      "generated-file",
    ];

    for (const kind of kinds) {
      const artifact: Artifact = {
        id: `art_${kind}`,
        snapshotId: "snap_1",
        kind,
        path: "/tmp/file",
        checksum: "sha",
        mediaType: "text/plain",
        createdAt: "2024-01-01T00:00:00.000Z",
      };
      expect(artifact.kind).toBe(kind);
    }
  });

  it("should use art_ as the ID prefix convention", () => {
    const artifact: Artifact = {
      id: "art_test123",
      snapshotId: "snap_1",
      kind: "metadata",
      path: "/tmp/test",
      checksum: "sha256",
      mediaType: "application/json",
      createdAt: "2024-01-01T00:00:00.000Z",
    };

    expect(artifact.id).toMatch(/^art_/);
  });
});

// ── ArtifactRow interface ───────────────────────────────────────────────────

describe("ArtifactRow", () => {
  it("should use snake_case field names matching the DB schema", () => {
    const row: ArtifactRow = {
      id: "art_row1",
      snapshot_id: "snap_1",
      kind: "patch",
      path: "/tmp/file.patch",
      checksum: "sha256def",
      media_type: "text/x-diff",
      created_at: "2024-01-01T00:00:00.000Z",
    };

    expect(row.id).toBe("art_row1");
    expect(row.snapshot_id).toBe("snap_1");
    expect(row.kind).toBe("patch");
    expect(row.path).toBe("/tmp/file.patch");
    expect(row.checksum).toBe("sha256def");
    expect(row.media_type).toBe("text/x-diff");
    expect(row.created_at).toBe("2024-01-01T00:00:00.000Z");
  });
});

// ── WorkspaceSnapshot - path and checksum removed ───────────────────────────

describe("WorkspaceSnapshot", () => {
  it("should not have path or checksum fields after separating Artifact model", () => {
    const snapshot: WorkspaceSnapshot = {
      id: "snap_1",
      workspaceId: "ws_1",
      kind: "metadata-only",
      createdAt: "2024-01-01T00:00:00.000Z",
    };

    // Verify the snapshot has the core fields
    expect(snapshot.id).toBe("snap_1");
    expect(snapshot.workspaceId).toBe("ws_1");
    expect(snapshot.kind).toBe("metadata-only");
    expect(snapshot.createdAt).toBe("2024-01-01T00:00:00.000Z");

    // path and checksum must not exist on the snapshot object
    expect("path" in snapshot).toBe(false);
    expect("checksum" in snapshot).toBe(false);
  });

  it("should accept all valid snapshot kinds", () => {
    const kinds: WorkspaceSnapshot["kind"][] = [
      "manifest",
      "diff",
      "archive",
      "metadata-only",
    ];

    for (const kind of kinds) {
      const snapshot: WorkspaceSnapshot = {
        id: "snap_1",
        workspaceId: "ws_1",
        kind,
        createdAt: "2024-01-01T00:00:00.000Z",
      };
      expect(snapshot.kind).toBe(kind);
    }
  });

  it("should use snap_ as the ID prefix convention", () => {
    const snapshot: WorkspaceSnapshot = {
      id: "snap_test123",
      workspaceId: "ws_1",
      kind: "metadata-only",
      createdAt: "2024-01-01T00:00:00.000Z",
    };

    expect(snapshot.id).toMatch(/^snap_/);
  });
});

// ── Contract types remain intact ────────────────────────────────────────────

describe("contract types", () => {
  it("should preserve CONTRACT_VERSION = 1", () => {
    expect(CONTRACT_VERSION).toBe(1);
  });

  it("should preserve ZigmaError code enumeration", () => {
    const codes: ZigmaErrorCode[] = [
      "WORKSPACE_NOT_FOUND",
      "WORKSPACE_LOCK_CONFLICT",
      "WORKSPACE_DIRECTORY_NOT_FOUND",
      "GIT_ERROR",
      "INVALID_INPUT",
      "OPERATION_ID_CONFLICT",
      "INTERNAL_ERROR",
    ];

    for (const code of codes) {
      const err = new ZigmaError(code, "test message");
      expect(err.code).toBe(code);
      expect(err.message).toBe("test message");
      expect(err.name).toBe("ZigmaError");
    }
  });
});

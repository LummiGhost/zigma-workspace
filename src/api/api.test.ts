import { describe, it, expect } from "vitest";
import {
  CONTRACT_VERSION,
  ZigmaError,
  ARTIFACT_KINDS,
  createArtifact,
  getArtifactsForSnapshot,
  createSnapshot,
  listSnapshots,
  createWorkspace,
  bindRun,
  getWorkspace,
  listAllWorkspaces,
  lockWorkspace,
  unlockWorkspace,
  getLock,
  collectDiff,
  cleanupWorkspace,
  detectOrphanWorktrees,
  getConfig,
  ensureStateDirs,
  openDb,
} from "./index.js";

describe("API exports", () => {
  it("should export CONTRACT_VERSION constant", () => {
    expect(CONTRACT_VERSION).toBe(1);
  });

  it("should export ZigmaError class", () => {
    const err = new ZigmaError("INTERNAL_ERROR", "test");
    expect(err).toBeInstanceOf(ZigmaError);
  });

  it("should export ARTIFACT_KINDS constant", () => {
    expect(ARTIFACT_KINDS).toBeDefined();
    expect(Array.isArray(ARTIFACT_KINDS)).toBe(true);
  });

  // ── New Artifact exports ───────────────────────────────────────────────

  it("should export createArtifact function", () => {
    expect(createArtifact).toBeDefined();
    expect(typeof createArtifact).toBe("function");
    expect(createArtifact.name).toBe("createArtifact");
  });

  it("should export getArtifactsForSnapshot function", () => {
    expect(getArtifactsForSnapshot).toBeDefined();
    expect(typeof getArtifactsForSnapshot).toBe("function");
    expect(getArtifactsForSnapshot.name).toBe("getArtifactsForSnapshot");
  });

  // ── Unchanged exports (contracts preserved) ────────────────────────────

  it("should export createWorkspace function", () => {
    expect(createWorkspace).toBeDefined();
    expect(typeof createWorkspace).toBe("function");
  });

  it("should export bindRun function", () => {
    expect(bindRun).toBeDefined();
    expect(typeof bindRun).toBe("function");
  });

  it("should export getWorkspace and listAllWorkspaces functions", () => {
    expect(getWorkspace).toBeDefined();
    expect(typeof getWorkspace).toBe("function");
    expect(listAllWorkspaces).toBeDefined();
    expect(typeof listAllWorkspaces).toBe("function");
  });

  it("should export lockWorkspace, unlockWorkspace, and getLock functions", () => {
    expect(lockWorkspace).toBeDefined();
    expect(typeof lockWorkspace).toBe("function");
    expect(unlockWorkspace).toBeDefined();
    expect(typeof unlockWorkspace).toBe("function");
    expect(getLock).toBeDefined();
    expect(typeof getLock).toBe("function");
  });

  it("should export collectDiff function", () => {
    expect(collectDiff).toBeDefined();
    expect(typeof collectDiff).toBe("function");
  });

  it("should export createSnapshot and listSnapshots functions", () => {
    expect(createSnapshot).toBeDefined();
    expect(typeof createSnapshot).toBe("function");
    expect(listSnapshots).toBeDefined();
    expect(typeof listSnapshots).toBe("function");
  });

  it("should export cleanupWorkspace and detectOrphanWorktrees functions", () => {
    expect(cleanupWorkspace).toBeDefined();
    expect(typeof cleanupWorkspace).toBe("function");
    expect(detectOrphanWorktrees).toBeDefined();
    expect(typeof detectOrphanWorktrees).toBe("function");
  });

  it("should export getConfig and ensureStateDirs functions", () => {
    expect(getConfig).toBeDefined();
    expect(typeof getConfig).toBe("function");
    expect(ensureStateDirs).toBeDefined();
    expect(typeof ensureStateDirs).toBe("function");
  });

  it("should export openDb function", () => {
    expect(openDb).toBeDefined();
    expect(typeof openDb).toBe("function");
  });
});

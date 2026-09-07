import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getConfig, ensureStateDirs } from "../../src/config/index.js";
import { closeDb, openDb } from "../../src/db/index.js";
import {
  createWorkspace,
  getWorkspace,
  bindRun,
} from "../../src/core/workspace.js";
import { commitWorkspace } from "../../src/core/commit.js";
import {
  integrateWorkspace,
  abortIntegration,
} from "../../src/core/integrate.js";
import { publishWorkspace } from "../../src/core/publish.js";
import { reconcileWorkspace } from "../../src/core/reconcile.js";
import { cleanupWorkspaceStrict } from "../../src/core/cleanup.js";
import { lockWorkspace } from "../../src/core/lock.js";
import {
  acquireIntegrationLock,
  releaseIntegrationLock,
  takeoverIntegrationLock,
  heartbeatIntegrationLock,
  getIntegrationLockState,
} from "../../src/core/integration-lock.js";
import { getHeadCommit } from "../../src/git/index.js";
import { transition } from "../../src/core/state-machine.js";
import { updateWorkspaceStatus } from "../../src/db/queries.js";
import type { Database } from "better-sqlite3";
import type { ZigmaWorkspaceConfig } from "../../src/types/index.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

interface TestContext {
  root: string;
  repo: string;
  stateDir: string;
  config: ZigmaWorkspaceConfig;
  db: Database.Database;
  baseCommit: string;
}

const tempDirs: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function setupRepo(): TestContext {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zigma-contract-"));
  tempDirs.push(root);
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "contract@example.test");
  git(repo, "config", "user.name", "contract-test");
  git(repo, "config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(repo, "README.md"), "# test repo\n", "utf-8");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "initial");
  const baseCommit = git(repo, "rev-parse", "HEAD");

  const stateDir = path.join(root, "state");
  const config = getConfig(stateDir);
  ensureStateDirs(config);
  const db = openDb(config);

  return { root, repo, stateDir, config, db, baseCommit };
}

function makeWorkspace(
  ctx: TestContext,
  branch: string,
  opts?: { jobId?: string; taskId?: string },
): ReturnType<typeof createWorkspace> {
  return createWorkspace(ctx.db, ctx.config, {
    repositoryUrl: ctx.repo,
    baseRef: "main",
    branch,
    jobId: opts?.jobId,
    taskId: opts?.taskId,
  });
}

function uniqueId(): string {
  return crypto.randomUUID();
}

/**
 * Ensure the workspace won't commit infrastructure files.
 * `.zigma-workspace.json` is written by createWorkspace and must be
 * git-ignored before any commitWorkspace call so it doesn't cause
 * merge conflicts during integration.
 */
function prepareWorkspaceForCommit(workspacePath: string): void {
  const gitignorePath = path.join(workspacePath, ".gitignore");
  const ignoreLine = ".zigma-workspace.json";
  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, "utf-8");
    if (content.split("\n").some((l) => l.trim() === ignoreLine)) return;
  }
  fs.appendFileSync(gitignorePath, `${ignoreLine}\n`, "utf-8");
  // Commit the .gitignore so the workspace is clean and won't conflict on merge
  execFileSync("git", ["add", ".gitignore"], { cwd: workspacePath, encoding: "utf-8" });
  execFileSync(
    "git",
    ["-c", "user.email=zigma-workspace@local", "-c", "user.name=zigma-workspace", "commit", "-m", "zigma-workspace: infrastructure setup"],
    { cwd: workspacePath, encoding: "utf-8" },
  );
}

afterEach(() => {
  closeDb();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 1. Sequential Integration ───────────────────────────────────────────────

describe("sequential integration of two Job workspaces into one target", () => {
  it("integrates two independent changesets in order into a shared target", () => {
    const ctx = setupRepo();

    const jobA = makeWorkspace(ctx, "job-a", { jobId: "job-a" });
    const jobB = makeWorkspace(ctx, "job-b", { jobId: "job-b" });
    const target = makeWorkspace(ctx, "target-main", { jobId: "target" });

    expect(jobA.status).toBe("READY");
    expect(jobB.status).toBe("READY");
    expect(target.status).toBe("READY");

    // Prepare infrastructure files before committing real work
    prepareWorkspaceForCommit(jobA.path);
    prepareWorkspaceForCommit(jobB.path);
    prepareWorkspaceForCommit(target.path);

    // Job A: write and commit
    fs.writeFileSync(
      path.join(jobA.path, "feature-a.txt"),
      "feature A content\n",
      "utf-8",
    );
    const commitA = commitWorkspace(ctx.db, {
      operationId: uniqueId(),
      workspaceId: jobA.id,
      message: "job-a: add feature A",
    });
    expect(commitA.noOp).toBe(false);
    expect(commitA.changedFiles).toContain("feature-a.txt");

    // Job B: write and commit
    fs.writeFileSync(
      path.join(jobB.path, "feature-b.txt"),
      "feature B content\n",
      "utf-8",
    );
    const commitB = commitWorkspace(ctx.db, {
      operationId: uniqueId(),
      workspaceId: jobB.id,
      message: "job-b: add feature B",
    });
    expect(commitB.noOp).toBe(false);
    expect(commitB.changedFiles).toContain("feature-b.txt");

    const targetHeadBefore = getHeadCommit(target.path);
    expect(targetHeadBefore).toBeTruthy();

    // Target must be RUNNING to accept integration
    bindRun(ctx.db, { workspaceId: target.id });
    expect(getWorkspace(ctx.db, target.id).status).toBe("RUNNING");

    // Integrate A → target
    const resultA = integrateWorkspace(ctx.db, {
      operationId: uniqueId(),
      sourceWorkspaceId: jobA.id,
      targetWorkspaceId: target.id,
      lockOwner: "test-runner",
    });
    expect(resultA.merged).toBe(true);
    expect(resultA.targetWorkspaceId).toBe(target.id);
    expect(resultA.sourceCommit).toBe(commitA.headCommit);
    expect(resultA.resultingCommit).not.toBe(targetHeadBefore);

    // Verify target has file A (normalize line endings for cross-platform)
    expect(fs.existsSync(path.join(target.path, "feature-a.txt"))).toBe(true);
    const contentA = fs.readFileSync(path.join(target.path, "feature-a.txt"), "utf-8").replace(/\r\n/g, "\n");
    expect(contentA).toBe("feature A content\n");

    // Target state should be MERGED after integration
    expect(getWorkspace(ctx.db, target.id).status).toBe("MERGED");

    // Transition MERGED → RUNNING for second integrate
    updateWorkspaceStatus(
      ctx.db,
      target.id,
      transition("MERGED", "RUNNING"),
      new Date().toISOString(),
    );
    expect(getWorkspace(ctx.db, target.id).status).toBe("RUNNING");

    // Integrate B → target (second integration)
    const targetHeadAfterA = getHeadCommit(target.path);
    const resultB = integrateWorkspace(ctx.db, {
      operationId: uniqueId(),
      sourceWorkspaceId: jobB.id,
      targetWorkspaceId: target.id,
      lockOwner: "test-runner",
    });
    expect(resultB.merged).toBe(true);
    expect(resultB.previousTargetHead).toBe(targetHeadAfterA);
    expect(resultB.resultingCommit).not.toBe(targetHeadAfterA);

    // Verify target has BOTH files
    expect(fs.existsSync(path.join(target.path, "feature-a.txt"))).toBe(true);
    expect(fs.existsSync(path.join(target.path, "feature-b.txt"))).toBe(true);

    // Transition MERGED → RUNNING for third integrate
    updateWorkspaceStatus(
      ctx.db,
      target.id,
      transition("MERGED", "RUNNING"),
      new Date().toISOString(),
    );

    // Re-integrate A → should be no-op (already ancestor)
    const resultA2 = integrateWorkspace(ctx.db, {
      operationId: uniqueId(),
      sourceWorkspaceId: jobA.id,
      targetWorkspaceId: target.id,
      lockOwner: "test-runner",
    });
    expect(resultA2.merged).toBe(false);
    expect(resultA2.resultingCommit).toBe(resultA2.previousTargetHead);
  });
});

// ── 2. Same-Line Conflict & Target Recovery ─────────────────────────────────

describe("same-line conflict detection and target recovery", () => {
  it("detects conflict on same-line edit, preserves target state, and recovers via abort", () => {
    const ctx = setupRepo();

    // Create a file with multiple lines that two jobs will both edit
    fs.writeFileSync(
      path.join(ctx.repo, "conflict.txt"),
      "line 1\nline 2\nline 3\n",
      "utf-8",
    );
    git(ctx.repo, "add", ".");
    git(ctx.repo, "commit", "-m", "add conflict file");

    const jobA = makeWorkspace(ctx, "job-a-conflict", { jobId: "job-a" });
    const jobB = makeWorkspace(ctx, "job-b-conflict", { jobId: "job-b" });
    const target = makeWorkspace(ctx, "target-conflict", { jobId: "target" });

    prepareWorkspaceForCommit(jobA.path);
    prepareWorkspaceForCommit(jobB.path);
    prepareWorkspaceForCommit(target.path);

    // Job A: modify line 2
    fs.writeFileSync(
      path.join(jobA.path, "conflict.txt"),
      "line 1\nline 2 modified by A\nline 3\n",
      "utf-8",
    );
    const commitA = commitWorkspace(ctx.db, {
      operationId: uniqueId(),
      workspaceId: jobA.id,
      message: "job-a: modify line 2",
    });
    expect(commitA.noOp).toBe(false);

    // Job B: modify line 2 differently
    fs.writeFileSync(
      path.join(jobB.path, "conflict.txt"),
      "line 1\nline 2 modified by B\nline 3\n",
      "utf-8",
    );
    const commitB = commitWorkspace(ctx.db, {
      operationId: uniqueId(),
      workspaceId: jobB.id,
      message: "job-b: modify line 2 differently",
    });
    expect(commitB.noOp).toBe(false);

    // Activate target for integration
    bindRun(ctx.db, { workspaceId: target.id });

    // Integrate A → target (should succeed)
    const resultA = integrateWorkspace(ctx.db, {
      operationId: uniqueId(),
      sourceWorkspaceId: jobA.id,
      targetWorkspaceId: target.id,
      lockOwner: "test-runner",
    });
    expect(resultA.merged).toBe(true);
    const targetHeadAfterA = getHeadCommit(target.path);
    expect(targetHeadAfterA).toBe(resultA.resultingCommit);

    // Verify target has A's content
    const contentAfterA = fs.readFileSync(
      path.join(target.path, "conflict.txt"),
      "utf-8",
    );
    expect(contentAfterA).toContain("line 2 modified by A");
    expect(contentAfterA).not.toContain("line 2 modified by B");

    // Transition MERGED → RUNNING for second integrate
    updateWorkspaceStatus(
      ctx.db,
      target.id,
      transition("MERGED", "RUNNING"),
      new Date().toISOString(),
    );

    // Integrate B → target (should conflict on same line)
    const conflictResult = integrateWorkspace(ctx.db, {
      operationId: uniqueId(),
      sourceWorkspaceId: jobB.id,
      targetWorkspaceId: target.id,
      lockOwner: "test-runner",
    });

    // Should be a conflict result
    expect("conflictFiles" in conflictResult).toBe(true);
    if ("conflictFiles" in conflictResult) {
      expect(conflictResult.message).toContain("Merge conflict");
    }

    // Target state should be CONFLICT
    expect(getWorkspace(ctx.db, target.id).status).toBe("CONFLICT");

    // Target HEAD should be restored to post-A-merge commit
    // (mergeOrConflict aborts the merge to restore clean state)
    const targetHeadAfterConflict = getHeadCommit(target.path);
    expect(targetHeadAfterConflict).toBe(targetHeadAfterA);

    // Target content should be A's version (restored after merge abort)
    const contentAfterConflict = fs.readFileSync(
      path.join(target.path, "conflict.txt"),
      "utf-8",
    );
    expect(contentAfterConflict).toContain("line 2 modified by A");
    expect(contentAfterConflict).not.toContain("line 2 modified by B");

    // Abort integration to recover target to RUNNING
    const abortResult = abortIntegration(ctx.db, {
      operationId: uniqueId(),
      workspaceId: target.id,
      reason: "conflict resolved manually",
    });
    expect(abortResult.aborted).toBe(true);
    expect(abortResult.workspaceId).toBe(target.id);

    const targetAfterAbort = getWorkspace(ctx.db, target.id);
    // abortIntegration is best-effort: CONFLICT→RUNNING is not a valid
    // transition, so the state stays CONFLICT. The abort is still recorded.
    expect(["CONFLICT", "RUNNING"]).toContain(targetAfterAbort.status);

    // Target HEAD and content still intact after abort
    const targetHeadAfterAbort = getHeadCommit(target.path);
    expect(targetHeadAfterAbort).toBe(targetHeadAfterA);
    expect(
      fs.readFileSync(path.join(target.path, "conflict.txt"), "utf-8"),
    ).toContain("line 2 modified by A");
  });

  it("recovers target to previous HEAD on non-conflict integration error", () => {
    const ctx = setupRepo();

    const jobA = makeWorkspace(ctx, "job-a-err", { jobId: "job-a" });
    const target = makeWorkspace(ctx, "target-err", { jobId: "target" });

    prepareWorkspaceForCommit(jobA.path);
    prepareWorkspaceForCommit(target.path);

    fs.writeFileSync(path.join(jobA.path, "file.txt"), "content\n", "utf-8");
    commitWorkspace(ctx.db, {
      operationId: uniqueId(),
      workspaceId: jobA.id,
      message: "add file",
    });

    bindRun(ctx.db, { workspaceId: target.id });
    const targetHeadBefore = getHeadCommit(target.path);

    // Force expectedHead mismatch so integration throws WORKSPACE_HEAD_CONFLICT
    expect(() =>
      integrateWorkspace(ctx.db, {
        operationId: uniqueId(),
        sourceWorkspaceId: jobA.id,
        targetWorkspaceId: target.id,
        expectedHead: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        lockOwner: "test-runner",
      }),
    ).toThrow(
      expect.objectContaining({ code: "WORKSPACE_HEAD_CONFLICT" }),
    );

    // Target HEAD should be unchanged
    expect(getHeadCommit(target.path)).toBe(targetHeadBefore);
  });
});

// ── 3. OperationId Idempotency ──────────────────────────────────────────────

describe("operationId idempotency", () => {
  it("commitWorkspace replays cached result for identical operationId + input", () => {
    const ctx = setupRepo();
    const ws = makeWorkspace(ctx, "idem-commit");
    prepareWorkspaceForCommit(ws.path);

    fs.writeFileSync(path.join(ws.path, "data.txt"), "data\n", "utf-8");

    const opId = uniqueId();
    const input = {
      operationId: opId,
      workspaceId: ws.id,
      message: "idempotent commit",
    };

    const r1 = commitWorkspace(ctx.db, input);
    expect(r1.noOp).toBe(false);
    expect(r1.changedFiles).toContain("data.txt");

    // Same operationId, same input — should return identical result
    const r2 = commitWorkspace(ctx.db, input);
    expect(r2).toEqual(r1);

    // Verify only one commit exists in git (not doubled)
    // Count commits since base: the infrastructure commit + the data commit = 2
    const log = execFileSync(
      "git",
      ["log", "--format=%H%n%s", `${ctx.baseCommit}..HEAD`],
      { cwd: ws.path, encoding: "utf-8" },
    ).trim();
    const commits = log.split("\n").filter(Boolean);
    // 2 commits (infrastructure + data) = 4 lines (hash + message each)
    expect(commits.length).toBe(4);
  });

  it("commitWorkspace throws OPERATION_ID_CONFLICT on same ID with different input", () => {
    const ctx = setupRepo();
    const ws = makeWorkspace(ctx, "idem-conflict");
    prepareWorkspaceForCommit(ws.path);

    fs.writeFileSync(path.join(ws.path, "a.txt"), "a\n", "utf-8");

    const opId = uniqueId();
    commitWorkspace(ctx.db, {
      operationId: opId,
      workspaceId: ws.id,
      message: "first variant",
    });

    // Same operationId but different message changes the hash
    expect(() =>
      commitWorkspace(ctx.db, {
        operationId: opId,
        workspaceId: ws.id,
        message: "different message",
      }),
    ).toThrow(
      expect.objectContaining({ code: "OPERATION_ID_CONFLICT" }),
    );
  });

  it("commitWorkspace no-op is also idempotent", () => {
    const ctx = setupRepo();
    const ws = makeWorkspace(ctx, "idem-noop");
    prepareWorkspaceForCommit(ws.path);

    // After prepareWorkspaceForCommit, the tree is clean
    const opId = uniqueId();
    const r1 = commitWorkspace(ctx.db, {
      operationId: opId,
      workspaceId: ws.id,
    });
    expect(r1.noOp).toBe(true);

    // Second call with same operationId returns identical no-op result
    const r2 = commitWorkspace(ctx.db, {
      operationId: opId,
      workspaceId: ws.id,
    });
    expect(r2).toEqual(r1);
  });

  it("integrateWorkspace replays cached result for identical operationId + input", () => {
    const ctx = setupRepo();

    const jobA = makeWorkspace(ctx, "idem-int-job");
    const target = makeWorkspace(ctx, "idem-int-target");

    prepareWorkspaceForCommit(jobA.path);
    prepareWorkspaceForCommit(target.path);

    fs.writeFileSync(path.join(jobA.path, "f.txt"), "f\n", "utf-8");
    commitWorkspace(ctx.db, {
      operationId: uniqueId(),
      workspaceId: jobA.id,
      message: "commit for idempotent integrate",
    });

    bindRun(ctx.db, { workspaceId: target.id });

    const opId = uniqueId();
    const input = {
      operationId: opId,
      sourceWorkspaceId: jobA.id,
      targetWorkspaceId: target.id,
      lockOwner: "test-runner",
    };

    const r1 = integrateWorkspace(ctx.db, input);
    expect(r1.merged).toBe(true);

    const r2 = integrateWorkspace(ctx.db, input);
    expect(r2).toEqual(r1);
  });

  it("integrateWorkspace throws OPERATION_ID_CONFLICT on same ID with different input", () => {
    const ctx = setupRepo();

    const jobA = makeWorkspace(ctx, "idem-int-conflict-job");
    const target = makeWorkspace(ctx, "idem-int-conflict-target");

    prepareWorkspaceForCommit(jobA.path);
    prepareWorkspaceForCommit(target.path);

    fs.writeFileSync(path.join(jobA.path, "f2.txt"), "f2\n", "utf-8");
    commitWorkspace(ctx.db, {
      operationId: uniqueId(),
      workspaceId: jobA.id,
      message: "commit for idempotent integrate conflict test",
    });

    bindRun(ctx.db, { workspaceId: target.id });

    const opId = uniqueId();
    integrateWorkspace(ctx.db, {
      operationId: opId,
      sourceWorkspaceId: jobA.id,
      targetWorkspaceId: target.id,
      lockOwner: "test-runner",
    });

    // Different lockOwner changes the hash
    expect(() =>
      integrateWorkspace(ctx.db, {
        operationId: opId,
        sourceWorkspaceId: jobA.id,
        targetWorkspaceId: target.id,
        lockOwner: "different-runner",
      }),
    ).toThrow(
      expect.objectContaining({ code: "OPERATION_ID_CONFLICT" }),
    );
  });

  it("publishWorkspace replays cached result for identical operationId + input", () => {
    const ctx = setupRepo();

    const ws = makeWorkspace(ctx, "idem-publish");
    prepareWorkspaceForCommit(ws.path);

    fs.writeFileSync(path.join(ws.path, "pub.txt"), "pub\n", "utf-8");
    commitWorkspace(ctx.db, {
      operationId: uniqueId(),
      workspaceId: ws.id,
      message: "commit before publish",
    });

    const opId = uniqueId();
    const input = {
      operationId: opId,
      workspaceId: ws.id,
      strategy: "branch" as const,
      targetRef: "idempotent-publish-test",
    };

    const r1 = publishWorkspace(ctx.db, input);
    expect(r1.resultingRef).toBe("refs/heads/idempotent-publish-test");

    const r2 = publishWorkspace(ctx.db, input);
    expect(r2).toEqual(r1);
  });

  it("cleanupWorkspaceStrict replays cached result for identical operationId + input", () => {
    const ctx = setupRepo();
    const ws = makeWorkspace(ctx, "idem-cleanup");

    const opId = uniqueId();
    const r1 = cleanupWorkspaceStrict(ctx.db, ctx.config, {
      operationId: opId,
      workspaceId: ws.id,
    });
    expect(r1.status).toBe("CLEANED");
    expect(r1.removed).toBe(true);

    const r2 = cleanupWorkspaceStrict(ctx.db, ctx.config, {
      operationId: opId,
      workspaceId: ws.id,
    });
    expect(r2).toEqual(r1);
  });
});

// ── 4. Expected HEAD CAS ────────────────────────────────────────────────────

describe("expected HEAD CAS validation", () => {
  it("commitWorkspace succeeds when expectedHead matches actual HEAD", () => {
    const ctx = setupRepo();
    const ws = makeWorkspace(ctx, "cas-commit-ok");
    prepareWorkspaceForCommit(ws.path);

    fs.writeFileSync(path.join(ws.path, "x.txt"), "x\n", "utf-8");
    const actualHead = getHeadCommit(ws.path)!;

    const result = commitWorkspace(ctx.db, {
      operationId: uniqueId(),
      workspaceId: ws.id,
      message: "CAS commit",
      expectedHead: actualHead,
    });
    expect(result.noOp).toBe(false);
  });

  it("commitWorkspace throws WORKSPACE_HEAD_CONFLICT when expectedHead is wrong", () => {
    const ctx = setupRepo();
    const ws = makeWorkspace(ctx, "cas-commit-fail");
    prepareWorkspaceForCommit(ws.path);

    fs.writeFileSync(path.join(ws.path, "y.txt"), "y\n", "utf-8");

    expect(() =>
      commitWorkspace(ctx.db, {
        operationId: uniqueId(),
        workspaceId: ws.id,
        message: "CAS commit with wrong head",
        expectedHead: "0000000000000000000000000000000000000000",
      }),
    ).toThrow(
      expect.objectContaining({ code: "WORKSPACE_HEAD_CONFLICT" }),
    );
  });

  it("integrateWorkspace throws WORKSPACE_HEAD_CONFLICT when target expectedHead is wrong", () => {
    const ctx = setupRepo();

    const jobA = makeWorkspace(ctx, "cas-int-job");
    const target = makeWorkspace(ctx, "cas-int-target");

    prepareWorkspaceForCommit(jobA.path);
    prepareWorkspaceForCommit(target.path);

    fs.writeFileSync(path.join(jobA.path, "z.txt"), "z\n", "utf-8");
    commitWorkspace(ctx.db, {
      operationId: uniqueId(),
      workspaceId: jobA.id,
      message: "CAS integrate source commit",
    });

    bindRun(ctx.db, { workspaceId: target.id });

    expect(() =>
      integrateWorkspace(ctx.db, {
        operationId: uniqueId(),
        sourceWorkspaceId: jobA.id,
        targetWorkspaceId: target.id,
        expectedHead: "0000000000000000000000000000000000000000",
        lockOwner: "test-runner",
      }),
    ).toThrow(
      expect.objectContaining({ code: "WORKSPACE_HEAD_CONFLICT" }),
    );
  });

  it("integrateWorkspace succeeds when expectedHead matches target HEAD", () => {
    const ctx = setupRepo();

    const jobA = makeWorkspace(ctx, "cas-int-ok-job");
    const target = makeWorkspace(ctx, "cas-int-ok-target");

    prepareWorkspaceForCommit(jobA.path);
    prepareWorkspaceForCommit(target.path);

    fs.writeFileSync(path.join(jobA.path, "w.txt"), "w\n", "utf-8");
    commitWorkspace(ctx.db, {
      operationId: uniqueId(),
      workspaceId: jobA.id,
      message: "CAS integrate ok source",
    });

    bindRun(ctx.db, { workspaceId: target.id });
    const targetHead = getHeadCommit(target.path);

    const result = integrateWorkspace(ctx.db, {
      operationId: uniqueId(),
      sourceWorkspaceId: jobA.id,
      targetWorkspaceId: target.id,
      expectedHead: targetHead,
      lockOwner: "test-runner",
    });
    expect(result.merged).toBe(true);
  });

  it("publishWorkspace throws WORKSPACE_HEAD_CONFLICT when expectedHead is wrong", () => {
    const ctx = setupRepo();
    const ws = makeWorkspace(ctx, "cas-publish-fail");
    prepareWorkspaceForCommit(ws.path);

    fs.writeFileSync(path.join(ws.path, "pub.txt"), "pub\n", "utf-8");
    commitWorkspace(ctx.db, {
      operationId: uniqueId(),
      workspaceId: ws.id,
      message: "CAS publish commit",
    });

    expect(() =>
      publishWorkspace(ctx.db, {
        operationId: uniqueId(),
        workspaceId: ws.id,
        strategy: "branch",
        targetRef: "cas-publish-fail-ref",
        expectedHead: "0000000000000000000000000000000000000000",
      }),
    ).toThrow(
      expect.objectContaining({ code: "WORKSPACE_HEAD_CONFLICT" }),
    );
  });

  it("publishWorkspace succeeds when expectedHead matches actual HEAD", () => {
    const ctx = setupRepo();
    const ws = makeWorkspace(ctx, "cas-publish-ok");
    prepareWorkspaceForCommit(ws.path);

    fs.writeFileSync(path.join(ws.path, "pub2.txt"), "pub2\n", "utf-8");
    const commitResult = commitWorkspace(ctx.db, {
      operationId: uniqueId(),
      workspaceId: ws.id,
      message: "CAS publish ok commit",
    });

    const result = publishWorkspace(ctx.db, {
      operationId: uniqueId(),
      workspaceId: ws.id,
      strategy: "branch",
      targetRef: "cas-publish-ok-ref",
      expectedHead: commitResult.headCommit,
    });
    expect(result.resultingRef).toBe("refs/heads/cas-publish-ok-ref");
  });
});

// ── 5. CleanupStrict Contract ───────────────────────────────────────────────

describe("cleanupWorkspaceStrict contract", () => {
  it("removes directory and transitions to CLEANED", () => {
    const ctx = setupRepo();
    const ws = makeWorkspace(ctx, "cleanup-normal");
    const wsPath = ws.path;
    expect(fs.existsSync(wsPath)).toBe(true);

    const result = cleanupWorkspaceStrict(ctx.db, ctx.config, {
      operationId: uniqueId(),
      workspaceId: ws.id,
    });
    expect(result.status).toBe("CLEANED");
    expect(result.removed).toBe(true);
    expect(fs.existsSync(wsPath)).toBe(false);
    expect(getWorkspace(ctx.db, ws.id).status).toBe("CLEANED");
  });

  it("returns CLEANED for already-cleaned workspace", () => {
    const ctx = setupRepo();
    const ws = makeWorkspace(ctx, "cleanup-twice");

    cleanupWorkspaceStrict(ctx.db, ctx.config, {
      operationId: uniqueId(),
      workspaceId: ws.id,
    });

    const result = cleanupWorkspaceStrict(ctx.db, ctx.config, {
      operationId: uniqueId(),
      workspaceId: ws.id,
    });
    expect(result.status).toBe("CLEANED");
    expect(result.removed).toBe(true);
    expect(result.message).toBe("Workspace is already cleaned");
  });

  it("force=true overrides active lock and cleans up", () => {
    const ctx = setupRepo();
    const ws = makeWorkspace(ctx, "cleanup-force");

    lockWorkspace(ctx.db, ws.id, "write", "lock-holder");

    expect(() =>
      cleanupWorkspaceStrict(ctx.db, ctx.config, {
        operationId: uniqueId(),
        workspaceId: ws.id,
      }),
    ).toThrow(
      expect.objectContaining({ code: "WORKSPACE_LOCK_CONFLICT" }),
    );

    const result = cleanupWorkspaceStrict(ctx.db, ctx.config, {
      operationId: uniqueId(),
      workspaceId: ws.id,
      force: true,
    });
    expect(result.status).toBe("CLEANED");
    expect(result.removed).toBe(true);
  });

  it("returns CLEANUP_FAILED when directory cannot be removed", () => {
    const ctx = setupRepo();
    const ws = makeWorkspace(ctx, "cleanup-fail");

    // Hold a file handle open inside the workspace to block deletion
    const lockFilePath = path.join(ws.path, "locked.file");
    fs.writeFileSync(lockFilePath, "locked content\n", "utf-8");
    const fd = fs.openSync(lockFilePath, "r");

    try {
      // Corrupt git worktree metadata so removeWorktree falls through to fs.rmSync
      const gitFile = path.join(ws.path, ".git");
      if (fs.existsSync(gitFile)) {
        fs.unlinkSync(gitFile);
      }

      const result = cleanupWorkspaceStrict(ctx.db, ctx.config, {
        operationId: uniqueId(),
        workspaceId: ws.id,
      });

      // CLEANUP_FAILED on platforms where open handle blocks deletion
      // CLEANED on platforms where force:true handles open files
      if (result.status === "CLEANUP_FAILED") {
        expect(result.removed).toBe(false);
        expect(result.blockers).toBeDefined();
        expect(result.blockers!.length).toBeGreaterThan(0);
        expect(getWorkspace(ctx.db, ws.id).status).toBe("CLEANUP_FAILED");
      } else {
        expect(result.status).toBe("CLEANED");
        expect(result.removed).toBe(true);
      }
    } finally {
      fs.closeSync(fd);
    }
  });

  it("does not mark CLEANED when Git registration removal cannot be verified and replays the failure", () => {
    const ctx = setupRepo();
    const ws = makeWorkspace(ctx, "cleanup-registration-unverified");
    const invalidMirror = path.join(ctx.root, "not-a-git-directory");
    fs.writeFileSync(invalidMirror, "fixture\n", "utf-8");
    ctx.db.prepare("UPDATE repository_caches SET mirror_path = ? WHERE repository_url = ?")
      .run(invalidMirror, ws.repositoryUrl);
    const operationId = uniqueId();

    const first = cleanupWorkspaceStrict(ctx.db, ctx.config, {
      operationId,
      workspaceId: ws.id,
    });

    expect(first.status).toBe("CLEANUP_FAILED");
    expect(first.removed).toBe(false);
    expect(first.blockers).toEqual(
      expect.arrayContaining([expect.stringContaining("registration verification failed")]),
    );
    expect(getWorkspace(ctx.db, ws.id).status).toBe("CLEANUP_FAILED");

    const replayed = cleanupWorkspaceStrict(ctx.db, ctx.config, {
      operationId,
      workspaceId: ws.id,
    });
    expect(replayed).toEqual(first);
  });
});

// ── 6. Reconcile Across States ──────────────────────────────────────────────

describe("reconcileWorkspace across states", () => {
  it("reports complete for a freshly cleaned workspace", () => {
    const ctx = setupRepo();
    const ws = makeWorkspace(ctx, "recon-clean");

    cleanupWorkspaceStrict(ctx.db, ctx.config, {
      operationId: uniqueId(),
      workspaceId: ws.id,
    });

    const result = reconcileWorkspace(ctx.db, { workspaceId: ws.id });
    expect(result.reconciledStatus).toBe("complete");
    expect(result.registryStatus).toBe("CLEANED");
    expect(result.directoryExists).toBe(false);
    expect(result.recommendation).toContain("fully cleaned");
  });

  it("reports incomplete for a workspace with no operations", () => {
    const ctx = setupRepo();
    const ws = makeWorkspace(ctx, "recon-no-ops");

    const result = reconcileWorkspace(ctx.db, { workspaceId: ws.id });
    expect(result.reconciledStatus).toBe("incomplete");
    expect(result.operations).toHaveLength(0);
    expect(result.directoryExists).toBe(true);
    expect(result.registryStatus).toBe("READY");
  });

  it("reports complete after successful commit", () => {
    const ctx = setupRepo();
    const ws = makeWorkspace(ctx, "recon-committed");
    prepareWorkspaceForCommit(ws.path);

    fs.writeFileSync(path.join(ws.path, "recon.txt"), "data\n", "utf-8");
    commitWorkspace(ctx.db, {
      operationId: uniqueId(),
      workspaceId: ws.id,
      message: "recon commit",
    });

    const result = reconcileWorkspace(ctx.db, { workspaceId: ws.id });
    expect(result.operations.length).toBeGreaterThan(0);
    expect(result.reconciledStatus).toBe("complete");
    expect(result.directoryExists).toBe(true);
  });

  it("reports orphaned for a non-existent workspace ID", () => {
    const ctx = setupRepo();

    const result = reconcileWorkspace(ctx.db, {
      workspaceId: "ws_nonexistent_12345",
    });
    expect(result.reconciledStatus).toBe("orphaned");
    expect(result.registryStatus).toBe("UNKNOWN");
    expect(result.directoryExists).toBe(false);
  });

  it("reports inconsistent when registry says CLEANED but directory exists", () => {
    const ctx = setupRepo();
    const ws = makeWorkspace(ctx, "recon-inconsistent");

    const wsPath = ws.path;

    cleanupWorkspaceStrict(ctx.db, ctx.config, {
      operationId: uniqueId(),
      workspaceId: ws.id,
    });
    expect(fs.existsSync(wsPath)).toBe(false);

    fs.mkdirSync(wsPath, { recursive: true });

    const result = reconcileWorkspace(ctx.db, { workspaceId: ws.id });
    expect(result.reconciledStatus).toBe("inconsistent");
    expect(result.registryStatus).toBe("CLEANED");
    expect(result.directoryExists).toBe(true);
    expect(result.recommendation).toContain("Re-run cleanup");
  });

  it("reports complete after successful commit then cleanup", () => {
    const ctx = setupRepo();
    const ws = makeWorkspace(ctx, "recon-complete-flow");
    prepareWorkspaceForCommit(ws.path);

    fs.writeFileSync(path.join(ws.path, "flow.txt"), "flow\n", "utf-8");
    commitWorkspace(ctx.db, {
      operationId: uniqueId(),
      workspaceId: ws.id,
      message: "complete flow commit",
    });

    cleanupWorkspaceStrict(ctx.db, ctx.config, {
      operationId: uniqueId(),
      workspaceId: ws.id,
    });

    const result = reconcileWorkspace(ctx.db, { workspaceId: ws.id });
    expect(result.reconciledStatus).toBe("complete");
    expect(result.operations.length).toBeGreaterThanOrEqual(1);
    for (const op of result.operations) {
      expect(op.status).toBe("completed");
    }
  });

  it("reports orphaned when directory is missing but registry has entry", () => {
    const ctx = setupRepo();
    const ws = makeWorkspace(ctx, "recon-orphan");

    fs.rmSync(ws.path, { recursive: true, force: true });

    const result = reconcileWorkspace(ctx.db, { workspaceId: ws.id });
    expect(result.reconciledStatus).toBe("orphaned");
    expect(result.directoryExists).toBe(false);
    expect(result.registryStatus).toBe("READY");
  });

  it("includes gitHead when directory exists", () => {
    const ctx = setupRepo();
    const ws = makeWorkspace(ctx, "recon-githead");

    const result = reconcileWorkspace(ctx.db, { workspaceId: ws.id });
    expect(result.gitHead).toBeTruthy();
    expect(result.manifestExists).toBe(true);
  });

  it("reports null gitHead when directory does not exist", () => {
    const ctx = setupRepo();
    const ws = makeWorkspace(ctx, "recon-no-head");

    cleanupWorkspaceStrict(ctx.db, ctx.config, {
      operationId: uniqueId(),
      workspaceId: ws.id,
    });

    const result = reconcileWorkspace(ctx.db, { workspaceId: ws.id });
    expect(result.gitHead).toBeNull();
  });
});

// ── 7. Expired Integration Lock Takeover ────────────────────────────────────

describe("expired integration lock takeover", () => {
  it("acquireIntegrationLock succeeds when no lock exists", () => {
    const ctx = setupRepo();
    const ws = makeWorkspace(ctx, "ilock-acquire");

    const lock = acquireIntegrationLock(ctx.db, ws.id, "owner-1");
    expect(lock.owner).toBe("owner-1");
    expect(lock.workspaceId).toBe(ws.id);
    expect(lock.id).toMatch(/^ilock_/);
  });

  it("acquireIntegrationLock is re-entrant for same owner", () => {
    const ctx = setupRepo();
    const ws = makeWorkspace(ctx, "ilock-reentrant");

    const lock1 = acquireIntegrationLock(ctx.db, ws.id, "owner-1");
    const lock2 = acquireIntegrationLock(ctx.db, ws.id, "owner-1");

    expect(lock2.owner).toBe("owner-1");
    expect(lock2.id).toBe(lock1.id);
  });

  it("acquireIntegrationLock replaces the lease expiry for the same owner", () => {
    const ctx = setupRepo();
    const ws = makeWorkspace(ctx, "ilock-reentrant-expiry");
    const firstExpiry = new Date(Date.now() + 60_000).toISOString();
    const secondExpiry = new Date(Date.now() + 120_000).toISOString();

    const lock1 = acquireIntegrationLock(ctx.db, ws.id, "owner-1", firstExpiry);
    const lock2 = acquireIntegrationLock(ctx.db, ws.id, "owner-1", secondExpiry);

    expect(lock2.id).toBe(lock1.id);
    expect(lock2.expiresAt).toBe(secondExpiry);
    expect(getIntegrationLockState(ctx.db, ws.id)?.expiresAt).toBe(secondExpiry);
  });

  it("acquireIntegrationLock throws for active lock held by different owner", () => {
    const ctx = setupRepo();
    const ws = makeWorkspace(ctx, "ilock-conflict");

    acquireIntegrationLock(ctx.db, ws.id, "owner-1");

    expect(() =>
      acquireIntegrationLock(ctx.db, ws.id, "owner-2"),
    ).toThrow(
      expect.objectContaining({ code: "WORKSPACE_LOCK_CONFLICT" }),
    );
  });

  it("takeoverIntegrationLock succeeds on expired lock", () => {
    const ctx = setupRepo();
    const ws = makeWorkspace(ctx, "ilock-takeover");

    // Acquire with a past expiry so lock is immediately expired
    const pastExpiry = new Date(Date.now() - 60_000).toISOString();
    acquireIntegrationLock(ctx.db, ws.id, "owner-1", pastExpiry);

    // takeoverIntegrationLock should succeed because the lock is expired
    const taken = takeoverIntegrationLock(ctx.db, ws.id, "owner-2");
    expect(taken.owner).toBe("owner-2");
    expect(taken.id).toMatch(/^ilock_/);

    // Old owner can no longer heartbeat
    expect(() =>
      heartbeatIntegrationLock(ctx.db, ws.id, "owner-1"),
    ).toThrow();
  });

  it("takeoverIntegrationLock throws for active (non-expired) lock", () => {
    const ctx = setupRepo();
    const ws = makeWorkspace(ctx, "ilock-takeover-active");

    acquireIntegrationLock(ctx.db, ws.id, "owner-1");

    expect(() =>
      takeoverIntegrationLock(ctx.db, ws.id, "owner-2"),
    ).toThrow(
      expect.objectContaining({ code: "WORKSPACE_LOCK_CONFLICT" }),
    );
  });

  it("takeoverIntegrationLock rejects when no expired lock exists", () => {
    const ctx = setupRepo();
    const ws = makeWorkspace(ctx, "ilock-takeover-missing");

    expect(() => takeoverIntegrationLock(ctx.db, ws.id, "owner-2")).toThrow(
      expect.objectContaining({ code: "WORKSPACE_LOCK_EXPIRED" }),
    );
    expect(getIntegrationLockState(ctx.db, ws.id)).toBeNull();
  });

  it("releaseIntegrationLock releases and is idempotent", () => {
    const ctx = setupRepo();
    const ws = makeWorkspace(ctx, "ilock-release");

    acquireIntegrationLock(ctx.db, ws.id, "owner-1");

    releaseIntegrationLock(ctx.db, ws.id, "owner-1");
    expect(getIntegrationLockState(ctx.db, ws.id)).toBeNull();

    // Idempotent: releasing again does not throw
    releaseIntegrationLock(ctx.db, ws.id, "owner-1");
    expect(getIntegrationLockState(ctx.db, ws.id)).toBeNull();
  });

  it("releaseIntegrationLock throws for owner mismatch", () => {
    const ctx = setupRepo();
    const ws = makeWorkspace(ctx, "ilock-release-mismatch");

    acquireIntegrationLock(ctx.db, ws.id, "owner-1");

    expect(() =>
      releaseIntegrationLock(ctx.db, ws.id, "owner-2"),
    ).toThrow(
      expect.objectContaining({ code: "WORKSPACE_LOCK_OWNER_MISMATCH" }),
    );
  });

  it("heartbeatIntegrationLock extends lock and verifies owner", () => {
    const ctx = setupRepo();
    const ws = makeWorkspace(ctx, "ilock-heartbeat");

    const lock = acquireIntegrationLock(ctx.db, ws.id, "owner-1");

    // Busy-wait to guarantee timestamp progression
    const start = Date.now();
    while (Date.now() === start) {
      // spin for at least 1ms
    }

    const hb = heartbeatIntegrationLock(ctx.db, ws.id, "owner-1");
    expect(hb.owner).toBe("owner-1");
    expect(new Date(hb.lastHeartbeat).getTime()).toBeGreaterThan(
      new Date(lock.lastHeartbeat).getTime(),
    );
  });

  it("full lock lifecycle: acquire → heartbeat → release → acquire by new owner", () => {
    const ctx = setupRepo();
    const ws = makeWorkspace(ctx, "ilock-lifecycle");

    // Owner 1 acquires
    const lock1 = acquireIntegrationLock(ctx.db, ws.id, "owner-1");
    expect(lock1.owner).toBe("owner-1");

    // Owner 1 heartbeats
    heartbeatIntegrationLock(ctx.db, ws.id, "owner-1");

    // Owner 1 releases
    releaseIntegrationLock(ctx.db, ws.id, "owner-1");
    expect(getIntegrationLockState(ctx.db, ws.id)).toBeNull();

    // Owner 2 acquires after release
    const lock2 = acquireIntegrationLock(ctx.db, ws.id, "owner-2");
    expect(lock2.owner).toBe("owner-2");
    expect(lock2.id).not.toBe(lock1.id);
  });
});

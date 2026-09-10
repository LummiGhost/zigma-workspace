import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { getConfig, ensureStateDirs } from "../../src/config/index.js";
import { closeDb, openDb } from "../../src/db/index.js";
import { prepareRun, prepareJob } from "../../src/core/provider.js";
import { commitWorkspace } from "../../src/core/commit.js";
import { integrateWorkspace } from "../../src/core/integrate.js";
import { publishWorkspace } from "../../src/core/publish.js";
import { getWorkspace, listAllWorkspaces } from "../../src/core/workspace.js";
import { acquireIntegrationLock, releaseIntegrationLock } from "../../src/core/integration-lock.js";
import { transition } from "../../src/core/state-machine.js";
import { getHeadCommit } from "../../src/git/index.js";
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zigma-lifecycle-"));
  tempDirs.push(root);
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "lifecycle@example.test");
  git(repo, "config", "user.name", "lifecycle-test");
  git(repo, "config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(repo, "README.md"), "# lifecycle repo\n", "utf-8");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "initial");
  const baseCommit = git(repo, "rev-parse", "HEAD");

  const stateDir = path.join(root, "state");
  const config = getConfig(stateDir);
  ensureStateDirs(config);
  const db = openDb(config);

  return { root, repo, stateDir, config, db, baseCommit };
}

function uniqueId(): string {
  return crypto.randomUUID();
}

function verifyArtifact(artifact: { uri: string; digest: string } | undefined, expectedBytes?: number): void {
  expect(artifact).toBeDefined();
  if (!artifact) return;
  expect(artifact.mediaType).toBe("text/x-diff");
  const filePath = fileURLToPath(artifact.uri);
  expect(fs.existsSync(filePath)).toBe(true);
  const content = fs.readFileSync(filePath, "utf-8");
  const digest = crypto.createHash("sha256").update(content, "utf-8").digest("hex");
  expect(`sha256:${digest}`).toBe(artifact.digest);
  if (expectedBytes !== undefined) {
    expect(Buffer.byteLength(content, "utf-8")).toBe(expectedBytes);
  }
}

afterEach(() => {
  closeDb();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── prepareRun ───────────────────────────────────────────────────────────────

describe("prepareRun", () => {
  it("creates a flow/<runId> Run workspace at the base commit and binds it", () => {
    const ctx = setupRepo();
    const run = prepareRun(ctx.db, ctx.config, {
      operationId: uniqueId(),
      runId: "run-123",
      repositoryUrl: ctx.repo,
      baseRef: "main",
    });

    expect(run.branch).toBe("flow/run-123");
    expect(run.baseCommit).toBe(ctx.baseCommit);
    expect(run.mode).toBe("writable");
    expect(run.status).toBe("RUNNING");
    expect(getHeadCommit(run.path)).toBe(ctx.baseCommit);

    const ws = getWorkspace(ctx.db, run.workspaceId);
    expect(ws.flowRunId).toBe("run-123");
    expect(ws.branch).toBe("flow/run-123");
  });

  it("replays the same operationId and adopts the workspace on retry after crash", () => {
    const ctx = setupRepo();
    const operationId = uniqueId();
    const first = prepareRun(ctx.db, ctx.config, {
      operationId,
      runId: "run-replay",
      repositoryUrl: ctx.repo,
      baseRef: "main",
    });

    // Same operationId + same input: replay, no new workspace.
    const replay = prepareRun(ctx.db, ctx.config, {
      operationId,
      runId: "run-replay",
      repositoryUrl: ctx.repo,
      baseRef: "main",
    });
    expect(replay.workspaceId).toBe(first.workspaceId);
    expect(listAllWorkspaces(ctx.db).filter((w) => w.branch === "flow/run-replay")).toHaveLength(1);

    // New operationId (simulated crash before idempotency recording): adopt
    // the existing workspace deterministically.
    const adopted = prepareRun(ctx.db, ctx.config, {
      operationId: uniqueId(),
      runId: "run-replay",
      repositoryUrl: ctx.repo,
      baseRef: "main",
    });
    expect(adopted.workspaceId).toBe(first.workspaceId);
    expect(listAllWorkspaces(ctx.db).filter((w) => w.branch === "flow/run-replay")).toHaveLength(1);
  });

  it("rejects a reused operationId with different input", () => {
    const ctx = setupRepo();
    const operationId = uniqueId();
    prepareRun(ctx.db, ctx.config, {
      operationId,
      runId: "run-conflict",
      repositoryUrl: ctx.repo,
      baseRef: "main",
    });
    expect(() =>
      prepareRun(ctx.db, ctx.config, {
        operationId,
        runId: "run-conflict",
        repositoryUrl: ctx.repo,
        baseRef: "other-ref",
      }),
    ).toThrow(expect.objectContaining({ code: "OPERATION_ID_CONFLICT" }));
  });

  it("fails CAS when the base ref resolves to an unexpected commit", () => {
    const ctx = setupRepo();
    expect(() =>
      prepareRun(ctx.db, ctx.config, {
        operationId: uniqueId(),
        runId: "run-cas",
        repositoryUrl: ctx.repo,
        baseRef: "main",
        expectedBaseCommit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      }),
    ).toThrow(expect.objectContaining({ code: "WORKSPACE_HEAD_CONFLICT" }));
    expect(listAllWorkspaces(ctx.db)).toHaveLength(0);
  });
});

// ── prepareJob ───────────────────────────────────────────────────────────────

describe("prepareJob", () => {
  it("creates a flow/<runId>/<jobId>/a<attempt> workspace from the exact Run HEAD", () => {
    const ctx = setupRepo();
    const run = prepareRun(ctx.db, ctx.config, {
      operationId: uniqueId(),
      runId: "run-jobs",
      repositoryUrl: ctx.repo,
      baseRef: "main",
    });

    const job = prepareJob(ctx.db, ctx.config, {
      operationId: uniqueId(),
      runId: "run-jobs",
      runWorkspaceId: run.workspaceId,
      jobId: "implement",
      attempt: 1,
      expectedRunHead: ctx.baseCommit,
    });

    expect(job.branch).toBe("job/run-jobs/implement/a1");
    expect(job.baseCommit).toBe(ctx.baseCommit);
    expect(getHeadCommit(job.path)).toBe(ctx.baseCommit);

    const ws = getWorkspace(ctx.db, job.workspaceId);
    expect(ws.jobId).toBe("implement");
    expect(ws.flowRunId).toBe("run-jobs");
  });

  it("replays and adopts like prepareRun", () => {
    const ctx = setupRepo();
    const run = prepareRun(ctx.db, ctx.config, {
      operationId: uniqueId(),
      runId: "run-adopt",
      repositoryUrl: ctx.repo,
      baseRef: "main",
    });
    const operationId = uniqueId();
    const input = {
      operationId,
      runId: "run-adopt",
      runWorkspaceId: run.workspaceId,
      jobId: "job",
      attempt: 1,
      expectedRunHead: ctx.baseCommit,
    };
    const first = prepareJob(ctx.db, ctx.config, input);
    const replay = prepareJob(ctx.db, ctx.config, input);
    expect(replay.workspaceId).toBe(first.workspaceId);

    const adopted = prepareJob(ctx.db, ctx.config, { ...input, operationId: uniqueId() });
    expect(adopted.workspaceId).toBe(first.workspaceId);
  });

  it("rejects a run workspace owned by a different flow run", () => {
    const ctx = setupRepo();
    const run = prepareRun(ctx.db, ctx.config, {
      operationId: uniqueId(),
      runId: "run-owner",
      repositoryUrl: ctx.repo,
      baseRef: "main",
    });
    expect(() =>
      prepareJob(ctx.db, ctx.config, {
        operationId: uniqueId(),
        runId: "other-run",
        runWorkspaceId: run.workspaceId,
        jobId: "job",
        attempt: 1,
        expectedRunHead: ctx.baseCommit,
      }),
    ).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("rejects an expectedRunHead outside the Run history and invalid attempt numbers", () => {
    const ctx = setupRepo();
    const run = prepareRun(ctx.db, ctx.config, {
      operationId: uniqueId(),
      runId: "run-stale",
      repositoryUrl: ctx.repo,
      baseRef: "main",
    });

    // A commit that exists in the repo but is not the Run HEAD: advance the
    // source repo so the mirror has a newer commit.
    fs.writeFileSync(path.join(ctx.repo, "upstream.txt"), "new\n", "utf-8");
    git(ctx.repo, "add", ".");
    git(ctx.repo, "commit", "-m", "upstream advance");
    const upstreamHead = git(ctx.repo, "rev-parse", "HEAD");

    expect(() =>
      prepareJob(ctx.db, ctx.config, {
        operationId: uniqueId(),
        runId: "run-stale",
        runWorkspaceId: run.workspaceId,
        jobId: "job",
        attempt: 1,
        expectedRunHead: upstreamHead,
      }),
    ).toThrow(expect.objectContaining({ code: "WORKSPACE_HEAD_CONFLICT" }));

    // A full SHA that does not exist anywhere.
    expect(() =>
      prepareJob(ctx.db, ctx.config, {
        operationId: uniqueId(),
        runId: "run-stale",
        runWorkspaceId: run.workspaceId,
        jobId: "job",
        attempt: 1,
        expectedRunHead: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      }),
    ).toThrow(expect.objectContaining({ code: "WORKSPACE_HEAD_CONFLICT" }));

    expect(() =>
      prepareJob(ctx.db, ctx.config, {
        operationId: uniqueId(),
        runId: "run-stale",
        runWorkspaceId: run.workspaceId,
        jobId: "job",
        attempt: 0,
        expectedRunHead: ctx.baseCommit,
      }),
    ).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });
});

// ── Full Run + Job-attempt lifecycle ─────────────────────────────────────────

describe("Run + Job-attempt lifecycle", () => {
  it("commits, integrates with CAS serialization, and publishes with evidence artifacts", () => {
    const ctx = setupRepo();
    const runOp = uniqueId();
    const run = prepareRun(ctx.db, ctx.config, {
      operationId: runOp,
      runId: "run-life",
      repositoryUrl: ctx.repo,
      baseRef: "main",
    });

    const jobA = prepareJob(ctx.db, ctx.config, {
      operationId: uniqueId(),
      runId: "run-life",
      runWorkspaceId: run.workspaceId,
      jobId: "job-a",
      attempt: 1,
      expectedRunHead: run.baseCommit,
    });
    const jobB = prepareJob(ctx.db, ctx.config, {
      operationId: uniqueId(),
      runId: "run-life",
      runWorkspaceId: run.workspaceId,
      jobId: "job-b",
      attempt: 1,
      expectedRunHead: run.baseCommit,
    });

    // The provider excludes the workspace manifest from staging itself
    // (per-worktree info/exclude), so no gitignore setup is needed here.
    fs.writeFileSync(path.join(jobA.path, "file-a.txt"), "from job A\n", "utf-8");
    const commitAOp = uniqueId();
    const commitA = commitWorkspace(ctx.db, {
      operationId: commitAOp,
      workspaceId: jobA.workspaceId,
      message: "job-a: add file-a",
      expectedState: "RUNNING",
    });
    expect(commitA.noOp).toBe(false);
    expect(commitA.changedFiles).toContain("file-a.txt");
    expect(commitA.changedFiles).not.toContain(".zigma-workspace.json");
    expect(commitA.baseCommit).toBe(run.baseCommit);
    verifyArtifact(commitA.artifact);

    // Job B changes file B
    fs.writeFileSync(path.join(jobB.path, "file-b.txt"), "from job B\n", "utf-8");
    const commitBOp = uniqueId();
    const commitB = commitWorkspace(ctx.db, {
      operationId: commitBOp,
      workspaceId: jobB.workspaceId,
      message: "job-b: add file-b",
    });
    expect(commitB.noOp).toBe(false);

    // Commit replay does not create a second commit.
    const commitsBeforeReplay = git(jobA.path, "rev-list", "--count", "HEAD");
    const replayCommit = commitWorkspace(ctx.db, {
      operationId: commitAOp,
      workspaceId: jobA.workspaceId,
      message: "job-a: add file-a",
      expectedState: "RUNNING",
    });
    expect(replayCommit.headCommit).toBe(commitA.headCommit);
    expect(git(jobA.path, "rev-list", "--count", "HEAD")).toBe(commitsBeforeReplay);

    // Integrate A into the Run workspace.
    const integrateA = integrateWorkspace(ctx.db, {
      operationId: uniqueId(),
      sourceWorkspaceId: jobA.workspaceId,
      targetWorkspaceId: run.workspaceId,
      expectedHead: run.baseCommit,
      lockOwner: "flow-engine",
    });
    expect(integrateA.merged).toBe(true);
    expect(integrateA.previousTargetHead).toBe(run.baseCommit);
    expect(integrateA.changedFiles).toContain("file-a.txt");
    verifyArtifact(integrateA.artifact);
    const runHeadAfterA = integrateA.resultingCommit;

    // Stale CAS: integrate B against the old Run HEAD must fail.
    expect(() =>
      integrateWorkspace(ctx.db, {
        operationId: uniqueId(),
        sourceWorkspaceId: jobB.workspaceId,
        targetWorkspaceId: run.workspaceId,
        expectedHead: run.baseCommit,
        lockOwner: "flow-engine",
      }),
    ).toThrow(expect.objectContaining({ code: "WORKSPACE_HEAD_CONFLICT" }));

    // Retry B with the current Run HEAD (serialized, commit-based).
    // integrate resumes a MERGED target implicitly — no advance step.
    const integrateB = integrateWorkspace(ctx.db, {
      operationId: uniqueId(),
      sourceWorkspaceId: jobB.workspaceId,
      targetWorkspaceId: run.workspaceId,
      expectedHead: runHeadAfterA,
      lockOwner: "flow-engine",
    });
    expect(integrateB.merged).toBe(true);
    const finalHead = integrateB.resultingCommit;

    // The Run workspace contains both changes (toContain sidesteps CRLF
    // checkout conversion on Windows).
    expect(fs.readFileSync(path.join(run.path, "file-a.txt"), "utf-8")).toContain("from job A");
    expect(fs.readFileSync(path.join(run.path, "file-b.txt"), "utf-8")).toContain("from job B");

    // Publish the Run branch.
    const publishOp = uniqueId();
    const published = publishWorkspace(ctx.db, {
      operationId: publishOp,
      workspaceId: run.workspaceId,
      strategy: "branch",
      targetRef: `flow/run-life`,
      expectedHead: finalHead,
    });
    expect(published.resultingRef).toBe("refs/heads/flow/run-life");
    expect(published.resultingCommit).toBe(finalHead);
    expect(published.changedFiles).toEqual(expect.arrayContaining(["file-a.txt", "file-b.txt"]));
    verifyArtifact(published.artifact);

    // The remote (source repository) ref now points at the published commit.
    expect(git(ctx.repo, "rev-parse", "flow/run-life")).toBe(finalHead);

    // Publish replay: same operationId returns the original result.
    const replayPublish = publishWorkspace(ctx.db, {
      operationId: publishOp,
      workspaceId: run.workspaceId,
      strategy: "branch",
      targetRef: `flow/run-life`,
      expectedHead: finalHead,
    });
    expect(replayPublish.resultingCommit).toBe(finalHead);

    // A second publish with a fresh operation id (the ref already points at
    // the published commit, as after a crash between push and result
    // recording) still reports the full change set: the evidence base falls
    // back to the creation base instead of producing an empty diff.
    const republish = publishWorkspace(ctx.db, {
      operationId: uniqueId(),
      workspaceId: run.workspaceId,
      strategy: "branch",
      targetRef: `flow/run-life`,
      expectedHead: finalHead,
    });
    expect(republish.changedFiles).toEqual(expect.arrayContaining(["file-a.txt", "file-b.txt"]));
    verifyArtifact(republish.artifact);

    // Target refs outside refs/heads/ are rejected before any refspec is
    // built: the raw name is pushed verbatim, so a refs/tags/* escape must
    // not reach git.
    expect(() =>
      publishWorkspace(ctx.db, {
        operationId: uniqueId(),
        workspaceId: run.workspaceId,
        strategy: "branch",
        targetRef: "refs/tags/evil",
        expectedHead: finalHead,
      }),
    ).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("restores the Run HEAD on same-line conflict and preserves structured evidence", () => {
    const ctx = setupRepo();

    fs.writeFileSync(
      path.join(ctx.repo, "conflict.txt"),
      "line 1\nline 2\nline 3\n",
      "utf-8",
    );
    git(ctx.repo, "add", ".");
    git(ctx.repo, "commit", "-m", "add conflict file");
    const newBase = git(ctx.repo, "rev-parse", "HEAD");

    const run = prepareRun(ctx.db, ctx.config, {
      operationId: uniqueId(),
      runId: "run-conflict",
      repositoryUrl: ctx.repo,
      baseRef: "main",
    });
    expect(run.baseCommit).toBe(newBase);

    const jobA = prepareJob(ctx.db, ctx.config, {
      operationId: uniqueId(),
      runId: "run-conflict",
      runWorkspaceId: run.workspaceId,
      jobId: "job-a",
      attempt: 1,
      expectedRunHead: newBase,
    });
    const jobB = prepareJob(ctx.db, ctx.config, {
      operationId: uniqueId(),
      runId: "run-conflict",
      runWorkspaceId: run.workspaceId,
      jobId: "job-b",
      attempt: 1,
      expectedRunHead: newBase,
    });

    // A edits line 2
    fs.writeFileSync(
      path.join(jobA.path, "conflict.txt"),
      "line 1\nline 2 by A\nline 3\n",
      "utf-8",
    );
    const commitA = commitWorkspace(ctx.db, {
      operationId: uniqueId(),
      workspaceId: jobA.workspaceId,
      message: "job-a: edit line 2",
    });
    expect(commitA.noOp).toBe(false);

    // B edits line 2 differently (based on the same old Run HEAD)
    fs.writeFileSync(
      path.join(jobB.path, "conflict.txt"),
      "line 1\nline 2 by B\nline 3\n",
      "utf-8",
    );
    const commitB = commitWorkspace(ctx.db, {
      operationId: uniqueId(),
      workspaceId: jobB.workspaceId,
      message: "job-b: edit line 2 differently",
    });
    expect(commitB.noOp).toBe(false);

    // A integrates cleanly.
    const integrateA = integrateWorkspace(ctx.db, {
      operationId: uniqueId(),
      sourceWorkspaceId: jobA.workspaceId,
      targetWorkspaceId: run.workspaceId,
      expectedHead: newBase,
      lockOwner: "flow-engine",
    });
    expect(integrateA.merged).toBe(true);
    const runHeadAfterA = integrateA.resultingCommit;

    // B conflicts on the same line (integrate resumes the MERGED target).
    const conflictOp = uniqueId();
    const conflict = integrateWorkspace(ctx.db, {
      operationId: conflictOp,
      sourceWorkspaceId: jobB.workspaceId,
      targetWorkspaceId: run.workspaceId,
      expectedHead: runHeadAfterA,
      lockOwner: "flow-engine",
    });

    expect("conflictFiles" in conflict).toBe(true);
    if ("conflictFiles" in conflict) {
      expect(conflict.conflictFiles).toEqual(["conflict.txt"]);
      expect(conflict.previousTargetHead).toBe(runHeadAfterA);
      expect(conflict.sourceCommit).toBe(commitB.headCommit);
      expect(conflict.message).toContain("Merge conflict");
    }

    // Run workspace restored to the pre-integration HEAD.
    expect(getHeadCommit(run.path)).toBe(runHeadAfterA);
    expect(fs.readFileSync(path.join(run.path, "conflict.txt"), "utf-8")).toContain("line 2 by A");

    // Job B's workspace and commit are preserved for diagnosis.
    expect(fs.existsSync(jobB.path)).toBe(true);
    expect(getHeadCommit(jobB.path)).toBe(commitB.headCommit);
    expect(getWorkspace(ctx.db, jobB.workspaceId).status).toBe("RUNNING");
    expect(getWorkspace(ctx.db, run.workspaceId).status).toBe("CONFLICT");

    // The conflict result replays identically (idempotency is checked before
    // any state transition, so the CONFLICT state does not matter here).
    const replay = integrateWorkspace(ctx.db, {
      operationId: conflictOp,
      sourceWorkspaceId: jobB.workspaceId,
      targetWorkspaceId: run.workspaceId,
      expectedHead: runHeadAfterA,
      lockOwner: "flow-engine",
    });
    if ("conflictFiles" in replay) {
      expect(replay.conflictFiles).toEqual(["conflict.txt"]);
      expect(replay.previousTargetHead).toBe(runHeadAfterA);
    }
    expect(getHeadCommit(run.path)).toBe(runHeadAfterA);
  });
});

// ── Concurrency stress ───────────────────────────────────────────────────────

describe("concurrent Run/Job stress", () => {
  it("prepares jobs in parallel and integrates them serially with CAS", () => {
    const ctx = setupRepo();
    const run = prepareRun(ctx.db, ctx.config, {
      operationId: uniqueId(),
      runId: "run-stress",
      repositoryUrl: ctx.repo,
      baseRef: "main",
    });

    const jobCount = 5;
    const jobs = Array.from({ length: jobCount }, (_, i) => ({
      jobId: `job-${i}`,
      fileName: `file-${i}.txt`,
      content: `content from job ${i}\n`,
    }));

    // Parallel preparation of all job attempt workspaces from the same Run HEAD.
    const handles = jobs.map((j) =>
      prepareJob(ctx.db, ctx.config, {
        operationId: uniqueId(),
        runId: "run-stress",
        runWorkspaceId: run.workspaceId,
        jobId: j.jobId,
        attempt: 1,
        expectedRunHead: run.baseCommit,
      }),
    );
    expect(new Set(handles.map((h) => h.branch)).size).toBe(jobCount);

    // Each job commits a different file.
    const commits = handles.map((handle, i) => {
      fs.writeFileSync(path.join(handle.path, jobs[i].fileName), jobs[i].content, "utf-8");
      const result = commitWorkspace(ctx.db, {
        operationId: uniqueId(),
        workspaceId: handle.workspaceId,
        message: `${jobs[i].jobId}: add ${jobs[i].fileName}`,
      });
      expect(result.noOp).toBe(false);
      return result;
    });

    // Serialized integration with a fresh expectedHead per step; no duplicate
    // merge commits.
    let expectedHead = run.baseCommit;
    for (let i = 0; i < commits.length; i++) {
      const result = integrateWorkspace(ctx.db, {
        operationId: uniqueId(),
        sourceWorkspaceId: handles[i].workspaceId,
        targetWorkspaceId: run.workspaceId,
        expectedHead,
        lockOwner: "flow-engine",
      });
      expect(result.merged).toBe(true);
      expectedHead = result.resultingCommit;
    }

    // The Run HEAD is the last merge commit.
    expect(getHeadCommit(run.path)).toBe(expectedHead);

    // Every job change is present.
    for (const j of jobs) {
      expect(fs.readFileSync(path.join(run.path, j.fileName), "utf-8")).toContain(j.content.trim());
    }

    // Exactly jobCount merge commits above the base on the Run branch
    // (job work commits are also reachable through the merges, so count
    // merge commits only).
    const mergeCount = git(run.path, "rev-list", "--count", "--merges", `${run.baseCommit}..HEAD`);
    expect(Number(mergeCount)).toBe(jobCount);

    // Parallel preparation of attempts for one job uses distinct branches.
    // (A fresh jobId avoids colliding with the job-0/a1 branch that the
    // first phase already created from the original base.)
    const attempts = Array.from({ length: 3 }, (_, i) => i + 1).map((attempt) =>
      prepareJob(ctx.db, ctx.config, {
        operationId: uniqueId(),
        runId: "run-stress",
        runWorkspaceId: run.workspaceId,
        jobId: "job-multi",
        attempt,
        expectedRunHead: expectedHead,
      }),
    );
    expect(new Set(attempts.map((a) => a.branch))).toEqual(
      new Set(["job/run-stress/job-multi/a1", "job/run-stress/job-multi/a2", "job/run-stress/job-multi/a3"]),
    );
    expect(attempts.every((a) => a.baseCommit === expectedHead)).toBe(true);
  });
});

// ── Recovery and validation regressions ───────────────────────────────────────

describe("recovery and validation", () => {
  it("replays a failed integrate with the same operation id", () => {
    const ctx = setupRepo();
    const run = prepareRun(ctx.db, ctx.config, {
      operationId: uniqueId(),
      runId: "run-retry",
      repositoryUrl: ctx.repo,
      baseRef: "main",
    });
    const jobA = prepareJob(ctx.db, ctx.config, {
      operationId: uniqueId(),
      runId: "run-retry",
      runWorkspaceId: run.workspaceId,
      jobId: "job-a",
      attempt: 1,
      expectedRunHead: run.baseCommit,
    });
    fs.writeFileSync(path.join(jobA.path, "file-a.txt"), "from job A\n", "utf-8");
    const commitA = commitWorkspace(ctx.db, {
      operationId: uniqueId(),
      workspaceId: jobA.workspaceId,
      message: "job-a: add file-a",
    });
    expect(commitA.noOp).toBe(false);

    // Another owner holds the integration lock: the first attempt fails
    // before the merge, leaving a 'failed' journal row behind.
    acquireIntegrationLock(ctx.db, run.workspaceId, "other-owner", null);
    const op = uniqueId();
    expect(() =>
      integrateWorkspace(ctx.db, {
        operationId: op,
        sourceWorkspaceId: jobA.workspaceId,
        targetWorkspaceId: run.workspaceId,
        expectedHead: run.baseCommit,
        lockOwner: "flow-engine",
      }),
    ).toThrow();
    releaseIntegrationLock(ctx.db, run.workspaceId, "other-owner");

    // The same operation id must retry cleanly instead of colliding with
    // the existing journal row.
    const integrated = integrateWorkspace(ctx.db, {
      operationId: op,
      sourceWorkspaceId: jobA.workspaceId,
      targetWorkspaceId: run.workspaceId,
      expectedHead: run.baseCommit,
      lockOwner: "flow-engine",
    });
    expect(integrated.merged).toBe(true);
  });

  it("enforces the expected base CAS when adopting an existing Run workspace", () => {
    const ctx = setupRepo();
    const run = prepareRun(ctx.db, ctx.config, {
      operationId: uniqueId(),
      runId: "run-adopt",
      repositoryUrl: ctx.repo,
      baseRef: "main",
      expectedBaseCommit: ctx.baseCommit,
    });

    // Adoption with the same expected base returns the same workspace.
    const adopted = prepareRun(ctx.db, ctx.config, {
      operationId: uniqueId(),
      runId: "run-adopt",
      repositoryUrl: ctx.repo,
      baseRef: "main",
      expectedBaseCommit: ctx.baseCommit,
    });
    expect(adopted.workspaceId).toBe(run.workspaceId);

    // Adoption with a mismatched expected base is a CAS conflict, not a
    // silent rebase onto a different baseline.
    expect(() =>
      prepareRun(ctx.db, ctx.config, {
        operationId: uniqueId(),
        runId: "run-adopt",
        repositoryUrl: ctx.repo,
        baseRef: "main",
        expectedBaseCommit: "0".repeat(40),
      }),
    ).toThrow(expect.objectContaining({ code: "WORKSPACE_HEAD_CONFLICT" }));
  });

  it("allows MERGING → RUNNING so a failed integrate can restore the target", () => {
    expect(transition("MERGING", "RUNNING")).toBe("RUNNING");
  });
});

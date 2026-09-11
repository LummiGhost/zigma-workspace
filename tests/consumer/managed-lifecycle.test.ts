/**
 * Black-box proof of the managed workspace lifecycle a Flow bridge consumes.
 *
 * Every command runs against the BUILT CLI (dist/cli/index.js) in a separate
 * process with a temp state directory — the same spawn boundary the
 * zigma-flow bridge uses. No provider code runs in-process; the registry is
 * only read back over SQLite for audit assertions.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cleanupTempDirs,
  dbCount,
  ensureBuiltDist,
  expectOk,
  git,
  invokeCli,
  invokeCliAsync,
  makeRepo,
  openRegistry,
  parseEnvelope,
  type Fixture,
  type InvokeResult,
} from "./helpers.js";

const BOGUS_SHA = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const RUN_ID = "run-a1";
const JOB_ID = "impl";

interface LifecycleFixture extends Fixture {
  baseCommit: string;
}

function setupLifecycle(): LifecycleFixture {
  const fx = makeRepo();
  return { ...fx, baseCommit: git(fx.repo, "rev-parse", "HEAD") };
}

function cli(fx: Fixture, args: string[]): InvokeResult {
  return invokeCli(["--state-dir", fx.stateDir, ...args]);
}

function okData(fx: Fixture, args: string[]): Record<string, unknown> {
  const envelope = expectOk(cli(fx, args));
  expect(envelope.data).toBeTruthy();
  return envelope.data as Record<string, unknown>;
}

function str(value: unknown): string {
  expect(typeof value).toBe("string");
  return value as string;
}

function writeFile(dir: string, name: string, content: string): void {
  fs.writeFileSync(path.join(dir, name), content, "utf-8");
}

afterAll(() => cleanupTempDirs());

// ── Full lifecycle: handshake → prepare → commit → integrate → publish ──────

describe("managed Run+Job lifecycle over the built CLI", () => {
  let fx: LifecycleFixture;
  let baseCommit = "";
  let runHead = "";
  let runWs = "";
  let runPath = "";
  let job1Ws = "";
  let job1Path = "";
  let job2Ws = "";
  let job2Path = "";
  let job3Ws = "";
  let job3Path = "";

  const opRun = "run:run-a1:create";
  const opJob1 = "run:run-a1:job:impl:attempt:1:create";
  const opJob2 = "run:run-a1:job:impl:attempt:2:create";
  const opJob3 = "run:run-a1:job:impl:attempt:3:create";

  const runArgs = (opId = opRun): string[] => [
    "prepare-run",
    "--operation-id", opId,
    "--run", RUN_ID,
    "--repo", fx.repo,
    "--base", "main",
    "--mode", "writable",
    "--json",
  ];

  const jobArgs = (attempt: string, opId: string, head = runHead): string[] => [
    "prepare-job",
    "--operation-id", opId,
    "--run", RUN_ID,
    "--run-workspace", runWs,
    "--job", JOB_ID,
    "--attempt", attempt,
    "--expected-head", head,
    "--json",
  ];

  beforeAll(async () => {
    await ensureBuiltDist();
    fx = setupLifecycle();
    baseCommit = fx.baseCommit;
  });

  it("handshake: negotiate and contract-info agree on the managed contract", () => {
    const info = okData(fx, ["contract-info", "--json"]);
    expect(info.managed_supported).toBe(true);

    const neg = okData(fx, ["negotiate", "--role", "managed", "--json"]);
    expect(neg).toMatchObject({ role: "managed", supported: true, contract_version: 1 });
  });

  it("prepare-run creates the flow/<runId> workspace and reports an absolute, existing path", () => {
    const run = okData(fx, runArgs());
    expect(run.run_id).toBe(RUN_ID);
    expect(run.branch).toBe("flow/run-a1");
    expect(run.base_commit).toBe(baseCommit);
    expect(run.mode).toBe("writable");
    expect(run.status).toBe("RUNNING");

    runWs = str(run.workspace_id);
    runPath = str(run.path);
    runHead = baseCommit;
    expect(path.isAbsolute(runPath)).toBe(true);
    expect(fs.existsSync(runPath)).toBe(true);
    expect(git(runPath, "rev-parse", "HEAD")).toBe(baseCommit);
  });

  it("replaying prepare-run with the same operation-id returns the byte-identical envelope", () => {
    const first = cli(fx, runArgs());
    const replay = cli(fx, runArgs());
    expect(replay.status).toBe(0);
    expect(replay.stdout).toBe(first.stdout);
  });

  it("prepare-job creates the attempt workspace and replays byte-identically", () => {
    const job = okData(fx, jobArgs("1", opJob1));
    expect(job.run_workspace_id).toBe(runWs);
    expect(job.job_id).toBe(JOB_ID);
    expect(job.attempt).toBe(1);
    expect(job.branch).toBe("job/run-a1/impl/a1");
    expect(job.base_commit).toBe(baseCommit);

    job1Ws = str(job.workspace_id);
    job1Path = str(job.path);
    expect(path.isAbsolute(job1Path)).toBe(true);
    expect(fs.existsSync(job1Path)).toBe(true);

    const first = cli(fx, jobArgs("1", opJob1));
    const replay = cli(fx, jobArgs("1", opJob1));
    expect(replay.status).toBe(0);
    expect(replay.stdout).toBe(first.stdout);
  });

  it("prepares concurrent job attempts with distinct workspaces and paths", async () => {
    const [r2, r3] = await Promise.all([
      invokeCliAsync(["--state-dir", fx.stateDir, ...jobArgs("2", opJob2)]),
      invokeCliAsync(["--state-dir", fx.stateDir, ...jobArgs("3", opJob3)]),
    ]);
    const d2 = expectOk(r2).data as Record<string, unknown>;
    const d3 = expectOk(r3).data as Record<string, unknown>;
    expect(d2.attempt).toBe(2);
    expect(d3.attempt).toBe(3);
    job2Ws = str(d2.workspace_id);
    job2Path = str(d2.path);
    job3Ws = str(d3.workspace_id);
    job3Path = str(d3.path);
    expect(job2Ws).not.toBe(job3Ws);
    expect(job2Path).not.toBe(job3Path);
    expect(d2.branch).toBe("job/run-a1/impl/a2");
    expect(d3.branch).toBe("job/run-a1/impl/a3");
    expect(fs.existsSync(job2Path)).toBe(true);
    expect(fs.existsSync(job3Path)).toBe(true);
  });

  it("commits the first attempt with CAS on state and head", () => {
    writeFile(job1Path, "change.txt", "from-attempt-1\n");
    const head = git(job1Path, "rev-parse", "HEAD");
    const commit = okData(fx, [
      "commit",
      "--operation-id", "run:run-a1:job:impl:attempt:1:commit",
      "--workspace", job1Ws,
      "--message", "job1: implement change.txt",
      "--expected-state", "RUNNING",
      "--expected-head", head,
      "--json",
    ]);
    expect(commit.no_op).toBe(false);
    expect(commit.base_commit).toBe(baseCommit);
    expect(commit.head_commit).not.toBe(baseCommit);
    expect(commit.changed_files).toContain("change.txt");
    expect(commit.artifact).toBeTruthy();
  });

  it("rejects a stale CAS head on commit", () => {
    const r = cli(fx, [
      "commit",
      "--operation-id", "run:run-a1:job:impl:attempt:1:commit-stale",
      "--workspace", job1Ws,
      "--expected-head", baseCommit,
      "--json",
    ]);
    expect(r.status).toBe(1);
    const env = parseEnvelope(r.stdout);
    expect(env.error?.code).toBe("WORKSPACE_HEAD_CONFLICT");
  });

  it("commits conflicting changes in attempts 2 and 3", () => {
    writeFile(job2Path, "change.txt", "from-attempt-2\n");
    const a2 = okData(fx, [
      "commit",
      "--operation-id", "run:run-a1:job:impl:attempt:2:commit",
      "--workspace", job2Ws,
      "--message", "job2: conflicting change.txt",
      "--expected-head", baseCommit,
      "--json",
    ]);
    expect(a2.changed_files).toContain("change.txt");

    writeFile(job3Path, "change.txt", "from-attempt-3\n");
    const a3 = okData(fx, [
      "commit",
      "--operation-id", "run:run-a1:job:impl:attempt:3:commit",
      "--workspace", job3Ws,
      "--message", "job3: conflicting change.txt",
      "--expected-head", baseCommit,
      "--json",
    ]);
    expect(a3.changed_files).toContain("change.txt");
  });

  it("integrates attempt 2 into the Run workspace under CAS", () => {
    const merged = okData(fx, [
      "integrate",
      "--operation-id", "run:run-a1:job:impl:attempt:2:integrate",
      "--source", job2Ws,
      "--target", runWs,
      "--lock-owner", "flow-bridge",
      "--expected-head", runHead,
      "--json",
    ]);
    expect(merged.merged).toBe(true);
    expect(merged.previous_target_head).toBe(runHead);
    expect(merged.changed_files).toContain("change.txt");
    expect(merged.artifact).toBeTruthy();
    runHead = str(merged.resulting_commit);
    expect(git(runPath, "rev-parse", "HEAD")).toBe(runHead);
  });

  it("publishes the Run workspace evidence (strategy none)", () => {
    const pub = okData(fx, [
      "publish",
      "--operation-id", "run:run-a1:publish",
      "--workspace", runWs,
      "--strategy", "none",
      "--target-ref", "published/run-a1",
      "--expected-head", runHead,
      "--json",
    ]);
    expect(pub.strategy).toBe("none");
    expect(pub.resulting_ref).toBeNull();
    expect(pub.resulting_commit).toBe(runHead);
    expect(pub.changed_files).toContain("change.txt");
    expect(pub.artifact).toBeTruthy();
  });

  it("integrating the conflicting attempt 3 returns a structured conflict envelope and replays it", () => {
    const args = [
      "integrate",
      "--operation-id", "run:run-a1:job:impl:attempt:3:integrate",
      "--source", job3Ws,
      "--target", runWs,
      "--lock-owner", "flow-bridge",
      "--expected-head", runHead,
      "--json",
    ];
    const first = cli(fx, args);
    expect(first.status).toBe(1);
    const env = parseEnvelope(first.stdout);
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe("WORKSPACE_INTEGRATION_CONFLICT");
    const details = env.error?.details as { conflict_files?: string[] } | undefined;
    expect(details?.conflict_files).toContain("change.txt");

    // The conflict is recorded as the operation's terminal result: replaying
    // the same operation-id returns the identical envelope.
    const replay = cli(fx, args);
    expect(replay.status).toBe(1);
    expect(replay.stdout).toBe(first.stdout);
  });

  it("reconcile reports the attempt workspace complete and the Run workspace mixed", () => {
    const jobRec = okData(fx, ["reconcile", "--workspace", job1Ws, "--json"]);
    expect(jobRec.reconciled_status).toBe("complete");
    expect(jobRec.directory_exists).toBe(true);
    const jobOps = jobRec.operations as Array<Record<string, unknown>>;
    expect(jobOps.map((o) => o.command)).toEqual(["prepare_job", "commit"]);
    expect(jobOps.every((o) => o.status === "completed")).toBe(true);

    const runRec = okData(fx, ["reconcile", "--workspace", runWs, "--json"]);
    expect(runRec.reconciled_status).toBe("inconsistent");
    const runOps = runRec.operations as Array<Record<string, unknown>>;
    const failed = runOps.find(
      (o) => o.command === "integrate" && o.status === "failed",
    );
    expect(failed).toBeTruthy();
    const failedResult = JSON.parse(str(failed?.result_json)) as {
      conflictFiles?: string[];
    };
    expect(failedResult.conflictFiles).toContain("change.txt");
  });

  it("strict-cleanup removes the attempt workspace and preserves registry, journal, and events", () => {
    const opCleanup = "run:run-a1:job:impl:attempt:1:cleanup";
    const args = ["cleanup", "--workspace", job1Ws, "--operation-id", opCleanup, "--strict", "--json"];
    const first = cli(fx, args);
    const cleaned = expectOk(first);
    expect(cleaned.data).toMatchObject({ removed: true, status: "CLEANED", workspace_id: job1Ws });
    expect(fs.existsSync(job1Path)).toBe(false);

    const db = openRegistry(fx.stateDir);
    try {
      expect(db.prepare("SELECT status FROM workspaces WHERE id = ?").get(job1Ws)).toEqual({
        status: "CLEANED",
      });
      expect(dbCount(db, "workspace_events", "workspace_id = ? AND event = ?", job1Ws, "workspace.cleaned")).toBe(1);
      expect(dbCount(db, "operation_journal", "workspace_id = ? AND command = ? AND status = ?", job1Ws, "cleanup", "completed")).toBe(1);
    } finally {
      db.close();
    }

    // Same operation-id replay is idempotent and byte-identical.
    const replay = cli(fx, args);
    expect(replay.status).toBe(0);
    expect(replay.stdout).toBe(first.stdout);
  });

  it("strict-cleanup finishes the remaining workspaces and list reflects CLEANED", () => {
    const remaining = [
      ["run:run-a1:job:impl:attempt:2:cleanup", job2Ws],
      ["run:run-a1:job:impl:attempt:3:cleanup", job3Ws],
      ["run:run-a1:cleanup", runWs],
    ] as const;
    for (const [opId, ws] of remaining) {
      const cleaned = okData(fx, ["cleanup", "--workspace", ws, "--operation-id", opId, "--strict", "--json"]);
      expect(cleaned).toMatchObject({ removed: true, status: "CLEANED", workspace_id: ws });
    }
    const list = okData(fx, ["list", "--json"]) as unknown as Array<Record<string, unknown>>;
    expect(list).toHaveLength(4);
    expect(list.every((w) => w.status === "CLEANED")).toBe(true);
  });
});

// ── Crash recovery: adoption after an interrupted prepare ──────────────────

describe("crash recovery over the built CLI", () => {
  let fx: LifecycleFixture;
  let baseCommit = "";
  let runWs = "";
  let jobWs = "";
  let jobPath = "";
  const opJob = "run:run-recover:job:impl:attempt:1:create";

  const jobArgs = (opId: string): string[] => [
    "prepare-job",
    "--operation-id", opId,
    "--run", "run-recover",
    "--run-workspace", runWs,
    "--job", JOB_ID,
    "--attempt", "1",
    "--expected-head", baseCommit,
    "--json",
  ];

  beforeAll(async () => {
    await ensureBuiltDist();
    fx = setupLifecycle();
    baseCommit = fx.baseCommit;
    const run = okData(fx, [
      "prepare-run",
      "--operation-id", "run:run-recover:create",
      "--run", "run-recover",
      "--repo", fx.repo,
      "--base", "main",
      "--json",
    ]);
    runWs = str(run.workspace_id);
  });

  it("prepares the attempt, then a simulated crash leaves the journal started", () => {
    const job = okData(fx, jobArgs(opJob));
    jobWs = str(job.workspace_id);
    jobPath = str(job.path);

    // Simulate a crash between workspace creation and journal completion:
    // rewind the journal row to 'started' and drop the idempotency record.
    const db = openRegistry(fx.stateDir);
    try {
      db.prepare(
        "UPDATE operation_journal SET status = 'started', result_json = NULL, updated_at = ? WHERE operation_id = ? AND workspace_id = ?",
      ).run(new Date().toISOString(), opJob, jobWs);
      db.prepare("DELETE FROM workspace_idempotency WHERE operation_id = ?").run(opJob);
    } finally {
      db.close();
    }

    const rec = okData(fx, ["reconcile", "--workspace", jobWs, "--json"]);
    expect(rec.reconciled_status).toBe("incomplete");
    const ops = rec.operations as Array<Record<string, unknown>>;
    expect(ops.some((o) => o.operation_id === opJob && o.status === "started")).toBe(true);
  });

  it("re-running the same operation-id adopts the workspace and completes the journal", () => {
    const adopted = okData(fx, jobArgs(opJob));
    expect(adopted.workspace_id).toBe(jobWs);
    expect(adopted.path).toBe(jobPath);

    const db = openRegistry(fx.stateDir);
    try {
      const row = db
        .prepare("SELECT status FROM operation_journal WHERE operation_id = ? AND workspace_id = ?")
        .get(opJob, jobWs);
      expect(row).toEqual({ status: "completed" });
      expect(dbCount(db, "workspace_idempotency", "operation_id = ?", opJob)).toBe(1);
    } finally {
      db.close();
    }

    const rec = okData(fx, ["reconcile", "--workspace", jobWs, "--json"]);
    expect(rec.reconciled_status).toBe("complete");
  });

  it("a fresh operation-id (crash before journaling) also adopts deterministically", () => {
    const adopted = okData(fx, jobArgs("run:run-recover:job:impl:attempt:1:retry"));
    expect(adopted.workspace_id).toBe(jobWs);
    expect(adopted.path).toBe(jobPath);

    const list = okData(fx, ["list", "--json"]) as unknown as Array<Record<string, unknown>>;
    expect(list.filter((w) => w.branch === "job/run-recover/impl/a1")).toHaveLength(1);
  });
});

// ── Stale CAS and input validation over the built CLI ───────────────────────

describe("stale-CAS and input validation over the built CLI", () => {
  let fx: LifecycleFixture;
  let runWs = "";
  let baseCommit = "";

  beforeAll(async () => {
    await ensureBuiltDist();
    fx = setupLifecycle();
    baseCommit = fx.baseCommit;
    const run = okData(fx, [
      "prepare-run",
      "--operation-id", "run:run-cas:create",
      "--run", "run-cas",
      "--repo", fx.repo,
      "--base", "main",
      "--json",
    ]);
    runWs = str(run.workspace_id);
  });

  it("prepare-run fails CAS on an unknown expected base and leaves no state", () => {
    const r = cli(fx, [
      "prepare-run",
      "--operation-id", "run:run-cas:create-bad",
      "--run", "run-cas-bad",
      "--repo", fx.repo,
      "--base", "main",
      "--expected-base", BOGUS_SHA,
      "--json",
    ]);
    expect(r.status).toBe(1);
    expect(parseEnvelope(r.stdout).error?.code).toBe("WORKSPACE_HEAD_CONFLICT");

    const list = okData(fx, ["list", "--json"]) as unknown as Array<Record<string, unknown>>;
    expect(list.filter((w) => w.flow_run_id === "run-cas-bad")).toHaveLength(0);
  });

  it("prepare-job rejects a stale expected head with WORKSPACE_HEAD_CONFLICT", () => {
    const r = cli(fx, [
      "prepare-job",
      "--operation-id", "run:run-cas:job:impl:attempt:1:create",
      "--run", "run-cas",
      "--run-workspace", runWs,
      "--job", JOB_ID,
      "--attempt", "1",
      "--expected-head", BOGUS_SHA,
      "--json",
    ]);
    expect(r.status).toBe(1);
    expect(parseEnvelope(r.stdout).error?.code).toBe("WORKSPACE_HEAD_CONFLICT");
  });

  it("prepare-job rejects a non-SHA expected head with INVALID_INPUT", () => {
    const r = cli(fx, [
      "prepare-job",
      "--operation-id", "run:run-cas:job:impl:attempt:2:create",
      "--run", "run-cas",
      "--run-workspace", runWs,
      "--job", JOB_ID,
      "--attempt", "2",
      "--expected-head", "not-a-sha",
      "--json",
    ]);
    expect(r.status).toBe(1);
    expect(parseEnvelope(r.stdout).error?.code).toBe("INVALID_INPUT");
  });

  it("prepare-job rejects a non-positive attempt", () => {
    const r = cli(fx, [
      "prepare-job",
      "--operation-id", "run:run-cas:job:impl:attempt:0:create",
      "--run", "run-cas",
      "--run-workspace", runWs,
      "--job", JOB_ID,
      "--attempt", "0",
      "--expected-head", baseCommit,
      "--json",
    ]);
    expect(r.status).toBe(1);
    expect(parseEnvelope(r.stdout).error?.code).toBe("INVALID_INPUT");
  });

  it("prepare-run rejects a run id that is unsafe for a git branch", () => {
    const r = cli(fx, [
      "prepare-run",
      "--operation-id", "run:unsafe:create",
      "--run", "bad/run",
      "--repo", fx.repo,
      "--base", "main",
      "--json",
    ]);
    expect(r.status).toBe(1);
    expect(parseEnvelope(r.stdout).error?.code).toBe("INVALID_INPUT");
  });
});

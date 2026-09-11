/**
 * Cancellation after host quiescence over the real CLI (§8 protocol).
 *
 * The host (Flow) is killed while an agent holds an open file inside the
 * job workspace. The platform must then: release the OS handle, stop the
 * collaboration lock, reconcile (reporting the interrupted operation), and
 * strict-clean the workspace — preserving registry, journal, idempotency,
 * and event audit rows throughout.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canDelete,
  cleanupTempDirs,
  dbCount,
  ensureBuiltDist,
  expectOk,
  invokeCli,
  makeRepo,
  openRegistry,
  parseEnvelope,
  pollUntil,
  type Fixture,
  type InvokeResult,
} from "./helpers.js";

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

afterAll(() => cleanupTempDirs());

describe("cancellation soak over the built CLI", () => {
  let fx: Fixture;
  let runWs = "";
  let jobWs = "";
  let jobPath = "";

  const opJob = "run:run-soak:job:impl:attempt:1:create";
  const opCleanup = "run:run-soak:job:impl:attempt:1:cleanup";

  beforeAll(async () => {
    await ensureBuiltDist();
    fx = makeRepo();
    const run = okData(fx, [
      "prepare-run",
      "--operation-id", "run:run-soak:create",
      "--run", "run-soak",
      "--repo", fx.repo,
      "--base", "main",
      "--json",
    ]);
    runWs = str(run.workspace_id);
    const job = okData(fx, [
      "prepare-job",
      "--operation-id", opJob,
      "--run", "run-soak",
      "--run-workspace", runWs,
      "--job", "impl",
      "--attempt", "1",
      "--expected-head", str(run.base_commit),
      "--json",
    ]);
    jobWs = str(job.workspace_id);
    jobPath = str(job.path);
  });

  it("holds the collaboration lock with heartbeats and fails closed on cleanup while locked", () => {
    const lock = okData(fx, [
      "lock",
      "--workspace", jobWs,
      "--mode", "write",
      "--owner", "flow-agent",
      "--json",
    ]);
    expect(lock).toMatchObject({ workspace_id: jobWs, mode: "write", owner: "flow-agent" });

    const beat = okData(fx, ["heartbeat", "--workspace", jobWs, "--owner", "flow-agent", "--json"]);
    expect(beat.last_heartbeat).toBeTruthy();

    // Strict cleanup must not proceed while the host still owns the lock.
    const blocked = cli(fx, ["cleanup", "--workspace", jobWs, "--operation-id", opCleanup, "--strict", "--json"]);
    expect(blocked.status).toBe(1);
    expect(parseEnvelope(blocked.stdout).error?.code).toBe("WORKSPACE_LOCK_CONFLICT");
  });

  it("SIGKILLs the agent process and waits for the OS handle to release", async () => {
    const heldFile = path.join(jobPath, "agent-output.txt");
    const script = `
      const fs = require("node:fs");
      const f = ${JSON.stringify(heldFile)};
      fs.writeFileSync(f, "agent output\\n");
      const fd = fs.openSync(f, "a");
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ["-e", script], { stdio: "ignore" });
    await pollUntil(() => fs.existsSync(heldFile));

    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("close", resolve));

    // Windows releases handles asynchronously after process death; retry
    // until the file becomes deletable.
    await pollUntil(() => canDelete(heldFile));
    expect(fs.existsSync(heldFile)).toBe(false);
  });

  it("releases the lock, then reconcile reports the interrupted operation as incomplete", () => {
    const unlocked = okData(fx, ["unlock", "--workspace", jobWs, "--json"]);
    expect(unlocked.unlocked).toBe(true);

    // The host died mid-commit: its journal row is still 'started'.
    const db = openRegistry(fx.stateDir);
    try {
      const ts = new Date().toISOString();
      db.prepare(
        "INSERT INTO operation_journal (operation_id, workspace_id, command, status, input_hash, result_json, created_at, updated_at) VALUES (?, ?, 'commit', 'started', 'soak-injected', NULL, ?, ?)",
      ).run("run:run-soak:job:impl:attempt:1:commit", jobWs, ts, ts);
    } finally {
      db.close();
    }

    const rec = okData(fx, ["reconcile", "--workspace", jobWs, "--json"]);
    expect(rec.reconciled_status).toBe("incomplete");
    expect(rec.directory_exists).toBe(true);
    const ops = rec.operations as Array<Record<string, unknown>>;
    const pending = ops.find(
      (o) => o.operation_id === "run:run-soak:job:impl:attempt:1:commit" && o.status === "started",
    );
    expect(pending).toBeTruthy();
  });

  it("strict-cleanup succeeds and preserves registry, journal, idempotency, and events", () => {
    const args = ["cleanup", "--workspace", jobWs, "--operation-id", opCleanup, "--strict", "--json"];
    const firstClean = cli(fx, args);
    const cleaned = expectOk(firstClean);
    expect(cleaned.data).toMatchObject({ removed: true, status: "CLEANED", workspace_id: jobWs });
    expect(fs.existsSync(jobPath)).toBe(false);

    const db = openRegistry(fx.stateDir);
    try {
      // Registry row transitions to CLEANED and is preserved.
      expect(db.prepare("SELECT status FROM workspaces WHERE id = ?").get(jobWs)).toEqual({
        status: "CLEANED",
      });
      // The interrupted commit row survives the cleanup audit trail.
      expect(
        dbCount(
          db,
          "operation_journal",
          "workspace_id = ? AND command = ? AND status = ?",
          jobWs,
          "commit",
          "started",
        ),
      ).toBe(1);
      expect(
        dbCount(
          db,
          "operation_journal",
          "workspace_id = ? AND command = ? AND status = ?",
          jobWs,
          "cleanup",
          "completed",
        ),
      ).toBe(1);
      // The cleanup operation is idempotent and the event is recorded.
      expect(dbCount(db, "workspace_idempotency", "operation_id = ?", opCleanup)).toBe(1);
      expect(dbCount(db, "workspace_events", "workspace_id = ? AND event = ?", jobWs, "workspace.cleaned")).toBe(1);
    } finally {
      db.close();
    }

    // Replaying the same cleanup operation-id is byte-identical.
    const replay = cli(fx, args);
    expect(replay.status).toBe(0);
    expect(replay.stdout).toBe(firstClean.stdout);
  });
});

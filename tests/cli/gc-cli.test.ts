import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

const cliPath = path.resolve("src/cli/index.ts");
const tempDirs: string[] = [];

interface JsonEnvelope {
  contract_version: number;
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function makeRepo(): { root: string; repo: string; stateDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zigma-gc-cli-"));
  tempDirs.push(root);
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "gc-cli@example.test");
  git(repo, "config", "user.name", "GC CLI test");
  git(repo, "config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(repo, "README.md"), "# fixture\n", "utf-8");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "initial");
  return { root, repo, stateDir: path.join(root, "state") };
}

function invokeCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
    cwd: path.resolve("."),
    encoding: "utf-8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function parseSingleEnvelope(stdout: string): JsonEnvelope {
  expect(stdout.trim()).not.toBe("");
  return JSON.parse(stdout) as JsonEnvelope;
}

function assertV1Envelope(envelope: JsonEnvelope, ok: boolean): void {
  expect(envelope.contract_version).toBe(1);
  expect(envelope.ok).toBe(ok);
}

function openRegistry(stateDir: string): Database.Database {
  return new Database(path.join(stateDir, "registry.db"));
}

function backdateWorkspace(db: Database.Database, workspaceId: string, daysAgo: number): void {
  const ts = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  db.prepare("UPDATE workspaces SET updated_at = ? WHERE id = ?").run(ts, workspaceId);
}

function expireLocks(db: Database.Database, workspaceId: string): void {
  const past = new Date(Date.now() - 60 * 1000).toISOString();
  db.prepare("UPDATE workspace_locks SET expires_at = ? WHERE workspace_id = ?").run(past, workspaceId);
  db.prepare("UPDATE integration_locks SET expires_at = ? WHERE workspace_id = ?").run(past, workspaceId);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Workspace CLI gc V1 black-box contract", () => {
  it("emits a dry-run plan envelope by default without side effects", () => {
    const { repo, stateDir } = makeRepo();
    const create = invokeCli([
      "--state-dir", stateDir,
      "create", "--repo", repo, "--base", "main", "--branch", "gc-plan-branch", "--json",
    ]);
    expect(create.status).toBe(0);
    const created = parseSingleEnvelope(create.stdout);
    assertV1Envelope(created, true);
    const workspaceId = String(created.data?.workspace_id);

    const db = openRegistry(stateDir);
    backdateWorkspace(db, workspaceId, 30);
    db.close();

    const plan = invokeCli(["--state-dir", stateDir, "gc", "--json"]);
    expect(plan.status).toBe(0);
    expect(plan.stderr).toBe("");
    const envelope = parseSingleEnvelope(plan.stdout);
    assertV1Envelope(envelope, true);
    expect(envelope.data).toMatchObject({ applied: false });
    const candidates = envelope.data?.candidates as Array<Record<string, unknown>>;
    const item = candidates.find((c) => c.workspace_id === workspaceId);
    expect(item).toMatchObject({ status: "READY", class: "abandoned", action: "cleanup" });
    expect(item?.reconcile).toBeDefined();
    expect(envelope.data?.orphan_worktrees).toEqual([]);

    // Dry-run must not touch anything.
    const dbAfter = openRegistry(stateDir);
    const row = dbAfter.prepare("SELECT * FROM workspaces WHERE id = ?").get(workspaceId) as { status: string; path: string };
    dbAfter.close();
    expect(row.status).toBe("READY");
    expect(fs.existsSync(row.path)).toBe(true);
  });

  it("sweeps expired locks, cleans abandoned workspaces, and preserves audit rows on --apply", () => {
    const { repo, stateDir } = makeRepo();
    const create = invokeCli([
      "--state-dir", stateDir,
      "create", "--repo", repo, "--base", "main", "--branch", "gc-apply-branch", "--json",
    ]);
    expect(create.status).toBe(0);
    const created = parseSingleEnvelope(create.stdout);
    assertV1Envelope(created, true);
    const workspaceId = String(created.data?.workspace_id);
    const workspacePath = String(created.data?.path);

    invokeCli(["--state-dir", stateDir, "lock", "--workspace", workspaceId, "--mode", "write", "--owner", "dead-owner", "--json"]);
    const db = openRegistry(stateDir);
    backdateWorkspace(db, workspaceId, 30);
    expireLocks(db, workspaceId);
    db.close();

    const apply = invokeCli(["--state-dir", stateDir, "gc", "--apply", "--json"]);
    expect(apply.status).toBe(0);
    expect(apply.stderr).toBe("");
    const envelope = parseSingleEnvelope(apply.stdout);
    assertV1Envelope(envelope, true);
    expect(envelope.data).toMatchObject({ applied: true });
    const swept = envelope.data?.swept_locks as Record<string, unknown>;
    expect(swept.workspace_locks_deleted).toBe(1);
    expect(swept.workspace_ids).toContain(workspaceId);

    const results = envelope.data?.results as Array<Record<string, unknown>>;
    const item = results.find((r) => r.workspace_id === workspaceId);
    expect(item).toMatchObject({
      action: "cleaned",
      removed: true,
      status: "CLEANED",
      operation_id: `gc:${workspaceId}:cleanup`,
    });
    expect(fs.existsSync(workspacePath)).toBe(false);

    // Registry row, journal, and idempotency rows are preserved.
    const dbAfter = openRegistry(stateDir);
    const row = dbAfter.prepare("SELECT * FROM workspaces WHERE id = ?").get(workspaceId) as { status: string } | undefined;
    expect(row?.status).toBe("CLEANED");
    const journal = dbAfter
      .prepare("SELECT COUNT(*) AS n FROM operation_journal WHERE workspace_id = ?")
      .get(workspaceId) as { n: number };
    expect(journal.n).toBeGreaterThan(0);
    const idempotency = dbAfter
      .prepare("SELECT COUNT(*) AS n FROM workspace_idempotency WHERE operation_id = ?")
      .get(`gc:${workspaceId}:cleanup`) as { n: number };
    expect(idempotency.n).toBe(1);
    const locks = dbAfter
      .prepare("SELECT COUNT(*) AS n FROM workspace_locks WHERE workspace_id = ?")
      .get(workspaceId) as { n: number };
    expect(locks.n).toBe(0);
    dbAfter.close();
  });

  it("skips workspaces with an active lock and reports them as blocked in the plan", () => {
    const { repo, stateDir } = makeRepo();
    const create = invokeCli([
      "--state-dir", stateDir,
      "create", "--repo", repo, "--base", "main", "--branch", "gc-blocked-branch", "--json",
    ]);
    expect(create.status).toBe(0);
    const created = parseSingleEnvelope(create.stdout);
    assertV1Envelope(created, true);
    const workspaceId = String(created.data?.workspace_id);
    const workspacePath = String(created.data?.path);

    invokeCli(["--state-dir", stateDir, "lock", "--workspace", workspaceId, "--mode", "write", "--owner", "active-owner", "--json"]);
    const db = openRegistry(stateDir);
    backdateWorkspace(db, workspaceId, 30);
    db.close();

    const plan = invokeCli(["--state-dir", stateDir, "gc", "--json"]);
    const envelope = parseSingleEnvelope(plan.stdout);
    assertV1Envelope(envelope, true);
    const candidates = envelope.data?.candidates as Array<Record<string, unknown>>;
    const item = candidates.find((c) => c.workspace_id === workspaceId);
    expect(item).toMatchObject({ class: "blocked", action: "skip" });

    const apply = invokeCli(["--state-dir", stateDir, "gc", "--apply", "--json"]);
    const applied = parseSingleEnvelope(apply.stdout);
    assertV1Envelope(applied, true);
    const results = applied.data?.results as Array<Record<string, unknown>>;
    expect(results.find((r) => r.workspace_id === workspaceId)).toBeUndefined();
    expect(fs.existsSync(workspacePath)).toBe(true);
  });
});

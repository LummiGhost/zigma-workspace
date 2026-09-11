import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getConfig, ensureStateDirs } from "../../src/config/index.js";
import { closeDb, openDb } from "../../src/db/index.js";
import { createWorkspace } from "../../src/core/workspace.js";
import {
  ABANDON_DAYS,
  garbageCollect,
  planGarbageCollection,
  sweepExpiredLocks,
} from "../../src/core/gc.js";
import {
  getWorkspaceById,
  insertOperationJournal,
  listExpiredWorkspaceLocks,
} from "../../src/db/queries.js";
import { lockWorkspace } from "../../src/core/lock.js";
import { acquireIntegrationLock } from "../../src/core/integration-lock.js";
import { canonicalizePath } from "../../src/git/index.js";
import type Database from "better-sqlite3";
import type { ZigmaWorkspaceConfig } from "../../src/types/index.js";

const tempDirs: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

interface TestContext {
  root: string;
  repo: string;
  config: ZigmaWorkspaceConfig;
  db: Database.Database;
}

function setupRepo(): TestContext {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zigma-gc-"));
  tempDirs.push(root);
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "gc@example.test");
  git(repo, "config", "user.name", "gc-test");
  git(repo, "config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(repo, "README.md"), "# gc test\n", "utf-8");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "initial");

  const config = getConfig(path.join(root, "state"));
  ensureStateDirs(config);
  const db = openDb(config);
  return { root, repo, config, db };
}

function makeWorkspace(ctx: TestContext, branch: string) {
  return createWorkspace(ctx.db, ctx.config, {
    repositoryUrl: ctx.repo,
    baseRef: "main",
    branch,
  });
}

function backdateUpdatedAt(db: Database.Database, workspaceId: string, daysAgo: number): void {
  const ts = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  db.prepare("UPDATE workspaces SET updated_at = ? WHERE id = ?").run(ts, workspaceId);
}

function setStatus(db: Database.Database, workspaceId: string, status: string): void {
  db.prepare("UPDATE workspaces SET status = ? WHERE id = ?").run(status, workspaceId);
}

function expireLock(db: Database.Database, workspaceId: string): void {
  const past = new Date(Date.now() - 60 * 1000).toISOString();
  db.prepare("UPDATE workspace_locks SET expires_at = ? WHERE workspace_id = ?").run(past, workspaceId);
}

function gcJournalRows(db: Database.Database, workspaceId: string): string[] {
  return (
    db
      .prepare(
        "SELECT operation_id FROM operation_journal WHERE workspace_id = ? AND operation_id LIKE 'gc:%'",
      )
      .all(workspaceId) as Array<{ operation_id: string }>
  ).map((r) => r.operation_id);
}

afterEach(() => {
  closeDb();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("gc eligibility", () => {
  it("collects failed workspaces older than retainFailedDays and retains younger ones", () => {
    const ctx = setupRepo();
    const ws = makeWorkspace(ctx, "gc-failed-eligible");
    setStatus(ctx.db, ws.id, "FAILED");
    backdateUpdatedAt(ctx.db, ws.id, 8);

    const plan = planGarbageCollection(ctx.db, ctx.config);
    const item = plan.candidates.find((c) => c.workspaceId === ws.id);
    expect(item?.class).toBe("failed");
    expect(item?.action).toBe("cleanup");
    expect(item?.reconcile?.reconciledStatus).toBeDefined();

    const fresh = makeWorkspace(ctx, "gc-failed-retained");
    setStatus(ctx.db, fresh.id, "FAILED");
    backdateUpdatedAt(ctx.db, fresh.id, 2);
    const plan2 = planGarbageCollection(ctx.db, ctx.config);
    const item2 = plan2.candidates.find((c) => c.workspaceId === fresh.id);
    expect(item2?.class).toBe("retained");
    expect(item2?.action).toBe("skip");
  });

  it("treats stale non-terminal workspaces as abandoned only past ABANDON_DAYS", () => {
    const ctx = setupRepo();
    const ws = makeWorkspace(ctx, "gc-abandoned");
    backdateUpdatedAt(ctx.db, ws.id, ABANDON_DAYS - 1);
    const plan = planGarbageCollection(ctx.db, ctx.config);
    const item = plan.candidates.find((c) => c.workspaceId === ws.id);
    expect(item?.class).toBe("active");
    expect(item?.action).toBe("skip");

    backdateUpdatedAt(ctx.db, ws.id, ABANDON_DAYS);
    const plan2 = planGarbageCollection(ctx.db, ctx.config);
    const item2 = plan2.candidates.find((c) => c.workspaceId === ws.id);
    expect(item2?.class).toBe("abandoned");
    expect(item2?.action).toBe("cleanup");
  });

  it("never touches ARCHIVED or CLEANED workspaces", () => {
    const ctx = setupRepo();
    const archived = makeWorkspace(ctx, "gc-archived");
    setStatus(ctx.db, archived.id, "ARCHIVED");
    backdateUpdatedAt(ctx.db, archived.id, 90);
    const cleaned = makeWorkspace(ctx, "gc-cleaned");
    setStatus(ctx.db, cleaned.id, "CLEANED");
    backdateUpdatedAt(ctx.db, cleaned.id, 90);

    const plan = planGarbageCollection(ctx.db, ctx.config);
    for (const id of [archived.id, cleaned.id]) {
      const item = plan.candidates.find((c) => c.workspaceId === id);
      expect(item?.class).toBe("never");
      expect(item?.action).toBe("skip");
    }
  });

  it("skips workspaces with an active collaboration or integration lock", () => {
    const ctx = setupRepo();
    const ws = makeWorkspace(ctx, "gc-blocked-lock");
    lockWorkspace(ctx.db, ws.id, "write", "active-owner");
    backdateUpdatedAt(ctx.db, ws.id, 90);
    const plan = planGarbageCollection(ctx.db, ctx.config);
    const item = plan.candidates.find((c) => c.workspaceId === ws.id);
    expect(item?.class).toBe("blocked");
    expect(item?.action).toBe("skip");

    const ws2 = makeWorkspace(ctx, "gc-blocked-ilock");
    acquireIntegrationLock(ctx.db, ws2.id, "integrator", null);
    backdateUpdatedAt(ctx.db, ws2.id, 90);
    const plan2 = planGarbageCollection(ctx.db, ctx.config);
    const item2 = plan2.candidates.find((c) => c.workspaceId === ws2.id);
    expect(item2?.class).toBe("blocked");
    expect(item2?.action).toBe("skip");
  });

  it("retries CLEANUP_FAILED workspaces with a prior gc attempt regardless of age", () => {
    const ctx = setupRepo();
    const ws = makeWorkspace(ctx, "gc-retry");
    setStatus(ctx.db, ws.id, "CLEANUP_FAILED");
    backdateUpdatedAt(ctx.db, ws.id, 0);
    insertOperationJournal(ctx.db, {
      operation_id: `gc:${ws.id}:cleanup`,
      workspace_id: ws.id,
      command: "cleanup",
      status: "failed",
      input_hash: "hash",
      result_json: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const plan = planGarbageCollection(ctx.db, ctx.config);
    const item = plan.candidates.find((c) => c.workspaceId === ws.id);
    expect(item?.class).toBe("failed");
    expect(item?.action).toBe("cleanup");
    expect(item?.reason).toContain("retry");
  });
});

describe("gc lock sweep", () => {
  it("dry-run reports expired locks without deleting them; apply deletes them", () => {
    const ctx = setupRepo();
    const ws = makeWorkspace(ctx, "gc-sweep");
    lockWorkspace(ctx.db, ws.id, "write", "dead-owner");
    expireLock(ctx.db, ws.id);

    const plan = planGarbageCollection(ctx.db, ctx.config);
    expect(plan.sweptLocks.workspaceLocksDeleted).toBe(1);
    expect(plan.sweptLocks.workspaceIds).toContain(ws.id);
    expect(listExpiredWorkspaceLocks(ctx.db, new Date().toISOString())).toHaveLength(1);

    const result = garbageCollect(ctx.db, ctx.config, { apply: true });
    expect(result.applied).toBe(true);
    if (result.applied) {
      expect(result.sweptLocks.workspaceLocksDeleted).toBe(1);
    }
    expect(listExpiredWorkspaceLocks(ctx.db, new Date().toISOString())).toHaveLength(0);

    const sweep = sweepExpiredLocks(ctx.db, new Date().toISOString());
    expect(sweep.workspaceLocksDeleted).toBe(0);
    expect(sweep.integrationLocksDeleted).toBe(0);
  });

  it("expired lock rows do not block eligibility even before the sweep", () => {
    const ctx = setupRepo();
    const ws = makeWorkspace(ctx, "gc-expired-unblock");
    lockWorkspace(ctx.db, ws.id, "write", "dead-owner");
    expireLock(ctx.db, ws.id);
    backdateUpdatedAt(ctx.db, ws.id, 30);

    const plan = planGarbageCollection(ctx.db, ctx.config);
    const item = plan.candidates.find((c) => c.workspaceId === ws.id);
    expect(item?.class).toBe("abandoned");
    expect(item?.action).toBe("cleanup");
  });
});

describe("gc apply", () => {
  it("strict-cleans eligible workspaces and preserves audit rows", () => {
    const ctx = setupRepo();
    const ws = makeWorkspace(ctx, "gc-apply-clean");
    setStatus(ctx.db, ws.id, "FAILED");
    backdateUpdatedAt(ctx.db, ws.id, 10);
    const wsPath = ws.path;

    const result = garbageCollect(ctx.db, ctx.config, { apply: true });
    expect(result.applied).toBe(true);
    if (!result.applied) throw new Error("expected apply result");

    const item = result.results.find((r) => r.workspaceId === ws.id);
    expect(item?.action).toBe("cleaned");
    expect(item?.removed).toBe(true);
    expect(item?.status).toBe("CLEANED");
    expect(item?.operationId).toBe(`gc:${ws.id}:cleanup`);

    expect(fs.existsSync(wsPath)).toBe(false);
    const row = getWorkspaceById(ctx.db, ws.id);
    expect(row).toBeDefined();
    expect(row?.status).toBe("CLEANED");

    expect(gcJournalRows(ctx.db, ws.id)).toEqual([`gc:${ws.id}:cleanup`]);
    const idempotency = ctx.db
      .prepare("SELECT * FROM workspace_idempotency WHERE operation_id = ?")
      .get(`gc:${ws.id}:cleanup`);
    expect(idempotency).toBeDefined();
  });

  it("advances the operation id suffix after a failed gc cleanup attempt", () => {
    const ctx = setupRepo();
    const ws = makeWorkspace(ctx, "gc-op-suffix");
    insertOperationJournal(ctx.db, {
      operation_id: `gc:${ws.id}:cleanup`,
      workspace_id: ws.id,
      command: "cleanup",
      status: "failed",
      input_hash: "hash",
      result_json: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    setStatus(ctx.db, ws.id, "CLEANUP_FAILED");

    const result = garbageCollect(ctx.db, ctx.config, { apply: true });
    if (!result.applied) throw new Error("expected apply result");
    const item = result.results.find((r) => r.workspaceId === ws.id);
    expect(item?.action).toBe("cleaned");
    expect(item?.operationId).toBe(`gc:${ws.id}:cleanup:1`);
  });

  it("reclaims orphan worktrees and skips blocked workspaces", () => {
    const ctx = setupRepo();
    const ws = makeWorkspace(ctx, "gc-orphan-source");
    const orphanPath = ws.path;
    ctx.db.prepare("DELETE FROM workspaces WHERE id = ?").run(ws.id);

    const blocked = makeWorkspace(ctx, "gc-blocked-skip");
    lockWorkspace(ctx.db, blocked.id, "write", "still-here");
    backdateUpdatedAt(ctx.db, blocked.id, 30);

    const result = garbageCollect(ctx.db, ctx.config, { apply: true });
    expect(result.applied).toBe(true);
    if (!result.applied) throw new Error("expected apply result");

    expect(result.results.some((r) => r.workspaceId === blocked.id)).toBe(false);
    expect(fs.existsSync(blocked.path)).toBe(true);

    // Path forms differ on Windows: registry rows may hold 8.3 aliases
    // (short TMP env on CI) while porcelain/realpath emit the long form.
    const orphan = result.orphanWorktrees.find(
      (o) => canonicalizePath(o.path) === canonicalizePath(orphanPath),
    );
    expect(orphan).toBeDefined();
    expect(orphan?.removed).toBe(true);
    expect(fs.existsSync(orphanPath)).toBe(false);
  });

});

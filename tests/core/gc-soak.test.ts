/**
 * GC soak: repeated lost-owner reclamation loops against real git.
 *
 * Each iteration: create a workspace, acquire a write lock with a near-future
 * expiry, simulate a lost owner (no release), backdate the workspace past the
 * abandon threshold, let the lease expire, plan (blocked -> abandoned), apply,
 * and assert the full reclamation contract: no stale lock rows, no orphan
 * worktree registration, status CLEANED, audit rows preserved.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getConfig, ensureStateDirs } from "../../src/config/index.js";
import { closeDb, openDb } from "../../src/db/index.js";
import { createWorkspace } from "../../src/core/workspace.js";
import { lockWorkspace } from "../../src/core/lock.js";
import { garbageCollect, planGarbageCollection } from "../../src/core/gc.js";
import { getRepositoryCacheByUrl, getWorkspaceById } from "../../src/db/queries.js";
import { canonicalizePath } from "../../src/git/index.js";
import type Database from "better-sqlite3";
import type { ZigmaWorkspaceConfig } from "../../src/types/index.js";

const tempDirs: string[] = [];
const ITERATIONS = 5;

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zigma-gc-soak-"));
  tempDirs.push(root);
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "gc-soak@example.test");
  git(repo, "config", "user.name", "gc-soak-test");
  git(repo, "config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(repo, "README.md"), "# gc soak\n", "utf-8");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "initial");

  const config = getConfig(path.join(root, "state"));
  ensureStateDirs(config);
  const db = openDb(config);
  return { root, repo, config, db };
}

function backdateUpdatedAt(db: Database.Database, workspaceId: string, daysAgo: number): void {
  const ts = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  db.prepare("UPDATE workspaces SET updated_at = ? WHERE id = ?").run(ts, workspaceId);
}

function expireWorkspaceLock(db: Database.Database, workspaceId: string): void {
  const past = new Date(Date.now() - 60 * 1000).toISOString();
  db.prepare("UPDATE workspace_locks SET expires_at = ? WHERE workspace_id = ?").run(past, workspaceId);
}

afterEach(() => {
  closeDb();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("gc soak: lost-owner reclamation loop", () => {
  it(
    `reclaims abandoned locked workspaces over ${ITERATIONS} iterations`,
    () => {
      const ctx = setupRepo();

      for (let i = 0; i < ITERATIONS; i++) {
        const ws = createWorkspace(ctx.db, ctx.config, {
          repositoryUrl: ctx.repo,
          baseRef: "main",
          branch: `soak-iteration-${i}`,
        });
        expect(ws.status).toBe("READY");

        // Lost owner: lock acquired with a near-future lease, never released.
        lockWorkspace(
          ctx.db,
          ws.id,
          "write",
          `lost-owner-${i}`,
          new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        );
        backdateUpdatedAt(ctx.db, ws.id, 30);

        // While the lease is live, gc must never disturb the workspace.
        const blockedPlan = planGarbageCollection(ctx.db, ctx.config);
        const blockedItem = blockedPlan.candidates.find((c) => c.workspaceId === ws.id);
        expect(blockedItem?.class).toBe("blocked");
        expect(blockedItem?.action).toBe("skip");

        // Owner is gone; the lease expires without a heartbeat.
        expireWorkspaceLock(ctx.db, ws.id);

        // Expired leases neither block eligibility nor outlive the apply.
        const plan = planGarbageCollection(ctx.db, ctx.config);
        const item = plan.candidates.find((c) => c.workspaceId === ws.id);
        expect(item?.class).toBe("abandoned");
        expect(item?.action).toBe("cleanup");
        expect(plan.sweptLocks.workspaceIds).toContain(ws.id);

        const result = garbageCollect(ctx.db, ctx.config, { apply: true });
        expect(result.applied).toBe(true);
        if (!result.applied) throw new Error("expected apply result");
        const appliedItem = result.results.find((r) => r.workspaceId === ws.id);
        expect(appliedItem).toMatchObject({
          action: "cleaned",
          status: "CLEANED",
          removed: true,
        });
        expect(fs.existsSync(ws.path)).toBe(false);

        // No stale lock rows remain.
        const lockCount = ctx.db
          .prepare("SELECT COUNT(*) AS n FROM workspace_locks WHERE workspace_id = ?")
          .get(ws.id) as { n: number };
        expect(lockCount.n).toBe(0);

        // Registry row preserved as audit evidence, transitioned to CLEANED.
        const row = getWorkspaceById(ctx.db, ws.id);
        expect(row?.status).toBe("CLEANED");

        // No orphan worktree registration remains in the mirror. Compare
        // canonicalized: registry paths may hold 8.3 aliases (short TMP env
        // on CI) while porcelain emits the on-disk long form.
        const cacheRow = getRepositoryCacheByUrl(ctx.db, ctx.repo);
        expect(cacheRow).toBeDefined();
        const listed = git(cacheRow!.mirror_path, "worktree", "list", "--porcelain");
        const stillRegistered = listed
          .split("\n")
          .filter((line) => line.startsWith("worktree "))
          .some(
            (line) =>
              canonicalizePath(line.slice("worktree ".length).trim()) ===
              canonicalizePath(ws.path),
          );
        expect(stillRegistered).toBe(false);

        // Journal and idempotency rows preserved.
        const journal = ctx.db
          .prepare(
            "SELECT COUNT(*) AS n FROM operation_journal WHERE workspace_id = ? AND operation_id LIKE 'gc:%'",
          )
          .get(ws.id) as { n: number };
        expect(journal.n).toBe(1);
        const idempotency = ctx.db
          .prepare("SELECT COUNT(*) AS n FROM workspace_idempotency WHERE operation_id = ?")
          .get(`gc:${ws.id}:cleanup`) as { n: number };
        expect(idempotency.n).toBe(1);
      }
    },
    120_000,
  );
});

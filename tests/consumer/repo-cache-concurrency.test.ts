/**
 * Black-box proof that concurrent prepare-runs sharing one stateDir (and
 * therefore one repo-cache mirror per repository) do not race:
 *
 * - cold cache: N simultaneous first prepare-runs clone the mirror exactly
 *   once (no "destination path already exists" clone collisions);
 * - row insert: exactly one repository_caches row per URL despite N
 *   concurrent first inserts;
 * - warm cache: N simultaneous fetches on the shared mirror succeed.
 *
 * These are the races that surfaced as GIT_ERROR in M4 parallel dispatch.
 */
import * as fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cleanupTempDirs,
  dbCount,
  ensureBuiltDist,
  expectOk,
  invokeCliAsync,
  makeRepo,
  openRegistry,
  type Fixture,
} from "./helpers.js";

beforeAll(async () => {
  await ensureBuiltDist();
});

afterAll(() => cleanupTempDirs());

function prepareRunArgs(fx: Fixture, runId: string): string[] {
  return [
    "--state-dir", fx.stateDir,
    "prepare-run",
    "--operation-id", `run:${runId}:create`,
    "--run", runId,
    "--repo", fx.repo,
    "--base", "main",
    "--mode", "writable",
    "--json",
  ];
}

function runConcurrent(fx: Fixture, runIds: string[]) {
  return Promise.all(
    runIds.map(async (runId) => {
      const result = await invokeCliAsync(prepareRunArgs(fx, runId));
      return { runId, envelope: expectOk(result) };
    }),
  );
}

function assertSingleCacheRow(fx: Fixture, expectedWorkspaces: number): void {
  const db = openRegistry(fx.stateDir);
  const caches = db.prepare("SELECT * FROM repository_caches").all() as Array<{ mirror_path: string }>;
  expect(caches.length).toBe(1);
  const workspaces = db.prepare("SELECT * FROM workspaces").all() as Array<{ path: string }>;
  expect(workspaces.length).toBe(expectedWorkspaces);
  db.close();
  expect(fs.existsSync(caches[0]!.mirror_path)).toBe(true);
  const uniquePaths = new Set(workspaces.map((w) => w.path));
  expect(uniquePaths.size).toBe(expectedWorkspaces);
}

describe("shared repo cache under concurrent prepare-run (built CLI)", () => {
  it(
    "cold cache: concurrent first prepare-runs clone once and all succeed",
    async () => {
      // Three fresh stateDirs: the pre-fix clone race was probabilistic, so
      // a single cold batch could pass by luck.
      for (let trial = 0; trial < 3; trial++) {
        const fx = makeRepo();
        const runIds = Array.from({ length: 8 }, (_, i) => `cold-${trial}-${i}`);
        const results = await runConcurrent(fx, runIds);
        for (const { envelope } of results) {
          expect(envelope.data?.["workspace_id"]).toBeTruthy();
        }
        assertSingleCacheRow(fx, 8);
      }
    },
    300_000,
  );

  it(
    "warm cache: concurrent prepare-runs on an existing mirror all succeed",
    async () => {
      const fx = makeRepo();
      const first = await runConcurrent(fx, ["warm-seed"]);
      expect(first[0]!.envelope.data?.["workspace_id"]).toBeTruthy();

      const runIds = Array.from({ length: 8 }, (_, i) => `warm-${i}`);
      const results = await runConcurrent(fx, runIds);
      for (const { envelope } of results) {
        expect(envelope.data?.["workspace_id"]).toBeTruthy();
      }
      assertSingleCacheRow(fx, 9);
      const db = openRegistry(fx.stateDir);
      expect(dbCount(db, "repository_caches", "repository_url = ?", fx.repo)).toBe(1);
      db.close();
    },
    300_000,
  );
});

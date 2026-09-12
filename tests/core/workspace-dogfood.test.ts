import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getConfig, ensureStateDirs } from "../../src/config/index.js";
import { closeDb, openDb } from "../../src/db/index.js";
import { createWorkspace, getWorkspace } from "../../src/core/workspace.js";
import { lockWorkspace, unlockWorkspace } from "../../src/core/lock.js";
import { collectDiff } from "../../src/core/diff.js";
import { createSnapshot } from "../../src/core/snapshot.js";
import { getArtifactsForSnapshot } from "../../src/core/artifact.js";
import { cleanupWorkspace } from "../../src/core/cleanup.js";
import { ZigmaError } from "../../src/types/index.js";

const tempDirs: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

afterEach(() => {
  closeDb();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("real local Git workspace isolation", () => {
  // Two worktree creations + cleanup: exceeds the default 20s under
  // full-suite parallel load.
  it("isolates worktrees and enforces manifest filtering for diff/snapshot/cleanup", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zigma-workspace-dogfood-"));
    tempDirs.push(root);
    const repo = path.join(root, "repo");
    fs.mkdirSync(repo, { recursive: true });
    git(repo, "init", "-b", "main");
    git(repo, "config", "user.email", "dogfood@example.test");
    git(repo, "config", "user.name", "dogfood");
    fs.mkdirSync(path.join(repo, "src"));
    fs.writeFileSync(path.join(repo, "src", "shared.txt"), "base\n", "utf-8");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "initial");

    const stateDir = path.join(root, "state");
    const config = getConfig(stateDir);
    ensureStateDirs(config);
    const db = openDb(config);
    const baseCommit = git(repo, "rev-parse", "HEAD");

    const first = createWorkspace(db, config, {
      repositoryUrl: repo,
      baseRef: "main",
      branch: "flow-first",
      taskId: "task-first",
    });
    const second = createWorkspace(db, config, {
      repositoryUrl: repo,
      baseRef: "main",
      branch: "flow-second",
      taskId: "task-second",
    });

    expect(first.status).toBe("READY");
    expect(second.status).toBe("READY");
    expect(first.path).not.toBe(second.path);
    expect(first.baseCommit).toBe(baseCommit);

    fs.writeFileSync(path.join(first.path, "src", "first.txt"), "first\n", "utf-8");
    fs.writeFileSync(path.join(first.path, ".env"), "SECRET=hidden\n", "utf-8");
    fs.writeFileSync(path.join(second.path, "src", "second.txt"), "second\n", "utf-8");

    const firstDiff = collectDiff(db, config, first.id);
    expect(firstDiff.changedFiles).toEqual([]);
    expect(firstDiff.untrackedFiles).toEqual(["src/first.txt"]);
    expect(firstDiff.statusText).not.toContain(".env");
    expect(firstDiff.statusText).not.toContain(".zigma-workspace.json");
    expect(firstDiff.patchPath).toBeUndefined();

    const firstSnapshot = createSnapshot(db, config, first.id);
    expect(firstSnapshot.kind).toBe("metadata-only");
    expect(getArtifactsForSnapshot(db, firstSnapshot.id)).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) AS count FROM workspace_snapshots WHERE id = ?").get(firstSnapshot.id)).toEqual({ count: 1 });

    const readOne = lockWorkspace(db, first.id, "read", "flow-reader-1");
    const readTwo = lockWorkspace(db, first.id, "read", "flow-reader-2");
    expect(readOne.mode).toBe("read");
    expect(readTwo.mode).toBe("read");
    expect(() => lockWorkspace(db, first.id, "write", "flow-writer")).toThrow(
      expect.objectContaining({ code: "WORKSPACE_LOCK_CONFLICT" }),
    );
    unlockWorkspace(db, first.id);

    const writeLock = lockWorkspace(db, first.id, "write", "flow-writer");
    expect(() => cleanupWorkspace(db, config, first.id)).toThrow(ZigmaError);
    unlockWorkspace(db, first.id);
    const firstCleanup = cleanupWorkspace(db, config, first.id);
    expect(firstCleanup.removed).toBe(true);
    expect(getWorkspace(db, first.id).status).toBe("CLEANED");
    expect(fs.existsSync(first.path)).toBe(false);
    expect(writeLock.owner).toBe("flow-writer");

    const secondDiff = collectDiff(db, config, second.id);
    expect(secondDiff.untrackedFiles).toEqual(["src/second.txt"]);
    expect(fs.existsSync(second.path)).toBe(true);
    expect(fs.existsSync(path.join(second.path, "src", "first.txt"))).toBe(false);
  }, 120_000);
});

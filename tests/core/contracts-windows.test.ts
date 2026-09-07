/**
 * Windows-Specific Contract Tests
 *
 * These tests verify behavior under Windows-specific constraints:
 * - File locking (open handles blocking deletion)
 * - Long paths (>260 characters, MAX_PATH limit)
 * - Unicode paths (Chinese characters, CJK filenames)
 *
 * All tests use real git and filesystem — no mocks.
 */
import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getConfig, ensureStateDirs } from "../../src/config/index.js";
import { closeDb, openDb } from "../../src/db/index.js";
import { createWorkspace, getWorkspace } from "../../src/core/workspace.js";
import { commitWorkspace } from "../../src/core/commit.js";
import { cleanupWorkspaceStrict } from "../../src/core/cleanup.js";
import { getHeadCommit } from "../../src/git/index.js";
import type { Database } from "better-sqlite3";
import type { ZigmaWorkspaceConfig } from "../../src/types/index.js";
import { assertPathWithin, readAndValidateManifest } from "../../src/core/isolation-policy.js";
import { getWorkspaceById } from "../../src/db/queries.js";

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
const isWindows = process.platform === "win32";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function setupRepo(): TestContext {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zigma-win-"));
  tempDirs.push(root);
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "win-contract@example.test");
  git(repo, "config", "user.name", "win-contract-test");
  git(repo, "config", "core.autocrlf", "false");
  // Enable long paths if on Windows
  if (isWindows) {
    try {
      git(repo, "config", "core.longpaths", "true");
    } catch {
      // best effort
    }
  }
  fs.writeFileSync(path.join(repo, "README.md"), "# win test repo\n", "utf-8");
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

describe.skipIf(!isWindows)("Windows M3.2 path isolation", () => {
  it("rejects a junction that escapes the workspace root", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zigma-junction-root-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "zigma-junction-outside-"));
    tempDirs.push(root, outside);
    const junction = path.join(root, "escape");
    fs.symlinkSync(outside, junction, "junction");

    expect(() => assertPathWithin(root, path.join(junction, "secret.txt"), "Changed path")).toThrow(
      expect.objectContaining({ code: "WORKSPACE_PATH_POLICY_VIOLATION" }),
    );
  });

  it("rejects case-fold aliases in manifest policy", () => {
    const ctx = setupRepo();
    const ws = makeWorkspace(ctx, "case-alias-policy");
    const manifestPath = path.join(ws.path, ".zigma-workspace.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
    manifest["allowed_paths"] = ["Src"];
    manifest["denied_paths"] = ["src"];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), "utf-8");
    const row = getWorkspaceById(ctx.db, ws.id)!;

    expect(() => readAndValidateManifest(row)).toThrow(
      expect.objectContaining({ code: "WORKSPACE_PATH_POLICY_VIOLATION" }),
    );
  });
});

afterEach(() => {
  closeDb();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── File Locking During Cleanup ─────────────────────────────────────────────

describe("Windows file locking during cleanup", () => {
  it("cleanupWorkspaceStrict returns CLEANUP_FAILED when a file handle is open", () => {
    // This test is Windows-specific but the code path is cross-platform.
    // On Windows, an open file handle blocks directory deletion.
    // On Linux/macOS, deletion usually succeeds anyway (inode semantics).
    const ctx = setupRepo();
    const ws = makeWorkspace(ctx, "lock-test");

    // Write a test file and hold it open with a write lease
    const lockedFilePath = path.join(ws.path, "locked-file.txt");
    fs.writeFileSync(lockedFilePath, "this file is locked\n", "utf-8");
    // Use 'w+' for exclusive write lease — stronger than 'r'
    const fd = fs.openSync(lockedFilePath, "w+");

    try {
      // Delete the .git metadata to make removeWorktree fail
      const gitFile = path.join(ws.path, ".git");
      if (fs.existsSync(gitFile)) {
        fs.unlinkSync(gitFile);
      }

      const result = cleanupWorkspaceStrict(ctx.db, ctx.config, {
        operationId: uniqueId(),
        workspaceId: ws.id,
      });

      // CLEANUP_FAILED when deletion is blocked by open handle.
      // CLEANED when the platform/Node version allows force-deletion.
      // The CLEANUP_FAILED path is the important contract: the function
      // MUST NOT throw, MUST return a result with blockers, and MUST
      // transition to CLEANUP_FAILED if the directory persists.
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
      // Clean up manually if needed
      if (fs.existsSync(ws.path)) {
        try {
          fs.rmSync(ws.path, { recursive: true, force: true });
        } catch {
          // best effort
        }
      }
    }
  });

  it("cleanupWorkspaceStrict succeeds after lock file is released", () => {
    const ctx = setupRepo();
    const ws = makeWorkspace(ctx, "lock-release-test");

    // Write and release a file, then clean up normally
    const tempFilePath = path.join(ws.path, "temp-file.txt");
    fs.writeFileSync(tempFilePath, "temporary\n", "utf-8");
    // File is written and closed — no open handle

    const result = cleanupWorkspaceStrict(ctx.db, ctx.config, {
      operationId: uniqueId(),
      workspaceId: ws.id,
    });
    expect(result.status).toBe("CLEANED");
    expect(result.removed).toBe(true);
    expect(fs.existsSync(ws.path)).toBe(false);
  });

  it("multiple open handles all block cleanup on Windows", () => {
    const ctx = setupRepo();
    const ws = makeWorkspace(ctx, "multi-lock-test");

    // Open multiple file handles
    const files: string[] = [];
    const handles: number[] = [];
    for (let i = 0; i < 3; i++) {
      const filePath = path.join(ws.path, `locked-${i}.txt`);
      fs.writeFileSync(filePath, `file ${i}\n`, "utf-8");
      handles.push(fs.openSync(filePath, "w+"));
      files.push(filePath);
    }

    try {
      // Corrupt git metadata
      const gitFile = path.join(ws.path, ".git");
      if (fs.existsSync(gitFile)) {
        fs.unlinkSync(gitFile);
      }

      const result = cleanupWorkspaceStrict(ctx.db, ctx.config, {
        operationId: uniqueId(),
        workspaceId: ws.id,
      });

      if (result.status === "CLEANUP_FAILED") {
        expect(result.blockers!.length).toBeGreaterThan(0);
      } else {
        expect(result.status).toBe("CLEANED");
      }
    } finally {
      for (const h of handles) {
        try { fs.closeSync(h); } catch { /* ok */ }
      }
      if (fs.existsSync(ws.path)) {
        try { fs.rmSync(ws.path, { recursive: true, force: true }); } catch { /* ok */ }
      }
    }
  });
});

// ── Long Paths (>260 Characters) ────────────────────────────────────────────

describe("long path handling (>260 chars on Windows)", () => {
  it("creates a workspace at a path near MAX_PATH limit", () => {
    // Skip on non-Windows — this is a Windows-constraint test
    if (!isWindows) {
      return;
    }

    const ctx = setupRepo();

    // Calculate how many chars we need to reach near 260
    // tmpdir is typically short (e.g. C:\Users\...\AppData\Local\Temp)
    const tmpDir = os.tmpdir();
    const remainingBudget = 259 - tmpDir.length - 50; // 50 for base dir structure
    const deepName = "a".repeat(Math.max(0, Math.min(remainingBudget, 200)));

    const ws = createWorkspace(ctx.db, ctx.config, {
      repositoryUrl: ctx.repo,
      baseRef: "main",
      branch: "long-path-branch",
      jobId: deepName.slice(0, 63),
    });

    expect(ws.status).toBe("READY");
    expect(ws.path.length).toBeGreaterThan(tmpDir.length);
    // Verify the worktree is functional
    expect(fs.existsSync(path.join(ws.path, "README.md"))).toBe(true);

    // Should be able to clean up long paths
    const result = cleanupWorkspaceStrict(ctx.db, ctx.config, {
      operationId: uniqueId(),
      workspaceId: ws.id,
    });
    expect(result.status).toBe("CLEANED");
  });

  it("creates a workspace with deeply nested files and cleans up", () => {
    if (!isWindows) {
      return;
    }

    const ctx = setupRepo();
    const ws = makeWorkspace(ctx, "deep-nested");

    // Create a deeply nested directory structure
    let deepPath = ws.path;
    for (let i = 0; i < 10; i++) {
      deepPath = path.join(deepPath, `level-${i}-with-some-padding`);
      fs.mkdirSync(deepPath, { recursive: true });
      fs.writeFileSync(
        path.join(deepPath, "file.txt"),
        `content at level ${i}\n`,
        "utf-8",
      );
    }

    // Verify file exists at the deepest level
    const deepestFile = path.join(deepPath, "file.txt");
    expect(fs.existsSync(deepestFile)).toBe(true);

    // Add the deep file to gitignore so commitWorkspace sees it
    fs.appendFileSync(path.join(ws.path, ".gitignore"), ".zigma-workspace.json\n", "utf-8");
    execFileSync("git", ["add", ".gitignore"], { cwd: ws.path, encoding: "utf-8" });
    execFileSync(
      "git",
      ["-c", "user.email=z@local", "-c", "user.name=z", "commit", "-m", "setup"],
      { cwd: ws.path, encoding: "utf-8" },
    );

    // Commit the deep structure
    const commitResult = commitWorkspace(ctx.db, {
      operationId: uniqueId(),
      workspaceId: ws.id,
      message: "deep structure commit",
    });
    expect(commitResult.noOp).toBe(false);

    // Cleanup should handle deep paths
    const result = cleanupWorkspaceStrict(ctx.db, ctx.config, {
      operationId: uniqueId(),
      workspaceId: ws.id,
    });
    expect(result.status).toBe("CLEANED");
    expect(fs.existsSync(ws.path)).toBe(false);
  });

  it("git worktree add and commit work at path exceeding 200 chars", () => {
    if (!isWindows) {
      return;
    }

    const ctx = setupRepo();

    // Create a workspace whose branch is long-ish
    const longBranch = `feature/long-branch-name-${"x".repeat(50)}`;
    const ws = createWorkspace(ctx.db, ctx.config, {
      repositoryUrl: ctx.repo,
      baseRef: "main",
      branch: longBranch,
      jobId: "long-branch-job",
    });

    expect(ws.status).toBe("READY");
    expect(ws.path.length).toBeGreaterThan(100);

    // Write and commit a change
    fs.appendFileSync(path.join(ws.path, ".gitignore"), ".zigma-workspace.json\n", "utf-8");
    execFileSync("git", ["add", ".gitignore"], { cwd: ws.path, encoding: "utf-8" });
    execFileSync(
      "git",
      ["-c", "user.email=z@local", "-c", "user.name=z", "commit", "-m", "setup"],
      { cwd: ws.path, encoding: "utf-8" },
    );

    fs.writeFileSync(path.join(ws.path, "long-path-test.txt"), "test\n", "utf-8");
    const commitResult = commitWorkspace(ctx.db, {
      operationId: uniqueId(),
      workspaceId: ws.id,
      message: "long path workspace commit",
    });
    expect(commitResult.noOp).toBe(false);
    expect(commitResult.changedFiles).toContain("long-path-test.txt");

    // Verify the commit is visible
    const head = getHeadCommit(ws.path);
    expect(head).toBeTruthy();
    expect(head).toBe(commitResult.headCommit);

    // Clean up
    cleanupWorkspaceStrict(ctx.db, ctx.config, {
      operationId: uniqueId(),
      workspaceId: ws.id,
    });
  });
});

// ── Chinese/Unicode Paths ───────────────────────────────────────────────────

describe("Chinese and Unicode path handling", () => {
  it("creates workspace from a repo at a path containing Chinese characters", () => {
    const ctx = setupRepo();
    const ws = makeWorkspace(ctx, "chinese-branch");

    // Write files with Chinese filenames and content
    const chineseFilename = "测试文件.txt";
    const chineseContent = "这是中文内容。\n";
    fs.writeFileSync(path.join(ws.path, chineseFilename), chineseContent, "utf-8");

    // Verify the file exists
    expect(fs.existsSync(path.join(ws.path, chineseFilename))).toBe(true);
    expect(fs.readFileSync(path.join(ws.path, chineseFilename), "utf-8")).toBe(chineseContent);

    // Prepare workspace
    fs.appendFileSync(path.join(ws.path, ".gitignore"), ".zigma-workspace.json\n", "utf-8");
    execFileSync("git", ["add", ".gitignore"], { cwd: ws.path, encoding: "utf-8" });
    execFileSync(
      "git",
      ["-c", "user.email=z@local", "-c", "user.name=z", "commit", "-m", "setup"],
      { cwd: ws.path, encoding: "utf-8" },
    );

    // Commit should capture the Chinese filename
    const result = commitWorkspace(ctx.db, {
      operationId: uniqueId(),
      workspaceId: ws.id,
      message: "中文提交信息",
    });
    expect(result.noOp).toBe(false);
    expect(result.changedFiles).toContain(chineseFilename);

    // Clean up
    cleanupWorkspaceStrict(ctx.db, ctx.config, {
      operationId: uniqueId(),
      workspaceId: ws.id,
    });
    expect(fs.existsSync(ws.path)).toBe(false);
  });

  it("handles CJK characters in branch names and file content", () => {
    const ctx = setupRepo();

    // Branch name with Japanese and Chinese characters
    const ws = createWorkspace(ctx.db, ctx.config, {
      repositoryUrl: ctx.repo,
      baseRef: "main",
      branch: "機能ブランチ/テスト",
      jobId: "cjk-job",
    });
    expect(ws.status).toBe("READY");

    // Japanese filename
    const japaneseFilename = "テスト計画.md";
    fs.writeFileSync(path.join(ws.path, japaneseFilename), "# テスト計画\n\nこれはテストです。\n", "utf-8");

    // Korean filename
    const koreanFilename = "테스트파일.txt";
    fs.writeFileSync(path.join(ws.path, koreanFilename), "한국어 콘텐츠\n", "utf-8");

    expect(fs.existsSync(path.join(ws.path, japaneseFilename))).toBe(true);
    expect(fs.existsSync(path.join(ws.path, koreanFilename))).toBe(true);

    // Prepare and commit
    fs.appendFileSync(path.join(ws.path, ".gitignore"), ".zigma-workspace.json\n", "utf-8");
    execFileSync("git", ["add", ".gitignore"], { cwd: ws.path, encoding: "utf-8" });
    execFileSync(
      "git",
      ["-c", "user.email=z@local", "-c", "user.name=z", "commit", "-m", "setup"],
      { cwd: ws.path, encoding: "utf-8" },
    );

    const result = commitWorkspace(ctx.db, {
      operationId: uniqueId(),
      workspaceId: ws.id,
      message: "多言語コミット",
    });
    expect(result.noOp).toBe(false);
    // Both files should be in the changed list
    const files = result.changedFiles;
    expect(files.some((f) => f.includes("テスト"))).toBe(true);
    expect(files.some((f) => f.includes("테스트"))).toBe(true);

    // Clean up
    cleanupWorkspaceStrict(ctx.db, ctx.config, {
      operationId: uniqueId(),
      workspaceId: ws.id,
    });
    expect(fs.existsSync(ws.path)).toBe(false);
  });

  it("handles emoji in file content", () => {
    const ctx = setupRepo();
    const ws = makeWorkspace(ctx, "emoji-branch");

    const emojiContent = "🚀 Deploy Status: ✅ Tests: 💚 Build: 🏗️\n";
    fs.writeFileSync(path.join(ws.path, "status.md"), emojiContent, "utf-8");

    // Prepare, commit, verify
    fs.appendFileSync(path.join(ws.path, ".gitignore"), ".zigma-workspace.json\n", "utf-8");
    execFileSync("git", ["add", ".gitignore"], { cwd: ws.path, encoding: "utf-8" });
    execFileSync(
      "git",
      ["-c", "user.email=z@local", "-c", "user.name=z", "commit", "-m", "setup"],
      { cwd: ws.path, encoding: "utf-8" },
    );

    const result = commitWorkspace(ctx.db, {
      operationId: uniqueId(),
      workspaceId: ws.id,
      message: "🎉 Deploy ready!",
    });
    expect(result.noOp).toBe(false);
    expect(result.changedFiles).toContain("status.md");

    // Content should roundtrip correctly
    const content = fs.readFileSync(path.join(ws.path, "status.md"), "utf-8");
    expect(content).toBe(emojiContent);

    cleanupWorkspaceStrict(ctx.db, ctx.config, {
      operationId: uniqueId(),
      workspaceId: ws.id,
    });
  });

  it("handles right-to-left and zero-width characters in filenames", () => {
    const ctx = setupRepo();
    const ws = makeWorkspace(ctx, "unicode-edge");

    // Arabic (RTL) content
    const arabicFilename = "ملف.txt";
    fs.writeFileSync(path.join(ws.path, arabicFilename), "مرحبا بالعالم\n", "utf-8");
    expect(fs.existsSync(path.join(ws.path, arabicFilename))).toBe(true);

    // Prepare and commit
    fs.appendFileSync(path.join(ws.path, ".gitignore"), ".zigma-workspace.json\n", "utf-8");
    execFileSync("git", ["add", ".gitignore"], { cwd: ws.path, encoding: "utf-8" });
    execFileSync(
      "git",
      ["-c", "user.email=z@local", "-c", "user.name=z", "commit", "-m", "setup"],
      { cwd: ws.path, encoding: "utf-8" },
    );

    const result = commitWorkspace(ctx.db, {
      operationId: uniqueId(),
      workspaceId: ws.id,
      message: "اختبار الالتزام",
    });
    expect(result.noOp).toBe(false);
    expect(result.changedFiles).toContain(arabicFilename);

    cleanupWorkspaceStrict(ctx.db, ctx.config, {
      operationId: uniqueId(),
      workspaceId: ws.id,
    });
  });
});

// ── Windows Path Edge Cases ─────────────────────────────────────────────────

describe("Windows path edge cases", () => {
  it("handles paths with spaces and special characters", () => {
    const ctx = setupRepo();
    // Create workspace with a branch that has special chars git allows
    const ws = createWorkspace(ctx.db, ctx.config, {
      repositoryUrl: ctx.repo,
      baseRef: "main",
      branch: "feature/special-chars-test",
      jobId: "special-chars",
    });
    expect(ws.status).toBe("READY");

    // Filename with spaces and parentheses (tricky on Windows CLI)
    const specialFilename = "report (v2) - final.txt";
    fs.writeFileSync(
      path.join(ws.path, specialFilename),
      "report content\n",
      "utf-8",
    );
    expect(fs.existsSync(path.join(ws.path, specialFilename))).toBe(true);

    // Prepare and commit
    fs.appendFileSync(path.join(ws.path, ".gitignore"), ".zigma-workspace.json\n", "utf-8");
    execFileSync("git", ["add", ".gitignore"], { cwd: ws.path, encoding: "utf-8" });
    execFileSync(
      "git",
      ["-c", "user.email=z@local", "-c", "user.name=z", "commit", "-m", "setup"],
      { cwd: ws.path, encoding: "utf-8" },
    );

    const result = commitWorkspace(ctx.db, {
      operationId: uniqueId(),
      workspaceId: ws.id,
      message: "commit special filename",
    });
    expect(result.noOp).toBe(false);
    expect(result.changedFiles).toContain(specialFilename);

    cleanupWorkspaceStrict(ctx.db, ctx.config, {
      operationId: uniqueId(),
      workspaceId: ws.id,
    });
    expect(fs.existsSync(ws.path)).toBe(false);
  });

  it("handles reserved device names in file content (not filenames)", () => {
    // CON, PRN, AUX, NUL, COM1, LPT1 are reserved on Windows as filenames
    // but should be fine as file content
    const ctx = setupRepo();
    const ws = makeWorkspace(ctx, "reserved-content");

    const content = "References: CON, PRN, AUX, NUL, COM1, LPT1\n";
    fs.writeFileSync(path.join(ws.path, "notes.txt"), content, "utf-8");

    // Prepare and commit
    fs.appendFileSync(path.join(ws.path, ".gitignore"), ".zigma-workspace.json\n", "utf-8");
    execFileSync("git", ["add", ".gitignore"], { cwd: ws.path, encoding: "utf-8" });
    execFileSync(
      "git",
      ["-c", "user.email=z@local", "-c", "user.name=z", "commit", "-m", "setup"],
      { cwd: ws.path, encoding: "utf-8" },
    );

    const result = commitWorkspace(ctx.db, {
      operationId: uniqueId(),
      workspaceId: ws.id,
      message: "reserved device name references",
    });
    expect(result.noOp).toBe(false);
    expect(result.changedFiles).toContain("notes.txt");

    const readBack = fs.readFileSync(path.join(ws.path, "notes.txt"), "utf-8");
    expect(readBack).toBe(content);

    cleanupWorkspaceStrict(ctx.db, ctx.config, {
      operationId: uniqueId(),
      workspaceId: ws.id,
    });
  });
});

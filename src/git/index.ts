import { execSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

export class GitError extends Error {
  constructor(
    message: string,
    public readonly command: string,
    public readonly stderr: string
  ) {
    super(message);
    this.name = "GitError";
  }
}

function runGit(args: string[], cwd?: string, env?: NodeJS.ProcessEnv): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 50 * 1024 * 1024,
  });

  if (result.error) {
    throw new GitError(
      `git command failed: ${result.error.message}`,
      `git ${args.join(" ")}`,
      ""
    );
  }

  if (result.status !== 0) {
    throw new GitError(
      `git ${args[0]} failed with exit code ${result.status}: ${(result.stderr ?? "").trim()}`,
      `git ${args.join(" ")}`,
      (result.stderr ?? "").trim()
    );
  }

  return (result.stdout ?? "").trimEnd();
}

/**
 * Compute a stable directory name from a repository URL (url hash).
 */
export function hashRepoUrl(url: string): string {
  return crypto.createHash("sha256").update(url).digest("hex").slice(0, 16);
}

/**
 * Clone a repository as a bare mirror into mirrorPath.
 * If mirrorPath already exists, skip.
 */
export function cloneMirror(repoUrl: string, mirrorPath: string): void {
  if (fs.existsSync(mirrorPath)) {
    return;
  }
  fs.mkdirSync(path.dirname(mirrorPath), { recursive: true });
  runGit(["clone", "--bare", "--mirror", repoUrl, mirrorPath]);
}

/**
 * Fetch all refs in an existing mirror.
 */
export function fetchMirror(mirrorPath: string): void {
  runGit(["fetch", "--all", "--prune"], mirrorPath);
}

/**
 * Resolve a ref (branch name, tag, or commit-ish) to a full commit SHA
 * inside a mirror/bare repo.
 */
export function resolveRef(mirrorPath: string, ref: string): string {
  // Try rev-parse with the ref as-is
  try {
    return runGit(["rev-parse", ref], mirrorPath).trim();
  } catch {
    // Try remote tracking refs
    try {
      return runGit(["rev-parse", `refs/heads/${ref}`], mirrorPath).trim();
    } catch {
      return runGit(["rev-parse", `origin/${ref}`], mirrorPath).trim();
    }
  }
}

/**
 * Create a git worktree at workspacePath from a bare mirror,
 * checking out baseCommit and creating a new branch called branch.
 */
export function createWorktree(
  mirrorPath: string,
  workspacePath: string,
  branch: string,
  baseCommit: string
): void {
  fs.mkdirSync(path.dirname(workspacePath), { recursive: true });
  // Use git worktree add -b <branch> <path> <commit>
  runGit(
    ["worktree", "add", "-b", branch, workspacePath, baseCommit],
    mirrorPath
  );
}

/**
 * Remove a git worktree, both its directory and the worktree metadata from the mirror.
 */
export function removeWorktree(mirrorPath: string, workspacePath: string): void {
  if (fs.existsSync(workspacePath)) {
    // Force-remove the worktree directory
    try {
      runGit(["worktree", "remove", "--force", workspacePath], mirrorPath);
    } catch {
      // If worktree remove fails (e.g., no longer registered), remove directory manually
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }
  }
  // Prune stale worktree references
  try {
    runGit(["worktree", "prune"], mirrorPath);
  } catch {
    // ignore prune errors
  }
}

/**
 * List all registered worktrees for a mirror.
 * Returns an array of { path, branch, commit } objects.
 */
export function listWorktrees(
  mirrorPath: string
): Array<{ path: string; branch: string; commit: string }> {
  let output: string;
  try {
    output = runGit(["worktree", "list", "--porcelain"], mirrorPath);
  } catch {
    return [];
  }

  const entries: Array<{ path: string; branch: string; commit: string }> = [];
  const blocks = output.split(/\n\n+/);

  for (const block of blocks) {
    const lines = block
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) continue;

    let wtPath = "";
    let commit = "";
    let branch = "";

    for (const line of lines) {
      if (line.startsWith("worktree ")) wtPath = line.slice("worktree ".length).trim();
      else if (line.startsWith("HEAD ")) commit = line.slice("HEAD ".length).trim();
      else if (line.startsWith("branch ")) {
        branch = line.slice("branch ".length).trim();
        // Convert refs/heads/foo to foo
        if (branch.startsWith("refs/heads/")) {
          branch = branch.slice("refs/heads/".length);
        }
      }
    }

    if (wtPath) {
      entries.push({ path: wtPath, branch, commit });
    }
  }

  return entries;
}

/**
 * Get git status --porcelain output in a worktree.
 */
export function getStatus(workspacePath: string): string {
  try {
    return runGit(["status", "--porcelain"], workspacePath);
  } catch {
    return "";
  }
}

/**
 * Get a list of changed (tracked) files relative to a base commit.
 */
export function getChangedFiles(workspacePath: string, baseCommit: string): string[] {
  try {
    const output = runGit(
      ["diff", "--name-only", baseCommit, "HEAD"],
      workspacePath
    );
    if (!output) return [];
    return output
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);
  } catch {
    // No commits yet or no diff
    try {
      const output = runGit(["diff", "--name-only", baseCommit], workspacePath);
      if (!output) return [];
      return output
        .split("\n")
        .map((f) => f.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }
}

/**
 * Get a list of untracked files.
 */
export function getUntrackedFiles(workspacePath: string): string[] {
  try {
    const output = runGit(
      ["ls-files", "--others", "--exclude-standard"],
      workspacePath
    );
    if (!output) return [];
    return output
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Get diff stat summary.
 */
export function getDiffStat(workspacePath: string, baseCommit: string): string {
  try {
    return runGit(["diff", "--stat", baseCommit], workspacePath);
  } catch {
    return "";
  }
}

/**
 * Generate a full patch (diff) from the base commit.
 * Returns the patch content as a string.
 */
export function generatePatch(workspacePath: string, baseCommit: string): string {
  try {
    return runGit(["diff", baseCommit], workspacePath);
  } catch {
    return "";
  }
}

/**
 * Get the current HEAD commit SHA in a worktree.
 */
export function getHeadCommit(workspacePath: string): string | undefined {
  try {
    return runGit(["rev-parse", "HEAD"], workspacePath).trim();
  } catch {
    return undefined;
  }
}

/**
 * Check if git is available on the PATH.
 */
export function checkGitAvailable(): void {
  const result = spawnSync("git", ["--version"], { encoding: "utf-8" });
  if (result.error || result.status !== 0) {
    throw new Error(
      "git is not available. Please install git and ensure it is in your PATH."
    );
  }
}

/**
 * Get the default branch of a mirror repository.
 */
export function getDefaultBranch(mirrorPath: string): string | undefined {
  try {
    const symref = runGit(["symbolic-ref", "HEAD"], mirrorPath).trim();
    if (symref.startsWith("refs/heads/")) {
      return symref.slice("refs/heads/".length);
    }
    return symref || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Configure a worktree to not be read-only (set git config).
 * For read-only mode, we set core.fileMode and configure sparse checkout.
 */
export function configureWorktreeMode(
  workspacePath: string,
  mode: "read-only" | "writable"
): void {
  if (mode === "read-only") {
    try {
      runGit(["config", "core.readOnly", "true"], workspacePath);
    } catch {
      // Not a real git config, just a marker — ignore
    }
  }
}

/**
 * Stage all changes and create a commit in the worktree (for snapshot purposes).
 * Returns the new commit SHA, or undefined if there was nothing to commit.
 */
export function commitAllChanges(
  workspacePath: string,
  message: string
): string | undefined {
  try {
    const status = getStatus(workspacePath);
    if (!status.trim()) return undefined;
    runGit(["add", "-A"], workspacePath);
    runGit(
      [
        "-c",
        "user.email=zigma-workspace@local",
        "-c",
        "user.name=zigma-workspace",
        "commit",
        "-m",
        message,
      ],
      workspacePath
    );
    return getHeadCommit(workspacePath);
  } catch {
    return undefined;
  }
}

/**
 * Safe exec for simple git commands where we want stdout as a string.
 * Falls back to empty string on error.
 */
export function safeGitOutput(args: string[], cwd: string): string {
  try {
    return runGit(args, cwd);
  } catch {
    return "";
  }
}

export { runGit };

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
  runGit(["fetch", "--all"], mirrorPath);
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
 * Check whether a path is still registered as a worktree.
 * Unlike listWorktrees(), verification failures are surfaced so callers that
 * require proof of removal cannot mistake an unreadable registry for absence.
 */
export function isWorktreeRegistered(mirrorPath: string, workspacePath: string): boolean {
  const output = runGit(["worktree", "list", "--porcelain"], mirrorPath);
  const normalize = (value: string): string => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const expected = normalize(workspacePath);

  return output.split("\n").some((line) => {
    if (!line.startsWith("worktree ")) return false;
    return normalize(line.slice("worktree ".length).trim()) === expected;
  });
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

export function getStatusFiles(workspacePath: string): string[] {
  const output = runGit(["-c", "core.quotepath=false", "status", "--porcelain=v1", "-z"], workspacePath);
  const records = output.split("\0").filter(Boolean);
  const files: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const status = record.slice(0, 2);
    files.push(record.slice(3));
    if (status.includes("R") || status.includes("C")) {
      const source = records[index + 1];
      if (source) files.push(source);
      index += 1;
    }
  }
  return [...new Set(files)];
}

/**
 * Get a list of changed (tracked) files relative to a base commit.
 */
export function getChangedFiles(workspacePath: string, baseCommit: string): string[] {
  try {
    const output = runGit(
      ["-c", "core.quotepath=false", "diff", "--name-only", baseCommit, "HEAD"],
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
      const output = runGit(["-c", "core.quotepath=false", "diff", "--name-only", baseCommit], workspacePath);
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
      ["-c", "core.quotepath=false", "ls-files", "--others", "--exclude-standard"],
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
export function getDiffStat(
  workspacePath: string,
  baseCommit: string,
  paths?: string[],
): string {
  try {
    return runGit(
      ["diff", "--stat", baseCommit, ...(paths && paths.length > 0 ? ["--", ...paths] : [])],
      workspacePath,
    );
  } catch {
    return "";
  }
}

/**
 * Generate a full patch (diff) from the base commit.
 * Returns the patch content as a string.
 */
export function generatePatch(
  workspacePath: string,
  baseCommit: string,
  paths?: string[],
): string {
  try {
    return runGit(
      ["diff", baseCommit, ...(paths && paths.length > 0 ? ["--", ...paths] : [])],
      workspacePath,
    );
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

/**
 * Stage ALL changes including untracked files, renames, and deletes.
 * Uses `git add --all` which captures tracked, untracked, rename, delete,
 * and binary changes. Does NOT silently swallow errors.
 */
export function stageAll(workspacePath: string): void {
  runGit(["add", "--all"], workspacePath);
}

/**
 * Create a commit with the given message. Returns the new commit SHA.
 * Throws GitError on failure — never returns undefined silently.
 */
export function createCommit(
  workspacePath: string,
  message: string
): string {
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
  return getHeadCommit(workspacePath)!;
}

/**
 * Get the list of files changed in a commit range.
 */
export function getCommitFiles(
  workspacePath: string,
  fromCommit: string,
  toCommit: string
): string[] {
  try {
    const output = runGit(
      ["-c", "core.quotepath=false", "diff", "--name-only", fromCommit, toCommit],
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
 * Check if the working tree has any uncommitted changes (tracked or untracked).
 * Returns true if dirty.
 */
export function isWorkingTreeDirty(workspacePath: string): boolean {
  try {
    const status = runGit(["status", "--porcelain"], workspacePath);
    return status.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Get the full status text including untracked files (--porcelain).
 */
export function getFullStatus(workspacePath: string): string {
  return runGit(["status", "--porcelain"], workspacePath);
}

/**
 * Merge a commit into the current branch. Returns the merge commit SHA.
 * Uses --no-ff to always create a merge commit for audit trail.
 * Throws GitError on conflict.
 */
export function mergeCommit(
  workspacePath: string,
  sourceCommit: string,
  message: string
): string {
  runGit(
    [
      "-c",
      "user.email=zigma-workspace@local",
      "-c",
      "user.name=zigma-workspace",
      "merge",
      "--no-ff",
      "-m",
      message,
      sourceCommit,
    ],
    workspacePath
  );
  return getHeadCommit(workspacePath)!;
}

/**
 * List paths with unmerged (conflict) index entries in a worktree.
 */
export function getUnmergedFiles(workspacePath: string): string[] {
  const output = runGit(
    ["-c", "core.quotepath=false", "diff", "--name-only", "--diff-filter=U"],
    workspacePath
  );
  return output
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);
}

/**
 * Attempt a merge and return the conflict file list if it fails.
 * On conflict, aborts the merge to restore clean state.
 * Returns { success: true, commit } or { success: false, conflictFiles }.
 * Non-conflict git failures rethrow the original error.
 */
export function mergeOrConflict(
  workspacePath: string,
  sourceCommit: string,
  message: string
): { success: true; commit: string } | { success: false; conflictFiles: string[] } {
  try {
    runGit(
      [
        "-c",
        "user.email=zigma-workspace@local",
        "-c",
        "user.name=zigma-workspace",
        "merge",
        "--no-ff",
        "-m",
        message,
        sourceCommit,
      ],
      workspacePath
    );
    const commit = getHeadCommit(workspacePath)!;
    return { success: true, commit };
  } catch (err) {
    // Collect unmerged paths before aborting: abort resets the index,
    // which would erase the conflict evidence.
    let conflictFiles: string[] = [];
    try {
      conflictFiles = getUnmergedFiles(workspacePath);
    } catch {
      // Can't get conflict files
    }

    // Abort merge to restore clean state
    try {
      runGit(["merge", "--abort"], workspacePath);
    } catch {
      // If abort fails, try reset
      try {
        runGit(["reset", "--hard", "HEAD"], workspacePath);
      } catch {
        // Best effort
      }
    }

    if (conflictFiles.length === 0) {
      // Not a conflict: genuine git failure
      throw err;
    }
    return { success: false, conflictFiles };
  }
}

/**
 * Diff two commits (works in bare mirrors).
 */
export function diffCommits(repoPath: string, from: string, to: string): string {
  return runGit(["diff", `${from}..${to}`], repoPath);
}

/**
 * List files changed between two commits (works in bare mirrors).
 */
export function getCommitsDiffFiles(repoPath: string, from: string, to: string): string[] {
  const output = runGit(["diff", "--name-only", `${from}..${to}`], repoPath);
  return output
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);
}

/**
 * Push a branch to the specified remote and ref.
 * Throws GitError on failure.
 */
export function pushBranch(
  mirrorPath: string,
  branch: string,
  remoteRef: string
): void {
  runGit(
    ["-c", "remote.origin.mirror=false", "push", "origin", `${branch}:${remoteRef}`],
    mirrorPath,
  );
}

/**
 * Fetch a specific ref from origin in a mirror.
 */
export function fetchRef(mirrorPath: string, ref: string): void {
  runGit(["fetch", "origin", ref], mirrorPath);
}

/**
 * Check if a branch exists in the mirror.
 */
export function branchExists(mirrorPath: string, branch: string): boolean {
  try {
    runGit(["rev-parse", "--verify", `refs/heads/${branch}`], mirrorPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reset a worktree to a specific commit, discarding all local changes.
 */
export function resetHard(workspacePath: string, commit: string): void {
  runGit(["reset", "--hard", commit], workspacePath);
}

/**
 * Get the commit log in a range as structured data.
 */
export function getCommitLog(
  workspacePath: string,
  fromCommit: string,
  toCommit: string
): Array<{ hash: string; message: string }> {
  try {
    const output = runGit(
      ["log", "--format=%H%n%s", `${fromCommit}..${toCommit}`],
      workspacePath
    );
    if (!output) return [];
    const lines = output.split("\n").filter(Boolean);
    const commits: Array<{ hash: string; message: string }> = [];
    for (let i = 0; i < lines.length; i += 2) {
      commits.push({ hash: lines[i].trim(), message: lines[i + 1]?.trim() ?? "" });
    }
    return commits;
  } catch {
    return [];
  }
}

/**
 * Check if a commit is an ancestor of another (i.e., already merged).
 */
export function isAncestor(
  workspacePath: string,
  maybeAncestor: string,
  commit: string
): boolean {
  try {
    runGit(["merge-base", "--is-ancestor", maybeAncestor, commit], workspacePath);
    return true;
  } catch {
    return false;
  }
}

export { runGit };

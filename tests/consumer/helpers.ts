/**
 * Consumer-process harness shared helpers.
 *
 * These tests play the role of an external consumer (Flow/Core) and exercise
 * the BUILT CLI artifact (dist/cli/index.js) over spawn boundaries — the
 * first test layer in this repo that never runs provider code in-process.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const distCli = path.join(repoRoot, "dist", "cli", "index.js");

export interface InvokeResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface JsonEnvelope {
  contract_version: number;
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

const tempDirs: string[] = [];

export function cleanupTempDirs(): void {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtime(p));
    } else {
      newest = Math.max(newest, fs.statSync(p).mtimeMs);
    }
  }
  return newest;
}

let distReady: Promise<void> | null = null;

/**
 * Build dist/cli/index.js when it is missing or older than any source file.
 * `pnpm check` builds before tests, so this is a no-op there; standalone
 * `pnpm test:unit` runs stay correct without a manual build step.
 */
export function ensureBuiltDist(): Promise<void> {
  if (distReady) return distReady;
  distReady = (async () => {
    const needsBuild =
      !fs.existsSync(distCli) ||
      newestMtime(path.join(repoRoot, "src")) > fs.statSync(distCli).mtimeMs;
    if (!needsBuild) return;
    const result = spawnSync("pnpm", ["build"], {
      cwd: repoRoot,
      encoding: "utf-8",
      shell: process.platform === "win32",
      timeout: 600_000,
      env: { ...process.env, NO_COLOR: "1" },
    });
    if (result.status !== 0) {
      throw new Error(`dist build failed:\n${result.stdout}\n${result.stderr}`);
    }
  })();
  return distReady;
}

export function invokeCli(args: string[]): InvokeResult {
  const result = spawnSync(process.execPath, [distCli, ...args], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: { ...process.env, NO_COLOR: "1" },
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

export function invokeCliAsync(args: string[]): Promise<InvokeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [distCli, ...args], {
      cwd: repoRoot,
      env: { ...process.env, NO_COLOR: "1" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf-8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf-8")));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

export function parseEnvelope(stdout: string): JsonEnvelope {
  if (stdout.trim() === "") {
    throw new Error("CLI produced no stdout envelope");
  }
  return JSON.parse(stdout) as JsonEnvelope;
}

export function expectOk(r: InvokeResult): JsonEnvelope {
  if (r.status !== 0) {
    throw new Error(`CLI exited ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  }
  const envelope = parseEnvelope(r.stdout);
  if (envelope.contract_version !== 1 || !envelope.ok) {
    throw new Error(`Unexpected envelope: ${r.stdout}`);
  }
  return envelope;
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

export interface Fixture {
  root: string;
  repo: string;
  stateDir: string;
}

export function makeRepo(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zigma-consumer-"));
  tempDirs.push(root);
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "consumer@example.test");
  git(repo, "config", "user.name", "Consumer harness");
  git(repo, "config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(repo, "README.md"), "# fixture\n", "utf-8");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "initial");
  return { root, repo, stateDir: path.join(root, "state") };
}

export function openRegistry(stateDir: string): Database.Database {
  return new Database(path.join(stateDir, "registry.db"));
}

export function waitForLine(
  stream: NodeJS.ReadableStream,
  needle: string,
  timeoutMs = 30_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for "${needle}"`)), timeoutMs);
    let buf = "";
    stream.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf-8");
      if (buf.includes(needle)) {
        clearTimeout(timer);
        resolve();
      }
    });
    stream.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export async function pollUntil(check: () => boolean, timeoutMs = 30_000, intervalMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("pollUntil timed out");
}

export function canDelete(file: string): boolean {
  try {
    fs.rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

export function dbCount(db: Database.Database, table: string, where: string, ...params: unknown[]): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...params) as { n: number };
  return row.n;
}

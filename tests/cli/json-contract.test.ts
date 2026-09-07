import { execFileSync, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

const cliPath = path.resolve("src/cli/index.ts");
const packageVersion = (JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf-8")) as { version: string }).version;
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zigma-cli-contract-"));
  tempDirs.push(root);
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "cli-contract@example.test");
  git(repo, "config", "user.name", "CLI contract test");
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
  // A consumer rejects any other major version before looking at data/error.
  // These black-box results prove this provider only emits the published V1.
  expect(envelope.contract_version).toBe(1);
  expect(envelope.ok).toBe(ok);
}

function canonicalHash(value: Record<string, unknown>): string {
  const sorted = Object.keys(value).sort().reduce<Record<string, unknown>>((result, key) => {
    result[key] = value[key];
    return result;
  }, {});
  return crypto.createHash("sha256").update(JSON.stringify(sorted), "utf-8").digest("hex");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Workspace CLI JSON V1 black-box contract", () => {
  it("reports the provider contract without creating state or workspace files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zigma-contract-info-"));
    tempDirs.push(root);
    const stateDir = path.join(root, "state-that-must-not-be-created");
    const result = invokeCli([
      "--state-dir",
      stateDir,
      "contract-info",
      "--json",
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const envelope = parseSingleEnvelope(result.stdout);
    assertV1Envelope(envelope, true);
    expect(envelope.data).toMatchObject({
      provider: "zigma-workspace",
      package_version: packageVersion,
      contract_version: 1,
      capabilities: [
        "workspace-create-v1",
        "workspace-bind-run-v1",
        "workspace-diff-artifact-v1",
        "workspace-snapshot-artifacts-v1",
        "workspace-cleanup-v1",
        "workspace-heartbeat-v1",
        "workspace-reconcile-v1",
        "workspace-integration-lock-v1",
        "workspace-strict-cleanup-v1",
      ],
    });
    expect(fs.existsSync(stateDir)).toBe(false);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("emits one stdout success envelope and verifiable diff/snapshot artifact descriptors", () => {
    const { repo, stateDir } = makeRepo();
    const create = invokeCli([
      "--state-dir", stateDir,
      "create", "--repo", repo, "--base", "main", "--branch", "contract-artifacts", "--json",
    ]);

    expect(create.status).toBe(0);
    expect(create.stderr).toBe("");
    const created = parseSingleEnvelope(create.stdout);
    assertV1Envelope(created, true);
    const workspaceId = String(created.data?.workspace_id);
    const workspacePath = String(created.data?.path);

    fs.writeFileSync(path.join(workspacePath, "README.md"), "# changed fixture\n", "utf-8");
    git(workspacePath, "config", "user.email", "cli-contract@example.test");
    git(workspacePath, "config", "user.name", "CLI contract test");
    git(workspacePath, "config", "core.autocrlf", "false");
    git(workspacePath, "add", "README.md");
    git(workspacePath, "commit", "-m", "change fixture");

    const diff = invokeCli(["--state-dir", stateDir, "diff", "--workspace", workspaceId, "--json"]);
    expect(diff.status).toBe(0);
    expect(diff.stderr).toBe("");
    const diffEnvelope = parseSingleEnvelope(diff.stdout);
    assertV1Envelope(diffEnvelope, true);
    const patchArtifact = diffEnvelope.data?.patch_artifact as Record<string, unknown>;
    expect(patchArtifact).toMatchObject({ media_type: "text/x-diff" });
    expect(String(patchArtifact.uri)).toMatch(/^file:/);
    expect(String(patchArtifact.digest)).toMatch(/^sha256:[a-f0-9]{64}$/);
    const patchBytes = fs.readFileSync(fileURLToPath(String(patchArtifact.uri)));
    expect(`sha256:${crypto.createHash("sha256").update(patchBytes).digest("hex")}`).toBe(patchArtifact.digest);

    const snapshot = invokeCli(["--state-dir", stateDir, "snapshot", "--workspace", workspaceId, "--json"]);
    expect(snapshot.status).toBe(0);
    expect(snapshot.stderr).toBe("");
    const snapshotEnvelope = parseSingleEnvelope(snapshot.stdout);
    assertV1Envelope(snapshotEnvelope, true);
    const artifacts = snapshotEnvelope.data?.artifacts as Array<Record<string, unknown>>;
    expect(artifacts).toHaveLength(2);
    expect(artifacts.map((artifact) => artifact.kind).sort()).toEqual(["metadata", "patch"]);
    for (const artifact of artifacts) {
      expect(String(artifact.uri)).toMatch(/^file:/);
      expect(String(artifact.digest)).toMatch(/^sha256:[a-f0-9]{64}$/);
      const bytes = fs.readFileSync(fileURLToPath(String(artifact.uri)));
      expect(`sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`).toBe(artifact.digest);
    }
  });

  it("writes classified failures as one stdout envelope without stderr protocol guessing", () => {
    const { stateDir } = makeRepo();
    const missing = invokeCli(["--state-dir", stateDir, "diff", "--workspace", "ws_missing", "--json"]);

    expect(missing.status).toBe(1);
    expect(missing.stderr).toBe("");
    const envelope = parseSingleEnvelope(missing.stdout);
    assertV1Envelope(envelope, false);
    expect(envelope.error?.code).toBe("WORKSPACE_NOT_FOUND");
  });

  it("preserves V1 error semantics for operation ID conflicts", () => {
    const { repo, stateDir } = makeRepo();
    const operationId = crypto.randomUUID();
    const create = invokeCli([
      "--state-dir", stateDir,
      "create", "--repo", repo, "--base", "main", "--branch", "contract-conflict",
      "--operation-id", operationId, "--json",
    ]);
    const created = parseSingleEnvelope(create.stdout);
    assertV1Envelope(created, true);

    const conflict = invokeCli([
      "--state-dir", stateDir,
      "bind-run", "--workspace", String(created.data?.workspace_id), "--flow-run", "flow_conflict",
      "--operation-id", operationId, "--json",
    ]);
    expect(conflict.status).toBe(1);
    expect(conflict.stderr).toBe("");
    const envelope = parseSingleEnvelope(conflict.stdout);
    assertV1Envelope(envelope, false);
    expect(envelope.error).toMatchObject({ code: "OPERATION_ID_CONFLICT" });
  });

  it("governs lock heartbeat, reconciliation, integration ownership, and strict cleanup", () => {
    const { repo, stateDir } = makeRepo();
    const created = parseSingleEnvelope(invokeCli([
      "--state-dir", stateDir,
      "create", "--repo", repo, "--base", "main", "--branch", "governed-lifecycle", "--json",
    ]).stdout);
    const workspaceId = String(created.data?.workspace_id);
    const workspacePath = String(created.data?.path);
    const futureExpiry = new Date(Date.now() + 60_000).toISOString();

    const acquired = invokeCli([
      "--state-dir", stateDir, "lock", "--workspace", workspaceId,
      "--mode", "write", "--owner", "worker-a", "--expires-at", futureExpiry, "--json",
    ]);
    assertV1Envelope(parseSingleEnvelope(acquired.stdout), true);
    const heartbeat = parseSingleEnvelope(invokeCli([
      "--state-dir", stateDir, "heartbeat", "--workspace", workspaceId,
      "--owner", "worker-a", "--json",
    ]).stdout);
    expect(heartbeat.data).toMatchObject({ workspace_id: workspaceId, owner: "worker-a" });

    const integration = parseSingleEnvelope(invokeCli([
      "--state-dir", stateDir, "integration-lock", "--workspace", workspaceId,
      "--action", "acquire", "--owner", "integrator-a", "--expires-at", futureExpiry, "--json",
    ]).stdout);
    expect(integration.data?.lock).toMatchObject({ workspace_id: workspaceId, owner: "integrator-a" });
    const wrongOwner = parseSingleEnvelope(invokeCli([
      "--state-dir", stateDir, "integration-lock", "--workspace", workspaceId,
      "--action", "release", "--owner", "integrator-b", "--json",
    ]).stdout);
    assertV1Envelope(wrongOwner, false);
    expect(wrongOwner.error?.code).toBe("WORKSPACE_LOCK_OWNER_MISMATCH");
    assertV1Envelope(parseSingleEnvelope(invokeCli([
      "--state-dir", stateDir, "integration-lock", "--workspace", workspaceId,
      "--action", "release", "--owner", "integrator-a", "--json",
    ]).stdout), true);

    const reconciled = parseSingleEnvelope(invokeCli([
      "--state-dir", stateDir, "reconcile", "--workspace", workspaceId, "--json",
    ]).stdout);
    expect(reconciled.data).toMatchObject({
      workspace_id: workspaceId,
      directory_exists: true,
      manifest_exists: true,
    });

    invokeCli(["--state-dir", stateDir, "unlock", "--workspace", workspaceId, "--json"]);
    const operationId = crypto.randomUUID();
    const cleaned = parseSingleEnvelope(invokeCli([
      "--state-dir", stateDir, "cleanup", "--workspace", workspaceId,
      "--strict", "--operation-id", operationId, "--json",
    ]).stdout);
    assertV1Envelope(cleaned, true);
    expect(cleaned.data).toMatchObject({ workspace_id: workspaceId, removed: true, status: "CLEANED" });
    expect(fs.existsSync(workspacePath)).toBe(false);

    const replayed = parseSingleEnvelope(invokeCli([
      "--state-dir", stateDir, "cleanup", "--workspace", workspaceId,
      "--strict", "--operation-id", operationId, "--json",
    ]).stdout);
    expect(replayed).toEqual(cleaned);
  }, 30_000);

  it("classifies an in-flight idempotent reservation without exposing its sentinel", () => {
    const { repo, stateDir } = makeRepo();
    const created = parseSingleEnvelope(invokeCli([
      "--state-dir", stateDir,
      "create", "--repo", repo, "--base", "main", "--branch", "pending-contract", "--json",
    ]).stdout);
    const workspaceId = String(created.data?.workspace_id);
    const operationId = crypto.randomUUID();
    const input = {
      agent: null,
      flowRun: "flow-pending",
      job: null,
      step: null,
      task: null,
      workflowRun: null,
      workspace: workspaceId,
    };
    const db = new Database(path.join(stateDir, "registry.db"));
    db.prepare(`INSERT INTO workspace_idempotency
      (operation_id, command, input_hash, result_json, created_at)
      VALUES (?, ?, ?, ?, ?)`)
      .run(operationId, "bind-run", canonicalHash(input), JSON.stringify({ __pending: true }), new Date().toISOString());
    db.close();

    const pending = invokeCli([
      "--state-dir", stateDir, "bind-run", "--workspace", workspaceId,
      "--flow-run", "flow-pending", "--operation-id", operationId, "--json",
    ]);
    expect(pending.status).toBe(1);
    expect(pending.stderr).toBe("");
    const envelope = parseSingleEnvelope(pending.stdout);
    assertV1Envelope(envelope, false);
    expect(envelope.error).toMatchObject({
      code: "OPERATION_PENDING",
      details: { operationId, command: "bind-run" },
    });
    expect(pending.stdout).not.toContain("__pending");
  });

  it("emits strict cleanup failure as a replayable non-success envelope", () => {
    const { root, repo, stateDir } = makeRepo();
    const created = parseSingleEnvelope(invokeCli([
      "--state-dir", stateDir,
      "create", "--repo", repo, "--base", "main", "--branch", "cleanup-failure", "--json",
    ]).stdout);
    const workspaceId = String(created.data?.workspace_id);
    const invalidMirror = path.join(root, "not-a-git-directory");
    fs.writeFileSync(invalidMirror, "fixture\n", "utf-8");
    const db = new Database(path.join(stateDir, "registry.db"));
    db.prepare("UPDATE repository_caches SET mirror_path = ? WHERE repository_url = ?")
      .run(invalidMirror, repo);
    db.close();
    const operationId = crypto.randomUUID();
    const args = [
      "--state-dir", stateDir, "cleanup", "--workspace", workspaceId,
      "--strict", "--operation-id", operationId, "--json",
    ];

    const first = invokeCli(args);
    expect(first.status).toBe(1);
    expect(first.stderr).toBe("");
    const firstEnvelope = parseSingleEnvelope(first.stdout);
    assertV1Envelope(firstEnvelope, false);
    expect(firstEnvelope.error).toMatchObject({
      code: "WORKSPACE_CLEANUP_FAILED",
      details: { workspace_id: workspaceId, removed: false, status: "CLEANUP_FAILED" },
    });

    const replayed = invokeCli(args);
    expect(replayed.status).toBe(1);
    expect(parseSingleEnvelope(replayed.stdout)).toEqual(firstEnvelope);
  }, 30_000);
});

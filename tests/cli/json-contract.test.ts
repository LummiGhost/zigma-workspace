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
        "workspace-isolation-policy-v1",
        "workspace-prepare-run-v1",
        "workspace-prepare-job-v1",
        "workspace-commit-v1",
        "workspace-integrate-v1",
        "workspace-publish-v1",
        "workspace-gc-v1",
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

    const status = parseSingleEnvelope(invokeCli([
      "--state-dir", stateDir, "status", "--workspace", workspaceId, "--json",
    ]).stdout);
    expect(status.data?.capacity).toMatchObject({
      max_bytes: 50 * 1024 * 1024 * 1024,
      exceeded: false,
      retain_failed_days: 7,
    });

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
      capacity: { max_bytes: 50 * 1024 * 1024 * 1024, exceeded: false, retain_failed_days: 7 },
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

  it("persists workflow path policy and rejects configured capacity before clone", () => {
    const { root, repo } = makeRepo();
    const stateDir = path.join(root, "policy-state");
    const definitionPath = path.join(root, "workspace.yml");
    fs.writeFileSync(definitionPath, [
      "apiVersion: zigma.ai/v1alpha1",
      "kind: Workspace",
      "metadata:",
      "  name: policy-contract",
      "spec:",
      "  type: worktree",
      `  repository: ${JSON.stringify(repo)}`,
      "  ref: main",
      "  allowedPaths:",
      "    - src",
      "  deniedPaths:",
      "    - src/private",
    ].join("\n"), "utf-8");

    const applied = invokeCli(["--state-dir", stateDir, "apply", "--file", definitionPath, "--json"]);
    expect(applied.status).toBe(0);
    const appliedEnvelope = parseSingleEnvelope(applied.stdout);
    const workspacePath = String(appliedEnvelope.data?.path);
    const manifest = JSON.parse(fs.readFileSync(path.join(workspacePath, ".zigma-workspace.json"), "utf-8")) as Record<string, unknown>;
    expect(manifest["allowed_paths"]).toEqual(["src"]);
    expect(manifest["denied_paths"]).toEqual(["src/private", ".zigma-workspace.json"]);

    const exhaustedState = path.join(root, "exhausted-state");
    fs.mkdirSync(exhaustedState, { recursive: true });
    fs.writeFileSync(path.join(exhaustedState, "config.json"), JSON.stringify({ maxDiskGb: 0, retainFailedDays: 2 }), "utf-8");
    const rejected = invokeCli([
      "--state-dir", exhaustedState, "create", "--repo", repo, "--base", "main", "--branch", "capacity-rejected", "--json",
    ]);
    expect(rejected.status).toBe(1);
    expect(parseSingleEnvelope(rejected.stdout).error).toMatchObject({ code: "WORKSPACE_CAPACITY_EXCEEDED" });
    expect(fs.readdirSync(path.join(exhaustedState, "workspaces"))).toEqual([]);
  }, 30_000);

  it("runs the Run + Job-attempt lifecycle through prepare/commit/integrate/publish commands", () => {
    const { repo, stateDir } = makeRepo();
    const baseCommit = git(repo, "rev-parse", "main");

    const run = parseSingleEnvelope(invokeCli([
      "--state-dir", stateDir,
      "prepare-run", "--operation-id", "cli-life-run", "--run", "cli-life",
      "--repo", repo, "--base", "main", "--json",
    ]).stdout);
    assertV1Envelope(run, true);
    const runWorkspaceId = String(run.data?.workspace_id);
    const runPath = String(run.data?.path);
    expect(run.data).toMatchObject({
      operation_id: "cli-life-run",
      run_id: "cli-life",
      branch: "flow/cli-life",
      base_commit: baseCommit,
    });

    const jobA = parseSingleEnvelope(invokeCli([
      "--state-dir", stateDir,
      "prepare-job", "--operation-id", "cli-life-job-a", "--run", "cli-life",
      "--run-workspace", runWorkspaceId, "--job", "job-a", "--attempt", "1",
      "--expected-head", baseCommit, "--json",
    ]).stdout);
    const jobB = parseSingleEnvelope(invokeCli([
      "--state-dir", stateDir,
      "prepare-job", "--operation-id", "cli-life-job-b", "--run", "cli-life",
      "--run-workspace", runWorkspaceId, "--job", "job-b", "--attempt", "1",
      "--expected-head", baseCommit, "--json",
    ]).stdout);
    expect(jobA.data).toMatchObject({
      branch: "job/cli-life/job-a/a1",
      run_workspace_id: runWorkspaceId,
      base_commit: baseCommit,
    });
    expect(jobB.data?.branch).toBe("job/cli-life/job-b/a1");
    const jobAPath = String(jobA.data?.path);
    const jobBPath = String(jobB.data?.path);
    const jobAWorkspaceId = String(jobA.data?.workspace_id);
    const jobBWorkspaceId = String(jobB.data?.workspace_id);

    // Each job commits a different file through the CLI. The provider
    // excludes the workspace manifest from git staging itself (per-worktree
    // info/exclude), so no caller-side gitignore setup is required.
    fs.writeFileSync(path.join(jobAPath, "file-a.txt"), "from job A\n", "utf-8");
    const commitA = parseSingleEnvelope(invokeCli([
      "--state-dir", stateDir,
      "commit", "--operation-id", "cli-life-commit-a", "--workspace", jobAWorkspaceId,
      "--message", "job-a: add file-a", "--expected-state", "RUNNING", "--json",
    ]).stdout);
    assertV1Envelope(commitA, true);
    expect(commitA.data?.no_op).toBe(false);
    expect(commitA.data?.changed_files).toContain("file-a.txt");
    expect(commitA.data?.changed_files).not.toContain(".zigma-workspace.json");
    const commitAHead = String(commitA.data?.head_commit);

    fs.writeFileSync(path.join(jobBPath, "file-b.txt"), "from job B\n", "utf-8");
    const commitB = parseSingleEnvelope(invokeCli([
      "--state-dir", stateDir,
      "commit", "--operation-id", "cli-life-commit-b", "--workspace", jobBWorkspaceId,
      "--message", "job-b: add file-b", "--json",
    ]).stdout);
    expect(commitB.data?.no_op).toBe(false);

    // Serialized integration with CAS on the Run HEAD.
    const integrateA = parseSingleEnvelope(invokeCli([
      "--state-dir", stateDir,
      "integrate", "--operation-id", "cli-life-integrate-a",
      "--source", jobAWorkspaceId, "--target", runWorkspaceId,
      "--lock-owner", "flow-engine", "--expected-head", baseCommit, "--json",
    ]).stdout);
    assertV1Envelope(integrateA, true);
    expect(integrateA.data?.merged).toBe(true);
    expect(integrateA.data?.previous_target_head).toBe(baseCommit);
    expect(integrateA.data?.changed_files).toContain("file-a.txt");
    const runHeadAfterA = String(integrateA.data?.resulting_commit);

    // The second integrate follows immediately: the provider resumes the
    // MERGED Run workspace, so no advance step is needed.
    const integrateB = parseSingleEnvelope(invokeCli([
      "--state-dir", stateDir,
      "integrate", "--operation-id", "cli-life-integrate-b",
      "--source", jobBWorkspaceId, "--target", runWorkspaceId,
      "--lock-owner", "flow-engine", "--expected-head", runHeadAfterA, "--json",
    ]).stdout);
    assertV1Envelope(integrateB, true);
    expect(integrateB.data?.merged).toBe(true);
    expect(integrateB.data?.changed_files).toContain("file-b.txt");
    const finalHead = String(integrateB.data?.resulting_commit);

    // Publish the Run branch with verifiable evidence.
    const publishOp = "cli-life-publish";
    const published = parseSingleEnvelope(invokeCli([
      "--state-dir", stateDir,
      "publish", "--operation-id", publishOp, "--workspace", runWorkspaceId,
      "--strategy", "branch", "--target-ref", "flow/cli-life",
      "--expected-head", finalHead, "--json",
    ]).stdout);
    assertV1Envelope(published, true);
    expect(published.data).toMatchObject({
      operation_id: publishOp,
      workspace_id: runWorkspaceId,
      strategy: "branch",
      resulting_ref: "refs/heads/flow/cli-life",
      resulting_commit: finalHead,
    });
    expect(published.data?.changed_files).toEqual(expect.arrayContaining(["file-a.txt", "file-b.txt"]));
    const artifact = published.data?.artifact as Record<string, unknown>;
    expect(artifact.media_type).toBe("text/x-diff");
    expect(String(artifact.uri)).toMatch(/^file:/);
    expect(String(artifact.digest)).toMatch(/^sha256:[a-f0-9]{64}$/);
    const artifactBytes = fs.readFileSync(fileURLToPath(String(artifact.uri)));
    expect(`sha256:${crypto.createHash("sha256").update(artifactBytes).digest("hex")}`).toBe(artifact.digest);

    // The remote ref now points at the published commit.
    expect(git(repo, "rev-parse", "flow/cli-life")).toBe(finalHead);

    // Publish replays the original envelope for the same operation ID.
    const replayed = parseSingleEnvelope(invokeCli([
      "--state-dir", stateDir,
      "publish", "--operation-id", publishOp, "--workspace", runWorkspaceId,
      "--strategy", "branch", "--target-ref", "flow/cli-life",
      "--expected-head", finalHead, "--json",
    ]).stdout);
    expect(replayed).toEqual(published);

    // The Run workspace contains both job changes.
    expect(fs.readFileSync(path.join(runPath, "file-a.txt"), "utf-8")).toContain("from job A");
    expect(fs.readFileSync(path.join(runPath, "file-b.txt"), "utf-8")).toContain("from job B");
  }, 60_000);

  it("classifies a same-line integration conflict as a structured non-success envelope", () => {
    const { repo, stateDir } = makeRepo();
    fs.writeFileSync(path.join(repo, "conflict.txt"), "line 1\nline 2\nline 3\n", "utf-8");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "add conflict file");
    const baseCommit = git(repo, "rev-parse", "HEAD");

    const run = parseSingleEnvelope(invokeCli([
      "--state-dir", stateDir,
      "prepare-run", "--operation-id", "cli-conflict-run", "--run", "cli-conflict",
      "--repo", repo, "--base", "main", "--json",
    ]).stdout);
    const runWorkspaceId = String(run.data?.workspace_id);
    const runPath = String(run.data?.path);

    const jobA = parseSingleEnvelope(invokeCli([
      "--state-dir", stateDir,
      "prepare-job", "--operation-id", "cli-conflict-job-a", "--run", "cli-conflict",
      "--run-workspace", runWorkspaceId, "--job", "job-a", "--attempt", "1",
      "--expected-head", baseCommit, "--json",
    ]).stdout);
    const jobB = parseSingleEnvelope(invokeCli([
      "--state-dir", stateDir,
      "prepare-job", "--operation-id", "cli-conflict-job-b", "--run", "cli-conflict",
      "--run-workspace", runWorkspaceId, "--job", "job-b", "--attempt", "1",
      "--expected-head", baseCommit, "--json",
    ]).stdout);
    const jobAPath = String(jobA.data?.path);
    const jobBPath = String(jobB.data?.path);

    fs.writeFileSync(path.join(jobAPath, "conflict.txt"), "line 1\nline 2 edited by A\nline 3\n", "utf-8");
    invokeCli([
      "--state-dir", stateDir,
      "commit", "--operation-id", "cli-conflict-commit-a", "--workspace", String(jobA.data?.workspace_id),
      "--message", "job-a: edit line 2", "--json",
    ]);
    fs.writeFileSync(path.join(jobBPath, "conflict.txt"), "line 1\nline 2 edited by B\nline 3\n", "utf-8");
    const commitB = parseSingleEnvelope(invokeCli([
      "--state-dir", stateDir,
      "commit", "--operation-id", "cli-conflict-commit-b", "--workspace", String(jobB.data?.workspace_id),
      "--message", "job-b: edit line 2", "--json",
    ]).stdout);
    const commitBHead = String(commitB.data?.head_commit);

    const integrateA = parseSingleEnvelope(invokeCli([
      "--state-dir", stateDir,
      "integrate", "--operation-id", "cli-conflict-integrate-a",
      "--source", String(jobA.data?.workspace_id), "--target", runWorkspaceId,
      "--lock-owner", "flow-engine", "--expected-head", baseCommit, "--json",
    ]).stdout);
    assertV1Envelope(integrateA, true);
    const runHeadAfterA = String(integrateA.data?.resulting_commit);

    // B edits the same line: the provider restores the Run HEAD and reports
    // structured conflict evidence in the error envelope.
    const conflictArgs = [
      "--state-dir", stateDir,
      "integrate", "--operation-id", "cli-conflict-integrate-b",
      "--source", String(jobB.data?.workspace_id), "--target", runWorkspaceId,
      "--lock-owner", "flow-engine", "--expected-head", runHeadAfterA, "--json",
    ];
    const conflict = invokeCli(conflictArgs);
    expect(conflict.status).toBe(1);
    expect(conflict.stderr).toBe("");
    const conflictEnvelope = parseSingleEnvelope(conflict.stdout);
    assertV1Envelope(conflictEnvelope, false);
    expect(conflictEnvelope.error).toMatchObject({
      code: "WORKSPACE_INTEGRATION_CONFLICT",
      details: {
        source_workspace_id: String(jobB.data?.workspace_id),
        target_workspace_id: runWorkspaceId,
        source_commit: commitBHead,
        previous_target_head: runHeadAfterA,
        conflict_files: ["conflict.txt"],
      },
    });

    // Conflict classification is idempotent: the same envelope replays.
    const replayed = invokeCli(conflictArgs);
    expect(replayed.status).toBe(1);
    expect(parseSingleEnvelope(replayed.stdout)).toEqual(conflictEnvelope);

    // The Run workspace is back at the pre-conflict HEAD and job B's
    // workspace and commit survive for diagnosis.
    expect(git(runPath, "rev-parse", "HEAD")).toBe(runHeadAfterA);
    expect(git(jobBPath, "rev-parse", "HEAD")).toBe(commitBHead);
  }, 60_000);
});

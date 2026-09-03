import { execFileSync, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

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
});

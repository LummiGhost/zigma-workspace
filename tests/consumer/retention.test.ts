/**
 * Black-box proof of per-workspace retention over the built CLI.
 *
 * prepare-run retention flags must persist as registry row columns, echo in
 * the success envelope, participate in operation-id idempotency, and govern
 * gc decisions per result class with the global policy as fallback.
 */
import * as fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cleanupTempDirs,
  ensureBuiltDist,
  expectOk,
  invokeCli,
  makeRepo,
  openRegistry,
  parseEnvelope,
  type Fixture,
} from "./helpers.js";

beforeAll(async () => {
  await ensureBuiltDist();
});

afterAll(() => cleanupTempDirs());

function cli(fx: Fixture, args: string[]): ReturnType<typeof invokeCli> {
  return invokeCli(["--state-dir", fx.stateDir, ...args]);
}

function okData(fx: Fixture, args: string[]): Record<string, unknown> {
  const envelope = expectOk(cli(fx, args));
  expect(envelope.data).toBeTruthy();
  return envelope.data as Record<string, unknown>;
}

function prepareRun(fx: Fixture, runId: string, operationId: string, retentionArgs: string[] = []) {
  return okData(fx, [
    "prepare-run",
    "--operation-id", operationId,
    "--run", runId,
    "--repo", fx.repo,
    "--base", "main",
    "--mode", "writable",
    ...retentionArgs,
    "--json",
  ]);
}

function setStatus(fx: Fixture, workspaceId: string, status: string): void {
  const db = openRegistry(fx.stateDir);
  db.prepare("UPDATE workspaces SET status = ? WHERE id = ?").run(status, workspaceId);
  db.close();
}

function row(fx: Fixture, workspaceId: string): Record<string, unknown> {
  const db = openRegistry(fx.stateDir);
  const found = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(workspaceId) as
    | Record<string, unknown>
    | undefined;
  db.close();
  expect(found).toBeDefined();
  return found!;
}

function gcApply(fx: Fixture): Record<string, unknown> {
  return okData(fx, ["gc", "--apply", "--json"]);
}

describe("per-workspace retention over the built CLI", () => {
  it("persists retention flags and echoes them in the prepare-run envelope", () => {
    const fx = makeRepo();
    const data = prepareRun(fx, "ret-a1", "run:ret-a1:create", [
      "--retention-success", "cleanup",
      "--retention-failure", "retain",
      "--retention-blocked", "retain",
    ]);
    expect(data["retention"]).toEqual({
      success: "cleanup",
      failure: "retain",
      blocked: "retain",
    });
    const stored = row(fx, data["workspace_id"] as string);
    expect(stored["retention_success"]).toBe("cleanup");
    expect(stored["retention_failure"]).toBe("retain");
    expect(stored["retention_blocked"]).toBe("retain");
  });

  it("rejects invalid retention values fail-closed", () => {
    const fx = makeRepo();
    const result = cli(fx, [
      "prepare-run",
      "--operation-id", "run:ret-bad:create",
      "--run", "ret-bad",
      "--repo", fx.repo,
      "--base", "main",
      "--retention-success", "maybe",
      "--json",
    ]);
    const envelope = parseEnvelope(result.stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe("INVALID_INPUT");
  });

  it("rejects a replay of the same operation-id with different retention", () => {
    const fx = makeRepo();
    prepareRun(fx, "ret-a2", "run:ret-a2:create", ["--retention-failure", "retain"]);
    const result = cli(fx, [
      "prepare-run",
      "--operation-id", "run:ret-a2:create",
      "--run", "ret-a2",
      "--repo", fx.repo,
      "--base", "main",
      "--retention-failure", "cleanup",
      "--json",
    ]);
    const envelope = parseEnvelope(result.stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe("OPERATION_ID_CONFLICT");
  });

  it("gc retains a FAILED workspace when retention-failure is retain", () => {
    const fx = makeRepo();
    const data = prepareRun(fx, "ret-a3", "run:ret-a3:create", ["--retention-failure", "retain"]);
    const workspaceId = data["workspace_id"] as string;
    const workspacePath = data["path"] as string;
    setStatus(fx, workspaceId, "FAILED");

    gcApply(fx);
    const stored = row(fx, workspaceId);
    expect(stored["status"]).toBe("FAILED");
    expect(fs.existsSync(workspacePath)).toBe(true);
  });

  it("gc cleans a FAILED workspace when retention-failure is cleanup", () => {
    const fx = makeRepo();
    const data = prepareRun(fx, "ret-a4", "run:ret-a4:create", ["--retention-failure", "cleanup"]);
    const workspaceId = data["workspace_id"] as string;
    const workspacePath = data["path"] as string;
    setStatus(fx, workspaceId, "FAILED");

    gcApply(fx);
    const stored = row(fx, workspaceId);
    expect(stored["status"]).toBe("CLEANED");
    expect(fs.existsSync(workspacePath)).toBe(false);
  });

  it("adoption of an existing branch updates retention from the new run", () => {
    const fx = makeRepo();
    prepareRun(fx, "ret-a5", "run:ret-a5:create:first", ["--retention-failure", "retain"]);
    const adopted = prepareRun(fx, "ret-a5", "run:ret-a5:create:second", ["--retention-failure", "cleanup"]);
    expect(adopted["retention"]).toEqual({ failure: "cleanup" });
    const stored = row(fx, adopted["workspace_id"] as string);
    expect(stored["retention_failure"]).toBe("cleanup");
  });
});

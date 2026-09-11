#!/usr/bin/env node
import { Command } from "commander";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";
import { getConfig, ensureStateDirs, loadConfigFile } from "../config/index.js";
import { openDb } from "../db/index.js";
import {
  getIdempotencyRecord,
  insertIdempotencyRecord,
  updateIdempotencyResult,
  getRepositoryCacheByUrl,
} from "../db/queries.js";
import { createWorkspace, bindRun, getWorkspace, listAllWorkspaces } from "../core/workspace.js";
import { lockWorkspace, unlockWorkspace, getLock, heartbeat } from "../core/lock.js";
import { collectDiff } from "../core/diff.js";
import { createSnapshot } from "../core/snapshot.js";
import { getArtifactsForSnapshot } from "../core/artifact.js";
import { cleanupWorkspace, cleanupWorkspaceStrict } from "../core/cleanup.js";
import { garbageCollect } from "../core/gc.js";
import { reconcileWorkspace } from "../core/reconcile.js";
import { prepareRun, prepareJob } from "../core/provider.js";
import { commitWorkspace } from "../core/commit.js";
import { integrateWorkspace } from "../core/integrate.js";
import { publishWorkspace } from "../core/publish.js";
import {
  acquireIntegrationLock,
  getIntegrationLockState,
  heartbeatIntegrationLock,
  releaseIntegrationLock,
  takeoverIntegrationLock,
} from "../core/integration-lock.js";
import { validateDefinition } from "../schema/validator.js";
import type { WorkspaceDefinition } from "../schema/definition.js";
import { CONTRACT_VERSION, ZigmaError } from "../types/index.js";
import { GitError } from "../git/index.js";
import type { Workspace, ZigmaErrorCode, GarbageCollectResult } from "../types/index.js";
import type Database from "better-sqlite3";
import { getCapacityStatus } from "../core/isolation-policy.js";

const require = createRequire(import.meta.url);
const { version } = require("../../package.json") as { version: string };

/**
 * Capabilities exposed by the read-only provider handshake.  Keep these names
 * stable: Core uses them to fail closed before issuing a mutating command.
 */
const WORKSPACE_CAPABILITIES = [
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
] as const;

// ── Output helpers ──────────────────────────────────────────────────────────

function outputOk(data: unknown, useJson: boolean): void {
  if (useJson) {
    console.log(JSON.stringify({ contract_version: CONTRACT_VERSION, ok: true, data }, null, 2));
  } else {
    console.log(formatHuman(data));
  }
}

function outputError(
  code: ZigmaErrorCode,
  message: string,
  useJson: boolean,
  details?: Record<string, unknown>
): never {
  if (useJson) {
    const out = {
      contract_version: CONTRACT_VERSION,
      ok: false,
      error: { code, message, ...(details !== undefined ? { details } : {}) },
    };
    // The JSON protocol has one authoritative channel: stdout.  A caller must
    // be able to parse both success and expected provider failures without
    // guessing which stream contains the envelope.  Keep stderr for transport
    // diagnostics that are outside the protocol (for example, a host's own
    // process-launch failure); never write human diagnostics here in JSON mode.
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.error(`Error: ${message}`);
    if (details !== undefined) {
      console.error(JSON.stringify(details, null, 2));
    }
  }
  process.exit(1);
}

function catchError(err: unknown, useJson: boolean): never {
  if (err instanceof ZigmaError) {
    return outputError(err.code, err.message, useJson, err.details);
  }
  if (err instanceof GitError) {
    return outputError("GIT_ERROR", err.message, useJson, { command: err.command, stderr: err.stderr });
  }
  const message = err instanceof Error ? err.message : String(err);
  return outputError("INTERNAL_ERROR", message, useJson);
}

function formatHuman(data: unknown): string {
  if (data === null || data === undefined) return "(empty)";
  if (typeof data === "string") return data;
  return JSON.stringify(data, null, 2);
}

/** CLI JSON is snake_case even though the TypeScript API returns camelCase. */
function formatArtifactDescriptor(artifact: { uri: string; mediaType: string; digest: string } | undefined | null): Record<string, string> | null {
  if (!artifact) return null;
  return { uri: artifact.uri, media_type: artifact.mediaType, digest: artifact.digest };
}

function formatWorkspace(ws: Workspace): string {
  return [
    `id:      ${ws.id}`,
    `status:  ${ws.status}`,
    `branch:  ${ws.branch}`,
    `base:    ${ws.baseRef} @ ${ws.baseCommit.slice(0, 12)}`,
    `path:    ${ws.path}`,
    `mode:    ${ws.mode}`,
    `repo:    ${ws.repositoryUrl}`,
    ws.taskId ? `task:    ${ws.taskId}` : null,
    ws.flowRunId ? `flow:    ${ws.flowRunId}` : null,
    ws.workflowRunId ? `wf-run:  ${ws.workflowRunId}` : null,
    ws.jobId ? `job:     ${ws.jobId}` : null,
    ws.stepId ? `step:    ${ws.stepId}` : null,
    ws.agentId ? `agent:   ${ws.agentId}` : null,
    `created: ${ws.createdAt}`,
  ]
    .filter(Boolean)
    .join("\n");
}

// ── Idempotency helpers ─────────────────────────────────────────────────────

function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value !== null && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = sortedKeys((value as Record<string, unknown>)[k]);
        return acc;
      }, {});
  }
  return value;
}

function hashInput(input: Record<string, unknown>): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(sortedKeys(input)), "utf-8")
    .digest("hex");
}

type IdempotencyOutcome =
  | { type: "hit"; cachedResult: unknown }
  | { type: "conflict" }
  | { type: "reserved" };

/**
 * Atomically check for an existing operation record and reserve a slot if absent.
 * Uses a SQLite transaction to prevent TOCTOU races between concurrent processes.
 */
function reserveOrCheckIdempotency(
  db: Database.Database,
  operationId: string,
  command: string,
  input: Record<string, unknown>
): IdempotencyOutcome {
  const inputHash = hashInput(input);
  return (db.transaction(() => {
    const existing = getIdempotencyRecord(db, operationId);
    if (existing) {
      if (existing.command !== command || existing.input_hash !== inputHash) {
        return { type: "conflict" as const };
      }
      const result = JSON.parse(existing.result_json) as unknown;
      if (
        result !== null &&
        typeof result === "object" &&
        (result as Record<string, unknown>)["__pending"] === true
      ) {
        throw new ZigmaError(
          "OPERATION_PENDING",
          `Operation ID "${operationId}" is still pending`,
          { operationId, command },
        );
      }
      return { type: "hit" as const, cachedResult: result };
    }
    // Reserve the slot with a sentinel so concurrent processes see "already claimed"
    insertIdempotencyRecord(db, {
      operation_id: operationId,
      command,
      input_hash: inputHash,
      result_json: JSON.stringify({ __pending: true }),
      created_at: new Date().toISOString(),
    });
    return { type: "reserved" as const };
  }) as () => IdempotencyOutcome)();
}

function commitIdempotency(
  db: Database.Database,
  operationId: string,
  result: unknown
): void {
  updateIdempotencyResult(db, operationId, JSON.stringify(result));
}

// ── URI helper ───────────────────────────────────────────────────────────────

function toFileUri(absolutePath: string): string {
  return pathToFileURL(absolutePath).href;
}

function capacityData(config: ReturnType<typeof getConfig>) {
  const capacity = getCapacityStatus(config);
  return {
    used_bytes: capacity.usedBytes,
    max_bytes: capacity.maxBytes,
    available_bytes: capacity.availableBytes,
    exceeded: capacity.exceeded,
    retain_failed_days: capacity.retainFailedDays,
  };
}

// ── Setup ──────────────────────────────────────────────────────────────────

function setup(stateDirOverride?: string) {
  const config = getConfig(stateDirOverride);
  ensureStateDirs(config);
  loadConfigFile(config);
  const db = openDb(config);
  return { config, db };
}

// ── CLI ────────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("zigma-workspace")
  .description("Zigma workspace management CLI")
  .version(version)
  .option(
    "--state-dir <path>",
    "Override state directory with an absolute path (or set ZIGMA_WORKSPACE_STATE_DIR)"
  );

// ── contract-info ─────────────────────────────────────────────────────────

program
  .command("contract-info")
  .description("Report the provider contract and capabilities without side effects")
  .option("--json", "Output JSON")
  .action((opts: { json?: boolean }) => {
    const useJson = opts.json ?? false;
    // Deliberately do not call setup(): this command must remain safe for a
    // caller to run during admission/handshake before a state directory,
    // database, mirror, or workspace exists.
    outputOk(
      {
        provider: "zigma-workspace",
        package_version: version,
        contract_version: CONTRACT_VERSION,
        capabilities: [...WORKSPACE_CAPABILITIES],
      },
      useJson
    );
  });

// ── create ─────────────────────────────────────────────────────────────────

program
  .command("create")
  .description("Create a new workspace from a git repository")
  .requiredOption("--repo <url>", "Repository URL to clone")
  .requiredOption("--base <ref>", "Base git ref (branch, tag, or commit)")
  .requiredOption("--branch <branch>", "New branch name for the workspace")
  .option("--mode <mode>", "Workspace mode: writable or read-only", "writable")
  .option("--project <projectId>", "Project ID to associate")
  .option("--task <taskId>", "Task ID to associate")
  .option("--flow-run <flowRunId>", "Flow run ID to associate")
  .option("--workflow-run <workflowRunId>", "Workflow run ID")
  .option("--job <jobId>", "Job ID")
  .option("--step <stepId>", "Step ID")
  .option("--agent <agentId>", "Agent ID")
  .option("--operation-id <id>", "Idempotency key: repeat with same inputs to get original result")
  .option("--json", "Output JSON")
  .action(
    async (opts: {
      repo: string;
      base: string;
      branch: string;
      mode: string;
      project?: string;
      task?: string;
      flowRun?: string;
      workflowRun?: string;
      job?: string;
      step?: string;
      agent?: string;
      operationId?: string;
      json?: boolean;
    }) => {
      const useJson = opts.json ?? false;
      const globalOpts = program.opts<{ stateDir?: string }>();
      try {
        if (opts.mode !== "writable" && opts.mode !== "read-only") {
          outputError(
            "INVALID_INPUT",
            `Invalid mode "${opts.mode}". Must be "writable" or "read-only"`,
            useJson
          );
        }

        const { config, db } = setup(globalOpts.stateDir);

        const idempotencyInput: Record<string, unknown> = {
          repo: opts.repo,
          base: opts.base,
          branch: opts.branch,
          mode: opts.mode,
          project: opts.project ?? null,
          task: opts.task ?? null,
          flowRun: opts.flowRun ?? null,
          workflowRun: opts.workflowRun ?? null,
          job: opts.job ?? null,
          step: opts.step ?? null,
          agent: opts.agent ?? null,
        };

        if (opts.operationId) {
          const outcome = reserveOrCheckIdempotency(db, opts.operationId, "create", idempotencyInput);
          if (outcome.type === "hit") {
            if (useJson) {
              console.log(JSON.stringify(outcome.cachedResult, null, 2));
            } else {
              console.log(`Using cached result for operation ID "${opts.operationId}" (already executed).`);
            }
            return;
          }
          if (outcome.type === "conflict") {
            outputError(
              "OPERATION_ID_CONFLICT",
              `Operation ID "${opts.operationId}" was already used with different inputs`,
              useJson,
              { operationId: opts.operationId }
            );
          }
        }

        const workspace = createWorkspace(db, config, {
          repositoryUrl: opts.repo,
          baseRef: opts.base,
          branch: opts.branch,
          mode: opts.mode as "writable" | "read-only",
          projectId: opts.project,
          taskId: opts.task,
          flowRunId: opts.flowRun,
          workflowRunId: opts.workflowRun,
          jobId: opts.job,
          stepId: opts.step,
          agentId: opts.agent,
        });

        const data = {
          workspace_id: workspace.id,
          path: workspace.path,
          branch: workspace.branch,
          base_ref: workspace.baseRef,
          base_commit: workspace.baseCommit,
          mode: workspace.mode,
          status: workspace.status,
          manifest_path: `${workspace.path}/.zigma-workspace.json`,
          created_at: workspace.createdAt,
        };

        if (opts.operationId) {
          commitIdempotency(db, opts.operationId, { contract_version: CONTRACT_VERSION, ok: true, data });
        }

        if (useJson) {
          outputOk(data, true);
        } else {
          console.log("Workspace created successfully\n");
          console.log(formatWorkspace(workspace));
          console.log(`\nManifest: ${workspace.path}/.zigma-workspace.json`);
        }
      } catch (err) {
        catchError(err, useJson);
      }
    }
  );

// ── bind-run ────────────────────────────────────────────────────────────────

program
  .command("bind-run")
  .description("Bind a workspace to a task or flow run")
  .requiredOption("--workspace <id>", "Workspace ID")
  .option("--task <taskId>", "Task ID")
  .option("--flow-run <flowRunId>", "Flow run ID")
  .option("--workflow-run <workflowRunId>", "Workflow run ID")
  .option("--job <jobId>", "Job ID")
  .option("--step <stepId>", "Step ID")
  .option("--agent <agentId>", "Agent ID")
  .option("--operation-id <id>", "Idempotency key: repeat with same inputs to get original result")
  .option("--json", "Output JSON")
  .action(
    async (opts: {
      workspace: string;
      task?: string;
      flowRun?: string;
      workflowRun?: string;
      job?: string;
      step?: string;
      agent?: string;
      operationId?: string;
      json?: boolean;
    }) => {
      const useJson = opts.json ?? false;
      const globalOpts = program.opts<{ stateDir?: string }>();
      try {
        const { db } = setup(globalOpts.stateDir);

        const idempotencyInput: Record<string, unknown> = {
          workspace: opts.workspace,
          task: opts.task ?? null,
          flowRun: opts.flowRun ?? null,
          workflowRun: opts.workflowRun ?? null,
          job: opts.job ?? null,
          step: opts.step ?? null,
          agent: opts.agent ?? null,
        };

        if (opts.operationId) {
          const outcome = reserveOrCheckIdempotency(db, opts.operationId, "bind-run", idempotencyInput);
          if (outcome.type === "hit") {
            if (useJson) {
              console.log(JSON.stringify(outcome.cachedResult, null, 2));
            } else {
              console.log(`Using cached result for operation ID "${opts.operationId}" (already executed).`);
            }
            return;
          }
          if (outcome.type === "conflict") {
            outputError(
              "OPERATION_ID_CONFLICT",
              `Operation ID "${opts.operationId}" was already used with different inputs`,
              useJson,
              { operationId: opts.operationId }
            );
          }
        }

        const workspace = bindRun(db, {
          workspaceId: opts.workspace,
          taskId: opts.task,
          flowRunId: opts.flowRun,
          workflowRunId: opts.workflowRun,
          jobId: opts.job,
          stepId: opts.step,
          agentId: opts.agent,
        });

        const data = {
          workspace_id: workspace.id,
          task_id: workspace.taskId ?? null,
          flow_run_id: workspace.flowRunId ?? null,
          workflow_run_id: workspace.workflowRunId ?? null,
          job_id: workspace.jobId ?? null,
          step_id: workspace.stepId ?? null,
          agent_id: workspace.agentId ?? null,
          status: workspace.status,
          updated_at: workspace.updatedAt,
        };

        if (opts.operationId) {
          commitIdempotency(db, opts.operationId, { contract_version: CONTRACT_VERSION, ok: true, data });
        }

        if (useJson) {
          outputOk(data, true);
        } else {
          console.log("Workspace bound to run\n");
          console.log(formatWorkspace(workspace));
        }
      } catch (err) {
        catchError(err, useJson);
      }
    }
  );

// ── status ──────────────────────────────────────────────────────────────────

program
  .command("status")
  .description("Show workspace status")
  .requiredOption("--workspace <id>", "Workspace ID")
  .option("--json", "Output JSON")
  .action(async (opts: { workspace: string; json?: boolean }) => {
    const useJson = opts.json ?? false;
    const globalOpts = program.opts<{ stateDir?: string }>();
    try {
      const { config, db } = setup(globalOpts.stateDir);
      const workspace = getWorkspace(db, opts.workspace);
      const lock = getLock(db, opts.workspace);
      const cacheRow = getRepositoryCacheByUrl(db, workspace.repositoryUrl);

      if (useJson) {
        outputOk(
          {
            workspace_id: workspace.id,
            status: workspace.status,
            branch: workspace.branch,
            base_ref: workspace.baseRef,
            base_commit: workspace.baseCommit,
            path: workspace.path,
            mode: workspace.mode,
            repository_url: workspace.repositoryUrl,
            repository_cache_id: cacheRow?.id ?? null,
            task_id: workspace.taskId ?? null,
            flow_run_id: workspace.flowRunId ?? null,
            workflow_run_id: workspace.workflowRunId ?? null,
            job_id: workspace.jobId ?? null,
            step_id: workspace.stepId ?? null,
            agent_id: workspace.agentId ?? null,
            project_id: workspace.projectId ?? null,
            created_at: workspace.createdAt,
            updated_at: workspace.updatedAt,
            lock: lock
              ? {
                  id: lock.id,
                  mode: lock.mode,
                  owner: lock.owner,
                  acquired_at: lock.acquiredAt,
                  expires_at: lock.expiresAt ?? null,
                  last_heartbeat: lock.lastHeartbeat ?? null,
                }
                : null,
            capacity: capacityData(config),
          },
          true
        );
      } else {
        console.log(formatWorkspace(workspace));
        if (lock) {
          console.log(
            `\nLocked by: ${lock.owner} (mode: ${lock.mode}, acquired: ${lock.acquiredAt})`
          );
        }
      }
    } catch (err) {
      catchError(err, useJson);
    }
  });

// ── diff ────────────────────────────────────────────────────────────────────

program
  .command("diff")
  .description("Collect workspace diff and generate patch")
  .requiredOption("--workspace <id>", "Workspace ID")
  .option("--patch-out <path>", "Output path for patch file")
  .option("--json", "Output JSON")
  .action(
    async (opts: { workspace: string; patchOut?: string; json?: boolean }) => {
      const useJson = opts.json ?? false;
      const globalOpts = program.opts<{ stateDir?: string }>();
      try {
        const { config, db } = setup(globalOpts.stateDir);
        const diff = collectDiff(db, config, opts.workspace, opts.patchOut);

        if (useJson) {
          const patchArtifact =
            diff.patchPath && diff.patchDigest
              ? {
                  uri: toFileUri(diff.patchPath),
                  media_type: "text/x-diff",
                  digest: `sha256:${diff.patchDigest}`,
                }
              : null;

          outputOk(
            {
              workspace_id: diff.workspaceId,
              base_commit: diff.baseCommit,
              head_commit: diff.headCommit ?? null,
              changed_files: diff.changedFiles,
              untracked_files: diff.untrackedFiles,
              status_text: diff.statusText,
              patch_path: diff.patchPath ?? null,
              patch_artifact: patchArtifact,
              summary: diff.summary,
            },
            true
          );
        } else {
          console.log(`Workspace: ${diff.workspaceId}`);
          console.log(`Base commit:  ${diff.baseCommit}`);
          console.log(`Head commit:  ${diff.headCommit ?? "N/A"}`);
          console.log(`Changed files (${diff.changedFiles.length}):`);
          for (const f of diff.changedFiles) console.log(`  ${f}`);
          console.log(`Untracked files (${diff.untrackedFiles.length}):`);
          for (const f of diff.untrackedFiles) console.log(`  ${f}`);
          if (diff.statusText.trim()) {
            console.log(`\nGit status:\n${diff.statusText}`);
          }
          if (diff.patchPath) {
            console.log(`\nPatch written to: ${diff.patchPath}`);
          }
        }
      } catch (err) {
        catchError(err, useJson);
      }
    }
  );

// ── snapshot ─────────────────────────────────────────────────────────────────

program
  .command("snapshot")
  .description("Create a snapshot of the workspace state")
  .requiredOption("--workspace <id>", "Workspace ID")
  .option("--operation-id <id>", "Idempotency key: repeat with same inputs to get original result")
  .option("--json", "Output JSON")
  .action(
    async (opts: { workspace: string; operationId?: string; json?: boolean }) => {
      const useJson = opts.json ?? false;
      const globalOpts = program.opts<{ stateDir?: string }>();
      try {
        const { config, db } = setup(globalOpts.stateDir);

        const idempotencyInput: Record<string, unknown> = { workspace: opts.workspace };

        if (opts.operationId) {
          const outcome = reserveOrCheckIdempotency(db, opts.operationId, "snapshot", idempotencyInput);
          if (outcome.type === "hit") {
            if (useJson) {
              console.log(JSON.stringify(outcome.cachedResult, null, 2));
            } else {
              console.log(`Using cached result for operation ID "${opts.operationId}" (already executed).`);
            }
            return;
          }
          if (outcome.type === "conflict") {
            outputError(
              "OPERATION_ID_CONFLICT",
              `Operation ID "${opts.operationId}" was already used with different inputs`,
              useJson,
              { operationId: opts.operationId }
            );
          }
        }

        const snapshot = createSnapshot(db, config, opts.workspace);
        const artifacts = getArtifactsForSnapshot(db, snapshot.id);

        const data = {
          snapshot_id: snapshot.id,
          workspace_id: snapshot.workspaceId,
          kind: snapshot.kind,
          artifacts: artifacts.map((a) => ({
            id: a.id,
            kind: a.kind,
            uri: toFileUri(a.path),
            media_type: a.mediaType,
            digest: `sha256:${a.checksum}`,
          })),
          created_at: snapshot.createdAt,
        };

        if (opts.operationId) {
          commitIdempotency(db, opts.operationId, { contract_version: CONTRACT_VERSION, ok: true, data });
        }

        if (useJson) {
          outputOk(data, true);
        } else {
          console.log(`Snapshot created: ${snapshot.id}`);
          console.log(`Kind:     ${snapshot.kind}`);
          for (const a of artifacts) {
            console.log(`Artifact: ${a.id} (${a.kind}) → ${a.path}`);
          }
          console.log(`Created:  ${snapshot.createdAt}`);
        }
      } catch (err) {
        catchError(err, useJson);
      }
    }
  );

// ── cleanup ──────────────────────────────────────────────────────────────────

program
  .command("cleanup")
  .description("Clean up a workspace (remove worktree and mark as cleaned)")
  .requiredOption("--workspace <id>", "Workspace ID")
  .option("--operation-id <id>", "Idempotency key: repeat with same inputs to get original result")
  .option("--strict", "Require verified directory and Git registration removal")
  .option("--force", "Allow strict cleanup while a collaboration lock exists")
  .option("--json", "Output JSON")
  .action(
    async (opts: { workspace: string; operationId?: string; strict?: boolean; force?: boolean; json?: boolean }) => {
      const useJson = opts.json ?? false;
      const globalOpts = program.opts<{ stateDir?: string }>();
      try {
        const { config, db } = setup(globalOpts.stateDir);

        if (opts.strict && !opts.operationId) {
          outputError("INVALID_INPUT", "Strict cleanup requires --operation-id", useJson);
        }
        if (opts.strict) {
          const result = cleanupWorkspaceStrict(db, config, {
            operationId: opts.operationId!,
            workspaceId: opts.workspace,
            force: opts.force ?? false,
          });
          if (result.status === "CLEANUP_FAILED") {
            outputError("WORKSPACE_CLEANUP_FAILED", result.message, useJson, {
              operation_id: result.operationId,
              workspace_id: result.workspaceId,
              path: result.path,
              removed: result.removed,
              status: result.status,
              blockers: result.blockers ?? [],
            });
          }
          outputOk({
            operation_id: result.operationId,
            workspace_id: result.workspaceId,
            path: result.path,
            removed: result.removed,
            status: result.status,
            message: result.message,
            blockers: result.blockers ?? [],
          }, useJson);
          return;
        }

        const idempotencyInput: Record<string, unknown> = { workspace: opts.workspace };

        if (opts.operationId) {
          const outcome = reserveOrCheckIdempotency(db, opts.operationId, "cleanup", idempotencyInput);
          if (outcome.type === "hit") {
            if (useJson) {
              console.log(JSON.stringify(outcome.cachedResult, null, 2));
            } else {
              console.log(`Using cached result for operation ID "${opts.operationId}" (already executed).`);
            }
            return;
          }
          if (outcome.type === "conflict") {
            outputError(
              "OPERATION_ID_CONFLICT",
              `Operation ID "${opts.operationId}" was already used with different inputs`,
              useJson,
              { operationId: opts.operationId }
            );
          }
        }

        const result = cleanupWorkspace(db, config, opts.workspace);

        const data = {
          workspace_id: result.workspaceId,
          path: result.path,
          removed: result.removed,
          message: result.message,
        };

        if (opts.operationId) {
          commitIdempotency(db, opts.operationId, { contract_version: CONTRACT_VERSION, ok: true, data });
        }

        if (useJson) {
          outputOk(data, true);
        } else {
          console.log(`Workspace ${result.workspaceId} cleaned`);
          console.log(`Path:    ${result.path}`);
          console.log(`Removed: ${result.removed}`);
          console.log(`Message: ${result.message}`);
        }
      } catch (err) {
        catchError(err, useJson);
      }
    }
  );

// ── gc ───────────────────────────────────────────────────────────────────────

function formatGcEnvelope(result: GarbageCollectResult): Record<string, unknown> {
  const sweptLocks = {
    workspace_locks_deleted: result.sweptLocks.workspaceLocksDeleted,
    integration_locks_deleted: result.sweptLocks.integrationLocksDeleted,
    workspace_ids: result.sweptLocks.workspaceIds,
  };
  const orphans = result.orphanWorktrees.map((o) => ({
    path: o.path,
    branch: o.branch,
    commit: o.commit,
    ...(o.registeredWorkspaceId !== undefined
      ? { registered_workspace_id: o.registeredWorkspaceId }
      : {}),
    mirror_path: o.mirrorPath,
    ...(o.removed !== undefined ? { removed: o.removed } : {}),
    ...(o.blockers !== undefined ? { blockers: o.blockers } : {}),
  }));
  if (!result.applied) {
    return {
      applied: false,
      swept_locks: sweptLocks,
      candidates: result.candidates.map((c) => ({
        workspace_id: c.workspaceId,
        status: c.status,
        class: c.class,
        action: c.action,
        reason: c.reason,
        age_days: c.ageDays,
        updated_at: c.updatedAt,
        ...(c.reconcile !== undefined
          ? {
              reconcile: {
                reconciled_status: c.reconcile.reconciledStatus,
                directory_exists: c.reconcile.directoryExists,
                recommendation: c.reconcile.recommendation,
              },
            }
          : {}),
      })),
      orphan_worktrees: orphans,
    };
  }
  return {
    applied: true,
    swept_locks: sweptLocks,
    results: result.results.map((r) => ({
      workspace_id: r.workspaceId,
      action: r.action,
      ...(r.reason !== undefined ? { reason: r.reason } : {}),
      ...(r.operationId !== undefined ? { operation_id: r.operationId } : {}),
      ...(r.removed !== undefined ? { removed: r.removed } : {}),
      ...(r.status !== undefined ? { status: r.status } : {}),
      ...(r.blockers !== undefined ? { blockers: r.blockers } : {}),
      ...(r.reconciledStatus !== undefined
        ? { reconciled_status: r.reconciledStatus }
        : {}),
    })),
    orphan_worktrees: orphans,
  };
}

program
  .command("gc")
  .description(
    "Plan or execute retention-driven garbage collection (dry-run by default)"
  )
  .option(
    "--apply",
    "Execute the collection plan: sweep expired locks, strict-clean eligible workspaces, reclaim orphan worktrees"
  )
  .option("--json", "Output JSON")
  .action((opts: { apply?: boolean; json?: boolean }) => {
    const useJson = opts.json ?? false;
    try {
      const { config, db } = setup(program.opts<{ stateDir?: string }>().stateDir);
      const result = garbageCollect(db, config, { apply: opts.apply ?? false });
      if (useJson) {
        outputOk(formatGcEnvelope(result), true);
      } else {
        console.log(formatHuman(formatGcEnvelope(result)));
      }
    } catch (err) {
      catchError(err, useJson);
    }
  });

// ── governed lifecycle provider operations ──────────────────────────────────

program
  .command("heartbeat")
  .description("Heartbeat an owned workspace collaboration lock")
  .requiredOption("--workspace <id>", "Workspace ID")
  .requiredOption("--owner <owner>", "Lock owner identifier")
  .option("--json", "Output JSON")
  .action((opts: { workspace: string; owner: string; json?: boolean }) => {
    const useJson = opts.json ?? false;
    try {
      const { db } = setup(program.opts<{ stateDir?: string }>().stateDir);
      const lock = heartbeat(db, opts.workspace, opts.owner);
      outputOk({
        lock_id: lock.id,
        workspace_id: lock.workspaceId,
        mode: lock.mode,
        owner: lock.owner,
        acquired_at: lock.acquiredAt,
        expires_at: lock.expiresAt ?? null,
        last_heartbeat: lock.lastHeartbeat ?? null,
      }, useJson);
    } catch (err) {
      catchError(err, useJson);
    }
  });

program
  .command("reconcile")
  .description("Reconcile registry, filesystem, Git, manifest, and operation state")
  .requiredOption("--workspace <id>", "Workspace ID")
  .option("--json", "Output JSON")
  .action((opts: { workspace: string; json?: boolean }) => {
    const useJson = opts.json ?? false;
    try {
      const { config, db } = setup(program.opts<{ stateDir?: string }>().stateDir);
      const result = reconcileWorkspace(db, { workspaceId: opts.workspace }, config);
      outputOk({
        workspace_id: result.workspaceId,
        registry_status: result.registryStatus,
        directory_exists: result.directoryExists,
        git_head: result.gitHead,
        manifest_exists: result.manifestExists,
        operations: result.operations.map((operation) => ({
          operation_id: operation.operationId,
          command: operation.command,
          status: operation.status,
          input_hash: operation.inputHash,
          result_json: operation.resultJson,
          created_at: operation.createdAt,
          updated_at: operation.updatedAt,
        })),
        reconciled_status: result.reconciledStatus,
        recommendation: result.recommendation,
        capacity: {
          used_bytes: result.capacity.usedBytes,
          max_bytes: result.capacity.maxBytes,
          available_bytes: result.capacity.availableBytes,
          exceeded: result.capacity.exceeded,
          retain_failed_days: result.capacity.retainFailedDays,
        },
      }, useJson);
    } catch (err) {
      catchError(err, useJson);
    }
  });

program
  .command("integration-lock")
  .description("Acquire, heartbeat, release, take over, or inspect a Run integration lock")
  .requiredOption("--workspace <id>", "Run workspace ID")
  .requiredOption("--action <action>", "acquire, heartbeat, release, takeover, or status")
  .option("--owner <owner>", "Lock owner identifier")
  .option("--expires-at <iso>", "ISO 8601 expiry datetime")
  .option("--json", "Output JSON")
  .action((opts: { workspace: string; action: string; owner?: string; expiresAt?: string; json?: boolean }) => {
    const useJson = opts.json ?? false;
    try {
      const { db } = setup(program.opts<{ stateDir?: string }>().stateDir);
      if (!["acquire", "heartbeat", "release", "takeover", "status"].includes(opts.action)) {
        outputError("INVALID_INPUT", `Unknown integration-lock action "${opts.action}"`, useJson);
      }
      if (opts.action !== "status" && !opts.owner) {
        outputError("INVALID_INPUT", `integration-lock ${opts.action} requires --owner`, useJson);
      }
      if (opts.expiresAt && Number.isNaN(Date.parse(opts.expiresAt))) {
        outputError("INVALID_INPUT", "--expires-at must be an ISO 8601 datetime", useJson);
      }

      let lock = null;
      if (opts.action === "acquire") lock = acquireIntegrationLock(db, opts.workspace, opts.owner!, opts.expiresAt);
      if (opts.action === "heartbeat") lock = heartbeatIntegrationLock(db, opts.workspace, opts.owner!);
      if (opts.action === "takeover") lock = takeoverIntegrationLock(db, opts.workspace, opts.owner!, opts.expiresAt);
      if (opts.action === "release") releaseIntegrationLock(db, opts.workspace, opts.owner!);
      if (opts.action === "status") lock = getIntegrationLockState(db, opts.workspace);

      outputOk({
        workspace_id: opts.workspace,
        action: opts.action,
        released: opts.action === "release",
        lock: lock === null ? null : {
          lock_id: lock.id,
          workspace_id: lock.workspaceId,
          owner: lock.owner,
          expires_at: lock.expiresAt,
          acquired_at: lock.acquiredAt,
          last_heartbeat: lock.lastHeartbeat,
        },
      }, useJson);
    } catch (err) {
      catchError(err, useJson);
    }
  });

// ── list ─────────────────────────────────────────────────────────────────────

program
  .command("list")
  .description("List all workspaces")
  .option("--json", "Output JSON")
  .action(async (opts: { json?: boolean }) => {
    const useJson = opts.json ?? false;
    const globalOpts = program.opts<{ stateDir?: string }>();
    try {
      const { db } = setup(globalOpts.stateDir);
      const workspaces = listAllWorkspaces(db);

      if (useJson) {
        outputOk(
          workspaces.map((ws) => ({
            workspace_id: ws.id,
            status: ws.status,
            branch: ws.branch,
            base_ref: ws.baseRef,
            base_commit: ws.baseCommit,
            path: ws.path,
            mode: ws.mode,
            repository_url: ws.repositoryUrl,
            task_id: ws.taskId ?? null,
            flow_run_id: ws.flowRunId ?? null,
            workflow_run_id: ws.workflowRunId ?? null,
            job_id: ws.jobId ?? null,
            step_id: ws.stepId ?? null,
            agent_id: ws.agentId ?? null,
            project_id: ws.projectId ?? null,
            created_at: ws.createdAt,
            updated_at: ws.updatedAt,
          })),
          true
        );
      } else {
        if (workspaces.length === 0) {
          console.log("No workspaces found.");
          return;
        }
        console.log(`Found ${workspaces.length} workspace(s):\n`);
        for (const ws of workspaces) {
          console.log(formatWorkspace(ws));
          console.log("─".repeat(60));
        }
      }
    } catch (err) {
      catchError(err, useJson);
    }
  });

// ── lock ──────────────────────────────────────────────────────────────────────

program
  .command("lock")
  .description("Acquire a lock on a workspace")
  .requiredOption("--workspace <id>", "Workspace ID")
  .requiredOption("--mode <mode>", "Lock mode: read or write")
  .requiredOption("--owner <owner>", "Lock owner identifier")
  .option("--expires-at <iso>", "ISO 8601 expiry datetime")
  .option("--json", "Output JSON")
  .action(
    async (opts: {
      workspace: string;
      mode: string;
      owner: string;
      expiresAt?: string;
      json?: boolean;
    }) => {
      const useJson = opts.json ?? false;
      const globalOpts = program.opts<{ stateDir?: string }>();
      try {
        if (opts.mode !== "read" && opts.mode !== "write") {
          outputError(
            "INVALID_INPUT",
            `Invalid lock mode "${opts.mode}". Must be "read" or "write"`,
            useJson
          );
        }
        const { db } = setup(globalOpts.stateDir);
        const lock = lockWorkspace(
          db,
          opts.workspace,
          opts.mode as "read" | "write",
          opts.owner,
          opts.expiresAt
        );

        if (useJson) {
          outputOk(
            {
              lock_id: lock.id,
              workspace_id: lock.workspaceId,
              mode: lock.mode,
              owner: lock.owner,
              acquired_at: lock.acquiredAt,
              expires_at: lock.expiresAt ?? null,
            },
            true
          );
        } else {
          console.log(`Lock acquired: ${lock.id}`);
          console.log(`Workspace: ${lock.workspaceId}`);
          console.log(`Mode:      ${lock.mode}`);
          console.log(`Owner:     ${lock.owner}`);
          console.log(`Acquired:  ${lock.acquiredAt}`);
          if (lock.expiresAt) console.log(`Expires:   ${lock.expiresAt}`);
        }
      } catch (err) {
        catchError(err, useJson);
      }
    }
  );

// ── unlock ────────────────────────────────────────────────────────────────────

program
  .command("unlock")
  .description("Release the lock on a workspace")
  .requiredOption("--workspace <id>", "Workspace ID")
  .option("--json", "Output JSON")
  .action(
    async (opts: { workspace: string; json?: boolean }) => {
      const useJson = opts.json ?? false;
      const globalOpts = program.opts<{ stateDir?: string }>();
      try {
        const { db } = setup(globalOpts.stateDir);
        unlockWorkspace(db, opts.workspace);

        if (useJson) {
          outputOk({ workspace_id: opts.workspace, unlocked: true }, true);
        } else {
          console.log(`Workspace ${opts.workspace} unlocked`);
        }
      } catch (err) {
        catchError(err, useJson);
      }
    }
  );

// ── validate ────────────────────────────────────────────────────────────────

program
  .command("validate")
  .description("Validate a workspace definition YAML file")
  .requiredOption("--file <path>", "Path to workspace definition YAML file")
  .option("--json", "Output JSON")
  .action(async (opts: { file: string; json?: boolean }) => {
    const useJson = opts.json ?? false;
    try {
      const filePath = path.resolve(opts.file);
      if (!fs.existsSync(filePath)) {
        outputError("INVALID_INPUT", `File not found: ${filePath}`, useJson);
      }

      const raw = fs.readFileSync(filePath, "utf-8");
      let parsed: unknown;
      try {
        parsed = YAML.parse(raw);
      } catch (err) {
        outputError(
          "INVALID_INPUT",
          `Failed to parse YAML: ${err instanceof Error ? err.message : String(err)}`,
          useJson,
        );
      }

      const result = validateDefinition(parsed);

      if (useJson) {
        outputOk(result, true);
      } else {
        if (result.valid) {
          console.log(`Valid workspace definition: ${filePath}`);
        } else {
          console.log(`Invalid workspace definition: ${filePath}`);
          for (const err of result.errors) {
            console.log(`  - [${err.code}] ${err.path}: ${err.message}`);
          }
        }
      }
    } catch (err) {
      catchError(err, useJson);
    }
  });

// ── apply ────────────────────────────────────────────────────────────────────

program
  .command("apply")
  .description("Apply a workspace definition YAML file to create a workspace")
  .requiredOption("--file <path>", "Path to workspace definition YAML file")
  .option("--operation-id <id>", "Idempotency key: repeat with same inputs to get original result")
  .option("--json", "Output JSON")
  .action(async (opts: { file: string; operationId?: string; json?: boolean }) => {
    const useJson = opts.json ?? false;
    const globalOpts = program.opts<{ stateDir?: string }>();
    try {
      const filePath = path.resolve(opts.file);
      if (!fs.existsSync(filePath)) {
        outputError("INVALID_INPUT", `File not found: ${filePath}`, useJson);
      }

      const raw = fs.readFileSync(filePath, "utf-8");
      let parsed: unknown;
      try {
        parsed = YAML.parse(raw);
      } catch (err) {
        outputError(
          "INVALID_INPUT",
          `Failed to parse YAML: ${err instanceof Error ? err.message : String(err)}`,
          useJson,
        );
      }

      const validation = validateDefinition(parsed);
      if (!validation.valid) {
        if (useJson) {
          outputError(
            "INVALID_INPUT",
            "Definition validation failed",
            useJson,
            { errors: validation.errors },
          );
        } else {
          console.log(`Invalid workspace definition: ${filePath}`);
          for (const err of validation.errors) {
            console.log(`  - [${err.code}] ${err.path}: ${err.message}`);
          }
          process.exit(1);
        }
      }

      const def = parsed as WorkspaceDefinition;
      const { config, db } = setup(globalOpts.stateDir);

      if (opts.operationId) {
        const rawBytes = Buffer.from(raw, "utf-8");
        const inputHash = crypto.createHash("sha256").update(rawBytes).digest("hex");
        const outcome = reserveOrCheckIdempotency(db, opts.operationId, "apply", { fileHash: inputHash });
        if (outcome.type === "hit") {
          if (useJson) {
            console.log(JSON.stringify(outcome.cachedResult, null, 2));
          } else {
            console.log(`Using cached result for operation ID "${opts.operationId}" (already executed).`);
          }
          return;
        }
        if (outcome.type === "conflict") {
          outputError(
            "OPERATION_ID_CONFLICT",
            `Operation ID "${opts.operationId}" was already used with different inputs`,
            useJson,
            { operationId: opts.operationId },
          );
        }
      }

      // Apply the workspace definition based on type
      if (def.spec.type === 'worktree') {
        const workspace = createWorkspace(db, config, {
          repositoryUrl: def.spec.repository,
          baseRef: def.spec.ref,
          branch: `zigma-${def.metadata.name}-${def.spec.ref.replace(/\//g, '-')}`,
          mode: (def.spec.mode as 'read-only' | 'writable') ?? 'writable',
          projectId: def.metadata.labels?.project,
          taskId: def.metadata.labels?.task,
          flowRunId: def.metadata.annotations?.['zigma.ai/flow-run'],
          allowedPaths: def.spec.allowedPaths,
          deniedPaths: def.spec.deniedPaths,
        });

        const data = {
          workspace_id: workspace.id,
          path: workspace.path,
          branch: workspace.branch,
          base_ref: workspace.baseRef,
          base_commit: workspace.baseCommit,
          mode: workspace.mode,
          status: workspace.status,
          manifest_path: `${workspace.path}/.zigma-workspace.json`,
          created_at: workspace.createdAt,
          definition_file: filePath,
        };

        if (opts.operationId) {
          commitIdempotency(db, opts.operationId, { contract_version: CONTRACT_VERSION, ok: true, data });
        }

        if (useJson) {
          outputOk(data, true);
        } else {
          console.log(`Workspace created from definition: ${filePath}`);
          console.log(formatWorkspace(workspace));
        }
      } else if (def.spec.type === 'docker' || def.spec.type === 'workspace') {
        // Docker and workspace types: store as metadata, actual creation by adapter
        const wsId = `ws_${crypto.randomUUID()}`;
        const ts = new Date().toISOString();

        outputError(
          "INVALID_INPUT",
          `Workspace type "${def.spec.type}" is not yet supported via CLI apply. Use validate to check the definition, then create via the appropriate adapter.`,
          useJson,
          { workspaceType: def.spec.type },
        );
      }
    } catch (err) {
      catchError(err, useJson);
    }
  });

// ── prepare-run ────────────────────────────────────────────────────────────

program
  .command("prepare-run")
  .description("Prepare (or adopt) the Run workspace for a flow run")
  .requiredOption("--operation-id <id>", "Idempotency key: repeat with same inputs to get original result")
  .requiredOption("--run <runId>", "Flow run ID; the workspace branch will be flow/<runId>")
  .requiredOption("--repo <url>", "Repository URL to clone")
  .requiredOption("--base <ref>", "Base git ref (branch, tag, or commit)")
  .option("--mode <mode>", "Workspace mode: writable or read-only", "writable")
  .option("--expected-base <sha>", "CAS: fail unless the base ref resolves to this commit")
  .option("--json", "Output JSON")
  .action(
    async (opts: {
      operationId: string;
      run: string;
      repo: string;
      base: string;
      mode: string;
      expectedBase?: string;
      json?: boolean;
    }) => {
      const useJson = opts.json ?? false;
      const globalOpts = program.opts<{ stateDir?: string }>();
      try {
        if (opts.mode !== "writable" && opts.mode !== "read-only") {
          outputError("INVALID_INPUT", `Invalid mode "${opts.mode}". Must be "writable" or "read-only"`, useJson);
        }
        const { config, db } = setup(globalOpts.stateDir);
        const handle = prepareRun(db, config, {
          operationId: opts.operationId,
          runId: opts.run,
          repositoryUrl: opts.repo,
          baseRef: opts.base,
          mode: opts.mode as "writable" | "read-only",
          expectedBaseCommit: opts.expectedBase,
        });
        outputOk(
          {
            operation_id: handle.operationId,
            run_id: handle.runId,
            workspace_id: handle.workspaceId,
            path: handle.path,
            branch: handle.branch,
            base_ref: handle.baseRef,
            base_commit: handle.baseCommit,
            mode: handle.mode,
            status: handle.status,
            created_at: handle.createdAt,
          },
          useJson
        );
      } catch (err) {
        catchError(err, useJson);
      }
    }
  );

// ── prepare-job ─────────────────────────────────────────────────────────────

program
  .command("prepare-job")
  .description("Prepare (or adopt) a Job attempt workspace from an exact Run HEAD")
  .requiredOption("--operation-id <id>", "Idempotency key: repeat with same inputs to get original result")
  .requiredOption("--run <runId>", "Flow run ID")
  .requiredOption("--run-workspace <id>", "Run workspace ID the attempt branches from")
  .requiredOption("--job <jobId>", "Job ID")
  .requiredOption("--attempt <n>", "Attempt number (positive integer)")
  .requiredOption("--expected-head <sha>", "Exact Run HEAD commit the attempt starts from")
  .option("--json", "Output JSON")
  .action(
    async (opts: {
      operationId: string;
      run: string;
      runWorkspace: string;
      job: string;
      attempt: string;
      expectedHead: string;
      json?: boolean;
    }) => {
      const useJson = opts.json ?? false;
      const globalOpts = program.opts<{ stateDir?: string }>();
      try {
        const attempt = Number.parseInt(opts.attempt, 10);
        if (!Number.isInteger(attempt) || String(attempt) !== opts.attempt || attempt < 1) {
          outputError("INVALID_INPUT", `Invalid attempt "${opts.attempt}". Must be a positive integer`, useJson);
        }
        const { config, db } = setup(globalOpts.stateDir);
        const handle = prepareJob(db, config, {
          operationId: opts.operationId,
          runId: opts.run,
          runWorkspaceId: opts.runWorkspace,
          jobId: opts.job,
          attempt,
          expectedRunHead: opts.expectedHead,
        });
        outputOk(
          {
            operation_id: handle.operationId,
            run_id: handle.runId,
            run_workspace_id: handle.runWorkspaceId,
            job_id: handle.jobId,
            attempt: handle.attempt,
            workspace_id: handle.workspaceId,
            path: handle.path,
            branch: handle.branch,
            base_commit: handle.baseCommit,
            mode: handle.mode,
            status: handle.status,
            created_at: handle.createdAt,
          },
          useJson
        );
      } catch (err) {
        catchError(err, useJson);
      }
    }
  );

// ── commit ──────────────────────────────────────────────────────────────────

program
  .command("commit")
  .description("Commit all workspace changes with CAS and idempotency")
  .requiredOption("--operation-id <id>", "Idempotency key: repeat with same inputs to get original result")
  .requiredOption("--workspace <id>", "Workspace ID")
  .option("--message <msg>", "Commit message")
  .option("--expected-state <state>", "CAS: fail unless the workspace is in this state")
  .option("--expected-head <sha>", "CAS: fail unless workspace HEAD is this commit")
  .option("--json", "Output JSON")
  .action(
    async (opts: {
      operationId: string;
      workspace: string;
      message?: string;
      expectedState?: string;
      expectedHead?: string;
      json?: boolean;
    }) => {
      const useJson = opts.json ?? false;
      const globalOpts = program.opts<{ stateDir?: string }>();
      try {
        const { db } = setup(globalOpts.stateDir);
        const result = commitWorkspace(db, {
          operationId: opts.operationId,
          workspaceId: opts.workspace,
          message: opts.message,
          expectedState: opts.expectedState,
          expectedHead: opts.expectedHead,
        });
        outputOk(
          {
            operation_id: result.operationId,
            workspace_id: result.workspaceId,
            base_commit: result.baseCommit,
            head_commit: result.headCommit,
            changed_files: result.changedFiles,
            evidence_digest: result.evidenceDigest,
            artifact: formatArtifactDescriptor(result.artifact),
            no_op: result.noOp,
          },
          useJson
        );
      } catch (err) {
        catchError(err, useJson);
      }
    }
  );

// ── integrate ───────────────────────────────────────────────────────────────

program
  .command("integrate")
  .description("Integrate a source Job workspace commit into a target Run workspace")
  .requiredOption("--operation-id <id>", "Idempotency key: repeat with same inputs to get original result")
  .requiredOption("--source <id>", "Source (Job) workspace ID")
  .requiredOption("--target <id>", "Target (Run) workspace ID")
  .requiredOption("--lock-owner <owner>", "Integration lock owner identifier")
  .option("--expected-head <sha>", "CAS: fail unless target HEAD is this commit")
  .option("--lock-expires-at <iso>", "Integration lock lease expiry (ISO timestamp)")
  .option("--json", "Output JSON")
  .action(
    async (opts: {
      operationId: string;
      source: string;
      target: string;
      lockOwner: string;
      expectedHead?: string;
      lockExpiresAt?: string;
      json?: boolean;
    }) => {
      const useJson = opts.json ?? false;
      const globalOpts = program.opts<{ stateDir?: string }>();
      try {
        const { db } = setup(globalOpts.stateDir);
        const result = integrateWorkspace(db, {
          operationId: opts.operationId,
          sourceWorkspaceId: opts.source,
          targetWorkspaceId: opts.target,
          expectedHead: opts.expectedHead,
          lockOwner: opts.lockOwner,
          lockExpiresAt: opts.lockExpiresAt,
        });

        if ("conflictFiles" in result) {
          outputError("WORKSPACE_INTEGRATION_CONFLICT", result.message, useJson, {
            operation_id: result.operationId,
            source_workspace_id: result.sourceWorkspaceId,
            target_workspace_id: result.targetWorkspaceId,
            source_commit: result.sourceCommit,
            previous_target_head: result.previousTargetHead,
            conflict_files: result.conflictFiles,
          });
        }

        outputOk(
          {
            operation_id: result.operationId,
            source_workspace_id: result.sourceWorkspaceId,
            target_workspace_id: result.targetWorkspaceId,
            source_commit: result.sourceCommit,
            previous_target_head: result.previousTargetHead,
            resulting_commit: result.resultingCommit,
            changed_files: result.changedFiles ?? [],
            artifact: formatArtifactDescriptor(result.artifact),
            merged: result.merged,
          },
          useJson
        );
      } catch (err) {
        catchError(err, useJson);
      }
    }
  );

// ── publish ─────────────────────────────────────────────────────────────────

program
  .command("publish")
  .description("Publish workspace changes to a target ref")
  .requiredOption("--operation-id <id>", "Idempotency key: repeat with same inputs to get original result")
  .requiredOption("--workspace <id>", "Workspace ID")
  .requiredOption("--strategy <strategy>", "Publish strategy: none or branch")
  .requiredOption("--target-ref <ref>", "Target ref name (ignored by strategy none)")
  .option("--expected-head <sha>", "CAS: fail unless workspace HEAD is this commit")
  .option("--json", "Output JSON")
  .action(
    async (opts: {
      operationId: string;
      workspace: string;
      strategy: string;
      targetRef: string;
      expectedHead?: string;
      json?: boolean;
    }) => {
      const useJson = opts.json ?? false;
      const globalOpts = program.opts<{ stateDir?: string }>();
      try {
        if (opts.strategy !== "none" && opts.strategy !== "branch") {
          outputError("INVALID_INPUT", `Invalid publish strategy "${opts.strategy}". Supported: none, branch`, useJson);
        }
        const { db } = setup(globalOpts.stateDir);
        const result = publishWorkspace(db, {
          operationId: opts.operationId,
          workspaceId: opts.workspace,
          strategy: opts.strategy as "none" | "branch",
          targetRef: opts.targetRef,
          expectedHead: opts.expectedHead,
        });
        outputOk(
          {
            operation_id: result.operationId,
            workspace_id: result.workspaceId,
            strategy: result.strategy,
            resulting_ref: result.resultingRef,
            resulting_commit: result.resultingCommit,
            previous_ref: result.previousRef ?? null,
            changed_files: result.changedFiles ?? [],
            artifact: formatArtifactDescriptor(result.artifact),
          },
          useJson
        );
      } catch (err) {
        catchError(err, useJson);
      }
    }
  );

// ── Run ───────────────────────────────────────────────────────────────────────

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

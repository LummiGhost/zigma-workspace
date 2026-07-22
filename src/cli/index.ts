#!/usr/bin/env node
import { Command } from "commander";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import * as crypto from "node:crypto";
import { getConfig, ensureStateDirs, loadConfigFile } from "../config/index.js";
import { openDb } from "../db/index.js";
import {
  getIdempotencyRecord,
  insertIdempotencyRecord,
  updateIdempotencyResult,
  getRepositoryCacheByUrl,
} from "../db/queries.js";
import { createWorkspace, bindRun, getWorkspace, listAllWorkspaces } from "../core/workspace.js";
import { lockWorkspace, unlockWorkspace, getLock } from "../core/lock.js";
import { collectDiff } from "../core/diff.js";
import { createSnapshot } from "../core/snapshot.js";
import { cleanupWorkspace } from "../core/cleanup.js";
import { CONTRACT_VERSION, ZigmaError } from "../types/index.js";
import { GitError } from "../git/index.js";
import type { Workspace, ZigmaErrorCode } from "../types/index.js";
import type Database from "better-sqlite3";

const require = createRequire(import.meta.url);
const { version } = require("../../package.json") as { version: string };

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
    console.error(JSON.stringify(out, null, 2));
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
  .option("--operation-id <id>", "Idempotency key: repeat with same inputs to get original result")
  .option("--json", "Output JSON")
  .action(
    async (opts: {
      workspace: string;
      task?: string;
      flowRun?: string;
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
        });

        const data = {
          workspace_id: workspace.id,
          task_id: workspace.taskId ?? null,
          flow_run_id: workspace.flowRunId ?? null,
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
      const { db } = setup(globalOpts.stateDir);
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
                }
              : null,
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

        const artifact =
          snapshot.path && snapshot.checksum
            ? {
                uri: toFileUri(snapshot.path),
                media_type: snapshot.kind === "diff" ? "text/x-diff" : "application/json",
                digest: `sha256:${snapshot.checksum}`,
              }
            : null;

        const data = {
          snapshot_id: snapshot.id,
          workspace_id: snapshot.workspaceId,
          kind: snapshot.kind,
          path: snapshot.path ?? null,
          checksum: snapshot.checksum ?? null,
          artifact,
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
          if (snapshot.path) console.log(`Path:     ${snapshot.path}`);
          if (snapshot.checksum) console.log(`Checksum: ${snapshot.checksum}`);
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
  .option("--json", "Output JSON")
  .action(
    async (opts: { workspace: string; operationId?: string; json?: boolean }) => {
      const useJson = opts.json ?? false;
      const globalOpts = program.opts<{ stateDir?: string }>();
      try {
        const { config, db } = setup(globalOpts.stateDir);

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

// ── Run ───────────────────────────────────────────────────────────────────────

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

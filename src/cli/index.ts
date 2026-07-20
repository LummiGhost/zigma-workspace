#!/usr/bin/env node
import { Command } from "commander";
import { createRequire } from "node:module";
import { getConfig, ensureStateDirs, loadConfigFile } from "../config/index.js";
import { openDb } from "../db/index.js";
import { createWorkspace, bindRun, getWorkspace, listAllWorkspaces } from "../core/workspace.js";
import { lockWorkspace, unlockWorkspace, getLock } from "../core/lock.js";
import { collectDiff } from "../core/diff.js";
import { createSnapshot } from "../core/snapshot.js";
import { cleanupWorkspace } from "../core/cleanup.js";
import type { Workspace } from "../types/index.js";

const require = createRequire(import.meta.url);
const { version } = require("../../package.json") as { version: string };

// ── Output helpers ──────────────────────────────────────────────────────────

function outputOk(data: unknown, useJson: boolean): void {
  if (useJson) {
    console.log(JSON.stringify({ ok: true, data }, null, 2));
  } else {
    console.log(formatHuman(data));
  }
}

function outputError(message: string, useJson: boolean, details?: unknown): void {
  if (useJson) {
    const out: Record<string, unknown> = { ok: false, error: message };
    if (details !== undefined) out["details"] = details;
    console.error(JSON.stringify(out, null, 2));
  } else {
    console.error(`Error: ${message}`);
    if (details !== undefined) {
      console.error(JSON.stringify(details, null, 2));
    }
  }
  process.exit(1);
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

// ── Setup ──────────────────────────────────────────────────────────────────

function setup() {
  const config = getConfig();
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
  .version(version);

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
  .option("--json", "Output JSON")
  .action(
    async (
      opts: {
        repo: string;
        base: string;
        branch: string;
        mode: string;
        project?: string;
        task?: string;
        flowRun?: string;
        json?: boolean;
      }
    ) => {
      const useJson = opts.json ?? false;
      try {
        if (opts.mode !== "writable" && opts.mode !== "read-only") {
          outputError(
            `Invalid mode "${opts.mode}". Must be "writable" or "read-only"`,
            useJson
          );
          return;
        }
        const { config, db } = setup();
        const workspace = createWorkspace(db, config, {
          repositoryUrl: opts.repo,
          baseRef: opts.base,
          branch: opts.branch,
          mode: opts.mode as "writable" | "read-only",
          projectId: opts.project,
          taskId: opts.task,
          flowRunId: opts.flowRun,
        });

        if (useJson) {
          outputOk(
            {
              workspace_id: workspace.id,
              path: workspace.path,
              branch: workspace.branch,
              base_ref: workspace.baseRef,
              base_commit: workspace.baseCommit,
              mode: workspace.mode,
              status: workspace.status,
              manifest_path: `${workspace.path}/.zigma-workspace.json`,
              created_at: workspace.createdAt,
            },
            true
          );
        } else {
          console.log("Workspace created successfully\n");
          console.log(formatWorkspace(workspace));
          console.log(`\nManifest: ${workspace.path}/.zigma-workspace.json`);
        }
      } catch (err) {
        outputError(
          err instanceof Error ? err.message : String(err),
          useJson
        );
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
  .option("--json", "Output JSON")
  .action(
    async (
      opts: {
        workspace: string;
        task?: string;
        flowRun?: string;
        json?: boolean;
      }
    ) => {
      const useJson = opts.json ?? false;
      try {
        const { db } = setup();
        const workspace = bindRun(db, {
          workspaceId: opts.workspace,
          taskId: opts.task,
          flowRunId: opts.flowRun,
        });

        if (useJson) {
          outputOk(
            {
              workspace_id: workspace.id,
              task_id: workspace.taskId ?? null,
              flow_run_id: workspace.flowRunId ?? null,
              status: workspace.status,
              updated_at: workspace.updatedAt,
            },
            true
          );
        } else {
          console.log("Workspace bound to run\n");
          console.log(formatWorkspace(workspace));
        }
      } catch (err) {
        outputError(
          err instanceof Error ? err.message : String(err),
          useJson
        );
      }
    }
  );

// ── status ──────────────────────────────────────────────────────────────────

program
  .command("status")
  .description("Show workspace status")
  .requiredOption("--workspace <id>", "Workspace ID")
  .option("--json", "Output JSON")
  .action(
    async (opts: { workspace: string; json?: boolean }) => {
      const useJson = opts.json ?? false;
      try {
        const { db } = setup();
        const workspace = getWorkspace(db, opts.workspace);
        const lock = getLock(db, opts.workspace);

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
        outputError(
          err instanceof Error ? err.message : String(err),
          useJson
        );
      }
    }
  );

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
      try {
        const { config, db } = setup();
        const diff = collectDiff(db, config, opts.workspace, opts.patchOut);

        if (useJson) {
          outputOk(
            {
              workspace_id: diff.workspaceId,
              base_commit: diff.baseCommit,
              head_commit: diff.headCommit ?? null,
              changed_files: diff.changedFiles,
              untracked_files: diff.untrackedFiles,
              status_text: diff.statusText,
              patch_path: diff.patchPath ?? null,
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
        outputError(
          err instanceof Error ? err.message : String(err),
          useJson
        );
      }
    }
  );

// ── snapshot ─────────────────────────────────────────────────────────────────

program
  .command("snapshot")
  .description("Create a snapshot of the workspace state")
  .requiredOption("--workspace <id>", "Workspace ID")
  .option("--json", "Output JSON")
  .action(
    async (opts: { workspace: string; json?: boolean }) => {
      const useJson = opts.json ?? false;
      try {
        const { config, db } = setup();
        const snapshot = createSnapshot(db, config, opts.workspace);

        if (useJson) {
          outputOk(
            {
              snapshot_id: snapshot.id,
              workspace_id: snapshot.workspaceId,
              kind: snapshot.kind,
              path: snapshot.path ?? null,
              checksum: snapshot.checksum ?? null,
              created_at: snapshot.createdAt,
            },
            true
          );
        } else {
          console.log(`Snapshot created: ${snapshot.id}`);
          console.log(`Kind:     ${snapshot.kind}`);
          if (snapshot.path) console.log(`Path:     ${snapshot.path}`);
          if (snapshot.checksum) console.log(`Checksum: ${snapshot.checksum}`);
          console.log(`Created:  ${snapshot.createdAt}`);
        }
      } catch (err) {
        outputError(
          err instanceof Error ? err.message : String(err),
          useJson
        );
      }
    }
  );

// ── cleanup ──────────────────────────────────────────────────────────────────

program
  .command("cleanup")
  .description("Clean up a workspace (remove worktree and mark as cleaned)")
  .requiredOption("--workspace <id>", "Workspace ID")
  .option("--json", "Output JSON")
  .action(
    async (opts: { workspace: string; json?: boolean }) => {
      const useJson = opts.json ?? false;
      try {
        const { config, db } = setup();
        const result = cleanupWorkspace(db, config, opts.workspace);

        if (useJson) {
          outputOk(
            {
              workspace_id: result.workspaceId,
              path: result.path,
              removed: result.removed,
              message: result.message,
            },
            true
          );
        } else {
          console.log(`Workspace ${result.workspaceId} cleaned`);
          console.log(`Path:    ${result.path}`);
          console.log(`Removed: ${result.removed}`);
          console.log(`Message: ${result.message}`);
        }
      } catch (err) {
        outputError(
          err instanceof Error ? err.message : String(err),
          useJson
        );
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
    try {
      const { db } = setup();
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
      outputError(
        err instanceof Error ? err.message : String(err),
        useJson
      );
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
      try {
        if (opts.mode !== "read" && opts.mode !== "write") {
          outputError(
            `Invalid lock mode "${opts.mode}". Must be "read" or "write"`,
            useJson
          );
          return;
        }
        const { db } = setup();
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
        outputError(
          err instanceof Error ? err.message : String(err),
          useJson
        );
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
      try {
        const { db } = setup();
        unlockWorkspace(db, opts.workspace);

        if (useJson) {
          outputOk({ workspace_id: opts.workspace, unlocked: true }, true);
        } else {
          console.log(`Workspace ${opts.workspace} unlocked`);
        }
      } catch (err) {
        outputError(
          err instanceof Error ? err.message : String(err),
          useJson
        );
      }
    }
  );

// ── Run ───────────────────────────────────────────────────────────────────────

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

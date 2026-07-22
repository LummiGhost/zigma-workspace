# CLAUDE.md

This file provides guidance to AI Agent when working with code in this repository.

## Commands

```bash
npm run build        # Clean dist/ and compile TypeScript
npm run typecheck    # Type-check without emitting (tsc --noEmit)
npm run dev          # Run CLI directly via tsx (no build needed)
npm run test         # Smoke test: node dist/cli/index.js --help
npm run check        # typecheck + build + test in sequence
```

There is no unit test framework — `test` is a smoke test only. To run a specific CLI command during development use `npm run dev -- <command> [args]`.

## Architecture

**Entry point:** `src/cli/index.ts` → compiled to `dist/`, registered as the `zigma-workspace` binary.

**Layer model:**

```
src/cli/       Commander.js command definitions — parse args, call core, print output
src/core/      Business logic — workspace.ts, lock.ts, diff.ts, snapshot.ts, cleanup.ts
src/db/        SQLite layer — index.ts (schema + WAL init), queries.ts (all CRUD)
src/git/       Thin spawnSync wrapper around git; throws GitError on non-zero exit
src/types/     Shared TypeScript interfaces (Workspace, Lock, Diff, Snapshot, etc.)
src/config/    State directory path resolution (ZIGMA_WORKSPACE_STATE_DIR env override)
```

**Data store:** A single `better-sqlite3` database at `~/.zigma-workspace/registry.db`. Five tables: `workspaces`, `repository_caches`, `workspace_locks`, `workspace_snapshots`, `workspace_events`. WAL mode is always on; foreign keys are always on.

**Key concepts:**
- **Workspace** — a `git worktree` directory created from a bare mirror of a remote repo. Lifecycle states: `created → prepared → active → cleaned`.
- **Repository cache** — a bare git mirror (`git clone --mirror`) keyed by SHA256 of the repo URL, reused across workspaces to avoid redundant full clones.
- **Workspace lock** — read/write mutex row in `workspace_locks`. Writers are exclusive; multiple readers are allowed.
- **Manifest** — `.zigma-workspace.json` written to the worktree root describing the workspace boundaries (`allowed_paths`, `denied_paths`). Declared but not enforced in the current MVP.
- **Snapshot** — a metadata or diff artifact captured at a point in time for audit purposes.

**ID convention:** All entity IDs are prefixed UUIDs (`ws_`, `cache_`, `lock_`, `snap_`, `evt_`).

**Git calls:** All git operations go through `src/git/` which sets `GIT_TERMINAL_PROMPT=0` and throws a typed `GitError` containing the command and stderr on failure.

**CLI output:** Every command accepts `--json` for structured output; human-readable text is the default.

## TypeScript config

Target: ES2022, module resolution: NodeNext. Strict mode is on. Source in `src/`, output in `dist/`. The package is ESM (`"type": "module"`).

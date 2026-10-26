# Agent workflow

## Rapid iteration

- Deliver one small, reviewable behavior change at a time. Clarify the outcome, implement, validate by risk, and deliver. A small change needs no separate plan or phase report.
- Inspect Git status and relevant code before editing. Preserve unrelated work. Use a task branch for code; isolate work when concurrent edits or user changes require it. Read design and history documents to resolve specific questions rather than as a fixed reading bundle.
- Keep task progress in the existing issue/project when one is used, and keep validation evidence in the PR. Do not duplicate these in Markdown trackers or routine round reports.
- Run the smallest sufficient checks, then broaden for cross-module or high-risk changes. Preserve executable gates for contracts, lifecycle, cancellation, cleanup and data integrity. Do not repeat successful checks unless the code changed or an unresolved concern warrants it.
- Submit implementation through a scoped PR with behavior, validation and material limitations. Required CI must pass and an independent reviewer must check the change. Merge and publish only within the maintainer's current authorization; do not add per-step approvals where that authorization already exists.
- With maintainer authorization, merge a reviewed change promptly and publish a patch for affected packages. Keep documentation in one authoritative location; direct-to-main documentation updates are allowed when the maintainer requests them. Documentation-only changes do not require a package release.
- Use exact published suite identities for downstream dogfood runs. Stop admission on unknown or incompatible provider state. Separate execution completion, independent acceptance and delivery; do not rewrite runtime state to manufacture success.
- Preserve failed evidence and report actual interventions. Keep candidate changes isolated from authoritative downstream repositories. Independent review, scientific/data contracts and rollback boundaries remain mandatory when applicable.

These instructions replace older fixed phase paperwork, mandatory report bundles, bulk reading and worktree creation for every edit. Relevant product contracts and technical boundaries still apply. User instructions in the current conversation take precedence.

## Zigma Workspace commands and boundaries

- Use npm with the checked-in package-lock.json. npm run check runs typecheck, build, unit tests and CLI smoke. npm run test:unit runs Vitest; npm test includes unit tests and the built CLI smoke.
- Preserve workspace ownership, retention policy, registry integrity, repository-cache concurrency and cleanup boundaries. Never recursively delete or move a path without proving that it belongs to the owned workspace.
- Git operations go through the existing Git layer. Keep the versioned JSON envelope stable and preserve audit evidence.

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
- **Workspace** — a `git worktree` directory created from a bare mirror of a remote repo. Use the uppercase lifecycle states in `src/types/index.ts` and the existing transition guards; review, merge, conflict and cleanup failure are distinct states.
- **Repository cache** — a bare git mirror (`git clone --mirror`) keyed by SHA256 of the repo URL, reused across workspaces to avoid redundant full clones.
- **Workspace lock** — read/write mutex row in `workspace_locks`. Writers are exclusive; multiple readers are allowed.
- **Manifest** — `.zigma-workspace.json` written to the worktree root describing workspace boundaries (`allowed_paths`, `denied_paths`). Commit operations validate the workspace boundary and changed paths through `src/core/isolation-policy.ts`; preserve these checks. This is not OS isolation for arbitrary subprocesses.
- **Snapshot** — a metadata or diff artifact captured at a point in time for audit purposes.

**ID convention:** All entity IDs are prefixed UUIDs (`ws_`, `cache_`, `lock_`, `snap_`, `evt_`).

**Git calls:** All git operations go through `src/git/` which sets `GIT_TERMINAL_PROMPT=0` and throws a typed `GitError` containing the command and stderr on failure.

**CLI output:** Every command accepts `--json` for structured output; human-readable text is the default.

## TypeScript config

Target: ES2022, module resolution: NodeNext. Strict mode is on. Source in `src/`, output in `dist/`. The package is ESM (`"type": "module"`).

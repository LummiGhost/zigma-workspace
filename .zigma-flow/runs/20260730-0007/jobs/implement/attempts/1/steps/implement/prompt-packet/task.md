Overall run task:

Implement GitHub Issue #4: feat: bind Workspace to Workflow Execution Context

## Background
Zigma requires traceability between Workflow Run, Job, Step, Agent and Workspace.
Without this association, it is difficult to identify which execution unit produced a code change.

## Requirement
Extend workspace metadata and the .zigma-workspace.json manifest with execution context fields:

```json
{
  "workspaceId": "",
  "workflowRunId": "",
  "jobId": "",
  "stepId": "",
  "agentId": ""
}
```

## Implementation tasks
1. Update the `Workspace` TypeScript interface in `src/types/index.ts` to add optional execution context fields:
   ```typescript
   workflowRunId?: string;
   jobId?: string;
   stepId?: string;
   agentId?: string;
   ```
2. Add corresponding nullable columns to the `workspaces` table in `src/db/index.ts`: `workflow_run_id`, `job_id`, `step_id`, `agent_id` (all TEXT NULL).
3. Update `insertWorkspace` and `getWorkspace` in `src/db/queries.ts` to read/write these fields.
4. Update `src/core/workspace.ts` `createWorkspace` to accept and persist these optional context fields.
5. Update the `.zigma-workspace.json` manifest written to the worktree root (in `src/core/workspace.ts`) to include these fields when present.
6. Update CLI `zigma-workspace create` command in `src/cli/` to accept optional flags: `--workflow-run-id`, `--job-id`, `--step-id`, `--agent-id`.
7. Ensure `zigma-workspace info` (or equivalent inspect command) displays these fields when set.

## Build validation
After implementing: npm run check
(typecheck + build + smoke test)

## Codebase notes
- Source in src/, built to dist/ with tsc
- better-sqlite3 (synchronous API)
- Workspace creation in src/core/workspace.ts
- DB schema in src/db/index.ts, queries in src/db/queries.ts
- CLI commands in src/cli/index.ts
- Manifest (.zigma-workspace.json) written during workspace creation
- See CLAUDE.md for architecture details

This task prompt is stable for the run. Do not let the step prompt replace or dilute the overall task.

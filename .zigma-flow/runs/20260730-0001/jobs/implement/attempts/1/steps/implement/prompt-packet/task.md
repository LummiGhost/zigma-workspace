Overall run task:

Implement GitHub Issue #3: feat: add Workspace State Machine

## Background
Workspace lifecycle should be explicitly modeled instead of being inferred only from commands.
Zigma execution requires deterministic workspace state tracking for workflow orchestration, UI display, and audit.

## Requirements
Add a WorkspaceStatus state machine with the following transitions:
CREATED -> PREPARING -> READY -> RUNNING -> WAIT_REVIEW -> MERGED -> CLEANED

Specific implementation tasks:
1. Add WorkspaceStatus type to src/types/ with the 7 states listed above.
2. Add a `status` field to the workspaces DB table (src/db/index.ts) with default 'CREATED'.
3. Add a `status` field to the Workspace TypeScript interface in src/types/.
4. Implement a transition validator in src/core/workspace.ts that only allows legal transitions:
   - CREATED -> PREPARING
   - PREPARING -> READY
   - READY -> RUNNING
   - RUNNING -> WAIT_REVIEW, RUNNING -> READY (if reverted)
   - WAIT_REVIEW -> MERGED, WAIT_REVIEW -> RUNNING (if changes needed)
   - Any state -> CLEANED
5. Add a `transitionStatus(workspaceId, newStatus)` method in src/core/workspace.ts that:
   - Validates the transition is legal
   - Updates the DB
   - Records a workspace_status_changed event in workspace_events table
6. Update relevant queries in src/db/queries.ts to read/write status.
7. Expose the current status in all CLI `inspect`/`list` command output (src/cli/).

## Build validation
After implementing, verify with: npm run check
(this runs typecheck + build + smoke test)

## Codebase notes
- Source in src/, built to dist/ with tsc
- Better-sqlite3 for DB (synchronous API, no async)
- All IDs prefixed: ws_, cache_, lock_, snap_, evt_
- CLI uses Commander.js
- See CLAUDE.md for full architecture details

This task prompt is stable for the run. Do not let the step prompt replace or dilute the overall task.

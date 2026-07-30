Overall run task:

Implement GitHub Issue #5: feat: implement Lease-based Lock Management

## Background
Agent execution requires reliable workspace locking. A crashed Agent should not permanently lock a workspace.

## Requirement
Replace simple locks with lease-based locking.

Example lease shape:
```json
{
  "owner": "agent-id",
  "createdAt": "",
  "expiresAt": "",
  "lastHeartbeat": ""
}
```

Requirements:
- Support lock heartbeat renewal
- Automatically reclaim expired leases
- Preserve lock history through events

## Implementation tasks
1. Update the `workspace_locks` table schema in `src/db/index.ts` to add `expires_at` and `last_heartbeat` columns (keep `owner`, `created_at`).
2. Update the Lock TypeScript interface in `src/types/index.ts` to add `expiresAt: string` and `lastHeartbeat: string` fields.
3. Add `renewLock(lockId, ttlMs)` function in `src/db/queries.ts` that updates `last_heartbeat` and `expires_at`.
4. Add `reclaimExpiredLocks(workspaceId)` function in `src/db/queries.ts` that deletes locks where `expires_at < now`.
5. Update `src/core/lock.ts` (or workspace.ts) so that:
   - `acquireLock` sets an initial lease duration (default 5 minutes TTL)
   - `renewLock` extends the lease
   - `releaseLock` removes the lock row
   - Before acquiring a lock, reclaim any expired leases
6. Emit workspace events for lock_acquired, lock_renewed, lock_released, lock_reclaimed (use the WorkspaceEvent schema if already implemented in src/types/index.ts).
7. Update CLI commands in `src/cli/` to expose heartbeat/renewal if appropriate.

## Build validation
After implementing: npm run check
(typecheck + build + smoke test)

## Codebase notes
- Source in src/, built to dist/ with tsc
- better-sqlite3 (synchronous API, synchronous transactions)
- Lock logic currently in src/core/workspace.ts (acquireLock, releaseLock)
- workspace_locks table: see src/db/index.ts
- All entity IDs prefixed: lock_
- See CLAUDE.md for architecture details

This task prompt is stable for the run. Do not let the step prompt replace or dilute the overall task.

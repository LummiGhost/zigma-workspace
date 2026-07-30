Overall run task:

Implement GitHub Issue #6: refactor: separate Snapshot and Artifact models

## Background
Snapshot currently contains diff artifacts. In Zigma architecture, Artifact should be an independent first-class object.

## Requirement
Refactor models so that:

```
Snapshot
 ├── metadata
 ├── git state
 └── artifact references

Artifact
 ├── diff
 ├── logs
 ├── reports
 └── generated files
```

This allows workspace outputs to support test reports, screenshots, benchmarks, logs and other execution results.

## Implementation tasks
1. Add an `Artifact` TypeScript interface to `src/types/index.ts`:
   ```typescript
   interface Artifact {
     id: string;          // art_<uuid>
     workspaceId: string;
     snapshotId?: string; // optional reference to parent snapshot
     kind: "diff" | "log" | "report" | "file";
     name: string;
     content: string;     // raw text or base64
     createdAt: string;
   }
   ```
2. Update the `Snapshot` interface in `src/types/index.ts` to remove embedded diff fields and add `artifactIds: string[]`.
3. Add a `workspace_artifacts` table in `src/db/index.ts` with columns: `id`, `workspace_id`, `snapshot_id` (nullable FK), `kind`, `name`, `content`, `created_at`.
4. Add CRUD functions for artifacts in `src/db/queries.ts`: `insertArtifact`, `getArtifactById`, `listArtifactsByWorkspace`, `listArtifactsBySnapshot`.
5. Update `src/core/snapshot.ts` (or wherever snapshots are created) so that diff content is stored as an Artifact row instead of inline on the Snapshot.
6. Update `src/cli/` to add an `artifact` command (or subcommands) to list/show artifacts, with `--json` support.

## Build validation
After implementing: npm run check
(typecheck + build + smoke test)

## Codebase notes
- Source in src/, built to dist/ with tsc
- better-sqlite3 (synchronous API)
- Snapshot logic in src/core/snapshot.ts, types in src/types/index.ts
- DB schema in src/db/index.ts, queries in src/db/queries.ts
- All entity IDs prefixed (ws_, snap_, evt_, etc.) — use art_ for artifacts
- See CLAUDE.md for architecture details

This task prompt is stable for the run. Do not let the step prompt replace or dilute the overall task.

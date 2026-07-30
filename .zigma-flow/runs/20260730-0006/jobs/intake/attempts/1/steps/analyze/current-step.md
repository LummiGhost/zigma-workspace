# intake/analyze Agent Prompt

## Task Prompt

Overall run task:

Implement GitHub Issue #6: refactor: separate Snapshot and Artifact models

#### Background
Snapshot currently contains diff artifacts. In Zigma architecture, Artifact should be an independent first-class object.

#### Requirement
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

#### Implementation tasks
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

#### Build validation
After implementing: npm run check
(typecheck + build + smoke test)

#### Codebase notes
- Source in src/, built to dist/ with tsc
- better-sqlite3 (synchronous API)
- Snapshot logic in src/core/snapshot.ts, types in src/types/index.ts
- DB schema in src/db/index.ts, queries in src/db/queries.ts
- All entity IDs prefixed (ws_, snap_, evt_, etc.) — use art_ for artifacts
- See CLAUDE.md for architecture details

This task prompt is stable for the run. Do not let the step prompt replace or dilute the overall task.

## Workflow Step Prompt

Current workflow scope: job "intake", step "analyze", attempt 1.
Primary prompt source: step.prompt -> intake.
Primary prompt path: prompts/intake.md.

### Intake Step Prompt

You are the intake agent for a code-change workflow step.

#### Task

Analyze the task description provided in the workflow inputs and produce an
intake summary that will guide subsequent steps.

#### What to Read

- The task description from `inputs.task`.
- The coding guidelines knowledge file for context.

#### Output Requirements

Write a `report.json` with the following fields:

- `outputs`: include `task_summary` (short restatement of the task) and
  `scope` (estimated scope: small/medium/large).
- `artifacts`: list any artifact files you produce.
- `signals`: leave empty unless you detect a blocking issue.
- `summary`: a short human-readable summary of the task.

The report schema is described in the workflow-guide knowledge file.

Stop after completing this step — do not proceed to subsequent steps autonomously.

## Context Blocks

### workspace-mode

- type: workspace-scan
- source: workflow.workspace
- priority: 80
- freshness: current
- summary: This job does not grant repository file modifications unless the workflow explicitly allows them. Writing report.json to the canonical runtime artifact path is allowed and required.


### knowledge-code-coding-guidelines

- type: knowledge-summary
- source: code.coding-guidelines
- priority: 70
- freshness: static
- path: `knowledge/coding-guidelines.md`
- summary: required (path-only — content is not included in this prompt): read before starting this step


### knowledge-code-workflow-guide

- type: knowledge-summary
- source: code.workflow-guide
- priority: 70
- freshness: static
- path: `knowledge/workflow-guide.md`
- summary: required (path-only — content is not included in this prompt): report schema and workflow DAG reference


### prompt-code-intake

- type: capability-summary
- source: code.intake
- priority: 65
- freshness: static
- path: `prompts/intake.md`
- summary: Primary step prompt rendered in the Workflow Step Prompt layer.


### knowledge-code-common-failure-patterns

- type: knowledge-summary
- source: code.common-failure-patterns
- priority: 50
- freshness: static
- path: `knowledge/common-failure-patterns.md`
- summary: optional (path-only — content is not included in this prompt): consult if unsure about approach, failure handling, or retry behavior


## Output Contract

Write your report to:

  `.zigma-flow/runs/20260730-0006/jobs/intake/attempts/1/steps/analyze/report.json`

This is the canonical step artifact path. Writing to any other location will cause the Engine to reject the report.
This is a runtime artifact file. Writing it does not modify workflow state or repository code; the Engine reads it and owns all state transitions.

### Required Outputs

- `complexity_profile`
- `scope`
- `task_summary`

### Required Artifacts

(none declared)

### Allowed Signals

(none)
### Artifact Rules

- Write the Agent report to the canonical report path only.
- Use artifact references for large logs, diffs, test results, and generated files.
- Do not place full large artifact contents in the prompt or report JSON.

### Artifact Reference Schema

Artifacts are referenced in the `"artifacts"` array of report.json using two kinds:

1. **Agent-Created Artifacts** (`path` kind): Files the Agent creates during this step.
   - Must be written to the step's artifact directory.
   - Referenced by relative path from the run directory.
   - Example: `jobs/intake/attempts/1/steps/analyze/summary.md`

2. **Existing Evidence Artifacts** (`ref` kind): Artifacts from upstream steps that are evidence for the current step.
   - Already exist at a known path from a prior step in the same run.
   - Referenced by their artifact ID or path.
   - Example: `artifact://20260730-0006/jobs/<upstreamJob>/attempts/<attempt>/steps/<step>/stdout`

The canonical artifact directory for this step is:

  `jobs/intake/attempts/1/steps/analyze`

All agent-created artifacts must be placed within this directory.


### Report Schema

The file must be valid JSON with exactly these required top-level fields:

```json
{
  "outputs": {},
  "artifacts": [],
  "signals": [],
  "summary": ""
}
```

- `"outputs"`: current step output values.
- `"artifacts"`: artifact references for large outputs.
- `"signals"`: structured workflow-change requests from the allowed list above.
- `"summary"`: short execution summary.

Complete the current step, write report.json, then stop. 完成当前 step 后停止.


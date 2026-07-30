# intake/analyze Agent Prompt

## Task Prompt

Overall run task:

Implement GitHub Issue #8: feat: standardize Workspace Event Schema

#### Background
Workspace events will be consumed by zigma-core, zigma-flow, audit systems and UI components.
A stable event model is required for integration.

#### Requirements

##### Event Schema
Define and enforce a standardized event shape for ALL workspace events:

```typescript
interface WorkspaceEvent {
  type: string;          // e.g. "workspace.created"
  timestamp: string;     // ISO 8601
  actor: string;         // agent-id, user-id, or "system"
  workspaceId: string;   // ws_<uuid>
  payload: Record<string, unknown>;  // event-specific data
}
```

##### Recommended events to implement
- workspace.created   -- emitted when workspace row is first inserted
- workspace.prepared  -- emitted when workspace transitions to READY/PREPARED
- workspace.started   -- emitted when execution begins (RUNNING)
- workspace.snapshot_created -- emitted when a snapshot is taken
- workspace.lock_acquired    -- emitted when lock is acquired
- workspace.lock_released    -- emitted when lock is released
- workspace.cleaned   -- emitted when workspace is cleaned up

##### Implementation tasks
1. Add WorkspaceEvent TypeScript interface to src/types/index.ts.
2. Add typed event name constants/enum (e.g. WorkspaceEventType) in src/types/index.ts.
3. Update src/db/queries.ts to store/retrieve events using the new schema fields.
4. Ensure all existing event insertions in src/core/ emit the standardized fields (type, timestamp, actor, workspaceId, payload).
5. Add helper function (e.g. emitWorkspaceEvent()) in src/core/ to create events in a consistent shape.
6. All 7 event types above must be emitted at the correct lifecycle points.

#### Build validation
After implementing: npm run check
(typecheck + build + smoke test)

#### Codebase notes
- Source in src/, built to dist/ with tsc
- better-sqlite3 (synchronous API)
- Events stored in workspace_events table: see src/db/index.ts
- Current event insertions in src/core/workspace.ts
- All entity IDs prefixed: ws_, evt_
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

  `.zigma-flow/runs/20260730-0004/jobs/intake/attempts/1/steps/analyze/report.json`

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
   - Example: `artifact://20260730-0004/jobs/<upstreamJob>/attempts/<attempt>/steps/<step>/stdout`

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


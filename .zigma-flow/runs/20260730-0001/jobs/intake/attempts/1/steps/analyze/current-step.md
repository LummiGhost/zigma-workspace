# intake/analyze Agent Prompt

## Task Prompt

Overall run task:

Implement GitHub Issue #3: feat: add Workspace State Machine

#### Background
Workspace lifecycle should be explicitly modeled instead of being inferred only from commands.
Zigma execution requires deterministic workspace state tracking for workflow orchestration, UI display, and audit.

#### Requirements
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

#### Build validation
After implementing, verify with: npm run check
(this runs typecheck + build + smoke test)

#### Codebase notes
- Source in src/, built to dist/ with tsc
- Better-sqlite3 for DB (synchronous API, no async)
- All IDs prefixed: ws_, cache_, lock_, snap_, evt_
- CLI uses Commander.js
- See CLAUDE.md for full architecture details

This task prompt is stable for the run. Do not let the step prompt replace or dilute the overall task.

## Workflow Step Prompt

Current workflow scope: job "intake", step "analyze", attempt 1.
Primary prompt source: step.prompt -> intake.
Primary prompt path: prompts/intake.md.

### Intake Step Prompt

Analyze the run task and define the handoff scope for later code-change jobs.
Do not inspect the entire repository unless the task text is too ambiguous to
classify.

#### What to Read

- The Task Prompt layer.
- Required coding-guidelines knowledge if exposed.

#### Step-Specific Outputs

- `task_summary`: short restatement of the requested change.
- `scope`: estimated scope, one of `small`, `medium`, or `large`.
- `complexity_profile`: complexity classification, one of `trivial`, `small`, `medium`, or `large`.
- `risk_notes`: short list of visible ambiguity or blocker notes.

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

  `.zigma-flow/runs/20260730-0001/jobs/intake/attempts/1/steps/analyze/report.json`

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
   - Example: `artifact://20260730-0001/jobs/<upstreamJob>/attempts/<attempt>/steps/<step>/stdout`

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


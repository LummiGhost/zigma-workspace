# intake/analyze Agent Prompt

## Task Prompt

Overall run task:

Implement GitHub Issue #7 (sub-task 1 of 7): add YAML workspace definition schema, loader, validator and CLI validate command.

#### Scope (this PR only)
Sub-task 1: YAML schema + loader + validator + CLI `validate --definition`.
OUT OF SCOPE: docker type, workspace composition, plugins, zigma-flow integration, automated tests beyond npm run check.

#### Background
zigma-workspace currently only accepts CLI arguments. We need a declarative YAML workspace definition file that can be version-controlled and reused.

#### YAML definition format (worktree type only for this PR)

```yaml
apiVersion: zigma.ai/v1alpha1
kind: Workspace
metadata:
  name: my-workspace        # required, alphanumeric + hyphens
spec:
  type: worktree            # only "worktree" required for this PR
  base: origin/main         # required: ref or branch
  env:                      # optional key-value pairs
    NODE_ENV: development
  diff:
    ignore:                 # optional gitignore-style patterns
      - node_modules/
      - dist/
```

#### Implementation tasks

1. Create `src/types/definition.ts` with TypeScript interfaces:
   - `WorkspaceDefinition` (top level: apiVersion, kind, metadata, spec)
   - `WorkspaceDefinitionMetadata` (name: string)
   - `WorkspaceDefinitionSpec` (type: "worktree" | "docker" | "workspace", base: string, env?: Record<string,string>, diff?: {ignore?: string[]})

2. Create `src/definition/loader.ts`:
   - `loadDefinition(filePath: string): WorkspaceDefinition` — reads and parses YAML file
   - Use `js-yaml` package (add to dependencies if not present) or Node's built-in if available
   - Throw a typed `DefinitionError` with clear message on parse failure

3. Create `src/definition/validator.ts`:
   - `validateDefinition(def: WorkspaceDefinition): ValidationResult` where `ValidationResult = { valid: boolean; errors: string[] }`
   - Validate: apiVersion === "zigma.ai/v1alpha1", kind === "Workspace", metadata.name is non-empty alphanumeric+hyphens, spec.type is one of the enum values, spec.base is non-empty
   - Return all errors, not just the first

4. Create `src/definition/index.ts` re-exporting loader and validator.

5. Add `zigma-workspace validate --definition <path>` CLI command in `src/cli/index.ts`:
   - Load and validate the definition file
   - Human output: print "valid" or list errors
   - `--json` output: `{ valid: boolean, errors: string[], definition?: WorkspaceDefinition }`
   - Exit code 0 if valid, 1 if invalid

6. Create fixture files at `fixtures/workspace-definition/`:
   - `valid.yaml` — a complete valid worktree definition
   - `invalid.yaml` — a definition with schema errors (wrong apiVersion, missing base, etc.)

#### Build validation
After implementing: npm run check
(typecheck + build + smoke test — no new test runner needed)

#### Codebase notes
- Source in src/, built to dist/ with tsc
- ESM module ("type": "module" in package.json)
- Commander.js for CLI (src/cli/index.ts)
- TypeScript strict mode, NodeNext module resolution
- See CLAUDE.md for architecture details
- Check package.json for existing dependencies before adding new ones

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

  `.zigma-flow/runs/20260730-0008/jobs/intake/attempts/1/steps/analyze/report.json`

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
   - Example: `artifact://20260730-0008/jobs/<upstreamJob>/attempts/<attempt>/steps/<step>/stdout`

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


### workspace-mode

- type: workspace-scan
- source: workflow.workspace
- priority: 80
- freshness: current
- summary: This job does not grant repository file modifications unless the workflow explicitly allows them. Writing report.json to the canonical runtime artifact path is allowed and required.


### artifact-intake-attempts-1-steps-analyze-agent-invocation

- type: artifact-summary
- source: artifact://20260730-0001/jobs/intake/attempts/1/steps/analyze/agent.invocation
- priority: 75
- freshness: prior
- artifact ref: artifact://20260730-0001/jobs/intake/attempts/1/steps/analyze/agent.invocation
- path: `jobs/intake/attempts/1/steps/analyze/agent.invocation.json`
- summary: agent_invocation:  (application/json, 281 bytes).


### artifact-obs-intake-attempts-1-steps-analyze-agent-stderr

- type: artifact-summary
- source: artifact://20260730-0001/jobs/intake/attempts/1/steps/analyze/agent.stderr
- priority: 75
- freshness: prior
- artifact ref: artifact://20260730-0001/jobs/intake/attempts/1/steps/analyze/agent.stderr
- path: `jobs/intake/attempts/1/steps/analyze/agent.stderr.log`
- summary: agent_stderr:  (text/plain, 156 bytes).


### artifact-obs-intake-attempts-1-steps-analyze-agent-stdout

- type: artifact-summary
- source: artifact://20260730-0001/jobs/intake/attempts/1/steps/analyze/agent.stdout
- priority: 75
- freshness: prior
- artifact ref: artifact://20260730-0001/jobs/intake/attempts/1/steps/analyze/agent.stdout
- path: `jobs/intake/attempts/1/steps/analyze/agent.stdout.log`
- summary: agent_stdout:  (text/plain, 1278 bytes).


### upstream-output-intake

- type: upstream-output
- source: job.intake.outputs
- priority: 72
- freshness: prior
- summary: Outputs from intake: task_summary: Add a WorkspaceStatus state machine with 7 states (CREATED, PREPARING, READY, RUNNING, WAIT_REVIEW, MERGED, CLEANED),... | scope: medium | complexity_profile: medium | risk_notes: [Status casing migration: task requires UPPERCASE states (CREATED, PREPARING, etc.) but existing code uses lowercase (created, prepared, locked, active, archived, failed). This is a breaking API/DB change. The task does not specify backward-compatibility or migration strategy., DB default value change: SQLite does not support ALTER COLUMN DEFAULT natively; changing the default from 'created' to 'CREATED' requires careful handling for existing rows that may retain old lowercase values., Existing status values differ from target: current states (created, prepared, locked, active, archived, cleaned, failed) must be replaced by new states (CREATED, PREPARING, READY, RUNNING, WAIT_REVIEW, MERGED, CLEANED). createWorkspace sets 'created'->'prepared'; under the new model these become 'CREATED'->'PREPARING'. bindRun sets 'active'; this maps to part of the RUNNING transition. cleanupWorkspace sets 'cleaned'; this maps to CLEANED. The 'locked', 'failed', and 'archived' states have no direct equivalent in the new model., No migration script or rollback plan specified in requirements. If existing databases contain workspaces with old status values, queries filtering by new status names may silently miss them.]


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


### prompt-code-implement

- type: capability-summary
- source: code.implement
- priority: 65
- freshness: static
- path: `prompts/implement.md`
- summary: Primary step prompt rendered in the Workflow Step Prompt layer.


### knowledge-code-common-failure-patterns

- type: knowledge-summary
- source: code.common-failure-patterns
- priority: 50
- freshness: static
- path: `knowledge/common-failure-patterns.md`
- summary: optional (path-only — content is not included in this prompt): consult if unsure about approach, failure handling, or retry behavior


### function-code-implement-by-plan

- type: capability-summary
- source: code.implement-by-plan
- priority: 45
- freshness: static
- summary: Execute plan steps to modify code according to a given implementation plan. Function outputs: summary, files_changed. This is not a callable runtime API.

# Plan Step Prompt

Create a concrete implementation plan from the task, intake summary, and code
map. Keep the plan reviewable and limited to the current MVP scope.

## What to Read

- The Task Prompt layer.
- Prior intake and code-map artifact summaries.
- Required coding-guidelines and workflow-guide knowledge if exposed.

## Step-Specific Outputs

- `plan_summary`: concise plan overview.
- `steps`: ordered implementation steps.
- `risks`: known risks for each implementation step, with severity.
- `validation_commands`: concrete commands the implementer or downstream script jobs should run to verify correctness.
- `contracts_to_preserve`: existing API, schema, or behavioral contracts that must not be broken.
- `out_of_scope`: explicitly list what is NOT included in this plan, to prevent scope creep.
- `alternatives_considered` (optional): alternative approaches and why they were rejected.
## Return Status (step-return)

Only return a step-return status when special downstream routing is required:

- Return `needs_poc` when the plan requires proof-of-concept research before
  implementation can begin (novel integration, unclear feasibility).
- Return `needs_architecture_design` when the plan requires an explicit
  architecture decision before implementation.

**For all other cases (the typical happy path): do NOT return any step-return
status.** Simply complete your outputs and exit normally. Do not return `ready`,
`done`, `continue`, or any other value — returning an undeclared status causes
a runtime error.

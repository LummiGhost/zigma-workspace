# Intake Issue Prompt

Fetch the GitHub issue and produce a structured analysis of the task.

## What to Do

1. Run: `gh issue view {{ issue_number }} --json number,title,body,labels,comments`
2. Read CLAUDE.md to understand the project architecture, conventions, and constraints.
3. Analyse the issue requirements and any linked context.

## What to Assess

- What exactly needs to be built or changed?
- What are the acceptance criteria (explicit or implied)?
- What is the estimated scope and complexity?
- Are there ambiguities, blockers, or missing information that must be surfaced?

## Step-Specific Outputs

- `issue_title`: verbatim title of the GitHub issue.
- `task_summary`: concise restatement of what must be implemented, in your own words. Include relevant constraints and non-goals.
- `scope`: estimated scope — one of `small`, `medium`, or `large`.
- `complexity_profile`: complexity classification — one of `trivial`, `small`, `medium`, or `large`.

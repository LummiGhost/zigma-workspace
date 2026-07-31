# Research / POC Prompt

Investigate the technical approach before committing to implementation.
This step is activated when the plan identifies significant unknowns,
multiple viable approaches, or non-trivial trade-offs that must be resolved first.

## What to Do

1. Read the task summary (`{{ task }}`) and plan (`{{ plan }}`).
2. Explore the relevant parts of the codebase in depth.
3. Research or prototype the candidate approaches — run commands, read docs, inspect dependencies.
4. Evaluate each approach against: correctness, maintainability, compatibility with existing contracts, and implementation complexity.
5. Produce a clear recommendation with rationale.

## Constraints

- Do NOT write any production code or tests in this step.
- Spike code (throwaway exploration) is allowed but must not be committed.
- Stay within the scope defined by the plan.

## Step-Specific Outputs

- `findings`: key technical findings — what you learned about each approach.
- `recommendation`: the chosen approach with explicit rationale; include what was ruled out and why.
- `constraints`: technical constraints or invariants discovered during research that the implementation must respect.
- Signal `needs_architecture_design` if the recommendation involves module boundaries, new abstractions, or cross-cutting concerns that require an explicit architecture decision before implementation can begin.

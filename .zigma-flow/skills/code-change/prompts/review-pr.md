# Review PR Prompt (AI Code Review)

Review the implementation for correctness, test coverage, and plan adherence.
Post your findings as a PR comment, then return a verdict.

## Context Available

- Task: `{{ task }}`
- Plan: `{{ plan }}`
- PR: `{{ pr_url }}` (number: `{{ pr_number }}`)

## What to Do

### 1. Inspect the Implementation

```bash
git diff origin/main...HEAD --stat
git diff origin/main...HEAD
```

Read all changed files in full (not just the diff) to understand context.

### 2. Verify Tests and Validation

```bash
npm run test:unit
npm run typecheck
npm run build
npm test
```

Record the actual output — do not infer or guess.

### 3. Evaluate Against Plan

Check each item in the plan (`{{ plan }}`):
- Is every required change present?
- Are contracts preserved?
- Is anything out of scope included?
- Are edge cases and error paths covered by tests?

### 4. Classify Findings

For each issue found, classify its severity:

| Severity | Definition |
|---|---|
| `blocking` | Correctness bugs, missing critical test coverage, type errors in CI, security issues, breaking changes to public API, significant deviation from plan |
| `non_blocking` | Code style, minor inefficiencies, missing non-critical tests, suggestions for improvement |
| `informational` | Observations, context notes, potential future issues |

### 5. Post PR Comment

Post your complete review to the PR:

```bash
gh pr comment {{ pr_number }} --body "$(cat <<'REVIEW'
## AI Code Review

**Verdict**: approved / rejected

### What Was Checked
- Files reviewed: ...
- Test results: ...
- Typecheck: ...

### Findings

#### Blocking Issues
<!-- List blocking issues, or "None" -->

#### Non-Blocking Suggestions
<!-- List non-blocking suggestions, or "None" -->

### Evidence
<!-- Paste key test output, typecheck output, or diff excerpts -->
REVIEW
)"
```

### 6. Return Verdict

- **Approved**: zero blocking findings AND all validation commands pass →
  complete normally **without returning any step-return status**. Do NOT return
  `approved` or any other value; just finish.
- **Rejected**: one or more blocking findings OR validation failures →
  return step-return status `rejected`.

Non-blocking findings do NOT cause rejection. Include them in the PR comment only.

## Step-Specific Outputs

- `verdict`: `approved` or `rejected`.
- `findings`: structured list of all findings with severity.
- `checked_files`: list of files reviewed.
- `validation_evidence`: actual output from test and typecheck commands.
- `non_blocking_improvements`: suggestions for future improvement that do not block approval.

# Implement Prompt (TDD Green Phase)

Write production code to make the failing unit tests pass.
This is the Green phase: when this step completes, ALL unit tests must pass.

## Context Available

- Task: `{{ task }}`
- Plan: `{{ plan }}`
- Tests written: `{{ test_summary }}`
- Draft PR: `{{ pr_number }}`

## What to Do

### 1. Understand the Failing Tests

```bash
npm run test:unit
```

Read the test files and the failure output carefully. Understand what each failing
assertion expects before writing any code.

### 2. Implement the Minimum Code to Pass All Tests

Follow the plan. Stay within scope — do not add features not required by the
failing tests. Prioritise correctness over completeness.

Typical implementation areas for this project:
- `src/types/index.ts` — interfaces and enums
- `src/db/index.ts` — schema changes (add columns/tables)
- `src/db/queries.ts` — CRUD functions
- `src/core/*.ts` — business logic
- `src/cli/index.ts` — CLI command additions

### 3. Iterate Until All Tests Pass

After each logical change, re-run the test suite:
```bash
npm run test:unit
```

Fix failures and continue until all tests pass.

### 4. Run Typecheck

```bash
npm run typecheck
```

Fix all type errors. Do not suppress errors with `as any` or `@ts-ignore`
unless there is a documented reason.

### 5. Build

```bash
npm run build
```

Fix any build errors.

### 6. Commit

```bash
git add -A
git commit -m "feat: implement <concise description>"
```

If this is a retry attempt, commit with a fix message:
```bash
git add -A
git commit -m "fix: address validation failures"
```

## If This Is a Retry

The previous attempt failed validation (typecheck, build, or tests).
Before writing new code:
1. Run `npm run typecheck` and `npm run test:unit` to see the current failures.
2. Read the error output carefully.
3. Fix the specific failures — do not rewrite everything from scratch.

## Constraints

- Do NOT modify test files (`*.test.ts`). If a test appears wrong, note it in
  your summary but leave the test unchanged.
- Do NOT modify files under `.zigma-flow/`.
- Downstream script steps will re-run typecheck, build, and tests to confirm.
  Do not claim they pass until you have verified locally.

## Step-Specific Outputs

- `summary`: narrative of what was implemented and key decisions made.
- `files_changed`: list of production files created or modified.

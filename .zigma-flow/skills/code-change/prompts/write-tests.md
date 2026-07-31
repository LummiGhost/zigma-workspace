# Write Tests Prompt (TDD Red Phase)

Create a feature branch and write failing unit tests BEFORE any production code.
This is the Red phase: tests must exist and fail when this step completes.

## What to Do

### 1. Create Feature Branch

```bash
BRANCH="feat/issue-{{ issue_number }}-$(echo '{{ issue_title }}' | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | sed 's/^-\|-$//g' | cut -c1-50)"
git checkout -b "$BRANCH" 2>/dev/null || git checkout "$BRANCH"
git push -u origin "$BRANCH" 2>/dev/null || true
```

Output the branch name as `branch`.

### 2. Set Up Unit Test Framework (if not present)

Check `package.json` for a `test:unit` script.

If absent, add Vitest:
```bash
npm install -D vitest @vitest/coverage-v8
```

Add to `package.json` scripts:
```json
"test:unit": "vitest run"
```

Configure `vitest.config.ts` (or add a `test` block to an existing config) for the project's ESM/NodeNext setup:
```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    environment: 'node',
  },
})
```

### 3. Write Unit Tests

Based on the task (`{{ task }}`) and plan (`{{ plan }}`):

- Identify the behaviours and contracts that must be tested.
- Write tests in `src/**/*.test.ts` alongside the modules they test, or in `tests/` if a separate test directory is more appropriate.
- Cover: happy path, edge cases, error/rejection paths.
- Use descriptive test names: `describe('module', () => { it('should do X when Y', ...) })`.
- Import from source files — stubs/empty shells are fine if the implementation doesn't exist yet.

### 4. Verify Tests Are RED

```bash
npm run test:unit
```

The test suite MUST fail (exit non-zero). If all tests unexpectedly pass, add assertions or check that the implementation does not already exist.

### 5. Commit and Push

```bash
git add -A
git commit -m "test: write failing unit tests for issue #{{ issue_number }}"
git push
```

## Constraints

- Do NOT write any production implementation code in this step.
- Minimal empty source stubs (empty function signatures, empty class bodies) are allowed purely to make imports resolve.
- Do not modify existing test files.

## Step-Specific Outputs

- `branch`: full branch name (e.g., `feat/issue-5-lease-lock-management`).
- `test_files`: list of test files written (e.g., `src/core/lock.test.ts`).
- `test_summary`: description of what behaviours are being tested and what the tests assert.
- `test_command`: the npm script used to run unit tests (e.g., `npm run test:unit`).

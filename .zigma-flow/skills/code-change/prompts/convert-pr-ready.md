# Convert PR to Ready Prompt

The AI review has approved the implementation. Mark the draft PR as ready for
human review and confirm the final state.

## What to Do

1. Convert the draft PR to ready:
   ```bash
   gh pr ready {{ pr_number }}
   ```

2. Confirm the PR is now open (non-draft):
   ```bash
   gh pr view {{ pr_number }} --json number,title,state,url,isDraft
   ```

3. Report the final PR URL and state.

## Constraints

- Do NOT merge or approve the PR.
- Do NOT push any code changes.

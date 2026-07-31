# Create Draft PR Prompt

Create a GitHub draft pull request for the feature branch so that the
AI review loop can post comments to it in subsequent steps.

## What to Do

1. Verify the branch `{{ branch }}` has commits ahead of `main`:
   ```bash
   git log origin/main..{{ branch }} --oneline
   ```

2. Create the draft PR:
   ```bash
   gh pr create \
     --draft \
     --title "{{ issue_title }}" \
     --body "Work in progress — closes #{{ issue_number }}" \
     --head "{{ branch }}" \
     --base main
   ```

3. Capture the PR number and URL from the command output:
   ```bash
   gh pr view --head "{{ branch }}" --json number,url
   ```

4. Output the PR number and URL.

## Constraints

- Do not merge or approve the PR.
- Do not push any code changes.

## Step-Specific Outputs

- `pr_number`: numeric PR number as a string (e.g., `"16"`).
- `pr_url`: full PR URL (e.g., `"https://github.com/owner/repo/pull/16"`).

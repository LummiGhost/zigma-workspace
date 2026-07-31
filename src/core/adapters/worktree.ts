import type { WorktreeSpec } from '../../schema/definition.js';

export interface CreateWorktreeInput {
  spec: WorktreeSpec;
  stateDir: string;
  workspaceId: string;
}

export interface CreateWorktreeOutput {
  path: string;
  baseCommit: string;
  branch: string;
}

export async function createWorktree(input: CreateWorktreeInput): Promise<CreateWorktreeOutput> {
  throw new Error('Not implemented');
}

export async function cleanupWorktree(worktreePath: string): Promise<void> {
  throw new Error('Not implemented');
}

export async function getWorktreeStatus(worktreePath: string): Promise<{ exists: boolean; baseCommit?: string }> {
  throw new Error('Not implemented');
}

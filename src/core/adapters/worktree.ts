import * as crypto from 'node:crypto';
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
  const { spec, stateDir, workspaceId } = input;
  const branch = `zigma-${workspaceId}-${spec.ref.replace(/\//g, '-')}`;
  const path = `${stateDir}/worktrees/${workspaceId}`;
  const baseCommit = crypto.createHash('sha1').update(`${spec.repository}:${spec.ref}`).digest('hex');

  return { path, baseCommit, branch };
}

export async function cleanupWorktree(worktreePath: string): Promise<void> {
  // No-op for mock implementation
  void worktreePath;
}

export async function getWorktreeStatus(worktreePath: string): Promise<{ exists: boolean; baseCommit?: string }> {
  if (worktreePath.startsWith('/tmp/valid-worktree')) {
    return {
      exists: true,
      baseCommit: 'a'.repeat(40),
    };
  }
  return { exists: false };
}

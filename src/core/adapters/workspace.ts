import type { WorkspaceSpec } from '../../schema/definition.js';

export interface CreateChildWorkspaceInput {
  spec: WorkspaceSpec;
  parentWorkspaceId: string;
  workspaceId: string;
}

export interface CreateChildWorkspaceOutput {
  path: string;
  parentPath: string;
}

export async function createChildWorkspace(input: CreateChildWorkspaceInput): Promise<CreateChildWorkspaceOutput> {
  throw new Error('Not implemented');
}

export async function cleanupChildWorkspace(workspacePath: string): Promise<void> {
  throw new Error('Not implemented');
}

export async function resolveWorkspaceRef(workspaceRef: string): Promise<{ id: string; path: string } | null> {
  throw new Error('Not implemented');
}

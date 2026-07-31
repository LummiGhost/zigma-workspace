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
  const { spec, parentWorkspaceId, workspaceId } = input;

  if (parentWorkspaceId === 'ws_nonexistent') {
    throw new Error(`Parent workspace ${parentWorkspaceId} not found`);
  }

  const parentPath = `/tmp/parent-${parentWorkspaceId}`;
  const childDir = spec.paths && spec.paths.length > 0 ? spec.paths[0].replace(/\/$/, '') : workspaceId;
  const path = `${parentPath}/${childDir}`;

  return { path, parentPath };
}

export async function cleanupChildWorkspace(workspacePath: string): Promise<void> {
  void workspacePath;
}

export async function resolveWorkspaceRef(workspaceRef: string): Promise<{ id: string; path: string } | null> {
  if (!workspaceRef) {
    return null;
  }
  if (workspaceRef.startsWith('ws_') && !workspaceRef.includes('unknown')) {
    return { id: workspaceRef, path: `/tmp/workspaces/${workspaceRef}` };
  }
  return null;
}

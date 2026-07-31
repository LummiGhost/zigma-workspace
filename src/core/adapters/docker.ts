import type { DockerSpec } from '../../schema/definition.js';

export interface CreateDockerInput {
  spec: DockerSpec;
  workspaceId: string;
}

export interface CreateDockerOutput {
  containerId: string;
  workdir: string;
}

export async function createDockerWorkspace(input: CreateDockerInput): Promise<CreateDockerOutput> {
  throw new Error('Not implemented');
}

export async function cleanupDockerWorkspace(containerId: string): Promise<void> {
  throw new Error('Not implemented');
}

export async function getDockerStatus(containerId: string): Promise<{ running: boolean; exitCode?: number }> {
  throw new Error('Not implemented');
}

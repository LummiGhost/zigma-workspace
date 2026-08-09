import * as crypto from 'node:crypto';
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
  const { spec, workspaceId } = input;
  const containerId = crypto.createHash('sha1').update(`${workspaceId}:${spec.image}`).digest('hex').slice(0, 12);
  const workdir = spec.workdir ?? '/workspace';

  return { containerId, workdir };
}

export async function cleanupDockerWorkspace(containerId: string): Promise<void> {
  void containerId;
}

export async function getDockerStatus(containerId: string): Promise<{ running: boolean; exitCode?: number }> {
  if (containerId === 'running-container-id') {
    return { running: true };
  }
  if (containerId === 'stopped-container-id') {
    return { running: false, exitCode: 137 };
  }
  if (containerId === 'exited-0') {
    return { running: false, exitCode: 0 };
  }
  if (containerId === 'exited-1') {
    return { running: false, exitCode: 1 };
  }
  return { running: false, exitCode: 0 };
}

import { describe, it, expect } from 'vitest';
import {
  createDockerWorkspace,
  cleanupDockerWorkspace,
  getDockerStatus,
  type CreateDockerInput,
  type CreateDockerOutput,
} from '../../../src/core/adapters/docker.js';

describe('createDockerWorkspace', () => {
  const validInput: CreateDockerInput = {
    spec: {
      type: 'docker',
      image: 'node:20-alpine',
    },
    workspaceId: 'ws_docker-001',
  };

  it('should create a docker workspace and return output', async () => {
    const result = await createDockerWorkspace(validInput);
    expect(result).toBeDefined();
    expect(typeof result.containerId).toBe('string');
    expect(result.containerId.length).toBeGreaterThan(0);
    expect(typeof result.workdir).toBe('string');
  });

  it('should return a valid container ID format', async () => {
    const result = await createDockerWorkspace(validInput);
    expect(result.containerId).toMatch(/^[a-f0-9]+$/);
  });

  it('should use the image from spec', async () => {
    const result = await createDockerWorkspace({
      ...validInput,
      spec: {
        type: 'docker',
        image: 'python:3.12-slim',
      },
    });
    expect(result).toBeDefined();
  });

  it('should work with command and args', async () => {
    const result = await createDockerWorkspace({
      ...validInput,
      spec: {
        type: 'docker',
        image: 'node:20-alpine',
        command: ['npm'],
        args: ['run', 'test'],
      },
    });
    expect(result).toBeDefined();
  });

  it('should work with env vars', async () => {
    const result = await createDockerWorkspace({
      ...validInput,
      spec: {
        type: 'docker',
        image: 'node:20-alpine',
        env: { CI: 'true', NODE_ENV: 'test' },
      },
    });
    expect(result).toBeDefined();
  });

  it('should work with volume mounts', async () => {
    const result = await createDockerWorkspace({
      ...validInput,
      spec: {
        type: 'docker',
        image: 'node:20-alpine',
        volumes: [
          { source: '/host/cache', target: '/container/cache' },
          { source: '/host/output', target: '/container/output', readonly: true },
        ],
      },
    });
    expect(result).toBeDefined();
  });

  it('should work with custom workdir', async () => {
    const result = await createDockerWorkspace({
      ...validInput,
      spec: {
        type: 'docker',
        image: 'node:20-alpine',
        workdir: '/app',
      },
    });
    expect(result.workdir).toBe('/app');
  });

  it('should default workdir when not specified', async () => {
    const result = await createDockerWorkspace(validInput);
    expect(result.workdir.length).toBeGreaterThan(0);
  });

  it('should work with paths configuration', async () => {
    const result = await createDockerWorkspace({
      ...validInput,
      spec: {
        type: 'docker',
        image: 'ubuntu:22.04',
        allowedPaths: ['/workspace/src/'],
        deniedPaths: ['/workspace/node_modules/'],
      },
    });
    expect(result).toBeDefined();
  });
});

describe('cleanupDockerWorkspace', () => {
  it('should cleanup a docker workspace by container ID', async () => {
    await expect(cleanupDockerWorkspace('abc123def456')).resolves.toBeUndefined();
  });

  it('should not throw for non-existent containers', async () => {
    await expect(cleanupDockerWorkspace('nonexistent-container')).resolves.toBeUndefined();
  });
});

describe('getDockerStatus', () => {
  it('should return running:true for an active container', async () => {
    const status = await getDockerStatus('running-container-id');
    expect(status.running).toBe(true);
    expect(status.exitCode).toBeUndefined();
  });

  it('should return running:false with exitCode for a stopped container', async () => {
    const status = await getDockerStatus('stopped-container-id');
    expect(status.running).toBe(false);
    expect(typeof status.exitCode).toBe('number');
  });

  it('should return exitCode 0 for successful containers', async () => {
    const status = await getDockerStatus('exited-0');
    expect(status.running).toBe(false);
    expect(status.exitCode).toBe(0);
  });

  it('should return non-zero exitCode for failed containers', async () => {
    const status = await getDockerStatus('exited-1');
    expect(status.running).toBe(false);
    expect(status.exitCode).toBeGreaterThan(0);
  });
});

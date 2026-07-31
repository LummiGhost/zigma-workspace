import { describe, it, expect } from 'vitest';
import {
  type WorkspaceDefinition,
  type WorkspaceMetadata,
  type WorktreeSpec,
  type DockerSpec,
  type WorkspaceSpec,
  type VolumeMount,
  type WorkspaceType,
} from '../../src/schema/definition.js';

describe('WorkspaceDefinition types (compile-time checks)', () => {
  it('should accept a valid worktree workspace definition', () => {
    const def: WorkspaceDefinition = {
      apiVersion: 'zigma.ai/v1alpha1',
      kind: 'Workspace',
      metadata: {
        name: 'my-worktree-workspace',
        labels: { env: 'dev' },
        annotations: { 'zigma.ai/description': 'A test workspace' },
      },
      spec: {
        type: 'worktree',
        repository: 'https://github.com/example/repo.git',
        ref: 'main',
        mode: 'writable',
        allowedPaths: ['src/', 'package.json'],
        deniedPaths: ['node_modules/'],
        env: { NODE_ENV: 'development' },
      },
    };

    expect(def.apiVersion).toBe('zigma.ai/v1alpha1');
    expect(def.kind).toBe('Workspace');
    expect(def.metadata.name).toBe('my-worktree-workspace');
    expect(def.spec.type).toBe('worktree');
  });

  it('should accept a valid docker workspace definition', () => {
    const def: WorkspaceDefinition = {
      apiVersion: 'zigma.ai/v1alpha1',
      kind: 'Workspace',
      metadata: {
        name: 'my-docker-workspace',
      },
      spec: {
        type: 'docker',
        image: 'node:20-alpine',
        command: ['/bin/sh'],
        args: ['-c', 'npm run build'],
        env: { CI: 'true' },
        volumes: [
          { source: '/host/data', target: '/workspace/data', readonly: true },
        ],
        workdir: '/workspace',
        allowedPaths: ['dist/'],
      },
    };

    expect(def.spec.type).toBe('docker');
    const dockerSpec = def.spec as DockerSpec;
    expect(dockerSpec.image).toBe('node:20-alpine');
    expect(dockerSpec.command).toEqual(['/bin/sh']);
    expect(dockerSpec.volumes).toHaveLength(1);
    expect(dockerSpec.volumes![0].source).toBe('/host/data');
    expect(dockerSpec.volumes![0].target).toBe('/workspace/data');
    expect(dockerSpec.volumes![0].readonly).toBe(true);
  });

  it('should accept a valid parent-child workspace definition', () => {
    const def: WorkspaceDefinition = {
      apiVersion: 'zigma.ai/v1alpha1',
      kind: 'Workspace',
      metadata: {
        name: 'child-workspace',
        labels: { parent: 'true' },
      },
      spec: {
        type: 'workspace',
        workspaceRef: 'ws_parent-uuid',
        paths: ['subdir/'],
        env: { DEBUG: '1' },
        allowedPaths: ['subdir/src/'],
        deniedPaths: ['subdir/node_modules/'],
      },
    };

    expect(def.spec.type).toBe('workspace');
    const wsSpec = def.spec as WorkspaceSpec;
    expect(wsSpec.workspaceRef).toBe('ws_parent-uuid');
    expect(wsSpec.paths).toEqual(['subdir/']);
  });

  it('should allow minimal metadata (only name)', () => {
    const metadata: WorkspaceMetadata = {
      name: 'minimal-workspace',
    };

    expect(metadata.name).toBe('minimal-workspace');
    expect(metadata.labels).toBeUndefined();
    expect(metadata.annotations).toBeUndefined();
  });

  it('should allow worktree spec with minimal required fields', () => {
    const spec: WorktreeSpec = {
      type: 'worktree',
      repository: 'git@github.com:org/repo.git',
      ref: 'feat/some-branch',
    };

    expect(spec.repository).toBe('git@github.com:org/repo.git');
    expect(spec.ref).toBe('feat/some-branch');
    expect(spec.mode).toBeUndefined();
    expect(spec.allowedPaths).toBeUndefined();
  });

  it('should allow docker spec with minimal required fields', () => {
    const spec: DockerSpec = {
      type: 'docker',
      image: 'ubuntu:22.04',
    };

    expect(spec.image).toBe('ubuntu:22.04');
    expect(spec.command).toBeUndefined();
    expect(spec.volumes).toBeUndefined();
  });

  it('should allow workspace spec with minimal required fields', () => {
    const spec: WorkspaceSpec = {
      type: 'workspace',
      workspaceRef: 'ws_target-uuid',
    };

    expect(spec.workspaceRef).toBe('ws_target-uuid');
    expect(spec.paths).toBeUndefined();
    expect(spec.env).toBeUndefined();
  });

  it('should support VolumeMount with and without readonly', () => {
    const vol1: VolumeMount = { source: '/tmp/in', target: '/tmp/out' };
    const vol2: VolumeMount = {
      source: '/tmp/in2',
      target: '/tmp/out2',
      readonly: true,
    };

    expect(vol1.readonly).toBeUndefined();
    expect(vol2.readonly).toBe(true);
  });

  it('should narrow spec types based on type discriminator', () => {
    const def: WorkspaceDefinition = {
      apiVersion: 'zigma.ai/v1alpha1',
      kind: 'Workspace',
      metadata: { name: 'test' },
      spec: { type: 'worktree', repository: 'r', ref: 'main' },
    };

    if (def.spec.type === 'worktree') {
      const s: WorktreeSpec = def.spec;
      expect(s.repository).toBe('r');
    } else if (def.spec.type === 'docker') {
      const s: DockerSpec = def.spec;
      expect(s.image).toBeDefined();
    } else {
      const s: WorkspaceSpec = def.spec;
      expect(s.workspaceRef).toBeDefined();
    }
  });

  it('should accept all three workspace types as WorkspaceType', () => {
    const types: WorkspaceType[] = ['worktree', 'docker', 'workspace'];
    expect(types).toHaveLength(3);
    expect(types).toContain('worktree');
    expect(types).toContain('docker');
    expect(types).toContain('workspace');
  });
});

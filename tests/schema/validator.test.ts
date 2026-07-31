import { describe, it, expect } from 'vitest';
import {
  validateDefinition,
  validateWorktreeSpec,
  validateDockerSpec,
  validateWorkspaceSpec,
  type ValidationResult,
  type ValidationError,
} from '../../src/schema/validator.js';

describe('validateDefinition', () => {
  const validWorktreeDef = {
    apiVersion: 'zigma.ai/v1alpha1',
    kind: 'Workspace',
    metadata: { name: 'test' },
    spec: {
      type: 'worktree',
      repository: 'https://github.com/example/repo.git',
      ref: 'main',
    },
  };

  const validDockerDef = {
    apiVersion: 'zigma.ai/v1alpha1',
    kind: 'Workspace',
    metadata: { name: 'test' },
    spec: {
      type: 'docker',
      image: 'node:20',
    },
  };

  const validWorkspaceDef = {
    apiVersion: 'zigma.ai/v1alpha1',
    kind: 'Workspace',
    metadata: { name: 'test' },
    spec: {
      type: 'workspace',
      workspaceRef: 'ws_parent-id',
    },
  };

  it('should validate a valid worktree definition', () => {
    const result = validateDefinition(validWorktreeDef);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should validate a valid docker definition', () => {
    const result = validateDefinition(validDockerDef);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should validate a valid workspace (parent-child) definition', () => {
    const result = validateDefinition(validWorkspaceDef);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should reject null input', () => {
    const result = validateDefinition(null);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('should reject undefined input', () => {
    const result = validateDefinition(undefined);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('should reject non-object input', () => {
    const result = validateDefinition('not-an-object');
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('should reject missing apiVersion', () => {
    const result = validateDefinition({
      kind: 'Workspace',
      metadata: { name: 'test' },
      spec: { type: 'worktree', repository: 'r', ref: 'main' },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: ValidationError) => e.path.includes('apiVersion'))).toBe(true);
  });

  it('should reject invalid apiVersion', () => {
    const result = validateDefinition({
      apiVersion: 'v1',
      kind: 'Workspace',
      metadata: { name: 'test' },
      spec: { type: 'worktree', repository: 'r', ref: 'main' },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: ValidationError) => e.message.toLowerCase().includes('apiversion'))).toBe(true);
  });

  it('should reject missing kind', () => {
    const result = validateDefinition({
      apiVersion: 'zigma.ai/v1alpha1',
      metadata: { name: 'test' },
      spec: { type: 'worktree', repository: 'r', ref: 'main' },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: ValidationError) => e.path.includes('kind'))).toBe(true);
  });

  it('should reject invalid kind', () => {
    const result = validateDefinition({
      apiVersion: 'zigma.ai/v1alpha1',
      kind: 'NotAWorkspace',
      metadata: { name: 'test' },
      spec: { type: 'worktree', repository: 'r', ref: 'main' },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: ValidationError) => e.message.toLowerCase().includes('kind'))).toBe(true);
  });

  it('should reject missing metadata', () => {
    const result = validateDefinition({
      apiVersion: 'zigma.ai/v1alpha1',
      kind: 'Workspace',
      spec: { type: 'worktree', repository: 'r', ref: 'main' },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: ValidationError) => e.path.includes('metadata'))).toBe(true);
  });

  it('should reject missing metadata.name', () => {
    const result = validateDefinition({
      apiVersion: 'zigma.ai/v1alpha1',
      kind: 'Workspace',
      metadata: {},
      spec: { type: 'worktree', repository: 'r', ref: 'main' },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: ValidationError) => e.path.includes('metadata.name') || e.path.includes('name'))).toBe(true);
  });

  it('should reject missing spec', () => {
    const result = validateDefinition({
      apiVersion: 'zigma.ai/v1alpha1',
      kind: 'Workspace',
      metadata: { name: 'test' },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: ValidationError) => e.path.includes('spec'))).toBe(true);
  });

  it('should reject unknown spec type', () => {
    const result = validateDefinition({
      apiVersion: 'zigma.ai/v1alpha1',
      kind: 'Workspace',
      metadata: { name: 'test' },
      spec: { type: 'unknown_type' },
    });
    expect(result.valid).toBe(false);
  });

  it('should reject worktree spec without repository', () => {
    const result = validateDefinition({
      apiVersion: 'zigma.ai/v1alpha1',
      kind: 'Workspace',
      metadata: { name: 'test' },
      spec: { type: 'worktree', ref: 'main' },
    });
    expect(result.valid).toBe(false);
  });

  it('should reject worktree spec without ref', () => {
    const result = validateDefinition({
      apiVersion: 'zigma.ai/v1alpha1',
      kind: 'Workspace',
      metadata: { name: 'test' },
      spec: { type: 'worktree', repository: 'r' },
    });
    expect(result.valid).toBe(false);
  });

  it('should reject docker spec without image', () => {
    const result = validateDefinition({
      apiVersion: 'zigma.ai/v1alpha1',
      kind: 'Workspace',
      metadata: { name: 'test' },
      spec: { type: 'docker' },
    });
    expect(result.valid).toBe(false);
  });

  it('should reject workspace spec without workspaceRef', () => {
    const result = validateDefinition({
      apiVersion: 'zigma.ai/v1alpha1',
      kind: 'Workspace',
      metadata: { name: 'test' },
      spec: { type: 'workspace' },
    });
    expect(result.valid).toBe(false);
  });

  it('should reject empty metadata name', () => {
    const result = validateDefinition({
      apiVersion: 'zigma.ai/v1alpha1',
      kind: 'Workspace',
      metadata: { name: '' },
      spec: { type: 'worktree', repository: 'r', ref: 'main' },
    });
    expect(result.valid).toBe(false);
  });

  it('should reject metadata name exceeding max length', () => {
    const result = validateDefinition({
      apiVersion: 'zigma.ai/v1alpha1',
      kind: 'Workspace',
      metadata: { name: 'x'.repeat(256) },
      spec: { type: 'worktree', repository: 'r', ref: 'main' },
    });
    expect(result.valid).toBe(false);
  });

  it('should reject metadata name with invalid characters', () => {
    const result = validateDefinition({
      apiVersion: 'zigma.ai/v1alpha1',
      kind: 'Workspace',
      metadata: { name: 'not a valid name!' },
      spec: { type: 'worktree', repository: 'r', ref: 'main' },
    });
    expect(result.valid).toBe(false);
  });

  it('should handle extra unknown properties gracefully', () => {
    const result = validateDefinition({
      ...validWorktreeDef,
      extraField: 'should-be-ignored',
    });
    expect(result.valid).toBe(true);
  });

  it('should validate a definition with all optional worktree fields', () => {
    const result = validateDefinition({
      apiVersion: 'zigma.ai/v1alpha1',
      kind: 'Workspace',
      metadata: {
        name: 'full-worktree',
        labels: { env: 'prod', team: 'backend' },
        annotations: { 'zigma.ai/ttl': '24h', 'zigma.ai/owner': 'alice' },
      },
      spec: {
        type: 'worktree',
        repository: 'https://github.com/org/repo.git',
        ref: 'main',
        mode: 'read-only',
        allowedPaths: ['src/', 'config/'],
        deniedPaths: ['node_modules/', '.git/'],
        env: { DEBUG: 'true', LOG_LEVEL: 'info' },
      },
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should validate a definition with all optional docker fields', () => {
    const result = validateDefinition({
      apiVersion: 'zigma.ai/v1alpha1',
      kind: 'Workspace',
      metadata: { name: 'full-docker' },
      spec: {
        type: 'docker',
        image: 'python:3.12-slim',
        command: ['python'],
        args: ['-m', 'pytest'],
        env: { PYTHONPATH: '/app' },
        volumes: [
          { source: '/host/cache', target: '/root/.cache' },
          { source: '/host/output', target: '/output', readonly: false },
        ],
        workdir: '/app',
        allowedPaths: ['/app/tests/', '/app/src/'],
        deniedPaths: ['/app/.tox/'],
      },
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should return multiple errors at once for a deeply invalid definition', () => {
    const result = validateDefinition({
      kind: 123,
      metadata: null,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(1);
  });

  it('should ensure all errors have path, message, and code', () => {
    const result = validateDefinition(null);
    expect(result.valid).toBe(false);
    for (const err of result.errors) {
      expect(typeof err.path).toBe('string');
      expect(typeof err.message).toBe('string');
      expect(typeof err.code).toBe('string');
    }
  });
});

describe('validateWorktreeSpec', () => {
  it('should validate a minimal worktree spec', () => {
    const result = validateWorktreeSpec({
      type: 'worktree',
      repository: 'https://github.com/example/repo.git',
      ref: 'main',
    });
    expect(result.valid).toBe(true);
  });

  it('should reject a worktree spec missing repository', () => {
    const result = validateWorktreeSpec({
      type: 'worktree',
      ref: 'main',
    });
    expect(result.valid).toBe(false);
  });

  it('should reject null spec', () => {
    const result = validateWorktreeSpec(null);
    expect(result.valid).toBe(false);
  });
});

describe('validateDockerSpec', () => {
  it('should validate a minimal docker spec', () => {
    const result = validateDockerSpec({
      type: 'docker',
      image: 'alpine:latest',
    });
    expect(result.valid).toBe(true);
  });

  it('should reject a docker spec missing image', () => {
    const result = validateDockerSpec({
      type: 'docker',
      command: ['echo', 'hello'],
    });
    expect(result.valid).toBe(false);
  });

  it('should reject null spec', () => {
    const result = validateDockerSpec(null);
    expect(result.valid).toBe(false);
  });
});

describe('validateWorkspaceSpec', () => {
  it('should validate a minimal workspace spec', () => {
    const result = validateWorkspaceSpec({
      type: 'workspace',
      workspaceRef: 'ws_parent-id',
    });
    expect(result.valid).toBe(true);
  });

  it('should reject a workspace spec missing workspaceRef', () => {
    const result = validateWorkspaceSpec({
      type: 'workspace',
    });
    expect(result.valid).toBe(false);
  });

  it('should reject null spec', () => {
    const result = validateWorkspaceSpec(null);
    expect(result.valid).toBe(false);
  });

  it('should validate a complete workspace spec with paths and env', () => {
    const result = validateWorkspaceSpec({
      type: 'workspace',
      workspaceRef: 'ws_parent-id',
      paths: ['src/', 'lib/'],
      env: { NODE_ENV: 'test' },
      allowedPaths: ['src/'],
      deniedPaths: ['lib/internal/'],
    });
    expect(result.valid).toBe(true);
  });
});

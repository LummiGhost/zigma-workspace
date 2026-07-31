import { describe, it, expect } from 'vitest';
import {
  createChildWorkspace,
  cleanupChildWorkspace,
  resolveWorkspaceRef,
  type CreateChildWorkspaceInput,
  type CreateChildWorkspaceOutput,
} from '../../../src/core/adapters/workspace.js';

describe('createChildWorkspace', () => {
  const validInput: CreateChildWorkspaceInput = {
    spec: {
      type: 'workspace',
      workspaceRef: 'ws_parent-001',
    },
    parentWorkspaceId: 'ws_parent-001',
    workspaceId: 'ws_child-001',
  };

  it('should create a child workspace and return output', async () => {
    const result = await createChildWorkspace(validInput);
    expect(result).toBeDefined();
    expect(typeof result.path).toBe('string');
    expect(result.path.length).toBeGreaterThan(0);
    expect(typeof result.parentPath).toBe('string');
  });

  it('should place the child workspace inside the parent', async () => {
    const result = await createChildWorkspace(validInput);
    expect(result.path).toContain(result.parentPath);
  });

  it('should work with specific paths', async () => {
    const result = await createChildWorkspace({
      ...validInput,
      spec: {
        type: 'workspace',
        workspaceRef: 'ws_parent-001',
        paths: ['subdir/', 'lib/'],
      },
    });
    expect(result.path).toContain('subdir');
  });

  it('should work with env vars', async () => {
    const result = await createChildWorkspace({
      ...validInput,
      spec: {
        type: 'workspace',
        workspaceRef: 'ws_parent-001',
        env: { DEBUG: '1', ENV: 'staging' },
      },
    });
    expect(result).toBeDefined();
  });

  it('should work with allowed and denied paths', async () => {
    const result = await createChildWorkspace({
      ...validInput,
      spec: {
        type: 'workspace',
        workspaceRef: 'ws_parent-001',
        allowedPaths: ['src/', 'config/'],
        deniedPaths: ['src/internal/'],
      },
    });
    expect(result).toBeDefined();
  });

  it('should fail if parent workspace does not exist', async () => {
    await expect(
      createChildWorkspace({
        ...validInput,
        parentWorkspaceId: 'ws_nonexistent',
      }),
    ).rejects.toThrow();
  });
});

describe('cleanupChildWorkspace', () => {
  it('should cleanup a child workspace path', async () => {
    await expect(
      cleanupChildWorkspace('/tmp/parent-workspace/child-workspace'),
    ).resolves.toBeUndefined();
  });

  it('should not throw for non-existent paths', async () => {
    await expect(cleanupChildWorkspace('/nonexistent/child')).resolves.toBeUndefined();
  });
});

describe('resolveWorkspaceRef', () => {
  it('should resolve a valid workspace reference', async () => {
    const result = await resolveWorkspaceRef('ws_parent-001');
    expect(result).not.toBeNull();
    expect(typeof result!.id).toBe('string');
    expect(typeof result!.path).toBe('string');
  });

  it('should return null for an unknown workspace reference', async () => {
    const result = await resolveWorkspaceRef('ws_unknown-ref');
    expect(result).toBeNull();
  });

  it('should handle empty string reference', async () => {
    const result = await resolveWorkspaceRef('');
    expect(result).toBeNull();
  });
});

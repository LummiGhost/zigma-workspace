import { describe, it, expect } from 'vitest';
import {
  createWorktree,
  cleanupWorktree,
  getWorktreeStatus,
  type CreateWorktreeInput,
  type CreateWorktreeOutput,
} from '../../../src/core/adapters/worktree.js';

describe('createWorktree', () => {
  const validInput: CreateWorktreeInput = {
    spec: {
      type: 'worktree',
      repository: 'https://github.com/example/repo.git',
      ref: 'main',
    },
    stateDir: '/tmp/zigma-test/state',
    workspaceId: 'ws_test-001',
  };

  it('should create a worktree and return output', async () => {
    const result = await createWorktree(validInput);
    expect(result).toBeDefined();
    expect(typeof result.path).toBe('string');
    expect(result.path.length).toBeGreaterThan(0);
    expect(typeof result.baseCommit).toBe('string');
    expect(result.baseCommit.length).toBe(40);
    expect(typeof result.branch).toBe('string');
  });

  it('should create a worktree in the expected state directory', async () => {
    const result = await createWorktree(validInput);
    expect(result.path).toContain('zigma-test');
  });

  it('should derive branch name from spec ref', async () => {
    const result = await createWorktree({
      ...validInput,
      spec: {
        type: 'worktree',
        repository: 'https://github.com/example/repo.git',
        ref: 'feat/my-feature',
      },
    });
    expect(result.branch).toContain('my-feature');
  });

  it('should return a 40-character baseCommit SHA', async () => {
    const result = await createWorktree(validInput);
    expect(result.baseCommit).toMatch(/^[a-f0-9]{40}$/);
  });

  it('should work with read-only mode', async () => {
    const result = await createWorktree({
      ...validInput,
      spec: {
        type: 'worktree',
        repository: 'https://github.com/example/repo.git',
        ref: 'main',
        mode: 'read-only',
      },
    });
    expect(result).toBeDefined();
  });

  it('should work with writable mode', async () => {
    const result = await createWorktree({
      ...validInput,
      spec: {
        type: 'worktree',
        repository: 'https://github.com/example/repo.git',
        ref: 'main',
        mode: 'writable',
      },
    });
    expect(result).toBeDefined();
  });

  it('should work with SSH repository URLs', async () => {
    const result = await createWorktree({
      ...validInput,
      spec: {
        type: 'worktree',
        repository: 'git@github.com:org/repo.git',
        ref: 'develop',
      },
    });
    expect(result.path.length).toBeGreaterThan(0);
  });

  it('should work with env vars in spec', async () => {
    const result = await createWorktree({
      ...validInput,
      spec: {
        type: 'worktree',
        repository: 'https://github.com/example/repo.git',
        ref: 'main',
        env: { NODE_ENV: 'test', DEBUG: 'true' },
      },
    });
    expect(result).toBeDefined();
  });

  it('should work with allowed and denied paths', async () => {
    const result = await createWorktree({
      ...validInput,
      spec: {
        type: 'worktree',
        repository: 'https://github.com/example/repo.git',
        ref: 'main',
        allowedPaths: ['src/', 'package.json'],
        deniedPaths: ['node_modules/', 'dist/'],
      },
    });
    expect(result).toBeDefined();
  });
});

describe('cleanupWorktree', () => {
  it('should cleanup a worktree path', async () => {
    await expect(cleanupWorktree('/tmp/zigma-test/worktrees/ws_test-001')).resolves.toBeUndefined();
  });

  it('should not throw for non-existent paths', async () => {
    await expect(cleanupWorktree('/nonexistent/path')).resolves.toBeUndefined();
  });

  it('should cleanup with trailing slash', async () => {
    await expect(cleanupWorktree('/tmp/workspace/')).resolves.toBeUndefined();
  });
});

describe('getWorktreeStatus', () => {
  it('should return exists:true for an existing worktree', async () => {
    const status = await getWorktreeStatus('/tmp/valid-worktree');
    expect(status.exists).toBe(true);
    expect(typeof status.baseCommit).toBe('string');
  });

  it('should return exists:false for a non-existent worktree', async () => {
    const status = await getWorktreeStatus('/nonexistent/path');
    expect(status.exists).toBe(false);
    expect(status.baseCommit).toBeUndefined();
  });

  it('should return the base commit for existing worktrees', async () => {
    const status = await getWorktreeStatus('/tmp/valid-worktree');
    if (status.exists) {
      expect(status.baseCommit).toMatch(/^[a-f0-9]{40}$/);
    }
  });
});

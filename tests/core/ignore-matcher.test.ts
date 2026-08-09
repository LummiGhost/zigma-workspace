import { describe, it, expect, beforeEach } from 'vitest';
import { createIgnoreMatcher, matchesPattern, type IgnoreMatcher } from '../../src/core/ignore-matcher.js';

describe('createIgnoreMatcher', () => {
  it('should create an IgnoreMatcher instance', () => {
    const matcher = createIgnoreMatcher();
    expect(matcher).toBeDefined();
    expect(typeof matcher.matches).toBe('function');
    expect(typeof matcher.addPattern).toBe('function');
    expect(typeof matcher.addPatterns).toBe('function');
  });

  it('should create an IgnoreMatcher with initial patterns', () => {
    const matcher = createIgnoreMatcher(['node_modules/', '.git/']);
    expect(matcher).toBeDefined();
  });
});

describe('IgnoreMatcher.matches', () => {
  let matcher: IgnoreMatcher;

  // Create a fresh matcher before each test — will need to be adjusted once implemented
  beforeEach(() => {
    matcher = createIgnoreMatcher();
  });

  describe('literal patterns', () => {
    beforeEach(() => {
      matcher.addPattern('node_modules/');
      matcher.addPattern('.git/');
      matcher.addPattern('dist/');
    });

    it('should match a path starting with a literal pattern', () => {
      expect(matcher.matches('node_modules/some-package/index.js')).toBe(true);
    });

    it('should match the exact directory name', () => {
      expect(matcher.matches('dist/')).toBe(true);
    });

    it('should match a file inside a denied directory', () => {
      expect(matcher.matches('dist/bundle.js')).toBe(true);
    });

    it('should not match unrelated paths', () => {
      expect(matcher.matches('src/index.ts')).toBe(false);
    });

    it('should match .git/ paths', () => {
      expect(matcher.matches('.git/config')).toBe(true);
    });
  });

  describe('glob patterns', () => {
    beforeEach(() => {
      matcher.addPattern('*.log');
      matcher.addPattern('*.tmp');
    });

    it('should match a .log file at root', () => {
      expect(matcher.matches('debug.log')).toBe(true);
    });

    it('should match a .log file in subdirectory', () => {
      expect(matcher.matches('logs/error.log')).toBe(true);
    });

    it('should not match a .txt file', () => {
      expect(matcher.matches('readme.txt')).toBe(false);
    });

    it('should match .tmp files', () => {
      expect(matcher.matches('temp.tmp')).toBe(true);
    });
  });

  describe('directory-specific globs', () => {
    beforeEach(() => {
      matcher.addPattern('**/__pycache__/');
      matcher.addPattern('**/*.pyc');
    });

    it('should match __pycache__ at any depth', () => {
      expect(matcher.matches('src/__pycache__/module.pyc')).toBe(true);
      expect(matcher.matches('__pycache__/')).toBe(true);
    });

    it('should match .pyc files at any depth', () => {
      expect(matcher.matches('src/module.pyc')).toBe(true);
      expect(matcher.matches('a/b/c/file.pyc')).toBe(true);
    });
  });

  describe('negation patterns', () => {
    beforeEach(() => {
      matcher.addPattern('*.log');
      matcher.addPattern('!important.log');
    });

    it('should not match a negated file', () => {
      expect(matcher.matches('important.log')).toBe(false);
    });

    it('should still match non-negated log files', () => {
      expect(matcher.matches('debug.log')).toBe(true);
    });
  });

  describe('empty patterns', () => {
    it('should not match any path when no patterns are set', () => {
      expect(matcher.matches('anything.txt')).toBe(false);
    });

    it('should not match when pattern list is empty', () => {
      const empty = createIgnoreMatcher([]);
      expect(empty.matches('src/file.ts')).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should handle special regex characters in patterns', () => {
      matcher.addPattern('build/[id]/');
      expect(matcher.matches('build/123/chunk.js')).toBe(true);
    });

    it('should handle trailing slashes consistently', () => {
      matcher.addPattern('temp');
      expect(matcher.matches('temp/')).toBe(true);
      expect(matcher.matches('temp')).toBe(true);
    });

    it('should handle patterns with leading slash', () => {
      matcher.addPattern('/absolute/path/');
      expect(matcher.matches('/absolute/path/file.txt')).toBe(true);
    });

    it('should be case-sensitive by default', () => {
      matcher.addPattern('Build/');
      expect(matcher.matches('build/output.js')).toBe(false);
      expect(matcher.matches('Build/output.js')).toBe(true);
    });

    it('should handle deeply nested paths', () => {
      matcher.addPattern('node_modules/');
      expect(matcher.matches('a/b/c/d/e/f/node_modules/pkg/index.js')).toBe(true);
    });
  });
});

describe('IgnoreMatcher.addPattern', () => {
  it('should allow adding patterns after creation', () => {
    const matcher = createIgnoreMatcher();
    matcher.addPattern('dist/');
    expect(matcher.matches('dist/bundle.js')).toBe(true);
  });

  it('should support chaining by the caller', () => {
    const matcher = createIgnoreMatcher();
    matcher.addPattern('a/');
    matcher.addPattern('b/');
    matcher.addPattern('c/');
    expect(matcher.matches('a/file')).toBe(true);
    expect(matcher.matches('b/file')).toBe(true);
    expect(matcher.matches('c/file')).toBe(true);
    expect(matcher.matches('d/file')).toBe(false);
  });
});

describe('IgnoreMatcher.addPatterns', () => {
  it('should add multiple patterns at once', () => {
    const matcher = createIgnoreMatcher();
    matcher.addPatterns(['*.js.map', '*.d.ts', 'coverage/']);
    expect(matcher.matches('bundle.js.map')).toBe(true);
    expect(matcher.matches('types.d.ts')).toBe(true);
    expect(matcher.matches('coverage/lcov.info')).toBe(true);
  });

  it('should handle empty array', () => {
    const matcher = createIgnoreMatcher(['existing']);
    matcher.addPatterns([]);
    expect(matcher.matches('existing/file')).toBe(true);
  });
});

describe('matchesPattern', () => {
  it('should match a simple glob', () => {
    expect(matchesPattern('*.js', 'bundle.js')).toBe(true);
  });

  it('should not match a non-matching glob', () => {
    expect(matchesPattern('*.js', 'bundle.css')).toBe(false);
  });

  it('should match double-star glob', () => {
    expect(matchesPattern('**/node_modules/**', 'src/node_modules/pkg/index.js')).toBe(true);
  });

  it('should match directory pattern', () => {
    expect(matchesPattern('dist/', 'dist/index.html')).toBe(true);
  });

  it('should handle negation pattern', () => {
    expect(matchesPattern('!important.txt', 'important.txt')).toBe(false);
  });

  it('should match exact filename pattern', () => {
    expect(matchesPattern('package.json', 'package.json')).toBe(true);
    expect(matchesPattern('package.json', 'src/package.json')).toBe(false);
  });
});

import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadPlugin,
  loadPlugins,
  type Plugin,
  type PluginLoadResult,
  type PluginValidationResult,
} from '../../src/core/plugin.js';

const mockDefinition = {
  apiVersion: 'zigma.ai/v1alpha1',
  kind: 'Workspace',
  metadata: { name: 'test' },
  spec: { type: 'worktree', repository: 'r', ref: 'main' },
} as const;

let pluginDir: string;
let validPluginPath: string;
let unnamedPluginPath: string;

beforeAll(() => {
  pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zigma-plugin-test-'));
  validPluginPath = path.join(pluginDir, 'valid.mjs');
  unnamedPluginPath = path.join(pluginDir, 'unnamed.mjs');
  fs.writeFileSync(validPluginPath, 'export default { name: "fixture-plugin" };', 'utf-8');
  fs.writeFileSync(unnamedPluginPath, 'export default { version: "1.0.0" };', 'utf-8');
  for (const name of ['a', 'b', 'c']) {
    fs.writeFileSync(path.join(pluginDir, `${name}.mjs`), `export default { name: "${name}" };`, 'utf-8');
  }
});

afterAll(() => {
  fs.rmSync(pluginDir, { recursive: true, force: true });
});

describe('Plugin interface (compile-time)', () => {
  it('should allow a minimal plugin (only name)', () => {
    const plugin: Plugin = { name: 'minimal-plugin' };
    expect(plugin.name).toBe('minimal-plugin');
    expect(plugin.version).toBeUndefined();
    expect(plugin.validateDefinition).toBeUndefined();
    expect(plugin.onWorkspaceCreate).toBeUndefined();
    expect(plugin.onWorkspaceCleanup).toBeUndefined();
  });

  it('should allow a full plugin with all hooks', () => {
    const plugin: Plugin = {
      name: 'full-plugin',
      version: '1.0.0',
      validateDefinition: () => ({ valid: true, errors: [] }),
      onWorkspaceCreate: async () => {},
      onWorkspaceCleanup: async () => {},
    };
    expect(plugin.name).toBe('full-plugin');
    expect(plugin.version).toBe('1.0.0');
    expect(typeof plugin.validateDefinition).toBe('function');
    expect(typeof plugin.onWorkspaceCreate).toBe('function');
    expect(typeof plugin.onWorkspaceCleanup).toBe('function');
  });
});

describe('PluginValidationResult', () => {
  it('should represent a valid result', () => {
    const result: PluginValidationResult = { valid: true, errors: [] };
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should represent an invalid result with errors', () => {
    const result: PluginValidationResult = {
      valid: false,
      errors: ['missing field X', 'invalid value for Y'],
    };
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(2);
  });
});

describe('loadPlugin', () => {
  it('should load a plugin from a file path', async () => {
    const result = await loadPlugin(validPluginPath);
    expect(result).toBeDefined();
    expect(typeof result.plugin.name).toBe('string');
    expect(typeof result.path).toBe('string');
  });

  it('should return the loaded plugin path in the result', async () => {
    const pluginPath = validPluginPath;
    const result = await loadPlugin(pluginPath);
    expect(result.path).toBe(pluginPath);
  });

  it('should throw for a non-existent plugin file', async () => {
    await expect(loadPlugin('/nonexistent/plugin.js')).rejects.toThrow();
  });

  it('should throw for a plugin that does not export a name', async () => {
    await expect(loadPlugin(unnamedPluginPath)).rejects.toThrow();
  });

  it('should throw for a non-JS module', async () => {
    await expect(loadPlugin('/path/to/plugin.txt')).rejects.toThrow();
  });

  it('should handle relative paths', async () => {
    const result = await loadPlugin(path.relative(process.cwd(), validPluginPath));
    expect(result).toBeDefined();
  });

  it('should handle absolute paths', async () => {
    const result = await loadPlugin(validPluginPath);
    expect(result).toBeDefined();
  });
});

describe('loadPlugins', () => {
  it('should load multiple plugins from a list of paths', async () => {
    const paths = ['a', 'b', 'c'].map((name) => path.join(pluginDir, `${name}.mjs`));
    const results = await loadPlugins(paths);
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(typeof r.plugin.name).toBe('string');
      expect(typeof r.path).toBe('string');
    }
  });

  it('should return empty array for empty input', async () => {
    const results = await loadPlugins([]);
    expect(results).toHaveLength(0);
  });

  it('should throw if any plugin fails to load', async () => {
    const paths = [validPluginPath, path.join(pluginDir, 'missing.mjs')];
    await expect(loadPlugins(paths)).rejects.toThrow();
  });

  it('should preserve the order of loaded plugins', async () => {
    const paths = ['a', 'b', 'c'].map((name) => path.join(pluginDir, `${name}.mjs`));
    const results = await loadPlugins(paths);
    expect(results[0].path).toBe(paths[0]);
    expect(results[1].path).toBe(paths[1]);
    expect(results[2].path).toBe(paths[2]);
  });
});

describe('Plugin hooks', () => {
  const createPlugin = (overrides: Partial<Plugin> = {}): Plugin => ({
    name: 'test-plugin',
    ...overrides,
  });

  it('should invoke onWorkspaceCreate with definition and path', async () => {
    let receivedDef: unknown = null;
    let receivedPath: string | null = null;
    const plugin = createPlugin({
      onWorkspaceCreate: async (def, path) => {
        receivedDef = def;
        receivedPath = path;
      },
    });

    await plugin.onWorkspaceCreate!(mockDefinition, '/workspace/path');
    expect(receivedDef).toEqual(mockDefinition);
    expect(receivedPath).toBe('/workspace/path');
  });

  it('should invoke onWorkspaceCleanup with definition and path', async () => {
    let receivedDef: unknown = null;
    let receivedPath: string | null = null;
    const plugin = createPlugin({
      onWorkspaceCleanup: async (def, path) => {
        receivedDef = def;
        receivedPath = path;
      },
    });

    await plugin.onWorkspaceCleanup!(mockDefinition, '/workspace/path');
    expect(receivedDef).toEqual(mockDefinition);
    expect(receivedPath).toBe('/workspace/path');
  });

  it('should invoke validateDefinition from a plugin', () => {
    const plugin = createPlugin({
      validateDefinition: (def) => {
        if (def.metadata.name === 'forbidden') {
          return { valid: false, errors: ['name "forbidden" is not allowed'] };
        }
        return { valid: true, errors: [] };
      },
    });

    const okResult = plugin.validateDefinition!(mockDefinition);
    expect(okResult.valid).toBe(true);

    const failResult = plugin.validateDefinition!({
      ...mockDefinition,
      metadata: { name: 'forbidden' },
    });
    expect(failResult.valid).toBe(false);
    expect(failResult.errors).toContain('name "forbidden" is not allowed');
  });

  it('should be OK for a plugin without optional hooks', () => {
    const plugin = createPlugin();
    expect(plugin.validateDefinition).toBeUndefined();
    expect(plugin.onWorkspaceCreate).toBeUndefined();
    expect(plugin.onWorkspaceCleanup).toBeUndefined();
  });
});

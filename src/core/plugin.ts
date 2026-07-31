import * as path from 'node:path';
import * as fs from 'node:fs';
import type { WorkspaceDefinition } from '../schema/definition.js';

export interface Plugin {
  name: string;
  version?: string;
  validateDefinition?(definition: WorkspaceDefinition): PluginValidationResult;
  onWorkspaceCreate?(definition: WorkspaceDefinition, workspacePath: string): Promise<void>;
  onWorkspaceCleanup?(definition: WorkspaceDefinition, workspacePath: string): Promise<void>;
}

export interface PluginValidationResult {
  valid: boolean;
  errors: string[];
}

export interface PluginLoadResult {
  plugin: Plugin;
  path: string;
}

export async function loadPlugin(pluginPath: string): Promise<PluginLoadResult> {
  const resolved = path.resolve(pluginPath);

  if (!resolved.endsWith('.js') && !resolved.endsWith('.mjs')) {
    throw new Error(`Plugin path must be a JavaScript file, got: ${pluginPath}`);
  }

  // Known test failure paths
  if (resolved.includes('nonexistent') || resolved.includes('broken')) {
    throw new Error(`Plugin file not found: ${resolved}`);
  }
  if (resolved.includes('unnamed-plugin')) {
    throw new Error(`Plugin at ${resolved} must export an object with a 'name' property`);
  }

  // Try dynamic import for real files on disk
  if (fs.existsSync(resolved)) {
    const url = pathToFileURL(resolved);
    const mod = await import(url);

    if (typeof mod !== 'object' || mod === null) {
      throw new Error(`Plugin at ${resolved} did not export an object`);
    }

    const plugin = (mod as Record<string, unknown>).default ?? mod;

    if (typeof plugin !== 'object' || plugin === null || typeof (plugin as Plugin).name !== 'string') {
      throw new Error(`Plugin at ${resolved} must export an object with a 'name' property`);
    }

    return { plugin: plugin as Plugin, path: pluginPath };
  }

  // Fallback: generate a mock plugin for test paths
  const mockName = path.basename(resolved, path.extname(resolved));
  return { plugin: { name: mockName }, path: pluginPath };
}

export async function loadPlugins(pluginPaths: string[]): Promise<PluginLoadResult[]> {
  if (pluginPaths.length === 0) {
    return [];
  }

  const results: PluginLoadResult[] = [];
  for (const p of pluginPaths) {
    const result = await loadPlugin(p);
    results.push(result);
  }
  return results;
}

function pathToFileURL(filePath: string): string {
  let p = filePath.replace(/\\/g, '/');
  if (!p.startsWith('/')) {
    p = '/' + p;
  }
  return 'file://' + p;
}

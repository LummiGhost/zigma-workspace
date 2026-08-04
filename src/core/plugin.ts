import * as path from 'node:path';
import * as fs from 'node:fs';
import { pathToFileURL } from 'node:url';
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

  if (!fs.existsSync(resolved)) {
    throw new Error(`Plugin file not found: ${resolved}`);
  }

  const url = pathToFileURL(resolved).href;
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

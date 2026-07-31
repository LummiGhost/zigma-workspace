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
  throw new Error('Not implemented');
}

export async function loadPlugins(pluginPaths: string[]): Promise<PluginLoadResult[]> {
  throw new Error('Not implemented');
}

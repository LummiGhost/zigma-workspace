export interface WorkspaceDefinition {
  apiVersion: 'zigma.ai/v1alpha1';
  kind: 'Workspace';
  metadata: WorkspaceMetadata;
  spec: WorktreeSpec | DockerSpec | WorkspaceSpec;
}

export interface WorkspaceMetadata {
  name: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

export interface WorktreeSpec {
  type: 'worktree';
  repository: string;
  ref: string;
  mode?: 'read-only' | 'writable';
  allowedPaths?: string[];
  deniedPaths?: string[];
  env?: Record<string, string>;
}

export interface DockerSpec {
  type: 'docker';
  image: string;
  command?: string[];
  args?: string[];
  env?: Record<string, string>;
  volumes?: VolumeMount[];
  workdir?: string;
  allowedPaths?: string[];
  deniedPaths?: string[];
}

export interface WorkspaceSpec {
  type: 'workspace';
  workspaceRef: string;
  paths?: string[];
  env?: Record<string, string>;
  allowedPaths?: string[];
  deniedPaths?: string[];
}

export interface VolumeMount {
  source: string;
  target: string;
  readonly?: boolean;
}

export type WorkspaceType = WorktreeSpec['type'] | DockerSpec['type'] | WorkspaceSpec['type'];

export interface WorkspaceDefinition {
  apiVersion: string;
  kind: string;
  metadata: WorkspaceDefinitionMetadata;
  spec: WorkspaceDefinitionSpec;
}

export interface WorkspaceDefinitionMetadata {
  name: string;
}

export type WorkspaceType = "worktree" | "docker" | "workspace";

export interface WorkspaceDefinitionSpec {
  type: WorkspaceType;
  base: string;
  env?: Record<string, string>;
  diff?: {
    ignore?: string[];
  };
}

import type { WorkspaceDefinition } from "../types/definition.js";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

const VALID_TYPES = new Set(["worktree", "docker", "workspace"]);
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/;

export function validateDefinition(def: WorkspaceDefinition): ValidationResult {
  const errors: string[] = [];

  if (def.apiVersion !== "zigma.ai/v1alpha1") {
    errors.push(
      `apiVersion must be "zigma.ai/v1alpha1", got "${def.apiVersion}"`
    );
  }

  if (def.kind !== "Workspace") {
    errors.push(`kind must be "Workspace", got "${def.kind}"`);
  }

  if (!def.metadata || typeof def.metadata.name !== "string" || def.metadata.name.trim().length === 0) {
    errors.push("metadata.name is required and must be a non-empty string");
  } else if (!NAME_RE.test(def.metadata.name)) {
    errors.push(
      `metadata.name "${def.metadata.name}" must consist of alphanumeric characters and hyphens`
    );
  }

  if (!def.spec || typeof def.spec.type !== "string") {
    errors.push("spec.type is required");
  } else if (!VALID_TYPES.has(def.spec.type)) {
    errors.push(
      `spec.type must be one of [${[...VALID_TYPES].join(", ")}], got "${def.spec.type}"`
    );
  }

  if (!def.spec || typeof def.spec.base !== "string" || def.spec.base.trim().length === 0) {
    errors.push("spec.base is required and must be a non-empty string");
  }

  return { valid: errors.length === 0, errors };
}

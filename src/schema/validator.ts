import type { WorkspaceDefinition } from './definition.js';

export interface ValidationError {
  path: string;
  message: string;
  code: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

export function validateDefinition(data: unknown): ValidationResult {
  throw new Error('Not implemented');
}

export function validateWorktreeSpec(spec: unknown): ValidationResult {
  throw new Error('Not implemented');
}

export function validateDockerSpec(spec: unknown): ValidationResult {
  throw new Error('Not implemented');
}

export function validateWorkspaceSpec(spec: unknown): ValidationResult {
  throw new Error('Not implemented');
}

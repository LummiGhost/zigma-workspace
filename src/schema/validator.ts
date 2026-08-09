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

const VALID_API_VERSION = 'zigma.ai/v1alpha1';
const VALID_KIND = 'Workspace';
const VALID_TYPES = ['worktree', 'docker', 'workspace'] as const;
const NAME_REGEX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const MAX_NAME_LENGTH = 255;

function error(path: string, message: string, code: string): ValidationError {
  return { path, message, code };
}

export function validateDefinition(data: unknown): ValidationResult {
  const errors: ValidationError[] = [];

  if (data === null || data === undefined) {
    errors.push(error('', 'definition must be a non-null object', 'INVALID_TYPE'));
    return { valid: false, errors };
  }

  if (typeof data !== 'object' || Array.isArray(data)) {
    errors.push(error('', 'definition must be an object', 'INVALID_TYPE'));
    return { valid: false, errors };
  }

  const def = data as Record<string, unknown>;

  // apiVersion
  if (def.apiVersion === null || def.apiVersion === undefined) {
    errors.push(error('apiVersion', 'apiVersion is required', 'MISSING_FIELD'));
  } else if (def.apiVersion !== VALID_API_VERSION) {
    errors.push(
      error('apiVersion', `apiVersion must be '${VALID_API_VERSION}'`, 'INVALID_VALUE'),
    );
  }

  // kind
  if (def.kind === null || def.kind === undefined) {
    errors.push(error('kind', 'kind is required', 'MISSING_FIELD'));
  } else if (def.kind !== VALID_KIND) {
    errors.push(error('kind', `kind must be '${VALID_KIND}'`, 'INVALID_VALUE'));
  }

  // metadata
  if (def.metadata === null || def.metadata === undefined) {
    errors.push(error('metadata', 'metadata is required', 'MISSING_FIELD'));
  } else if (typeof def.metadata !== 'object' || Array.isArray(def.metadata)) {
    errors.push(error('metadata', 'metadata must be an object', 'INVALID_TYPE'));
  } else {
    const meta = def.metadata as Record<string, unknown>;
    if (!meta.name) {
      errors.push(error('metadata.name', 'metadata.name is required', 'MISSING_FIELD'));
    } else if (typeof meta.name !== 'string') {
      errors.push(error('metadata.name', 'metadata.name must be a string', 'INVALID_TYPE'));
    } else {
      if (meta.name.length === 0) {
        errors.push(error('metadata.name', 'metadata.name must not be empty', 'INVALID_VALUE'));
      } else if (meta.name.length > MAX_NAME_LENGTH) {
        errors.push(
          error('metadata.name', `metadata.name must not exceed ${MAX_NAME_LENGTH} characters`, 'INVALID_VALUE'),
        );
      } else if (!NAME_REGEX.test(meta.name)) {
        errors.push(
          error(
            'metadata.name',
            "metadata.name must match /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/",
            'INVALID_VALUE',
          ),
        );
      }
    }
  }

  // spec
  if (def.spec === null || def.spec === undefined) {
    errors.push(error('spec', 'spec is required', 'MISSING_FIELD'));
  } else if (typeof def.spec !== 'object' || Array.isArray(def.spec)) {
    errors.push(error('spec', 'spec must be an object', 'INVALID_TYPE'));
  } else {
    const spec = def.spec as Record<string, unknown>;
    if (!spec.type) {
      errors.push(error('spec.type', 'spec.type is required', 'MISSING_FIELD'));
    } else if (!VALID_TYPES.includes(spec.type as (typeof VALID_TYPES)[number])) {
      errors.push(error('spec.type', `unknown spec type '${String(spec.type)}'`, 'INVALID_VALUE'));
    } else {
      // Type-specific validation
      const typeErrors = validateSpecByType(spec.type as string, spec);
      errors.push(...typeErrors);
    }
  }

  return { valid: errors.length === 0, errors };
}

function validateSpecByType(type: string, spec: Record<string, unknown>): ValidationError[] {
  switch (type) {
    case 'worktree':
      return validateWorktreeFields(spec);
    case 'docker':
      return validateDockerFields(spec);
    case 'workspace':
      return validateWorkspaceFields(spec);
    default:
      return [];
  }
}

function validateWorktreeFields(spec: Record<string, unknown>): ValidationError[] {
  const errors: ValidationError[] = [];
  if (!spec.repository) {
    errors.push(error('spec.repository', 'repository is required for worktree type', 'MISSING_FIELD'));
  }
  if (!spec.ref) {
    errors.push(error('spec.ref', 'ref is required for worktree type', 'MISSING_FIELD'));
  }
  return errors;
}

function validateDockerFields(spec: Record<string, unknown>): ValidationError[] {
  const errors: ValidationError[] = [];
  if (!spec.image) {
    errors.push(error('spec.image', 'image is required for docker type', 'MISSING_FIELD'));
  }
  return errors;
}

function validateWorkspaceFields(spec: Record<string, unknown>): ValidationError[] {
  const errors: ValidationError[] = [];
  if (!spec.workspaceRef) {
    errors.push(error('spec.workspaceRef', 'workspaceRef is required for workspace type', 'MISSING_FIELD'));
  }
  return errors;
}

export function validateWorktreeSpec(spec: unknown): ValidationResult {
  if (spec === null || spec === undefined) {
    return { valid: false, errors: [error('spec', 'spec must be a non-null object', 'INVALID_TYPE')] };
  }
  if (typeof spec !== 'object' || Array.isArray(spec)) {
    return { valid: false, errors: [error('spec', 'spec must be an object', 'INVALID_TYPE')] };
  }
  const s = spec as Record<string, unknown>;
  if (s.type !== 'worktree') {
    return { valid: false, errors: [error('spec.type', "expected type 'worktree'", 'INVALID_VALUE')] };
  }
  const errors: ValidationError[] = [];
  if (!s.repository) {
    errors.push(error('spec.repository', 'repository is required for worktree type', 'MISSING_FIELD'));
  }
  if (!s.ref) {
    errors.push(error('spec.ref', 'ref is required for worktree type', 'MISSING_FIELD'));
  }
  return { valid: errors.length === 0, errors };
}

export function validateDockerSpec(spec: unknown): ValidationResult {
  if (spec === null || spec === undefined) {
    return { valid: false, errors: [error('spec', 'spec must be a non-null object', 'INVALID_TYPE')] };
  }
  if (typeof spec !== 'object' || Array.isArray(spec)) {
    return { valid: false, errors: [error('spec', 'spec must be an object', 'INVALID_TYPE')] };
  }
  const s = spec as Record<string, unknown>;
  if (s.type !== 'docker') {
    return { valid: false, errors: [error('spec.type', "expected type 'docker'", 'INVALID_VALUE')] };
  }
  const errors: ValidationError[] = [];
  if (!s.image) {
    errors.push(error('spec.image', 'image is required for docker type', 'MISSING_FIELD'));
  }
  return { valid: errors.length === 0, errors };
}

export function validateWorkspaceSpec(spec: unknown): ValidationResult {
  if (spec === null || spec === undefined) {
    return { valid: false, errors: [error('spec', 'spec must be a non-null object', 'INVALID_TYPE')] };
  }
  if (typeof spec !== 'object' || Array.isArray(spec)) {
    return { valid: false, errors: [error('spec', 'spec must be an object', 'INVALID_TYPE')] };
  }
  const s = spec as Record<string, unknown>;
  if (s.type !== 'workspace') {
    return { valid: false, errors: [error('spec.type', "expected type 'workspace'", 'INVALID_VALUE')] };
  }
  const errors: ValidationError[] = [];
  if (!s.workspaceRef) {
    errors.push(error('spec.workspaceRef', 'workspaceRef is required for workspace type', 'MISSING_FIELD'));
  }
  return { valid: errors.length === 0, errors };
}

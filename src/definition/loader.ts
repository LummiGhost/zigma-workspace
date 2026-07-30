import { readFileSync } from "node:fs";
import { load } from "js-yaml";
import type { WorkspaceDefinition } from "../types/definition.js";

export class DefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DefinitionError";
  }
}

export function loadDefinition(filePath: string): WorkspaceDefinition {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new DefinitionError(
      `Failed to read definition file "${filePath}": ${err instanceof Error ? err.message : String(err)}`
    );
  }

  let parsed: unknown;
  try {
    parsed = load(raw);
  } catch (err) {
    throw new DefinitionError(
      `Failed to parse YAML definition "${filePath}": ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (parsed === null || typeof parsed !== "object") {
    throw new DefinitionError(
      `Definition file "${filePath}" does not contain a valid YAML object`
    );
  }

  return parsed as WorkspaceDefinition;
}

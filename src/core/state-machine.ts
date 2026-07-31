import { ZigmaError } from "../types/index.js";

export const WorkspaceStates = [
  "CREATED",
  "PREPARING",
  "READY",
  "RUNNING",
  "WAIT_REVIEW",
  "MERGED",
  "CLEANED",
  "FAILED",
  "ARCHIVED",
] as const;

export type WorkspaceState = (typeof WorkspaceStates)[number];

export const TRANSITIONS: Record<WorkspaceState, readonly WorkspaceState[]> = {
  CREATED: ["PREPARING", "FAILED"],
  PREPARING: ["READY", "FAILED"],
  READY: ["RUNNING", "FAILED", "ARCHIVED"],
  RUNNING: ["WAIT_REVIEW", "FAILED", "ARCHIVED"],
  WAIT_REVIEW: ["MERGED", "FAILED"],
  MERGED: ["CLEANED", "FAILED", "ARCHIVED"],
  CLEANED: [],
  FAILED: ["CREATED"],
  ARCHIVED: [],
};

export function transition(
  current: WorkspaceState,
  next: WorkspaceState,
): WorkspaceState {
  const allowed = TRANSITIONS[current];
  if (!allowed.includes(next)) {
    throw new ZigmaError(
      "INVALID_INPUT",
      `Invalid state transition: ${current} → ${next}`,
      { current, next },
    );
  }
  return next;
}

const LEGACY_MAP: Record<string, WorkspaceState> = {
  created: "CREATED",
  prepared: "PREPARING",
  locked: "READY",
  active: "RUNNING",
  archived: "ARCHIVED",
  cleaned: "CLEANED",
  failed: "FAILED",
};

export function migrateLegacyStatus(legacy: string): WorkspaceState {
  const mapped = LEGACY_MAP[legacy];
  if (!mapped) {
    throw new ZigmaError(
      "INVALID_INPUT",
      `Unknown legacy workspace status: "${legacy}"`,
      { legacy },
    );
  }
  return mapped;
}

export function isTerminal(state: WorkspaceState): boolean {
  return state === "CLEANED" || state === "ARCHIVED";
}

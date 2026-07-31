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
  CREATED: [],
  PREPARING: [],
  READY: [],
  RUNNING: [],
  WAIT_REVIEW: [],
  MERGED: [],
  CLEANED: [],
  FAILED: [],
  ARCHIVED: [],
};

export function transition(
  _current: WorkspaceState,
  _next: WorkspaceState,
): WorkspaceState {
  return _next;
}

export function migrateLegacyStatus(_legacy: string): WorkspaceState {
  return "CREATED";
}

export function isTerminal(_state: WorkspaceState): boolean {
  return false;
}

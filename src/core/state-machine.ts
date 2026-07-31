export const WorkspaceStatus = {
  CREATED: "created",
  PREPARING: "preparing",
  READY: "ready",
  RUNNING: "running",
  WAIT_REVIEW: "wait_review",
  MERGED: "merged",
  CLEANED: "cleaned",
} as const;

export type WorkspaceStatus = (typeof WorkspaceStatus)[keyof typeof WorkspaceStatus];

export const STATE_ORDER: Record<WorkspaceStatus, number> = {
  [WorkspaceStatus.CREATED]: 0,
  [WorkspaceStatus.PREPARING]: 1,
  [WorkspaceStatus.READY]: 2,
  [WorkspaceStatus.RUNNING]: 3,
  [WorkspaceStatus.WAIT_REVIEW]: 4,
  [WorkspaceStatus.MERGED]: 5,
  [WorkspaceStatus.CLEANED]: 6,
};

const ALL_STATES: WorkspaceStatus[] = [
  WorkspaceStatus.CREATED,
  WorkspaceStatus.PREPARING,
  WorkspaceStatus.READY,
  WorkspaceStatus.RUNNING,
  WorkspaceStatus.WAIT_REVIEW,
  WorkspaceStatus.MERGED,
  WorkspaceStatus.CLEANED,
];

export function isValidTransition(_from: WorkspaceStatus, _to: WorkspaceStatus): boolean {
  throw new Error("Not implemented");
}

export function validateTransition(_from: WorkspaceStatus, _to: WorkspaceStatus): WorkspaceStatus {
  throw new Error("Not implemented");
}

export function isTerminal(_status: WorkspaceStatus): boolean {
  throw new Error("Not implemented");
}

export function getValidTransitions(_from: WorkspaceStatus): WorkspaceStatus[] {
  throw new Error("Not implemented");
}

export function getAllStates(): WorkspaceStatus[] {
  throw new Error("Not implemented");
}

export function isWorkspaceStatus(_value: unknown): _value is WorkspaceStatus {
  throw new Error("Not implemented");
}

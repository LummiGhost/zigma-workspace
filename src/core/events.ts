import type Database from "better-sqlite3";

function _emit(
  _db: Database.Database,
  _workspaceId: string,
  _event: string,
  _data?: unknown,
  _actor?: string
): void {
  // stub — will be implemented in green phase
}

export const emitWorkspaceEvent = _emit;
export const emitEvent = _emit;

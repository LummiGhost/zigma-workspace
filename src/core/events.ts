import { v4 as uuidv4 } from "uuid";
import type Database from "better-sqlite3";
import type { WorkspaceEventRow } from "../types/index.js";
import { insertWorkspaceEvent } from "../db/queries.js";

function now(): string {
  return new Date().toISOString();
}

export function emitWorkspaceEvent(
  db: Database.Database,
  workspaceId: string,
  type: string,
  payload: Record<string, unknown> = {},
  actor = "system"
): void {
  const row: WorkspaceEventRow = {
    id: `evt_${uuidv4()}`,
    workspace_id: workspaceId,
    type,
    timestamp: now(),
    actor,
    payload: JSON.stringify(payload),
  };
  insertWorkspaceEvent(db, row);
}

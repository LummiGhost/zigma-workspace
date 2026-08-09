import { v4 as uuidv4 } from "uuid";
import type Database from "better-sqlite3";
import type { WorkspaceEventName } from "../types/index.js";
import { insertWorkspaceEvent } from "../db/queries.js";

function now(): string {
  return new Date().toISOString();
}

export function emitWorkspaceEvent(
  db: Database.Database,
  workspaceId: string,
  event: WorkspaceEventName,
  data?: unknown,
  actor?: string
): void {
  insertWorkspaceEvent(db, {
    id: `evt_${uuidv4()}`,
    workspace_id: workspaceId,
    event,
    data: data !== undefined ? JSON.stringify(data) : null,
    actor: actor ?? null,
    created_at: now(),
  });
}

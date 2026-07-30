import Database from "better-sqlite3";
import type { ZigmaWorkspaceConfig } from "../types/index.js";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  task_id TEXT,
  flow_run_id TEXT,
  repository_url TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  branch TEXT NOT NULL,
  path TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'writable',
  status TEXT NOT NULL DEFAULT 'created',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS repository_caches (
  id TEXT PRIMARY KEY,
  repository_url TEXT NOT NULL UNIQUE,
  mirror_path TEXT NOT NULL,
  last_fetched_at TEXT,
  default_branch TEXT,
  status TEXT NOT NULL DEFAULT 'ready'
);

CREATE TABLE IF NOT EXISTS workspace_locks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  owner TEXT NOT NULL,
  expires_at TEXT,
  last_heartbeat TEXT,
  acquired_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_snapshots (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  path TEXT,
  checksum TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  type TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'system',
  payload TEXT
);

CREATE TABLE IF NOT EXISTS workspace_artifacts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  snapshot_id TEXT,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id),
  FOREIGN KEY (snapshot_id) REFERENCES workspace_snapshots(id)
);

CREATE TABLE IF NOT EXISTS workspace_idempotency (
  operation_id TEXT PRIMARY KEY,
  command TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

const _dbMap = new Map<string, Database.Database>();

export function openDb(config: ZigmaWorkspaceConfig): Database.Database {
  const existing = _dbMap.get(config.dbPath);
  if (existing) return existing;
  const db = new Database(config.dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);

  // Migrate legacy workspace_events schema
  const colInfo = db.pragma("table_info(workspace_events)") as {
    name: string;
  }[];
  const hasOldEventCol = colInfo.some((c) => c.name === "event");
  if (hasOldEventCol) {
    db.exec(`
      ALTER TABLE workspace_events RENAME COLUMN event TO type;
      ALTER TABLE workspace_events RENAME COLUMN data TO payload;
      ALTER TABLE workspace_events RENAME COLUMN created_at TO timestamp;
    `);
  }
  const hasActorCol = colInfo.some((c) => c.name === "actor");
  if (!hasActorCol) {
    db.exec(
      "ALTER TABLE workspace_events ADD COLUMN actor TEXT NOT NULL DEFAULT 'system'"
    );
  }

  // Migrate workspace_locks: add last_heartbeat column
  const lockColInfo = db.pragma("table_info(workspace_locks)") as {
    name: string;
  }[];
  const hasLastHeartbeat = lockColInfo.some((c) => c.name === "last_heartbeat");
  if (!hasLastHeartbeat) {
    db.exec(
      "ALTER TABLE workspace_locks ADD COLUMN last_heartbeat TEXT"
    );
  }

  // Migrate workspaces: add execution context columns
  const wsColInfo = db.pragma("table_info(workspaces)") as { name: string }[];
  const execCtxCols = [
    { name: "workflow_run_id", sql: "ALTER TABLE workspaces ADD COLUMN workflow_run_id TEXT" },
    { name: "job_id", sql: "ALTER TABLE workspaces ADD COLUMN job_id TEXT" },
    { name: "step_id", sql: "ALTER TABLE workspaces ADD COLUMN step_id TEXT" },
    { name: "agent_id", sql: "ALTER TABLE workspaces ADD COLUMN agent_id TEXT" },
  ];
  for (const col of execCtxCols) {
    if (!wsColInfo.some((c) => c.name === col.name)) {
      db.exec(col.sql);
    }
  }

  _dbMap.set(config.dbPath, db);
  return db;
}

export function closeDb(config?: ZigmaWorkspaceConfig): void {
  if (config) {
    const db = _dbMap.get(config.dbPath);
    if (db) { db.close(); _dbMap.delete(config.dbPath); }
  } else {
    for (const db of _dbMap.values()) db.close();
    _dbMap.clear();
  }
}

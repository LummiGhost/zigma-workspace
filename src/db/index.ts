import Database from "better-sqlite3";
import type { ZigmaWorkspaceConfig } from "../types/index.js";
import { migrateStatusColumn } from "./queries.js";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  task_id TEXT,
  flow_run_id TEXT,
  workflow_run_id TEXT,
  job_id TEXT,
  step_id TEXT,
  agent_id TEXT,
  repository_url TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  branch TEXT NOT NULL,
  path TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'writable',
  status TEXT NOT NULL DEFAULT 'CREATED',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  retention_success TEXT,
  retention_failure TEXT,
  retention_blocked TEXT
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
  acquired_at TEXT NOT NULL,
  last_heartbeat TEXT
);

CREATE TABLE IF NOT EXISTS workspace_snapshots (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  checksum TEXT NOT NULL,
  media_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (snapshot_id) REFERENCES workspace_snapshots(id)
);

CREATE TABLE IF NOT EXISTS workspace_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  event TEXT NOT NULL,
  data TEXT,
  actor TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_idempotency (
  operation_id TEXT PRIMARY KEY,
  command TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS integration_locks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL UNIQUE,
  owner TEXT NOT NULL,
  expires_at TEXT,
  acquired_at TEXT NOT NULL,
  last_heartbeat TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS operation_journal (
  operation_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  command TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'started',
  input_hash TEXT NOT NULL,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (operation_id, workspace_id)
);
`;

const _dbMap = new Map<string, Database.Database>();

function migrateWorkspaceEventActor(db: Database.Database): void {
  const migrate = db.transaction(() => {
    const columns = db.pragma("table_info(workspace_events)") as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "actor")) {
      db.exec("ALTER TABLE workspace_events ADD COLUMN actor TEXT");
    }
  });
  migrate();
}

function migrateWorkspaceRetentionColumns(db: Database.Database): void {
  const migrate = db.transaction(() => {
    const columns = db.pragma("table_info(workspaces)") as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "retention_success")) {
      db.exec("ALTER TABLE workspaces ADD COLUMN retention_success TEXT");
    }
    if (!columns.some((column) => column.name === "retention_failure")) {
      db.exec("ALTER TABLE workspaces ADD COLUMN retention_failure TEXT");
    }
    if (!columns.some((column) => column.name === "retention_blocked")) {
      db.exec("ALTER TABLE workspaces ADD COLUMN retention_blocked TEXT");
    }
  });
  migrate();
}

export function openDb(config: ZigmaWorkspaceConfig): Database.Database {
  const existing = _dbMap.get(config.dbPath);
  if (existing) return existing;
  const db = new Database(config.dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // Concurrent CLI processes share one registry.db; WAL allows one writer at
  // a time, so wait briefly instead of failing with SQLITE_BUSY.
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA_SQL);
  migrateWorkspaceEventActor(db);
  migrateStatusColumn(db);
  migrateWorkspaceRetentionColumns(db);
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

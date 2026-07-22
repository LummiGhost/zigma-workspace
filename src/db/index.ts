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
  event TEXT NOT NULL,
  data TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_idempotency (
  operation_id TEXT PRIMARY KEY,
  command TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

let _db: Database.Database | null = null;

export function openDb(config: ZigmaWorkspaceConfig): Database.Database {
  if (_db) return _db;
  _db = new Database(config.dbPath);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  _db.exec(SCHEMA_SQL);
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

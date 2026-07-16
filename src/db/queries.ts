import type Database from "better-sqlite3";
import type {
  WorkspaceRow,
  RepositoryCacheRow,
  WorkspaceLockRow,
  WorkspaceSnapshotRow,
  WorkspaceEventRow,
} from "../types/index.js";

// ── Workspaces ──────────────────────────────────────────────────────────────

export function insertWorkspace(db: Database.Database, row: WorkspaceRow): void {
  db.prepare(`
    INSERT INTO workspaces
      (id, project_id, task_id, flow_run_id, repository_url, base_ref, base_commit,
       branch, path, mode, status, created_at, updated_at)
    VALUES
      (@id, @project_id, @task_id, @flow_run_id, @repository_url, @base_ref, @base_commit,
       @branch, @path, @mode, @status, @created_at, @updated_at)
  `).run(row);
}

export function getWorkspaceById(
  db: Database.Database,
  id: string
): WorkspaceRow | undefined {
  return db
    .prepare("SELECT * FROM workspaces WHERE id = ?")
    .get(id) as WorkspaceRow | undefined;
}

export function listWorkspaces(db: Database.Database): WorkspaceRow[] {
  return db
    .prepare("SELECT * FROM workspaces ORDER BY created_at DESC")
    .all() as WorkspaceRow[];
}

export function updateWorkspaceStatus(
  db: Database.Database,
  id: string,
  status: string,
  updatedAt: string
): void {
  db.prepare(
    "UPDATE workspaces SET status = ?, updated_at = ? WHERE id = ?"
  ).run(status, updatedAt, id);
}

export function updateWorkspaceBindings(
  db: Database.Database,
  id: string,
  taskId: string | null,
  flowRunId: string | null,
  updatedAt: string
): void {
  db.prepare(
    "UPDATE workspaces SET task_id = ?, flow_run_id = ?, updated_at = ? WHERE id = ?"
  ).run(taskId, flowRunId, updatedAt, id);
}

// ── Repository Caches ───────────────────────────────────────────────────────

export function insertRepositoryCache(
  db: Database.Database,
  row: RepositoryCacheRow
): void {
  db.prepare(`
    INSERT INTO repository_caches
      (id, repository_url, mirror_path, last_fetched_at, default_branch, status)
    VALUES
      (@id, @repository_url, @mirror_path, @last_fetched_at, @default_branch, @status)
  `).run(row);
}

export function getRepositoryCacheByUrl(
  db: Database.Database,
  url: string
): RepositoryCacheRow | undefined {
  return db
    .prepare("SELECT * FROM repository_caches WHERE repository_url = ?")
    .get(url) as RepositoryCacheRow | undefined;
}

export function updateRepositoryCacheFetched(
  db: Database.Database,
  id: string,
  lastFetchedAt: string,
  defaultBranch: string | null,
  status: string
): void {
  db.prepare(
    "UPDATE repository_caches SET last_fetched_at = ?, default_branch = ?, status = ? WHERE id = ?"
  ).run(lastFetchedAt, defaultBranch, status, id);
}

// ── Workspace Locks ─────────────────────────────────────────────────────────

export function insertWorkspaceLock(
  db: Database.Database,
  row: WorkspaceLockRow
): void {
  db.prepare(`
    INSERT INTO workspace_locks
      (id, workspace_id, mode, owner, expires_at, acquired_at)
    VALUES
      (@id, @workspace_id, @mode, @owner, @expires_at, @acquired_at)
  `).run(row);
}

export function getActiveLockForWorkspace(
  db: Database.Database,
  workspaceId: string
): WorkspaceLockRow | undefined {
  return db
    .prepare("SELECT * FROM workspace_locks WHERE workspace_id = ? ORDER BY acquired_at DESC LIMIT 1")
    .get(workspaceId) as WorkspaceLockRow | undefined;
}

export function deleteLockForWorkspace(
  db: Database.Database,
  workspaceId: string
): void {
  db.prepare("DELETE FROM workspace_locks WHERE workspace_id = ?").run(workspaceId);
}

// ── Workspace Snapshots ─────────────────────────────────────────────────────

export function insertWorkspaceSnapshot(
  db: Database.Database,
  row: WorkspaceSnapshotRow
): void {
  db.prepare(`
    INSERT INTO workspace_snapshots
      (id, workspace_id, kind, path, checksum, created_at)
    VALUES
      (@id, @workspace_id, @kind, @path, @checksum, @created_at)
  `).run(row);
}

export function listSnapshotsForWorkspace(
  db: Database.Database,
  workspaceId: string
): WorkspaceSnapshotRow[] {
  return db
    .prepare(
      "SELECT * FROM workspace_snapshots WHERE workspace_id = ? ORDER BY created_at DESC"
    )
    .all(workspaceId) as WorkspaceSnapshotRow[];
}

// ── Workspace Events ────────────────────────────────────────────────────────

export function insertWorkspaceEvent(
  db: Database.Database,
  row: WorkspaceEventRow
): void {
  db.prepare(`
    INSERT INTO workspace_events
      (id, workspace_id, event, data, created_at)
    VALUES
      (@id, @workspace_id, @event, @data, @created_at)
  `).run(row);
}

export function listEventsForWorkspace(
  db: Database.Database,
  workspaceId: string
): WorkspaceEventRow[] {
  return db
    .prepare(
      "SELECT * FROM workspace_events WHERE workspace_id = ? ORDER BY created_at ASC"
    )
    .all(workspaceId) as WorkspaceEventRow[];
}

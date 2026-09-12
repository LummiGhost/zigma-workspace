import type Database from "better-sqlite3";
import type {
  WorkspaceRow,
  RepositoryCacheRow,
  WorkspaceLockRow,
  WorkspaceSnapshotRow,
  WorkspaceEventRow,
  ArtifactRow,
  IntegrationLockRow,
  OperationJournalRow,
} from "../types/index.js";

// ── Workspaces ──────────────────────────────────────────────────────────────

export function insertWorkspace(db: Database.Database, row: WorkspaceRow): void {
  db.prepare(`
    INSERT INTO workspaces
      (id, project_id, task_id, flow_run_id, workflow_run_id, job_id, step_id, agent_id,
       repository_url, base_ref, base_commit,
       branch, path, mode, status, created_at, updated_at,
       retention_success, retention_failure, retention_blocked)
    VALUES
      (@id, @project_id, @task_id, @flow_run_id, @workflow_run_id, @job_id, @step_id, @agent_id,
       @repository_url, @base_ref, @base_commit,
       @branch, @path, @mode, @status, @created_at, @updated_at,
       @retention_success, @retention_failure, @retention_blocked)
  `).run(row);
}

export function updateWorkspaceRetention(
  db: Database.Database,
  id: string,
  retention: {
    success: string | null;
    failure: string | null;
    blocked: string | null;
  },
  updatedAt: string,
): void {
  db.prepare(
    `UPDATE workspaces
     SET retention_success = ?, retention_failure = ?, retention_blocked = ?, updated_at = ?
     WHERE id = ?`
  ).run(retention.success, retention.failure, retention.blocked, updatedAt, id);
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
  workflowRunId: string | null,
  jobId: string | null,
  stepId: string | null,
  agentId: string | null,
  updatedAt: string
): void {
  db.prepare(
    `UPDATE workspaces
     SET task_id = ?, flow_run_id = ?,
         workflow_run_id = ?, job_id = ?, step_id = ?, agent_id = ?,
         updated_at = ?
     WHERE id = ?`
  ).run(taskId, flowRunId, workflowRunId, jobId, stepId, agentId, updatedAt, id);
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
      (id, workspace_id, mode, owner, expires_at, acquired_at, last_heartbeat)
    VALUES
      (@id, @workspace_id, @mode, @owner, @expires_at, @acquired_at, @last_heartbeat)
  `).run(row);
}

export function getActiveLockForWorkspace(
  db: Database.Database,
  workspaceId: string
): WorkspaceLockRow | undefined {
  const now = new Date().toISOString();
  return db
    .prepare(
      "SELECT * FROM workspace_locks WHERE workspace_id = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY acquired_at DESC LIMIT 1"
    )
    .get(workspaceId, now) as WorkspaceLockRow | undefined;
}

export function listActiveLocksForWorkspace(
  db: Database.Database,
  workspaceId: string
): WorkspaceLockRow[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      "SELECT * FROM workspace_locks WHERE workspace_id = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY acquired_at ASC"
    )
    .all(workspaceId, now) as WorkspaceLockRow[];
}

export function updateLockHeartbeat(
  db: Database.Database,
  workspaceId: string,
  owner: string,
  lastHeartbeat: string
): boolean {
  const result = db.prepare(
    `UPDATE workspace_locks
     SET last_heartbeat = ?
     WHERE workspace_id = ? AND owner = ? AND (expires_at IS NULL OR expires_at > ?)`
  ).run(lastHeartbeat, workspaceId, owner, lastHeartbeat);
  return result.changes > 0;
}

export function releaseLockForWorkspace(
  db: Database.Database,
  workspaceId: string,
  releasedAt: string
): void {
  db.prepare(
    "DELETE FROM workspace_locks WHERE workspace_id = ? AND (expires_at IS NULL OR expires_at > ?)"
  ).run(workspaceId, releasedAt);
}

export function deleteExpiredLocksForWorkspace(
  db: Database.Database,
  workspaceId: string,
  expiredAt: string
): void {
  db.prepare(
    "DELETE FROM workspace_locks WHERE workspace_id = ? AND expires_at IS NOT NULL AND expires_at <= ?"
  ).run(workspaceId, expiredAt);
}

export function deleteLockForWorkspace(
  db: Database.Database,
  workspaceId: string
): void {
  db.prepare("DELETE FROM workspace_locks WHERE workspace_id = ?").run(workspaceId);
}

export function listExpiredWorkspaceLocks(
  db: Database.Database,
  expiredAt: string
): WorkspaceLockRow[] {
  return db
    .prepare(
      "SELECT * FROM workspace_locks WHERE expires_at IS NOT NULL AND expires_at <= ? ORDER BY workspace_id ASC"
    )
    .all(expiredAt) as WorkspaceLockRow[];
}

export function deleteExpiredWorkspaceLocks(
  db: Database.Database,
  expiredAt: string
): number {
  const result = db
    .prepare(
      "DELETE FROM workspace_locks WHERE expires_at IS NOT NULL AND expires_at <= ?"
    )
    .run(expiredAt);
  return result.changes;
}

// ── Workspace Snapshots ─────────────────────────────────────────────────────

export function insertWorkspaceSnapshot(
  db: Database.Database,
  row: WorkspaceSnapshotRow
): void {
  db.prepare(`
    INSERT INTO workspace_snapshots
      (id, workspace_id, kind, created_at)
    VALUES
      (@id, @workspace_id, @kind, @created_at)
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

// ── Idempotency Records ─────────────────────────────────────────────────────

export interface IdempotencyRow {
  operation_id: string;
  command: string;
  input_hash: string;
  result_json: string;
  created_at: string;
}

export function getIdempotencyRecord(
  db: Database.Database,
  operationId: string
): IdempotencyRow | undefined {
  return db
    .prepare("SELECT * FROM workspace_idempotency WHERE operation_id = ?")
    .get(operationId) as IdempotencyRow | undefined;
}

export function insertIdempotencyRecord(
  db: Database.Database,
  row: IdempotencyRow
): void {
  db.prepare(`
    INSERT INTO workspace_idempotency
      (operation_id, command, input_hash, result_json, created_at)
    VALUES
      (@operation_id, @command, @input_hash, @result_json, @created_at)
  `).run(row);
}

export function updateIdempotencyResult(
  db: Database.Database,
  operationId: string,
  resultJson: string
): void {
  db.prepare(
    "UPDATE workspace_idempotency SET result_json = ? WHERE operation_id = ?"
  ).run(resultJson, operationId);
}

// ── Workspace Events ────────────────────────────────────────────────────────

export function insertWorkspaceEvent(
  db: Database.Database,
  row: WorkspaceEventRow
): void {
  db.prepare(`
    INSERT INTO workspace_events
      (id, workspace_id, event, data, actor, created_at)
    VALUES
      (@id, @workspace_id, @event, @data, @actor, @created_at)
  `).run(row);
}

export function migrateStatusColumn(db: Database.Database): void {
  db.exec(`
    UPDATE workspaces SET status = CASE status
      WHEN 'created'  THEN 'CREATED'
      WHEN 'prepared' THEN 'PREPARING'
      WHEN 'locked'   THEN 'READY'
      WHEN 'active'   THEN 'RUNNING'
      WHEN 'archived' THEN 'ARCHIVED'
      WHEN 'cleaned'  THEN 'CLEANED'
      WHEN 'failed'   THEN 'FAILED'
      WHEN 'ready'    THEN 'READY'
      WHEN 'running'  THEN 'RUNNING'
      ELSE status
    END
  `);
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

// ── Artifacts ───────────────────────────────────────────────────────────────

export function insertArtifact(
  db: Database.Database,
  row: ArtifactRow
): void {
  db.prepare(`
    INSERT INTO artifacts
      (id, snapshot_id, kind, path, checksum, media_type, created_at)
    VALUES
      (@id, @snapshot_id, @kind, @path, @checksum, @media_type, @created_at)
  `).run(row);
}

export function listArtifactsForSnapshot(
  db: Database.Database,
  snapshotId: string
): ArtifactRow[] {
  return db
    .prepare("SELECT * FROM artifacts WHERE snapshot_id = ? ORDER BY created_at DESC")
    .all(snapshotId) as ArtifactRow[];
}

// ── Integration Locks ────────────────────────────────────────────────────────

export function getIntegrationLock(
  db: Database.Database,
  workspaceId: string
): IntegrationLockRow | undefined {
  const now = new Date().toISOString();
  return db
    .prepare(
      "SELECT * FROM integration_locks WHERE workspace_id = ? AND (expires_at IS NULL OR expires_at > ?)"
    )
    .get(workspaceId, now) as IntegrationLockRow | undefined;
}

export function getIntegrationLockExpired(
  db: Database.Database,
  workspaceId: string
): IntegrationLockRow | undefined {
  return db
    .prepare("SELECT * FROM integration_locks WHERE workspace_id = ?")
    .get(workspaceId) as IntegrationLockRow | undefined;
}

export function insertIntegrationLock(
  db: Database.Database,
  row: IntegrationLockRow
): void {
  db.prepare(`
    INSERT INTO integration_locks
      (id, workspace_id, owner, expires_at, acquired_at, last_heartbeat)
    VALUES
      (@id, @workspace_id, @owner, @expires_at, @acquired_at, @last_heartbeat)
  `).run(row);
}

export function deleteIntegrationLock(
  db: Database.Database,
  workspaceId: string,
  owner: string
): boolean {
  const result = db.prepare(
    "DELETE FROM integration_locks WHERE workspace_id = ? AND owner = ?"
  ).run(workspaceId, owner);
  return result.changes > 0;
}

export function deleteExpiredIntegrationLock(
  db: Database.Database,
  workspaceId: string,
  expiredAt: string
): void {
  db.prepare(
    "DELETE FROM integration_locks WHERE workspace_id = ? AND expires_at IS NOT NULL AND expires_at <= ?"
  ).run(workspaceId, expiredAt);
}

export function listExpiredIntegrationLocks(
  db: Database.Database,
  expiredAt: string
): IntegrationLockRow[] {
  return db
    .prepare(
      "SELECT * FROM integration_locks WHERE expires_at IS NOT NULL AND expires_at <= ? ORDER BY workspace_id ASC"
    )
    .all(expiredAt) as IntegrationLockRow[];
}

export function deleteExpiredIntegrationLocks(
  db: Database.Database,
  expiredAt: string
): number {
  const result = db
    .prepare(
      "DELETE FROM integration_locks WHERE expires_at IS NOT NULL AND expires_at <= ?"
    )
    .run(expiredAt);
  return result.changes;
}

export function updateIntegrationLockHeartbeat(
  db: Database.Database,
  workspaceId: string,
  owner: string,
  lastHeartbeat: string
): boolean {
  const result = db.prepare(
    `UPDATE integration_locks
     SET last_heartbeat = ?
     WHERE workspace_id = ? AND owner = ? AND (expires_at IS NULL OR expires_at > ?)`
  ).run(lastHeartbeat, workspaceId, owner, lastHeartbeat);
  return result.changes > 0;
}

export function updateIntegrationLockLease(
  db: Database.Database,
  workspaceId: string,
  owner: string,
  lastHeartbeat: string,
  expiresAt: string | null,
): boolean {
  const result = db.prepare(
    `UPDATE integration_locks
     SET last_heartbeat = ?, expires_at = ?
     WHERE workspace_id = ? AND owner = ? AND (expires_at IS NULL OR expires_at > ?)`
  ).run(lastHeartbeat, expiresAt, workspaceId, owner, lastHeartbeat);
  return result.changes > 0;
}

// ── Operation Journal ────────────────────────────────────────────────────────

export function insertOperationJournal(
  db: Database.Database,
  row: OperationJournalRow
): void {
  db.prepare(`
    INSERT INTO operation_journal
      (operation_id, workspace_id, command, status, input_hash, result_json, created_at, updated_at)
    VALUES
      (@operation_id, @workspace_id, @command, @status, @input_hash, @result_json, @created_at, @updated_at)
  `).run(row);
}

export function getOperationJournal(
  db: Database.Database,
  operationId: string,
  workspaceId: string
): OperationJournalRow | undefined {
  return db
    .prepare(
      "SELECT * FROM operation_journal WHERE operation_id = ? AND workspace_id = ?"
    )
    .get(operationId, workspaceId) as OperationJournalRow | undefined;
}

export function updateOperationJournalStatus(
  db: Database.Database,
  operationId: string,
  workspaceId: string,
  status: string,
  resultJson: string | null,
  updatedAt: string
): void {
  db.prepare(
    `UPDATE operation_journal
     SET status = ?, result_json = ?, updated_at = ?
     WHERE operation_id = ? AND workspace_id = ?`
  ).run(status, resultJson, updatedAt, operationId, workspaceId);
}

/**
 * Record an operation start, reusing a journal row left behind by a failed
 * or crashed attempt instead of violating the (operation_id, workspace_id)
 * primary key. A retry of the same operation id must be able to proceed.
 */
export function startOperationJournal(
  db: Database.Database,
  row: OperationJournalRow
): void {
  const existing = getOperationJournal(db, row.operation_id, row.workspace_id);
  if (existing) {
    updateOperationJournalStatus(
      db,
      row.operation_id,
      row.workspace_id,
      "started",
      null,
      row.updated_at
    );
    return;
  }
  insertOperationJournal(db, row);
}

/**
 * Re-point a journal row at its real workspace after the workspace row is
 * created (prepare operations journal with a placeholder workspace id).
 */
export function updateOperationJournalWorkspace(
  db: Database.Database,
  operationId: string,
  workspaceId: string
): void {
  db.prepare(
    `UPDATE operation_journal SET workspace_id = ? WHERE operation_id = ?`
  ).run(workspaceId, operationId);
}

export function listOperationJournalForWorkspace(
  db: Database.Database,
  workspaceId: string
): OperationJournalRow[] {
  return db
    .prepare(
      "SELECT * FROM operation_journal WHERE workspace_id = ? ORDER BY created_at ASC"
    )
    .all(workspaceId) as OperationJournalRow[];
}

export function updateWorkspaceHead(
  db: Database.Database,
  workspaceId: string,
  headCommit: string,
  updatedAt: string
): void {
  db.prepare(
    "UPDATE workspaces SET base_commit = ?, updated_at = ? WHERE id = ?"
  ).run(headCommit, updatedAt, workspaceId);
}

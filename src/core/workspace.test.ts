import Database from "better-sqlite3";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getWorkspace, listAllWorkspaces } from "./workspace.js";
import type { Workspace, WorkspaceManifest } from "../types/index.js";
import { ZigmaError } from "../types/index.js";
import { insertWorkspace } from "../db/queries.js";

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
  status TEXT NOT NULL DEFAULT 'created',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

const baseRow = {
  id: "ws_core_001",
  project_id: null,
  task_id: null,
  flow_run_id: null,
  repository_url: "https://github.com/test/repo",
  base_ref: "main",
  base_commit: "abc123def456",
  branch: "test-branch",
  path: "/tmp/ws_core_001",
  mode: "writable",
  status: "active",
  created_at: "2025-01-01T00:00:00.000Z",
  updated_at: "2025-01-01T00:00:00.000Z",
};

describe("Workspace core - workflow execution context", () => {
  let db: Database.Database;

  beforeAll(() => {
    db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA_SQL);
  });

  afterAll(() => {
    db.close();
  });

  describe("getWorkspace", () => {
    it("should return a Workspace with workflowRunId, jobId, stepId, and agentId", () => {
      insertWorkspace(db, {
        ...baseRow,
        id: "ws_core_wf_001",
        workflow_run_id: "wr_core_001",
        job_id: "job_core_001",
        step_id: "step_core_001",
        agent_id: "agent_core_001",
      } as Parameters<typeof insertWorkspace>[1]);

      const ws = getWorkspace(db, "ws_core_wf_001") as Workspace;
      expect(ws.workflowRunId).toBe("wr_core_001");
      expect(ws.jobId).toBe("job_core_001");
      expect(ws.stepId).toBe("step_core_001");
      expect(ws.agentId).toBe("agent_core_001");
    });

    it("should return undefined for workflow context fields when not set", () => {
      insertWorkspace(db, {
        ...baseRow,
        id: "ws_core_null_001",
        workflow_run_id: null,
        job_id: null,
        step_id: null,
        agent_id: null,
      } as Parameters<typeof insertWorkspace>[1]);

      const ws = getWorkspace(db, "ws_core_null_001") as Workspace;
      expect(ws.workflowRunId).toBeUndefined();
      expect(ws.jobId).toBeUndefined();
      expect(ws.stepId).toBeUndefined();
      expect(ws.agentId).toBeUndefined();
    });

    it("should preserve existing fields alongside new workflow context fields", () => {
      insertWorkspace(db, {
        ...baseRow,
        id: "ws_core_all_001",
        task_id: "task_123",
        flow_run_id: "flow_456",
        workflow_run_id: "wr_all_001",
        job_id: "job_all_001",
        step_id: "step_all_001",
        agent_id: "agent_all_001",
      } as Parameters<typeof insertWorkspace>[1]);

      const ws = getWorkspace(db, "ws_core_all_001") as Workspace;
      expect(ws.id).toBe("ws_core_all_001");
      expect(ws.taskId).toBe("task_123");
      expect(ws.flowRunId).toBe("flow_456");
      expect(ws.workflowRunId).toBe("wr_all_001");
      expect(ws.jobId).toBe("job_all_001");
      expect(ws.stepId).toBe("step_all_001");
      expect(ws.agentId).toBe("agent_all_001");
      expect(ws.repositoryUrl).toBe("https://github.com/test/repo");
      expect(ws.baseRef).toBe("main");
      expect(ws.mode).toBe("writable");
      expect(ws.status).toBe("active");
    });
  });

  describe("listAllWorkspaces", () => {
    it("should return workspaces with workflow execution context fields", () => {
      const workspaces = listAllWorkspaces(db) as Workspace[];
      expect(workspaces.length).toBeGreaterThan(0);
      for (const ws of workspaces) {
        expect(ws).toHaveProperty("workflowRunId");
        expect(ws).toHaveProperty("jobId");
        expect(ws).toHaveProperty("stepId");
        expect(ws).toHaveProperty("agentId");
      }
    });
  });

  describe("ZigmaError - WORKSPACE_NOT_FOUND", () => {
    it("should throw ZigmaError for non-existent workspace", () => {
      expect(() => getWorkspace(db, "ws_nonexistent")).toThrow(ZigmaError);
    });
  });
});

describe("WorkspaceManifest - workflow execution context", () => {
  it("should include workflowRunId, jobId, stepId, and agentId in manifest type", () => {
    const manifest: WorkspaceManifest = {
      workspace_id: "ws_manifest_001",
      project_id: null,
      task_id: null,
      flow_run_id: null,
      workflow_run_id: "wr_manifest",
      job_id: "job_manifest",
      step_id: "step_manifest",
      agent_id: "agent_manifest",
      repo: "https://github.com/test/repo",
      base_ref: "main",
      base_commit: "abc123",
      branch: "test-branch",
      path: "/tmp/ws_manifest",
      mode: "writable",
      allowed_paths: ["."],
      denied_paths: [],
    };

    expect(manifest.workflow_run_id).toBe("wr_manifest");
    expect(manifest.job_id).toBe("job_manifest");
    expect(manifest.step_id).toBe("step_manifest");
    expect(manifest.agent_id).toBe("agent_manifest");
  });

  it("should allow null for workflow context fields in manifest", () => {
    const manifest: WorkspaceManifest = {
      workspace_id: "ws_null_manifest",
      project_id: null,
      task_id: null,
      flow_run_id: null,
      workflow_run_id: null,
      job_id: null,
      step_id: null,
      agent_id: null,
      repo: "https://github.com/test/repo",
      base_ref: "main",
      base_commit: "abc123",
      branch: "test-branch",
      path: "/tmp/ws_null",
      mode: "read-only",
      allowed_paths: [],
      denied_paths: [],
    };

    expect(manifest.workflow_run_id).toBeNull();
    expect(manifest.job_id).toBeNull();
    expect(manifest.step_id).toBeNull();
    expect(manifest.agent_id).toBeNull();
  });
});

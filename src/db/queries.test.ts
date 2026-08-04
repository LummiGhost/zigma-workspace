import Database from "better-sqlite3";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  insertWorkspace,
  getWorkspaceById,
  listWorkspaces,
  updateWorkspaceBindings,
} from "./queries.js";

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

describe("Workspace queries - workflow execution context", () => {
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

  const baseRow = {
    id: "ws_test001",
    project_id: null,
    task_id: null,
    flow_run_id: null,
    repository_url: "https://github.com/test/repo",
    base_ref: "main",
    base_commit: "abc123def456",
    branch: "test-branch",
    path: "/tmp/ws_test001",
    mode: "writable",
    status: "created",
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-01T00:00:00.000Z",
  };

  it("should have workflow_execution context columns in workspaces table", () => {
    const columns = db.pragma("table_info(workspaces)") as Array<{
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>;
    const names = columns.map((c) => c.name);
    expect(names).toContain("workflow_run_id");
    expect(names).toContain("job_id");
    expect(names).toContain("step_id");
    expect(names).toContain("agent_id");
  });

  describe("insertWorkspace", () => {
    it("should store workflowRunId, jobId, stepId, and agentId", () => {
      const row = {
        ...baseRow,
        id: "ws_wf_001",
        workflow_run_id: "wr_prod_001",
        job_id: "job_build_001",
        step_id: "step_compile_001",
        agent_id: "agent_claude_001",
      };
      insertWorkspace(db, row as Parameters<typeof insertWorkspace>[1]);
      const retrieved = getWorkspaceById(db, "ws_wf_001");
      expect(retrieved?.workflow_run_id).toBe("wr_prod_001");
      expect(retrieved?.job_id).toBe("job_build_001");
      expect(retrieved?.step_id).toBe("step_compile_001");
      expect(retrieved?.agent_id).toBe("agent_claude_001");
    });

    it("should accept null workflow context fields", () => {
      const row = {
        ...baseRow,
        id: "ws_wf_002",
        workflow_run_id: null,
        job_id: null,
        step_id: null,
        agent_id: null,
      };
      insertWorkspace(db, row as Parameters<typeof insertWorkspace>[1]);
      const retrieved = getWorkspaceById(db, "ws_wf_002");
      expect(retrieved?.workflow_run_id).toBeNull();
      expect(retrieved?.job_id).toBeNull();
      expect(retrieved?.step_id).toBeNull();
      expect(retrieved?.agent_id).toBeNull();
    });
  });

  describe("getWorkspaceById", () => {
    it("should return rows with workflowRunId, jobId, stepId, and agentId", () => {
      const id = "ws_wf_001";
      const retrieved = getWorkspaceById(db, id);
      expect(retrieved).toBeDefined();
      expect(retrieved).toHaveProperty("workflow_run_id");
      expect(retrieved).toHaveProperty("job_id");
      expect(retrieved).toHaveProperty("step_id");
      expect(retrieved).toHaveProperty("agent_id");
      expect(retrieved?.workflow_run_id).toBe("wr_prod_001");
    });
  });

  describe("listWorkspaces", () => {
    it("should return rows with workflow context fields", () => {
      const workspaces = listWorkspaces(db);
      expect(workspaces.length).toBeGreaterThan(0);
      for (const ws of workspaces) {
        expect(ws).toHaveProperty("workflow_run_id");
        expect(ws).toHaveProperty("job_id");
        expect(ws).toHaveProperty("step_id");
        expect(ws).toHaveProperty("agent_id");
      }
    });
  });

  describe("updateWorkspaceBindings", () => {
    it("should update workflowRunId, jobId, stepId, and agentId", () => {
      updateWorkspaceBindings(
        db,
        "ws_wf_001",
        null,
        null,
        "wr_prod_002",
        "job_build_002",
        "step_compile_002",
        "agent_claude_002",
        "2025-01-02T00:00:00.000Z"
      );

      const retrieved = getWorkspaceById(db, "ws_wf_001");
      expect(retrieved?.workflow_run_id).toBe("wr_prod_002");
      expect(retrieved?.job_id).toBe("job_build_002");
      expect(retrieved?.step_id).toBe("step_compile_002");
      expect(retrieved?.agent_id).toBe("agent_claude_002");
    });

    it("should preserve existing task_id and flow_run_id when updating workflow context fields", () => {
      updateWorkspaceBindings(
        db,
        "ws_wf_001",
        "task_keep",
        "flow_keep",
        "wr_prod_003",
        "job_build_003",
        "step_compile_003",
        "agent_claude_003",
        "2025-01-03T00:00:00.000Z"
      );

      const retrieved = getWorkspaceById(db, "ws_wf_001");
      expect(retrieved?.task_id).toBe("task_keep");
      expect(retrieved?.flow_run_id).toBe("flow_keep");
      expect(retrieved?.workflow_run_id).toBe("wr_prod_003");
      expect(retrieved?.job_id).toBe("job_build_003");
    });

    it("should allow null values for workflow context fields", () => {
      updateWorkspaceBindings(
        db,
        "ws_wf_001",
        null,
        null,
        null,
        null,
        null,
        null,
        "2025-01-04T00:00:00.000Z"
      );

      const retrieved = getWorkspaceById(db, "ws_wf_001");
      expect(retrieved?.workflow_run_id).toBeNull();
      expect(retrieved?.job_id).toBeNull();
      expect(retrieved?.step_id).toBeNull();
      expect(retrieved?.agent_id).toBeNull();
    });
  });
});

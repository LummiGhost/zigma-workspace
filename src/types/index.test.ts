import { describe, it, expect } from "vitest";
import type {
  Workspace,
  WorkspaceRow,
  WorkspaceManifest,
  CreateWorkspaceInput,
  BindWorkspaceRunInput,
} from "./index.js";
import { ZigmaError, CONTRACT_VERSION } from "./index.js";

describe("Types - workflow execution context", () => {
  describe("Workspace", () => {
    it("should include optional workflowRunId, jobId, stepId, agentId", () => {
      const ws: Workspace = {
        id: "ws_type_001",
        repositoryUrl: "https://github.com/test/repo",
        baseRef: "main",
        baseCommit: "abc123",
        branch: "test",
        path: "/tmp/ws",
        mode: "writable",
        status: "active",
        workflowRunId: "wr_001",
        jobId: "job_001",
        stepId: "step_001",
        agentId: "agent_001",
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      };
      expect(ws.workflowRunId).toBe("wr_001");
      expect(ws.jobId).toBe("job_001");
      expect(ws.stepId).toBe("step_001");
      expect(ws.agentId).toBe("agent_001");
    });

    it("should allow undefined for all new fields", () => {
      const ws: Workspace = {
        id: "ws_type_002",
        repositoryUrl: "https://github.com/test/repo",
        baseRef: "main",
        baseCommit: "abc123",
        branch: "test",
        path: "/tmp/ws2",
        mode: "read-only",
        status: "created",
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-01T00:00:00.000Z",
      };
      expect(ws.workflowRunId).toBeUndefined();
      expect(ws.jobId).toBeUndefined();
      expect(ws.stepId).toBeUndefined();
      expect(ws.agentId).toBeUndefined();
    });
  });

  describe("WorkspaceRow", () => {
    it("should include optional workflow_run_id, job_id, step_id, agent_id", () => {
      const row: WorkspaceRow = {
        id: "ws_row_001",
        project_id: null,
        task_id: null,
        flow_run_id: null,
        workflow_run_id: "wr_001",
        job_id: "job_001",
        step_id: "step_001",
        agent_id: "agent_001",
        repository_url: "https://github.com/test/repo",
        base_ref: "main",
        base_commit: "abc123",
        branch: "test",
        path: "/tmp/ws",
        mode: "writable",
        status: "active",
        created_at: "2025-01-01T00:00:00.000Z",
        updated_at: "2025-01-01T00:00:00.000Z",
      };
      expect(row.workflow_run_id).toBe("wr_001");
      expect(row.job_id).toBe("job_001");
      expect(row.step_id).toBe("step_001");
      expect(row.agent_id).toBe("agent_001");
    });

    it("should allow null for all new db columns", () => {
      const row: WorkspaceRow = {
        id: "ws_row_002",
        project_id: null,
        task_id: null,
        flow_run_id: null,
        workflow_run_id: null,
        job_id: null,
        step_id: null,
        agent_id: null,
        repository_url: "https://github.com/test/repo",
        base_ref: "main",
        base_commit: "abc123",
        branch: "test",
        path: "/tmp/ws2",
        mode: "read-only",
        status: "created",
        created_at: "2025-01-01T00:00:00.000Z",
        updated_at: "2025-01-01T00:00:00.000Z",
      };
      expect(row.workflow_run_id).toBeNull();
      expect(row.job_id).toBeNull();
      expect(row.step_id).toBeNull();
      expect(row.agent_id).toBeNull();
    });
  });

  describe("CreateWorkspaceInput", () => {
    it("should include optional workflowRunId, jobId, stepId, agentId", () => {
      const input: CreateWorkspaceInput = {
        repositoryUrl: "https://github.com/test/repo",
        baseRef: "main",
        branch: "test-branch",
        workflowRunId: "wr_create_001",
        jobId: "job_create_001",
        stepId: "step_create_001",
        agentId: "agent_create_001",
      };
      expect(input.workflowRunId).toBe("wr_create_001");
      expect(input.jobId).toBe("job_create_001");
      expect(input.stepId).toBe("step_create_001");
      expect(input.agentId).toBe("agent_create_001");
    });

    it("should allow omitting new fields", () => {
      const input: CreateWorkspaceInput = {
        repositoryUrl: "https://github.com/test/repo",
        baseRef: "main",
        branch: "test-branch",
      };
      expect(input.workflowRunId).toBeUndefined();
      expect(input.jobId).toBeUndefined();
      expect(input.stepId).toBeUndefined();
      expect(input.agentId).toBeUndefined();
    });
  });

  describe("BindWorkspaceRunInput", () => {
    it("should include optional workflowRunId, jobId, stepId, agentId", () => {
      const input: BindWorkspaceRunInput = {
        workspaceId: "ws_bind_001",
        workflowRunId: "wr_bind",
        jobId: "job_bind",
        stepId: "step_bind",
        agentId: "agent_bind",
      };
      expect(input.workflowRunId).toBe("wr_bind");
      expect(input.jobId).toBe("job_bind");
      expect(input.stepId).toBe("step_bind");
      expect(input.agentId).toBe("agent_bind");
    });

    it("should allow omitting new fields", () => {
      const input: BindWorkspaceRunInput = {
        workspaceId: "ws_bind_002",
      };
      expect(input.workflowRunId).toBeUndefined();
      expect(input.jobId).toBeUndefined();
      expect(input.stepId).toBeUndefined();
      expect(input.agentId).toBeUndefined();
    });
  });

  describe("WorkspaceManifest", () => {
    it("should include workflow_run_id, job_id, step_id, agent_id", () => {
      const manifest: WorkspaceManifest = {
        workspace_id: "ws_001",
        project_id: null,
        task_id: null,
        flow_run_id: null,
        workflow_run_id: "wr_001",
        job_id: "job_001",
        step_id: "step_001",
        agent_id: "agent_001",
        repo: "https://github.com/test/repo",
        base_ref: "main",
        base_commit: "abc123",
        branch: "test",
        path: "/tmp/ws",
        mode: "writable",
        allowed_paths: ["."],
        denied_paths: [],
      };
      expect(manifest.workflow_run_id).toBe("wr_001");
      expect(manifest.job_id).toBe("job_001");
      expect(manifest.step_id).toBe("step_001");
      expect(manifest.agent_id).toBe("agent_001");
    });
  });

  describe("CONTRACT_VERSION", () => {
    it("should remain 1 (additive fields are backward-compatible)", () => {
      expect(CONTRACT_VERSION).toBe(1);
    });
  });

  describe("ZigmaError", () => {
    it("should construct with code, message, and optional details", () => {
      const err = new ZigmaError("INVALID_INPUT", "test message", {
        field: "workflowRunId",
      });
      expect(err).toBeInstanceOf(Error);
      expect(err.code).toBe("INVALID_INPUT");
      expect(err.message).toBe("test message");
      expect(err.details).toEqual({ field: "workflowRunId" });
    });
  });
});

import { describe, it, expect } from "vitest";
import {
  WorkspaceStates,
  TRANSITIONS,
  transition,
  migrateLegacyStatus,
  isTerminal,
} from "./state-machine.js";
import type { WorkspaceState } from "./state-machine.js";

// ── WorkspaceState union ──────────────────────────────────────────────────────

describe("WorkspaceState", () => {
  it("should include all expected lifecycle states", () => {
    const expected = [
      "CREATED",
      "PREPARING",
      "READY",
      "RUNNING",
      "WAIT_REVIEW",
      "MERGED",
      "CLEANED",
      "FAILED",
      "ARCHIVED",
    ];
    expect(WorkspaceStates).toEqual(expected);
  });

  it("should have exactly 9 states", () => {
    expect(WorkspaceStates).toHaveLength(9);
  });
});

// ── TRANSITIONS map ───────────────────────────────────────────────────────────

describe("TRANSITIONS", () => {
  it("should define entries for every WorkspaceState", () => {
    for (const state of WorkspaceStates) {
      expect(TRANSITIONS).toHaveProperty(state);
    }
  });

  it("should allow CREATED → PREPARING", () => {
    expect(TRANSITIONS.CREATED).toContain("PREPARING");
  });

  it("should allow CREATED → FAILED", () => {
    expect(TRANSITIONS.CREATED).toContain("FAILED");
  });

  it("should allow PREPARING → READY", () => {
    expect(TRANSITIONS.PREPARING).toContain("READY");
  });

  it("should allow PREPARING → FAILED", () => {
    expect(TRANSITIONS.PREPARING).toContain("FAILED");
  });

  it("should allow READY → RUNNING", () => {
    expect(TRANSITIONS.READY).toContain("RUNNING");
  });

  it("should allow READY → FAILED", () => {
    expect(TRANSITIONS.READY).toContain("FAILED");
  });

  it("should allow READY → ARCHIVED", () => {
    expect(TRANSITIONS.READY).toContain("ARCHIVED");
  });

  it("should allow RUNNING → WAIT_REVIEW", () => {
    expect(TRANSITIONS.RUNNING).toContain("WAIT_REVIEW");
  });

  it("should allow RUNNING → FAILED", () => {
    expect(TRANSITIONS.RUNNING).toContain("FAILED");
  });

  it("should allow RUNNING → ARCHIVED", () => {
    expect(TRANSITIONS.RUNNING).toContain("ARCHIVED");
  });

  it("should allow WAIT_REVIEW → MERGED", () => {
    expect(TRANSITIONS.WAIT_REVIEW).toContain("MERGED");
  });

  it("should allow WAIT_REVIEW → FAILED", () => {
    expect(TRANSITIONS.WAIT_REVIEW).toContain("FAILED");
  });

  it("should allow MERGED → CLEANED", () => {
    expect(TRANSITIONS.MERGED).toContain("CLEANED");
  });

  it("should allow MERGED → FAILED", () => {
    expect(TRANSITIONS.MERGED).toContain("FAILED");
  });

  it("should allow MERGED → ARCHIVED", () => {
    expect(TRANSITIONS.MERGED).toContain("ARCHIVED");
  });

  it("should allow FAILED → CREATED for retry", () => {
    expect(TRANSITIONS.FAILED).toContain("CREATED");
  });

  it("should have no outbound transitions from CLEANED (terminal)", () => {
    expect(TRANSITIONS.CLEANED).toEqual([]);
  });

  it("should have no outbound transitions from ARCHIVED (terminal)", () => {
    expect(TRANSITIONS.ARCHIVED).toEqual([]);
  });
});

// ── transition() ──────────────────────────────────────────────────────────────

describe("transition()", () => {
  describe("happy-path chain", () => {
    it("CREATED → PREPARING should succeed", () => {
      const result = transition("CREATED", "PREPARING");
      expect(result).toBe("PREPARING");
    });

    it("PREPARING → READY should succeed", () => {
      const result = transition("PREPARING", "READY");
      expect(result).toBe("READY");
    });

    it("READY → RUNNING should succeed", () => {
      const result = transition("READY", "RUNNING");
      expect(result).toBe("RUNNING");
    });

    it("RUNNING → WAIT_REVIEW should succeed", () => {
      const result = transition("RUNNING", "WAIT_REVIEW");
      expect(result).toBe("WAIT_REVIEW");
    });

    it("WAIT_REVIEW → MERGED should succeed", () => {
      const result = transition("WAIT_REVIEW", "MERGED");
      expect(result).toBe("MERGED");
    });

    it("MERGED → CLEANED should succeed", () => {
      const result = transition("MERGED", "CLEANED");
      expect(result).toBe("CLEANED");
    });

    it("should complete the full happy path chain", () => {
      let state: WorkspaceState = "CREATED";
      state = transition(state, "PREPARING");
      expect(state).toBe("PREPARING");
      state = transition(state, "READY");
      expect(state).toBe("READY");
      state = transition(state, "RUNNING");
      expect(state).toBe("RUNNING");
      state = transition(state, "WAIT_REVIEW");
      expect(state).toBe("WAIT_REVIEW");
      state = transition(state, "MERGED");
      expect(state).toBe("MERGED");
      state = transition(state, "CLEANED");
      expect(state).toBe("CLEANED");
    });
  });

  describe("failure transitions", () => {
    it("CREATED → FAILED should succeed", () => {
      expect(transition("CREATED", "FAILED")).toBe("FAILED");
    });

    it("PREPARING → FAILED should succeed", () => {
      expect(transition("PREPARING", "FAILED")).toBe("FAILED");
    });

    it("READY → FAILED should succeed", () => {
      expect(transition("READY", "FAILED")).toBe("FAILED");
    });

    it("RUNNING → FAILED should succeed", () => {
      expect(transition("RUNNING", "FAILED")).toBe("FAILED");
    });

    it("WAIT_REVIEW → FAILED should succeed", () => {
      expect(transition("WAIT_REVIEW", "FAILED")).toBe("FAILED");
    });

    it("MERGED → FAILED should succeed", () => {
      expect(transition("MERGED", "FAILED")).toBe("FAILED");
    });

    it("FAILED → CREATED (retry) should succeed", () => {
      expect(transition("FAILED", "CREATED")).toBe("CREATED");
    });
  });

  describe("archiving transitions", () => {
    it("READY → ARCHIVED should succeed", () => {
      expect(transition("READY", "ARCHIVED")).toBe("ARCHIVED");
    });

    it("RUNNING → ARCHIVED should succeed", () => {
      expect(transition("RUNNING", "ARCHIVED")).toBe("ARCHIVED");
    });

    it("MERGED → ARCHIVED should succeed", () => {
      expect(transition("MERGED", "ARCHIVED")).toBe("ARCHIVED");
    });
  });

  describe("invalid transitions", () => {
    it("should reject CREATED → RUNNING (skipping PREPARING and READY)", () => {
      expect(() => transition("CREATED", "RUNNING")).toThrow();
    });

    it("should reject PREPARING → RUNNING (skipping READY)", () => {
      expect(() => transition("PREPARING", "RUNNING")).toThrow();
    });

    it("should reject READY → WAIT_REVIEW (skipping RUNNING)", () => {
      expect(() => transition("READY", "WAIT_REVIEW")).toThrow();
    });

    it("should reject RUNNING → MERGED (skipping WAIT_REVIEW)", () => {
      expect(() => transition("RUNNING", "MERGED")).toThrow();
    });

    it("should reject RUNNING → CLEANED (skipping WAIT_REVIEW and MERGED)", () => {
      expect(() => transition("RUNNING", "CLEANED")).toThrow();
    });

    it("should reject CREATED → CLEANED (skipping entire chain)", () => {
      expect(() => transition("CREATED", "CLEANED")).toThrow();
    });

    it("should reject PREPARING → ARCHIVED directly", () => {
      expect(() => transition("PREPARING", "ARCHIVED")).toThrow();
    });

    it("should reject self-transition CREATED → CREATED", () => {
      expect(() => transition("CREATED", "CREATED")).toThrow();
    });

    it("should reject self-transition READY → READY", () => {
      expect(() => transition("READY", "READY")).toThrow();
    });
  });

  describe("terminal state transitions", () => {
    it("should reject CLEANED → any state", () => {
      expect(() => transition("CLEANED", "CREATED")).toThrow();
      expect(() => transition("CLEANED", "RUNNING")).toThrow();
      expect(() => transition("CLEANED", "FAILED")).toThrow();
    });

    it("should reject ARCHIVED → any state", () => {
      expect(() => transition("ARCHIVED", "CREATED")).toThrow();
      expect(() => transition("ARCHIVED", "RUNNING")).toThrow();
      expect(() => transition("ARCHIVED", "FAILED")).toThrow();
    });
  });

  describe("error message quality", () => {
    it("should include the current and target state in error message", () => {
      expect(() => transition("CREATED", "CLEANED")).toThrow(
        expect.objectContaining({
          message: expect.stringMatching(/CREATED.*CLEANED/i),
        }),
      );
    });
  });
});

// ── migrateLegacyStatus() ─────────────────────────────────────────────────────

describe("migrateLegacyStatus()", () => {
  it('should map "created" → "CREATED"', () => {
    expect(migrateLegacyStatus("created")).toBe("CREATED");
  });

  it('should map "prepared" → "PREPARING"', () => {
    expect(migrateLegacyStatus("prepared")).toBe("PREPARING");
  });

  it('should map "locked" → "READY" (lock state is separate from lifecycle)', () => {
    expect(migrateLegacyStatus("locked")).toBe("READY");
  });

  it('should map "active" → "RUNNING"', () => {
    expect(migrateLegacyStatus("active")).toBe("RUNNING");
  });

  it('should map "archived" → "ARCHIVED"', () => {
    expect(migrateLegacyStatus("archived")).toBe("ARCHIVED");
  });

  it('should map "cleaned" → "CLEANED"', () => {
    expect(migrateLegacyStatus("cleaned")).toBe("CLEANED");
  });

  it('should map "failed" → "FAILED"', () => {
    expect(migrateLegacyStatus("failed")).toBe("FAILED");
  });

  it("should throw for unknown legacy status values", () => {
    expect(() => migrateLegacyStatus("unknown")).toThrow();
    expect(() => migrateLegacyStatus("")).toThrow();
    expect(() => migrateLegacyStatus("bogus")).toThrow();
  });
});

// ── isTerminal() ──────────────────────────────────────────────────────────────

describe("isTerminal()", () => {
  it("should return true for CLEANED", () => {
    expect(isTerminal("CLEANED")).toBe(true);
  });

  it("should return true for ARCHIVED", () => {
    expect(isTerminal("ARCHIVED")).toBe(true);
  });

  it("should return false for CREATED", () => {
    expect(isTerminal("CREATED")).toBe(false);
  });

  it("should return false for PREPARING", () => {
    expect(isTerminal("PREPARING")).toBe(false);
  });

  it("should return false for READY", () => {
    expect(isTerminal("READY")).toBe(false);
  });

  it("should return false for RUNNING", () => {
    expect(isTerminal("RUNNING")).toBe(false);
  });

  it("should return false for WAIT_REVIEW", () => {
    expect(isTerminal("WAIT_REVIEW")).toBe(false);
  });

  it("should return false for MERGED", () => {
    expect(isTerminal("MERGED")).toBe(false);
  });

  it("should return false for FAILED", () => {
    expect(isTerminal("FAILED")).toBe(false);
  });
});

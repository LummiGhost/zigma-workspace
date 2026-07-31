import { describe, it, expect } from 'vitest';
import {
  WorkspaceStatus,
  isValidTransition,
  validateTransition,
  isTerminal,
  getValidTransitions,
  getAllStates,
  isWorkspaceStatus,
  STATE_ORDER,
} from './state-machine.js';

describe('WorkspaceStatus', () => {
  it('should define all 7 states', () => {
    const states = getAllStates();
    expect(states).toHaveLength(7);
    expect(states).toContain(WorkspaceStatus.CREATED);
    expect(states).toContain(WorkspaceStatus.PREPARING);
    expect(states).toContain(WorkspaceStatus.READY);
    expect(states).toContain(WorkspaceStatus.RUNNING);
    expect(states).toContain(WorkspaceStatus.WAIT_REVIEW);
    expect(states).toContain(WorkspaceStatus.MERGED);
    expect(states).toContain(WorkspaceStatus.CLEANED);
  });

  it('should have states in correct sequential order via STATE_ORDER', () => {
    expect(STATE_ORDER[WorkspaceStatus.CREATED]).toBe(0);
    expect(STATE_ORDER[WorkspaceStatus.PREPARING]).toBe(1);
    expect(STATE_ORDER[WorkspaceStatus.READY]).toBe(2);
    expect(STATE_ORDER[WorkspaceStatus.RUNNING]).toBe(3);
    expect(STATE_ORDER[WorkspaceStatus.WAIT_REVIEW]).toBe(4);
    expect(STATE_ORDER[WorkspaceStatus.MERGED]).toBe(5);
    expect(STATE_ORDER[WorkspaceStatus.CLEANED]).toBe(6);
  });
});

describe('isValidTransition', () => {
  describe('forward transitions', () => {
    it('CREATED → PREPARING', () => {
      expect(isValidTransition(WorkspaceStatus.CREATED, WorkspaceStatus.PREPARING)).toBe(true);
    });

    it('PREPARING → READY', () => {
      expect(isValidTransition(WorkspaceStatus.PREPARING, WorkspaceStatus.READY)).toBe(true);
    });

    it('READY → RUNNING', () => {
      expect(isValidTransition(WorkspaceStatus.READY, WorkspaceStatus.RUNNING)).toBe(true);
    });

    it('RUNNING → WAIT_REVIEW', () => {
      expect(isValidTransition(WorkspaceStatus.RUNNING, WorkspaceStatus.WAIT_REVIEW)).toBe(true);
    });

    it('WAIT_REVIEW → MERGED', () => {
      expect(isValidTransition(WorkspaceStatus.WAIT_REVIEW, WorkspaceStatus.MERGED)).toBe(true);
    });

    it('MERGED → CLEANED', () => {
      expect(isValidTransition(WorkspaceStatus.MERGED, WorkspaceStatus.CLEANED)).toBe(true);
    });
  });

  describe('backward transition (rework)', () => {
    it('WAIT_REVIEW → RUNNING is the only allowed backward transition', () => {
      expect(isValidTransition(WorkspaceStatus.WAIT_REVIEW, WorkspaceStatus.RUNNING)).toBe(true);
    });
  });

  describe('cleanup transitions from any non-terminal state', () => {
    it('RUNNING → CLEANED is valid', () => {
      expect(isValidTransition(WorkspaceStatus.RUNNING, WorkspaceStatus.CLEANED)).toBe(true);
    });

    it('CREATED → CLEANED is valid', () => {
      expect(isValidTransition(WorkspaceStatus.CREATED, WorkspaceStatus.CLEANED)).toBe(true);
    });

    it('PREPARING → CLEANED is valid', () => {
      expect(isValidTransition(WorkspaceStatus.PREPARING, WorkspaceStatus.CLEANED)).toBe(true);
    });

    it('READY → CLEANED is valid', () => {
      expect(isValidTransition(WorkspaceStatus.READY, WorkspaceStatus.CLEANED)).toBe(true);
    });

    it('WAIT_REVIEW → CLEANED is valid', () => {
      expect(isValidTransition(WorkspaceStatus.WAIT_REVIEW, WorkspaceStatus.CLEANED)).toBe(true);
    });

    it('MERGED → CLEANED is valid', () => {
      expect(isValidTransition(WorkspaceStatus.MERGED, WorkspaceStatus.CLEANED)).toBe(true);
    });
  });

  describe('invalid forward transitions (skipping states)', () => {
    it('CREATED → RUNNING is invalid', () => {
      expect(isValidTransition(WorkspaceStatus.CREATED, WorkspaceStatus.RUNNING)).toBe(false);
    });

    it('PREPARING → WAIT_REVIEW is invalid', () => {
      expect(isValidTransition(WorkspaceStatus.PREPARING, WorkspaceStatus.WAIT_REVIEW)).toBe(false);
    });

    it('READY → MERGED is invalid', () => {
      expect(isValidTransition(WorkspaceStatus.READY, WorkspaceStatus.MERGED)).toBe(false);
    });

    it('CREATED → MERGED is invalid', () => {
      expect(isValidTransition(WorkspaceStatus.CREATED, WorkspaceStatus.MERGED)).toBe(false);
    });
  });

  describe('invalid backward transitions', () => {
    it('RUNNING → READY is invalid', () => {
      expect(isValidTransition(WorkspaceStatus.RUNNING, WorkspaceStatus.READY)).toBe(false);
    });

    it('MERGED → WAIT_REVIEW is invalid', () => {
      expect(isValidTransition(WorkspaceStatus.MERGED, WorkspaceStatus.WAIT_REVIEW)).toBe(false);
    });

    it('CLEANED → MERGED is invalid', () => {
      expect(isValidTransition(WorkspaceStatus.CLEANED, WorkspaceStatus.MERGED)).toBe(false);
    });

    it('READY → CREATED is invalid', () => {
      expect(isValidTransition(WorkspaceStatus.READY, WorkspaceStatus.CREATED)).toBe(false);
    });

    it('PREPARING → CREATED is invalid', () => {
      expect(isValidTransition(WorkspaceStatus.PREPARING, WorkspaceStatus.CREATED)).toBe(false);
    });

    it('RUNNING → CREATED is invalid', () => {
      expect(isValidTransition(WorkspaceStatus.RUNNING, WorkspaceStatus.CREATED)).toBe(false);
    });
  });

  describe('terminal state', () => {
    it('CLEANED has no outgoing transitions to other states', () => {
      expect(isValidTransition(WorkspaceStatus.CLEANED, WorkspaceStatus.CREATED)).toBe(false);
      expect(isValidTransition(WorkspaceStatus.CLEANED, WorkspaceStatus.RUNNING)).toBe(false);
      expect(isValidTransition(WorkspaceStatus.CLEANED, WorkspaceStatus.MERGED)).toBe(false);
    });
  });

  describe('self-transitions (idempotent)', () => {
    it('same-state transition is valid for non-terminal states', () => {
      expect(isValidTransition(WorkspaceStatus.CREATED, WorkspaceStatus.CREATED)).toBe(true);
      expect(isValidTransition(WorkspaceStatus.RUNNING, WorkspaceStatus.RUNNING)).toBe(true);
    });

    it('CLEANED → CLEANED is valid (idempotent cleanup)', () => {
      expect(isValidTransition(WorkspaceStatus.CLEANED, WorkspaceStatus.CLEANED)).toBe(true);
    });
  });
});

describe('validateTransition', () => {
  it('returns target state on valid transition', () => {
    expect(validateTransition(WorkspaceStatus.CREATED, WorkspaceStatus.PREPARING)).toBe(WorkspaceStatus.PREPARING);
    expect(validateTransition(WorkspaceStatus.READY, WorkspaceStatus.RUNNING)).toBe(WorkspaceStatus.RUNNING);
  });

  it('returns target state on self-transition', () => {
    expect(validateTransition(WorkspaceStatus.RUNNING, WorkspaceStatus.RUNNING)).toBe(WorkspaceStatus.RUNNING);
  });

  it('returns target state on CLEANED self-transition', () => {
    expect(validateTransition(WorkspaceStatus.CLEANED, WorkspaceStatus.CLEANED)).toBe(WorkspaceStatus.CLEANED);
  });

  it('throws on invalid forward transition', () => {
    expect(() => validateTransition(WorkspaceStatus.CREATED, WorkspaceStatus.RUNNING)).toThrow();
  });

  it('throws on invalid backward transition', () => {
    expect(() => validateTransition(WorkspaceStatus.RUNNING, WorkspaceStatus.READY)).toThrow();
  });

  it('throws on transition from terminal CLEANED to another state', () => {
    expect(() => validateTransition(WorkspaceStatus.CLEANED, WorkspaceStatus.RUNNING)).toThrow();
  });

  it('error message includes from and to status values', () => {
    expect(() => validateTransition(WorkspaceStatus.CREATED, WorkspaceStatus.RUNNING)).toThrow(/created/i);
    expect(() => validateTransition(WorkspaceStatus.CREATED, WorkspaceStatus.RUNNING)).toThrow(/running/i);
  });
});

describe('isTerminal', () => {
  it('CLEANED is terminal', () => {
    expect(isTerminal(WorkspaceStatus.CLEANED)).toBe(true);
  });

  it('non-terminal states return false', () => {
    expect(isTerminal(WorkspaceStatus.CREATED)).toBe(false);
    expect(isTerminal(WorkspaceStatus.PREPARING)).toBe(false);
    expect(isTerminal(WorkspaceStatus.READY)).toBe(false);
    expect(isTerminal(WorkspaceStatus.RUNNING)).toBe(false);
    expect(isTerminal(WorkspaceStatus.WAIT_REVIEW)).toBe(false);
    expect(isTerminal(WorkspaceStatus.MERGED)).toBe(false);
  });
});

describe('isWorkspaceStatus', () => {
  it('returns true for valid status string values', () => {
    expect(isWorkspaceStatus('created')).toBe(true);
    expect(isWorkspaceStatus('preparing')).toBe(true);
    expect(isWorkspaceStatus('ready')).toBe(true);
    expect(isWorkspaceStatus('running')).toBe(true);
    expect(isWorkspaceStatus('wait_review')).toBe(true);
    expect(isWorkspaceStatus('merged')).toBe(true);
    expect(isWorkspaceStatus('cleaned')).toBe(true);
  });

  it('returns false for legacy status strings', () => {
    expect(isWorkspaceStatus('active')).toBe(false);
    expect(isWorkspaceStatus('locked')).toBe(false);
    expect(isWorkspaceStatus('archived')).toBe(false);
    expect(isWorkspaceStatus('failed')).toBe(false);
    expect(isWorkspaceStatus('prepared')).toBe(false);
  });

  it('returns false for unknown strings', () => {
    expect(isWorkspaceStatus('')).toBe(false);
    expect(isWorkspaceStatus('unknown')).toBe(false);
    expect(isWorkspaceStatus('  created  ')).toBe(false);
  });

  it('returns false for non-string values', () => {
    expect(isWorkspaceStatus(null)).toBe(false);
    expect(isWorkspaceStatus(undefined)).toBe(false);
    expect(isWorkspaceStatus(123)).toBe(false);
    expect(isWorkspaceStatus({})).toBe(false);
    expect(isWorkspaceStatus([])).toBe(false);
  });
});

describe('getValidTransitions', () => {
  it('CREATED can transition to PREPARING and CLEANED', () => {
    const targets = getValidTransitions(WorkspaceStatus.CREATED);
    expect(targets).toContain(WorkspaceStatus.PREPARING);
    expect(targets).toContain(WorkspaceStatus.CLEANED);
    expect(targets).toHaveLength(2);
  });

  it('PREPARING can transition to READY and CLEANED', () => {
    const targets = getValidTransitions(WorkspaceStatus.PREPARING);
    expect(targets).toContain(WorkspaceStatus.READY);
    expect(targets).toContain(WorkspaceStatus.CLEANED);
  });

  it('READY can transition to RUNNING and CLEANED', () => {
    const targets = getValidTransitions(WorkspaceStatus.READY);
    expect(targets).toContain(WorkspaceStatus.RUNNING);
    expect(targets).toContain(WorkspaceStatus.CLEANED);
  });

  it('RUNNING can transition to WAIT_REVIEW and CLEANED', () => {
    const targets = getValidTransitions(WorkspaceStatus.RUNNING);
    expect(targets).toContain(WorkspaceStatus.WAIT_REVIEW);
    expect(targets).toContain(WorkspaceStatus.CLEANED);
    expect(targets).toHaveLength(2);
  });

  it('WAIT_REVIEW can transition to RUNNING, MERGED, and CLEANED', () => {
    const targets = getValidTransitions(WorkspaceStatus.WAIT_REVIEW);
    expect(targets).toContain(WorkspaceStatus.RUNNING);
    expect(targets).toContain(WorkspaceStatus.MERGED);
    expect(targets).toContain(WorkspaceStatus.CLEANED);
  });

  it('MERGED can transition to CLEANED only', () => {
    const targets = getValidTransitions(WorkspaceStatus.MERGED);
    expect(targets).toContain(WorkspaceStatus.CLEANED);
    expect(targets).toHaveLength(1);
  });

  it('CLEANED returns empty array', () => {
    const targets = getValidTransitions(WorkspaceStatus.CLEANED);
    expect(targets).toEqual([]);
  });
});

describe('getAllStates', () => {
  it('returns all 7 states in sequential lifecycle order', () => {
    const states = getAllStates();
    expect(states).toEqual([
      WorkspaceStatus.CREATED,
      WorkspaceStatus.PREPARING,
      WorkspaceStatus.READY,
      WorkspaceStatus.RUNNING,
      WorkspaceStatus.WAIT_REVIEW,
      WorkspaceStatus.MERGED,
      WorkspaceStatus.CLEANED,
    ]);
  });

  it('returns a new array each call', () => {
    const a = getAllStates();
    const b = getAllStates();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

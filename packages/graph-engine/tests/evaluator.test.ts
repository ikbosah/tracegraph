/**
 * T2.6 — Approval/suppression evaluator unit tests.
 */
import { describe, it, expect } from 'vitest';
import type {
  Finding, FindingApproval, Suppression, TraceSession, TraceEvent,
} from '@tracegraph/shared-types';
import { SCHEMA_VERSIONS } from '@tracegraph/shared-types';
import { evaluateFindings } from '../src/evaluator';

const FUTURE  = new Date(Date.now() + 365 * 24 * 3600_000).toISOString();
const PAST    = new Date(Date.now() - 1).toISOString();

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id:           'find_abc123',
    fingerprint:  'abc123def456ghi7',
    ruleId:       'behavior.validation.removed',
    severity:     'high',
    category:     'behavior_change',
    title:        'Validation step removed: validateCouponExpiry',
    description:  'Function validateCouponExpiry was removed.',
    evidence:     [{ traceId: 'trace_001', eventIds: [] }],
    recommendation: 'Restore the validation.',
    ...overrides,
  };
}

function makeSession(events: Partial<TraceEvent>[] = []): TraceSession {
  return {
    schemaVersion: SCHEMA_VERSIONS.trace,
    traceId:       'trace_001',
    sessionId:     'sess_001',
    runId:         'run_001',
    workspaceRoot: '/ws',
    language:      'javascript',
    entrypoint:    { type: 'cli_command', command: 'test' },
    startedAt:     1_000_000,
    status:        'passed',
    captureLevel:  { overall: 1, label: 'test', adapters: {} },
    events:        events.map((overrides, i) => ({
      schemaVersion: 'tracegraph.event.v1' as const,
      eventId:       `evt_${i}`,
      traceId:       'trace_001',
      parentEventId: null,
      type:          'function_call' as const,
      language:      'javascript' as const,
      name:          `fn_${i}`,
      startTime:     1_000_000 + i * 100,
      ...overrides,
    })),
  };
}

function makeApproval(fingerprint: string, expiresAt = FUTURE): FindingApproval {
  return {
    findingFingerprint: fingerprint,
    ruleId:             'behavior.validation.removed',
    semanticTarget:     {},
    approvedBy:         'alice',
    reason:             'Accepted regression',
    expiresAt,
    createdAt:          new Date().toISOString(),
  };
}

function makeSuppression(overrides: Partial<Suppression> = {}): Suppression {
  return {
    id:             'suppress_001',
    ruleId:         'behavior.validation.removed',
    semanticTarget: {},
    reason:         'Compensated by auth_check',
    expiresAt:      FUTURE,
    approvedBy:     'bob',
    createdAt:      new Date().toISOString(),
    ...overrides,
  };
}

describe('evaluateFindings()', () => {
  it('returns "open" when no approvals or suppressions', () => {
    const result = evaluateFindings([makeFinding()], makeSession(), [], []);
    expect(result[0]!.status).toBe('open');
  });

  it('returns "approved" when a matching non-expired approval exists', () => {
    const finding  = makeFinding({ fingerprint: 'abc123def456ghi7' });
    const approval = makeApproval('abc123def456ghi7');
    const result   = evaluateFindings([finding], makeSession(), [], [approval]);
    expect(result[0]!.status).toBe('approved');
    expect(result[0]!.approvedBy).toBe('alice');
  });

  it('does NOT approve when approval is expired', () => {
    const finding  = makeFinding({ fingerprint: 'abc123def456ghi7' });
    const approval = makeApproval('abc123def456ghi7', PAST);
    const result   = evaluateFindings([finding], makeSession(), [], [approval]);
    expect(result[0]!.status).toBe('open');
  });

  it('returns "suppressed" when a matching active suppression exists', () => {
    const finding     = makeFinding();
    const suppression = makeSuppression();
    const result      = evaluateFindings([finding], makeSession(), [suppression], []);
    expect(result[0]!.status).toBe('suppressed');
    expect(result[0]!.suppressedBy).toBe('bob');
  });

  it('does NOT suppress when suppression is expired', () => {
    const finding     = makeFinding();
    const suppression = makeSuppression({ expiresAt: PAST });
    const result      = evaluateFindings([finding], makeSession(), [suppression], []);
    expect(result[0]!.status).toBe('open');
  });

  it('suppression with requiresEvidence → suppressed when evidence present in session', () => {
    const finding     = makeFinding();
    const suppression = makeSuppression({
      requiresEvidence: [{ type: 'auth_check', name: 'RolePolicy.update' }],
    });
    const session = makeSession([{
      type: 'auth_check',
      name: 'RolePolicy.update',
    }]);
    const result = evaluateFindings([finding], session, [suppression], []);
    expect(result[0]!.status).toBe('suppressed');
  });

  it('suppression self-invalidates when requiresEvidence is absent from session', () => {
    const finding     = makeFinding();
    const suppression = makeSuppression({
      requiresEvidence: [{ type: 'auth_check', name: 'RolePolicy.update' }],
    });
    // Session does NOT contain the required auth_check
    const session = makeSession([{ type: 'function_call', name: 'processPayment' }]);
    const result  = evaluateFindings([finding], session, [suppression], []);
    expect(result[0]!.status).toBe('open');
  });

  it('approval takes precedence over suppression', () => {
    const finding     = makeFinding({ fingerprint: 'fp_001' });
    const approval    = makeApproval('fp_001');
    const suppression = makeSuppression();
    const result      = evaluateFindings([finding], makeSession(), [suppression], [approval]);
    expect(result[0]!.status).toBe('approved');
  });

  it('processes multiple findings independently', () => {
    const f1 = makeFinding({ fingerprint: 'fp_001', id: 'find_fp_001' });
    const f2 = makeFinding({ fingerprint: 'fp_002', id: 'find_fp_002' });
    const approval = makeApproval('fp_001');
    const result   = evaluateFindings([f1, f2], makeSession(), [], [approval]);
    expect(result[0]!.status).toBe('approved');
    expect(result[1]!.status).toBe('open');
  });
});

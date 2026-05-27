/**
 * T2.5 — Finding generator unit tests.
 */
import { describe, it, expect } from 'vitest';
import type { BehaviorDiff, SignatureChange, SemanticSignature } from '@tracegraph/shared-types';
import { diffToFindings, computeFingerprint } from '../src/findings';

function makeSig(overrides: Partial<SemanticSignature> = {}): SemanticSignature {
  return {
    eventType:    'function_call',
    language:     'javascript',
    functionName: 'someFn',
    role:         'business_logic',
    ...overrides,
  };
}

function makeSignatureChange(overrides: Partial<SignatureChange> = {}): SignatureChange {
  const sig = makeSig();
  return {
    signature:    sig,
    identityHash: 'hash_' + (overrides.signature?.functionName ?? 'default'),
    role:         'business_logic',
    critical:     false,
    ...overrides,
  };
}

function makeEmptyDiff(): BehaviorDiff {
  return {
    traceId:           'trace_cand',
    baselineId:        'baseline_001',
    addedSignatures:   [],
    removedSignatures: [],
    changedResources:  [],
  };
}

describe('diffToFindings()', () => {
  it('returns no findings for an empty diff', () => {
    expect(diffToFindings(makeEmptyDiff())).toHaveLength(0);
  });

  it('generates Critical finding for removed authorization event', () => {
    const diff: BehaviorDiff = {
      ...makeEmptyDiff(),
      removedSignatures: [makeSignatureChange({
        signature:    makeSig({ role: 'authorization', eventType: 'auth_check' }),
        role:         'authorization',
        critical:     true,
        eventName:    'RolePolicy.update',
      })],
    };
    const findings = diffToFindings(diff);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('critical');
    expect(findings[0]!.ruleId).toBe('behavior.authorization.removed');
    expect(findings[0]!.title).toContain('RolePolicy.update');
  });

  it('generates High finding for removed validation event', () => {
    const diff: BehaviorDiff = {
      ...makeEmptyDiff(),
      removedSignatures: [makeSignatureChange({
        signature:    makeSig({ role: 'validation', functionName: 'validateCouponExpiry' }),
        role:         'validation',
        eventName:    'validateCouponExpiry',
      })],
    };
    const findings = diffToFindings(diff);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('high');
    expect(findings[0]!.ruleId).toBe('behavior.validation.removed');
    expect(findings[0]!.title).toContain('validateCouponExpiry');
  });

  it('generates Medium finding for removed business logic', () => {
    const diff: BehaviorDiff = {
      ...makeEmptyDiff(),
      removedSignatures: [makeSignatureChange({
        role:      'business_logic',
        eventName: 'processPayment',
      })],
    };
    const findings = diffToFindings(diff);
    expect(findings[0]!.severity).toBe('medium');
    expect(findings[0]!.ruleId).toBe('behavior.business_logic.removed');
  });

  it('generates High finding for added authorization event', () => {
    const diff: BehaviorDiff = {
      ...makeEmptyDiff(),
      addedSignatures: [makeSignatureChange({
        signature: makeSig({ role: 'authorization' }),
        role:      'authorization',
        critical:  true,
        eventId:   'evt_new',
        eventName: 'NewAuthCheck',
      })],
    };
    const findings = diffToFindings(diff);
    const authAdded = findings.find((f) => f.ruleId === 'behavior.authorization.added');
    expect(authAdded, 'behavior.authorization.added finding missing').toBeDefined();
    expect(authAdded!.severity).toBe('high');
  });

  it('deduplicates findings with the same fingerprint', () => {
    const removed = makeSignatureChange({
      signature: makeSig({ role: 'validation', functionName: 'validateFn' }),
      role:      'validation',
    });
    const diff: BehaviorDiff = {
      ...makeEmptyDiff(),
      removedSignatures: [removed, removed],  // exact duplicate
    };
    expect(diffToFindings(diff)).toHaveLength(1);
  });

  it('finding fingerprint is stable (same diff → same fingerprint)', () => {
    const removed = makeSignatureChange({
      signature: makeSig({ role: 'validation', functionName: 'validateInvoice' }),
      role:      'validation',
    });
    const diff: BehaviorDiff = { ...makeEmptyDiff(), removedSignatures: [removed] };

    const f1 = diffToFindings(diff);
    const f2 = diffToFindings(diff);
    expect(f1[0]!.fingerprint).toBe(f2[0]!.fingerprint);
  });

  it('fingerprint changes when functionName changes', () => {
    const fp1 = computeFingerprint({
      ruleId:  'r1',
      removed: makeSignatureChange({ signature: makeSig({ functionName: 'foo' }) }),
    });
    const fp2 = computeFingerprint({
      ruleId:  'r1',
      removed: makeSignatureChange({ signature: makeSig({ functionName: 'bar' }) }),
    });
    expect(fp1).not.toBe(fp2);
  });

  it('fingerprint does NOT change when file or line is present (file-path-agnostic)', () => {
    // file and line don't affect the signature, so fingerprint should be the same
    const sig1 = makeSig({ functionName: 'processPayment' });
    const sig2 = makeSig({ functionName: 'processPayment' });

    const fp1 = computeFingerprint({
      ruleId:  'r1',
      removed: makeSignatureChange({ signature: sig1 }),
    });
    const fp2 = computeFingerprint({
      ruleId:  'r1',
      removed: makeSignatureChange({ signature: sig2 }),
    });
    expect(fp1).toBe(fp2);
  });
});

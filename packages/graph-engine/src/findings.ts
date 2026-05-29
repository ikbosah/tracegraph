/**
 * T2.5 — Finding generator
 *
 * Converts a BehaviorDiff into a list of Findings.
 *
 * Severity rules:
 *   - Authorization event removed    → Critical
 *   - Validation event removed       → High
 *   - Business logic event removed   → Medium
 *   - Any security-critical event removed → Critical (overrides role)
 *   - Event added (auth-related)     → High
 *   - Resource operation count change → Medium
 *   - Response shape: field removed  → Low
 *   - Response shape: field added    → info
 *
 * Finding fingerprint:
 *   sha256(ruleId + ':' + role + ':' + routePathPattern + ':' +
 *          className + ':' + methodName + ':' + functionName + ':' + resourceOperation)
 *   .slice(0, 16)
 *
 * Fingerprints are stable across file moves (no file path included).
 */
import { createHash } from 'node:crypto';
import type {
  BehaviorDiff,
  Finding,
  FindingSeverity,
  FindingCategory,
  SignatureChange,
} from '@tracegraph/shared-types';

// ─── Rule IDs ─────────────────────────────────────────────────────────────────

const RULES = {
  AUTHORIZATION_REMOVED:        'behavior.authorization.removed',
  MIDDLEWARE_REMOVED:           'security.authorization.middleware_removed',
  VALIDATION_REMOVED:           'behavior.validation.removed',
  BUSINESS_LOGIC_REMOVED:       'behavior.business_logic.removed',
  AUTHORIZATION_ADDED:          'behavior.authorization.added',
  RESOURCE_COUNT_CHANGED:       'behavior.resource_count.changed',
  RESPONSE_FIELD_REMOVED:       'behavior.response_shape.field_removed',
  RESPONSE_FIELD_ADDED:         'behavior.response_shape.field_added',
} as const;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Convert a `BehaviorDiff` into a list of `Finding` objects.
 */
export function diffToFindings(diff: BehaviorDiff): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>(); // deduplicate by fingerprint

  // ── Removed signatures ────────────────────────────────────────────────────
  for (const removed of diff.removedSignatures) {
    const { ruleId, severity, category, title, description, recommendation } =
      classifyRemovedSignature(removed);

    const fingerprint = computeFingerprint({
      ruleId,
      removed,
    });

    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);

    findings.push({
      id:          `find_${fingerprint}`,
      fingerprint,
      ruleId,
      severity,
      category,
      title,
      description,
      evidence:    [{ traceId: diff.traceId, eventIds: [] }],
      recommendation,
    });
  }

  // ── Added security-critical signatures (auth checks added) ────────────────
  for (const added of diff.addedSignatures) {
    if (added.role !== 'authorization' && !added.critical) continue;

    const ruleId = RULES.AUTHORIZATION_ADDED;
    const fingerprint = computeFingerprint({ ruleId, removed: added });

    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);

    findings.push({
      id:          `find_${fingerprint}`,
      fingerprint,
      ruleId,
      severity:    'high',
      category:    'behavior_change',
      title:       `Authorization check added: ${sigLabel(added)}`,
      description: `A new authorization check was introduced: "${added.eventName ?? sigLabel(added)}". ` +
                   `Verify this is intentional and does not break existing authorized flows.`,
      evidence:    [{ traceId: diff.traceId, eventIds: added.eventId ? [added.eventId] : [] }],
      recommendation: 'Review the new authorization check and ensure all legitimate callers are still permitted.',
    });
  }

  // ── Resource operation count changes ─────────────────────────────────────
  for (const rc of diff.changedResources) {
    const ruleId = RULES.RESOURCE_COUNT_CHANGED;
    const fingerprint = createHash('sha256')
      .update(`${ruleId}:${rc.type}:${rc.key}:${rc.operation}`)
      .digest('hex')
      .slice(0, 16);

    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);

    findings.push({
      id:          `find_${fingerprint}`,
      fingerprint,
      ruleId,
      severity:    'medium',
      category:    'behavior_change',
      title:       `Resource operation count changed: ${rc.type}.${rc.operation}`,
      description: `The number of ${rc.operation} operations on "${rc.type}:${rc.key}" changed ` +
                   `from ${rc.baselineCount} (baseline) to ${rc.candidateCount} (candidate).`,
      evidence:    [{ traceId: diff.traceId, eventIds: [] }],
      recommendation: 'Verify the change in operation count is expected.',
    });
  }

  // ── Response shape changes ─────────────────────────────────────────────────
  if (diff.responseShapeChange) {
    const rsc = diff.responseShapeChange;

    for (const field of rsc.removedFields) {
      const fingerprint = createHash('sha256')
        .update(`${RULES.RESPONSE_FIELD_REMOVED}:${diff.baselineId}:${field}`)
        .digest('hex')
        .slice(0, 16);

      if (!seen.has(fingerprint)) {
        seen.add(fingerprint);
        findings.push({
          id:          `find_${fingerprint}`,
          fingerprint,
          ruleId:      RULES.RESPONSE_FIELD_REMOVED,
          severity:    'low',
          category:    'behavior_change',
          title:       `Response field removed: "${field}"`,
          description: `The field "${field}" was present in the baseline response shape but is absent in the candidate.`,
          evidence:    [{ traceId: diff.traceId, eventIds: [] }],
          recommendation: 'Verify this is a planned API change and update dependent clients.',
        });
      }
    }

    for (const field of rsc.addedFields) {
      const fingerprint = createHash('sha256')
        .update(`${RULES.RESPONSE_FIELD_ADDED}:${diff.baselineId}:${field}`)
        .digest('hex')
        .slice(0, 16);

      if (!seen.has(fingerprint)) {
        seen.add(fingerprint);
        findings.push({
          id:          `find_${fingerprint}`,
          fingerprint,
          ruleId:      RULES.RESPONSE_FIELD_ADDED,
          severity:    'info',
          category:    'behavior_change',
          title:       `Response field added: "${field}"`,
          description: `The field "${field}" is present in the candidate response but was absent in the baseline.`,
          evidence:    [{ traceId: diff.traceId, eventIds: [] }],
        });
      }
    }
  }

  return findings;
}

/**
 * Compute a stable 16-hex-char fingerprint for a finding.
 * Never includes file path, line, or column.
 */
export function computeFingerprint(input: {
  ruleId:  string;
  removed: SignatureChange;
}): string {
  const { ruleId, removed: sig } = input;
  const s = sig.signature;
  const parts = [
    ruleId,
    s.role              ?? '',
    s.routePathPattern  ?? '',
    s.routeMethod       ?? '',
    s.className         ?? '',
    s.methodName        ?? '',
    s.functionName      ?? '',
    s.resourceOperation ?? '',
    s.resourceType      ?? '',
    s.resourceKey       ?? '',
  ];
  return createHash('sha256').update(parts.join('\x00')).digest('hex').slice(0, 16);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function classifyRemovedSignature(removed: SignatureChange): {
  ruleId:         string;
  severity:       FindingSeverity;
  category:       FindingCategory;
  title:          string;
  description:    string;
  recommendation: string;
} {
  const label = sigLabel(removed);

  const eventLabel = removed.eventName ?? label;

  // M5.2 — Route-level authorization middleware removed (more severe than a
  // function-level auth check because it gates every request to that route).
  if (
    removed.role === 'authorization' &&
    removed.signature.routePathPattern &&
    !removed.critical
  ) {
    return {
      ruleId:         RULES.MIDDLEWARE_REMOVED,
      severity:       'critical',
      category:       'security_authorization',
      title:          `Authorization middleware removed: ${eventLabel}`,
      description:    `A route-level authorization middleware "${eventLabel}" that guarded ` +
                      `"${removed.signature.routeMethod ?? ''} ${removed.signature.routePathPattern}" ` +
                      `in the baseline is absent in the candidate trace. Removing route middleware ` +
                      `exposes every request to that route to unauthenticated or unauthorized access.`,
      recommendation: 'Restore the middleware or confirm the route is now protected by an equivalent mechanism.',
    };
  }

  if (removed.critical || removed.role === 'authorization') {
    return {
      ruleId:         RULES.AUTHORIZATION_REMOVED,
      severity:       'critical',
      category:       'security_authorization',
      title:          `Authorization check removed: ${eventLabel}`,
      description:    `An authorization check "${eventLabel}" that was present in the baseline is no longer present in the candidate trace. This may indicate a security regression.`,
      recommendation: 'Restore the authorization check or confirm this removal is intentional and safe.',
    };
  }

  if (removed.role === 'validation') {
    return {
      ruleId:         RULES.VALIDATION_REMOVED,
      severity:       'high',
      category:       'behavior_change',
      title:          `Validation step removed: ${eventLabel}`,
      description:    `A validation step "${eventLabel}" present in the baseline is absent in the candidate trace. Input may no longer be validated before processing.`,
      recommendation: 'Verify validation is still performed (possibly in a different location) or restore the validation step.',
    };
  }

  return {
    ruleId:         RULES.BUSINESS_LOGIC_REMOVED,
    severity:       'medium',
    category:       'behavior_change',
    title:          `Behaviour change: ${eventLabel} removed`,
    description:    `The event "${eventLabel}" was present in the baseline but is absent in the candidate trace.`,
    recommendation: 'Verify this change is intentional.',
  };
}

function sigLabel(change: SignatureChange): string {
  const s = change.signature;
  if (s.className && s.methodName) return `${s.className}.${s.methodName}`;
  if (s.functionName) return s.functionName;
  if (s.routePathPattern) return `${s.routeMethod ?? ''} ${s.routePathPattern}`.trim();
  return s.eventType;
}

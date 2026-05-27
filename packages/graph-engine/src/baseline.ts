/**
 * T2.2 — CompactBaseline builder
 *
 * Converts a TraceSession into a CompactBaseline that:
 *  - Aggregates events by semantic signature (deduplicates, counts)
 *  - Marks security-critical events (authorization_check, auth_check)
 *  - Extracts a resource summary (db_query events grouped by table+operation)
 *  - Captures the response shape from http_response output
 *
 * The baseline is later used by diffBaseline() to detect behaviour changes.
 */
import { createHash } from 'node:crypto';
import type {
  TraceSession,
  TraceEvent,
  CompactBaseline,
  JsonShape,
  TraceEntrypoint,
} from '@tracegraph/shared-types';
import { SCHEMA_VERSIONS } from '@tracegraph/shared-types';
import { eventToSignature, signatureToIdentityHash, classifyRole } from './signature';

// ─── Public API ───────────────────────────────────────────────────────────────

export type BaselineMeta = {
  approvedBy: string;
  reason: string;
};

/**
 * Convert a `TraceSession` into a `CompactBaseline`.
 *
 * @param session  The finalised trace session to baseline.
 * @param meta     Who approved this baseline and why.
 */
export function sessionToBaseline(
  session: TraceSession,
  meta: BaselineMeta,
): CompactBaseline {
  const signatureMap = new Map<string, {
    signature: ReturnType<typeof eventToSignature>;
    role:      string;
    count:     number;
    critical:  boolean;
  }>();

  const resourceMap = new Map<string, {
    type:      string;
    key:       string;
    operation: string;
    count:     number;
  }>();

  let responseShape: JsonShape = { type: 'unknown' };

  // ── Process events ────────────────────────────────────────────────────────
  for (const event of session.events) {
    // Skip trace lifecycle events — they are not behaviour signals
    if (event.type === 'trace_start' || event.type === 'trace_end') continue;
    if (event.type === 'return') continue;

    const sig  = eventToSignature(event);
    const hash = signatureToIdentityHash(sig);
    const role = classifyRole(event);

    // Aggregate by signature hash
    const existing = signatureMap.get(hash);
    if (existing) {
      existing.count++;
    } else {
      signatureMap.set(hash, {
        signature: sig,
        role:      String(role),
        count:     1,
        critical:  isSecurityCritical(event),
      });
    }

    // Resource summary for db_query events
    if (event.type === 'db_query' && event.resource) {
      const rKey = `${event.resource.type}:${event.resource.key}:${event.resource.operation}`;
      const r = resourceMap.get(rKey);
      if (r) {
        r.count++;
      } else {
        resourceMap.set(rKey, {
          type:      event.resource.type,
          key:       event.resource.key,
          operation: event.resource.operation,
          count:     1,
        });
      }
    }

    // Response shape: take the first http_response output
    if (event.type === 'http_response' && event.output) {
      responseShape = extractShape(event.output);
    }
  }

  return {
    schemaVersion: SCHEMA_VERSIONS.baseline,
    baselineId:    `baseline_${createBaselineId(session)}`,
    testId:        deriveTestId(session.entrypoint),
    entrypoint:    session.entrypoint,
    approvedAt:    Date.now(),
    approvedBy:    meta.approvedBy,
    reason:        meta.reason,
    captureLevel:  session.captureLevel.overall,
    events:        Array.from(signatureMap.values()),
    resources:     Array.from(resourceMap.values()),
    responseShape,
  };
}

/**
 * Derive a stable `testId` from a trace entrypoint.
 * Two sessions covering the same route/test get the same testId.
 */
export function deriveTestId(entrypoint: TraceEntrypoint): string {
  let key: string;
  switch (entrypoint.type) {
    case 'http_request': key = `${entrypoint.method}:${entrypoint.path}`; break;
    case 'test_case':    key = entrypoint.testName; break;
    case 'function':     key = `fn:${entrypoint.functionName}`; break;
    case 'cli_command':  key = `cmd:${entrypoint.command}`; break;
    default:             key = JSON.stringify(entrypoint);
  }
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createBaselineId(session: TraceSession): string {
  return createHash('sha256')
    .update(session.traceId + session.sessionId)
    .digest('hex')
    .slice(0, 12);
}

const SECURITY_CRITICAL_TYPES = new Set(['auth_check', 'authorization_check']);

function isSecurityCritical(event: TraceEvent): boolean {
  return SECURITY_CRITICAL_TYPES.has(event.type)
    || Boolean((event.security as Record<string, unknown> | undefined)?.['critical']);
}

/**
 * Recursively extract a `JsonShape` from a sanitised value.
 * Arrays capture one representative element shape only.
 */
export function extractShape(value: unknown, depth = 0, maxDepth = 4): JsonShape {
  if (depth >= maxDepth) return { type: 'unknown' };
  if (value === null || value === undefined) return { type: 'null' };

  switch (typeof value) {
    case 'string':  return { type: 'string' };
    case 'number':  return { type: 'number' };
    case 'boolean': return { type: 'boolean' };
  }

  if (Array.isArray(value)) {
    const itemShape = value.length > 0 ? extractShape(value[0], depth + 1, maxDepth) : { type: 'unknown' as const };
    return { type: 'array', items: itemShape };
  }

  if (typeof value === 'object') {
    const properties: Record<string, JsonShape> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      properties[k] = extractShape(v, depth + 1, maxDepth);
    }
    return { type: 'object', properties };
  }

  return { type: 'unknown' };
}

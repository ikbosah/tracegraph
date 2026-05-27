/**
 * T2.1 — Semantic signature extraction
 *
 * Extracts a file-path-agnostic semantic identity from a TraceEvent.
 * The identity hash NEVER includes file, line, column, or packageName so
 * that refactors (moving files) do not break baseline comparisons.
 *
 * Role classification:
 *   authorization  — auth_check / authorization_check events, or names matching gate/policy patterns
 *   validation     — function names matching validate|verify|check|assert|ensure|guard|permission
 *   db             — db_query events
 *   external_call  — external_http_call events
 *   business_logic — everything else
 */
import { createHash } from 'node:crypto';
import type { TraceEvent, SemanticSignature, EventRole } from '@tracegraph/shared-types';

// ─── Role classification ──────────────────────────────────────────────────────

const VALIDATION_RE = /validate|verify|check|assert|ensure|guard|permission|authorize/i;
const AUTH_EVENT_TYPES = new Set(['auth_check', 'authorization_check']);

/**
 * Classify an event into a semantic role.
 * Auth events → "authorization"; validation-named functions → "validation";
 * db_query → "db"; external_http_call → "external_call"; else → "business_logic".
 */
export function classifyRole(event: TraceEvent): EventRole {
  if (AUTH_EVENT_TYPES.has(event.type)) return 'authorization';
  if (event.type === 'db_query')             return 'db';
  if (event.type === 'external_http_call')   return 'external_call';

  // Validation: function name or class method matching common patterns
  const namesToCheck = [
    event.functionName,
    event.name,
    event.displayName,
    event.className,
  ].filter(Boolean).join(' ');

  if (VALIDATION_RE.test(namesToCheck)) return 'validation';

  return 'business_logic';
}

/**
 * Extract a `SemanticSignature` from a `TraceEvent`.
 * The signature is identity-stable across file moves and line changes.
 */
export function eventToSignature(event: TraceEvent): SemanticSignature {
  const role = classifyRole(event);

  // Route pattern: normalise dynamic segments to `:param`
  const routePathPattern = event.metadata?.['route']
    ? normaliseRoutePath(String(event.metadata['route']))
    : undefined;

  const routeMethod = event.metadata?.['method']
    ? String(event.metadata['method']).toUpperCase()
    : undefined;

  return {
    eventType:         event.type,
    language:          event.language,
    framework:         event.framework,
    className:         event.className,
    methodName:        event.functionName ?? undefined,      // functionName field on the event
    functionName:      event.name,
    routeMethod,
    routePathPattern,
    resourceType:      event.resource?.type,
    resourceKey:       event.resource?.key,
    resourceOperation: event.resource?.operation as SemanticSignature['resourceOperation'],
    role,
  };
}

/**
 * Normalise dynamic route segments to `:param` placeholders.
 * Examples:
 *   /invoices/123            → /invoices/:param
 *   /users/uuid-1234-abcd   → /users/:param
 *   /orders/:id             → /orders/:id  (already normalised)
 */
function normaliseRoutePath(path: string): string {
  return path.replace(
    /\/([^/]+)/g,
    (_, segment) => {
      // If segment already looks like a param or is a known pattern, keep it
      if (segment.startsWith(':')) return `/${segment}`;
      // UUID-shaped or all-digit segments → :param
      if (/^[0-9a-f-]{8,}$/i.test(segment) || /^\d+$/.test(segment)) return '/:param';
      return `/${segment}`;
    },
  );
}

// ─── Identity hash ────────────────────────────────────────────────────────────

/**
 * Produce a stable 16-char hex hash from a `SemanticSignature`.
 *
 * Fields included (in order): eventType, language, framework, className,
 * methodName, functionName, routeMethod, routePathPattern, resourceType,
 * resourceKey, resourceOperation, role.
 *
 * Fields NEVER included: file, line, column, packageName, eventId, traceId.
 */
export function signatureToIdentityHash(sig: SemanticSignature): string {
  const parts = [
    sig.eventType         ?? '',
    sig.language          ?? '',
    sig.framework         ?? '',
    sig.className         ?? '',
    sig.methodName        ?? '',
    sig.functionName      ?? '',
    sig.routeMethod       ?? '',
    sig.routePathPattern  ?? '',
    sig.resourceType      ?? '',
    sig.resourceKey       ?? '',
    sig.resourceOperation ?? '',
    sig.role              ?? '',
  ];
  return createHash('sha256')
    .update(parts.join('\x00'))
    .digest('hex')
    .slice(0, 16);
}

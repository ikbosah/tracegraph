/**
 * M5 — Trace-level security and reliability analysis
 *
 * Analyses a single TraceSession for security and reliability patterns that
 * cannot be detected by diff alone (i.e. they are intrinsic to the candidate
 * trace itself, not relative to a baseline).
 *
 * Rules:
 *   M5.4  security.sensitive_data.in_response  — sensitive field names in HTTP response
 *   M5.6  reliability.n_plus_one_query         — same DB query repeated N+ times
 *   M5.7  reliability.duplicate_side_effects   — same side-effect dispatched ≥ 2×
 *   M5.8  reliability.missing_transaction      — multi-table writes without a transaction
 */
import { createHash } from 'node:crypto';
import type { TraceSession, Finding } from '@tracegraph/shared-types';

// ─── Rule IDs ─────────────────────────────────────────────────────────────────

export const ANALYSE_RULES = {
  SENSITIVE_DATA_IN_RESPONSE: 'security.sensitive_data.in_response',
  N_PLUS_ONE_QUERY:           'reliability.n_plus_one_query',
  DUPLICATE_SIDE_EFFECTS:     'reliability.duplicate_side_effects',
  MISSING_TRANSACTION:        'reliability.missing_transaction',
} as const;

// ─── Configuration ────────────────────────────────────────────────────────────

/**
 * Normalised field names (lowercase, separators stripped) considered sensitive.
 * Presence of any of these in an HTTP response shape triggers a finding.
 */
const SENSITIVE_FIELD_NAMES = new Set([
  // Credentials
  'password', 'passwd', 'pass', 'secret', 'credentials',
  // API keys / tokens
  'token', 'apikey', 'apisecret', 'privatekey', 'signingkey',
  'clientsecret', 'clienttoken',
  // Auth tokens
  'authtoken', 'accesstoken', 'refreshtoken', 'sessiontoken',
  'idtoken', 'bearer',
  // Payment / PII
  'creditcard', 'cardnumber', 'cardcvv', 'cvv', 'cvc', 'cvc2',
  'ssn', 'socialsecurity',
]);

/** Minimum identical DB queries (same table + operation) to flag as N+1. */
const N_PLUS_ONE_THRESHOLD = 5;

/** DB resource operations that constitute a write (data-modifying). */
const WRITE_OPERATIONS = new Set(['write', 'insert', 'update', 'delete', 'upsert', 'create']);

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Analyse a single `TraceSession` for intrinsic security and reliability
 * findings (independent of any baseline comparison).
 */
export function analyseTraceFindings(session: TraceSession): Finding[] {
  return [
    ...detectSensitiveDataInResponse(session),
    ...detectNPlusOneQuery(session),
    ...detectDuplicateSideEffects(session),
    ...detectMissingTransaction(session),
  ];
}

// ─── M5.4: Sensitive data in HTTP response ─────────────────────────────────

function detectSensitiveDataInResponse(session: TraceSession): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();

  for (const event of session.events) {
    if (event.type !== 'http_response') continue;
    if (!event.output || typeof event.output !== 'object' || Array.isArray(event.output)) continue;

    const fields = collectKeys(event.output as Record<string, unknown>);
    for (const field of fields) {
      if (!isSensitiveFieldName(field)) continue;

      const fingerprint = fp(ANALYSE_RULES.SENSITIVE_DATA_IN_RESPONSE, session.traceId, field);
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);

      findings.push({
        id:          `find_${fingerprint}`,
        fingerprint,
        ruleId:      ANALYSE_RULES.SENSITIVE_DATA_IN_RESPONSE,
        severity:    'high',
        category:    'security_sensitive_data',
        title:       `Sensitive field in HTTP response: "${field}"`,
        description: `The field "${field}" appears in the HTTP response payload and may expose ` +
                     `sensitive data (password, token, secret, PII). Leaking such fields in API ` +
                     `responses is a security risk and may violate data-protection requirements.`,
        evidence:    [{ traceId: session.traceId, eventIds: event.eventId ? [event.eventId] : [] }],
        recommendation:
          `Remove "${field}" from the response or redact its value before sending. ` +
          `Use an API resource / serializer layer to explicitly whitelist the fields ` +
          `your API should expose (e.g. Laravel API Resources, a JSON:API transformer).`,
      });
    }
  }

  return findings;
}

// ─── M5.6: N+1 query detection ────────────────────────────────────────────────

function detectNPlusOneQuery(session: TraceSession): Finding[] {
  const findings: Finding[] = [];

  // Group by (resourceType, operation) — if the same pair appears N+ times
  // in one trace it likely reflects a loop-per-row fetch pattern.
  type Entry = { count: number; eventIds: string[]; resourceType: string; operation: string };
  const groups = new Map<string, Entry>();

  for (const event of session.events) {
    if (event.type !== 'db_query' || !event.resource) continue;
    const { type: resourceType, operation } = event.resource;
    const key = `${resourceType}\x00${operation}`;

    let entry = groups.get(key);
    if (!entry) {
      entry = { count: 0, eventIds: [], resourceType, operation };
      groups.set(key, entry);
    }
    entry.count++;
    if (event.eventId) entry.eventIds.push(event.eventId);
  }

  for (const entry of groups.values()) {
    if (entry.count < N_PLUS_ONE_THRESHOLD) continue;

    const fingerprint = fp(
      ANALYSE_RULES.N_PLUS_ONE_QUERY,
      session.traceId,
      `${entry.resourceType}\x00${entry.operation}`,
    );

    findings.push({
      id:          `find_${fingerprint}`,
      fingerprint,
      ruleId:      ANALYSE_RULES.N_PLUS_ONE_QUERY,
      severity:    'medium',
      category:    'performance',
      title:       `Possible N+1 query: ${entry.resourceType}.${entry.operation} × ${entry.count}`,
      description: `The "${entry.operation}" operation on "${entry.resourceType}" was executed ` +
                   `${entry.count} times in a single request. This pattern commonly indicates an ` +
                   `N+1 problem where child records are fetched individually in a loop rather than ` +
                   `in a single batched query.`,
      evidence:    [{ traceId: session.traceId, eventIds: entry.eventIds.slice(0, 10) }],
      recommendation:
        `Use eager loading to batch-fetch related records (e.g. Eloquent \`with()\`, ` +
        `TypeORM \`relations\`, Sequelize \`include\`). Add a query counter assertion to ` +
        `your test suite to prevent regressions.`,
    });
  }

  return findings;
}

// ─── M5.7: Duplicate side effects ─────────────────────────────────────────────

function detectDuplicateSideEffects(session: TraceSession): Finding[] {
  const findings: Finding[] = [];

  // Track queue dispatches and mutating outbound HTTP calls by identity key.
  type Entry = { count: number; eventIds: string[] };
  const queueGroups: Map<string, Entry>    = new Map();
  const outboundGroups: Map<string, Entry> = new Map();

  for (const event of session.events) {
    if (event.type === 'queue_event' && event.name) {
      addToGroup(queueGroups, event.name, event.eventId);
    }

    if (event.type === 'external_http_call') {
      const method = String(
        (event.metadata?.['method'] as string | undefined) ?? '',
      ).toUpperCase();
      if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) continue;

      const url = String(
        (event.metadata?.['url'] as string | undefined) ?? event.name ?? '',
      );
      addToGroup(outboundGroups, `${method}:${url}`, event.eventId);
    }
  }

  for (const [name, entry] of queueGroups) {
    if (entry.count < 2) continue;
    const fingerprint = fp(ANALYSE_RULES.DUPLICATE_SIDE_EFFECTS, session.traceId, `queue:${name}`);
    findings.push({
      id:          `find_${fingerprint}`,
      fingerprint,
      ruleId:      ANALYSE_RULES.DUPLICATE_SIDE_EFFECTS,
      severity:    'medium',
      category:    'data_integrity',
      title:       `Duplicate queue dispatch: "${name}" × ${entry.count}`,
      description: `The job/event "${name}" was dispatched ${entry.count} times within a single ` +
                   `request. Unless this is intentional, consumers may process the same work ` +
                   `multiple times (e.g. duplicate emails, double charges, redundant notifications).`,
      evidence:    [{ traceId: session.traceId, eventIds: entry.eventIds }],
      recommendation:
        `Verify the dispatch is not inside a loop or on multiple code paths. ` +
        `Consider idempotency keys or a deduplication layer in the queue consumer.`,
    });
  }

  for (const [key, entry] of outboundGroups) {
    if (entry.count < 2) continue;
    const colonIdx = key.indexOf(':');
    const method   = key.slice(0, colonIdx);
    const url      = key.slice(colonIdx + 1);
    const fingerprint = fp(ANALYSE_RULES.DUPLICATE_SIDE_EFFECTS, session.traceId, key);
    findings.push({
      id:          `find_${fingerprint}`,
      fingerprint,
      ruleId:      ANALYSE_RULES.DUPLICATE_SIDE_EFFECTS,
      severity:    'medium',
      category:    'data_integrity',
      title:       `Duplicate outbound ${method}: "${url}" × ${entry.count}`,
      description: `An outbound ${method} request to "${url}" was made ${entry.count} times in a ` +
                   `single request. This may cause unintended duplicate writes or side effects on ` +
                   `the remote service.`,
      evidence:    [{ traceId: session.traceId, eventIds: entry.eventIds }],
      recommendation:
        `Check whether the call appears in a loop or on multiple branches. ` +
        `If idempotency is required, pass an idempotency key in the request headers.`,
    });
  }

  return findings;
}

// ─── M5.8: Missing transaction boundary ───────────────────────────────────────

function detectMissingTransaction(session: TraceSession): Finding[] {
  // If the trace already has a transaction event, it's covered.
  const hasTransaction = session.events.some(
    (e) =>
      e.type === 'transaction_start' ||
      e.type === 'transaction_commit' ||
      e.type === 'transaction_rollback',
  );
  if (hasTransaction) return [];

  // Collect write events and their target tables.
  const writeEvents = session.events.filter(
    (e) =>
      e.type === 'db_query' &&
      e.resource != null &&
      WRITE_OPERATIONS.has(e.resource.operation),
  );

  // Only flag when writes touch ≥ 2 distinct tables.
  // A single-table write failing mid-request is normally safe (atomic).
  const tables = new Set(writeEvents.map((e) => e.resource!.type));
  if (tables.size < 2) return [];

  const sortedTables = [...tables].sort();
  const fingerprint  = fp(
    ANALYSE_RULES.MISSING_TRANSACTION,
    session.traceId,
    sortedTables.join(','),
  );

  const tableList = sortedTables.join(', ');
  return [{
    id:          `find_${fingerprint}`,
    fingerprint,
    ruleId:      ANALYSE_RULES.MISSING_TRANSACTION,
    severity:    'medium',
    category:    'data_integrity',
    title:       `Multi-table write without transaction: ${tableList}`,
    description: `Write operations were performed on multiple tables (${tableList}) within a single ` +
                 `request but no transaction boundary was observed. If an error occurs part-way ` +
                 `through, the database may be left in an inconsistent state.`,
    evidence:    [{
      traceId:  session.traceId,
      eventIds: writeEvents.map((e) => e.eventId).filter((id): id is string => id != null),
    }],
    recommendation:
      `Wrap the multi-table writes in a database transaction. ` +
      `Laravel: \`DB::transaction(fn() => ...)\`. ` +
      `Express/TypeORM: \`dataSource.transaction(async (em) => ...)\`.`,
  }];
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/** Compute a stable 16-hex-char fingerprint from the given parts. */
function fp(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\x00')).digest('hex').slice(0, 16);
}

/** Normalise a field name to lowercase with separators stripped for comparison. */
function normaliseName(name: string): string {
  return name.toLowerCase().replace(/[-_]/g, '');
}

/** Return true when a field name (after normalisation) matches a sensitive pattern. */
function isSensitiveFieldName(field: string): boolean {
  return SENSITIVE_FIELD_NAMES.has(normaliseName(field));
}

/**
 * Collect keys from a plain object up to 2 levels deep.
 * Top-level keys always; one level of nesting to catch shapes like
 * `{ data: { password: ... } }` without excessive recursion.
 */
function collectKeys(obj: Record<string, unknown>, depth = 0): string[] {
  const keys: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    keys.push(key);
    if (
      depth < 2 &&
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      keys.push(...collectKeys(value as Record<string, unknown>, depth + 1));
    }
  }
  return keys;
}

function addToGroup(
  map: Map<string, { count: number; eventIds: string[] }>,
  key: string,
  eventId: string | undefined,
): void {
  let entry = map.get(key);
  if (!entry) { entry = { count: 0, eventIds: [] }; map.set(key, entry); }
  entry.count++;
  if (eventId) entry.eventIds.push(eventId);
}

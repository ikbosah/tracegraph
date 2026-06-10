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
 *
 * Entrypoint scoping:
 *   Rules M5.6 and M5.7 assume the session represents a single isolated
 *   request lifecycle (http_request or test_case entrypoints).  They are
 *   automatically suppressed for cli_command sessions (full test-suite runs
 *   captured at Level 1) where independent tests naturally repeat queries and
 *   side-effect calls across the run.
 *
 * IMP-3.1: Rule configuration
 *   Accepts an optional `ruleConfig` map keyed by ruleId.
 *   Supports: `disabled`, `severity`, `thresholds.repetitionCount`.
 */
import { createHash } from 'node:crypto';
import type {
  TraceSession,
  Finding,
  FindingSeverity,
  RemediationSnippet,
  RuleConfig,
} from '@tracegraph/shared-types';

// ─── Rule IDs ─────────────────────────────────────────────────────────────────

export const ANALYSE_RULES = {
  SENSITIVE_DATA_IN_RESPONSE:        'security.sensitive_data.in_response',
  N_PLUS_ONE_QUERY:                  'reliability.n_plus_one_query',
  DUPLICATE_SIDE_EFFECTS:            'reliability.duplicate_side_effects',
  DUPLICATE_TEST_CLIENT_REQUESTS:    'reliability.duplicate_test_client_requests',
  MISSING_TRANSACTION:               'reliability.missing_transaction',
} as const;

// ─── Remediation registry (IMP-3.3) ──────────────────────────────────────────

const REMEDIATIONS: Partial<Record<string, RemediationSnippet>> = {
  [ANALYSE_RULES.SENSITIVE_DATA_IN_RESPONSE]: {
    text: 'Remove the sensitive field from the response or redact its value before sending. Use an explicit serializer or resource layer to whitelist response fields.',
    code: {
      express:
        '// Use an explicit DTO / serializer:\nconst safe = { id: user.id, email: user.email };\nres.json(safe); // never spread the whole model',
      laravel:
        '// Laravel API Resource:\nclass UserResource extends JsonResource {\n  public function toArray($request) {\n    return [\'id\' => $this->id, \'email\' => $this->email];\n  }\n}',
      fastapi:
        '# Pydantic response model:\nclass UserResponse(BaseModel):\n    id: int\n    email: str\n    # no password_hash field',
      spring:
        '// Jackson @JsonIgnore:\n@JsonIgnore\nprivate String passwordHash;',
    },
    docs: 'https://docs.tracegraph.io/rules/security-sensitive-data-in-response',
  },

  [ANALYSE_RULES.N_PLUS_ONE_QUERY]: {
    text: 'Eager-load the related data in the initial query instead of querying inside a loop. Add a query counter assertion to prevent regressions.',
    code: {
      laravel:
        '// Eager loading with with():\n$orders = Order::with(\'items\')->get();\n// Instead of:\n$orders = Order::all();\nforeach ($orders as $order) { $order->items; }',
      express:
        '// Batch query instead of N queries:\nconst ids = orders.map(o => o.id);\nconst items = await db.query(\n  \'SELECT * FROM items WHERE order_id = ANY($1)\',\n  [ids],\n);',
      spring:
        '// JOIN FETCH in JPQL:\n@Query("SELECT o FROM Order o JOIN FETCH o.items")\nList<Order> findAllWithItems();',
      fastapi:
        '# SQLAlchemy selectinload:\nresult = await session.execute(\n    select(Order).options(selectinload(Order.items))\n)',
    },
    docs: 'https://docs.tracegraph.io/rules/reliability-n-plus-one-query',
  },

  [ANALYSE_RULES.MISSING_TRANSACTION]: {
    text: 'Wrap the multi-table writes in a database transaction to ensure atomicity. A failure mid-way through will leave the database inconsistent without a transaction boundary.',
    code: {
      laravel:
        'DB::transaction(function () use ($data) {\n    $order = Order::create($data[\'order\']);\n    $order->items()->createMany($data[\'items\']);\n});',
      express:
        '// TypeORM / pg:\nconst queryRunner = dataSource.createQueryRunner();\nawait queryRunner.startTransaction();\ntry {\n  await queryRunner.manager.save(Order, order);\n  await queryRunner.manager.save(OrderItem, items);\n  await queryRunner.commitTransaction();\n} catch (e) {\n  await queryRunner.rollbackTransaction();\n  throw e;\n}',
      spring:
        '@Transactional\npublic void createOrder(OrderDto dto) {\n    orderRepository.save(toEntity(dto));\n    inventoryService.deduct(dto.items());\n}',
      fastapi:
        'async with session.begin():\n    session.add(order)\n    session.add_all(items)',
    },
    docs: 'https://docs.tracegraph.io/rules/reliability-missing-transaction',
  },

  [ANALYSE_RULES.DUPLICATE_SIDE_EFFECTS]: {
    text: 'Verify the dispatch or outbound call is not inside a loop or on multiple code paths. Consider idempotency keys or a deduplication layer.',
    code: {
      laravel:
        '// Idempotency key on queue dispatch:\nSendEmailJob::dispatch($user)->withUniqueId($user->id);',
      express:
        '// Pass idempotency-key header to the remote:\nfetch(url, {\n  method: \'POST\',\n  headers: { \'Idempotency-Key\': requestId },\n  body: JSON.stringify(payload),\n});',
    },
    docs: 'https://docs.tracegraph.io/rules/reliability-duplicate-side-effects',
  },
};

// ─── Configuration ────────────────────────────────────────────────────────────

/**
 * Normalised field names (lowercase, separators stripped) considered sensitive.
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

/** Default minimum identical DB queries (same table + operation) to flag as N+1. */
const DEFAULT_N_PLUS_ONE_THRESHOLD = 5;

/** DB resource operations that constitute a write (data-modifying). */
const WRITE_OPERATIONS = new Set(['write', 'insert', 'update', 'delete', 'upsert', 'create']);

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Analyse a single `TraceSession` for intrinsic security and reliability
 * findings (independent of any baseline comparison).
 *
 * @param session    The trace to analyse.
 * @param ruleConfig Optional per-rule configuration (IMP-3.1).
 */
export function analyseTraceFindings(
  session:    TraceSession,
  ruleConfig?: Record<string, RuleConfig>,
): Finding[] {
  const cfg = ruleConfig ?? {};
  return [
    ...detectSensitiveDataInResponse(session, cfg),
    ...detectNPlusOneQuery(session, cfg),
    ...detectDuplicateSideEffects(session, cfg),
    ...detectMissingTransaction(session, cfg),
  ];
}

// ─── Helpers: rule config resolution ─────────────────────────────────────────

/** Returns the effective severity for a rule, respecting config overrides. */
function effectiveSeverity(
  ruleId:  string,
  def:     FindingSeverity,
  cfg:     Record<string, RuleConfig>,
): FindingSeverity {
  return (cfg[ruleId]?.severity as FindingSeverity | undefined) ?? def;
}

/** Returns true when a rule is disabled via config. */
function isDisabled(ruleId: string, cfg: Record<string, RuleConfig>): boolean {
  return cfg[ruleId]?.disabled === true;
}

/** Returns the effective numeric threshold for a rule threshold key. */
function threshold(
  ruleId: string,
  key:    string,
  def:    number,
  cfg:    Record<string, RuleConfig>,
): number {
  const t = cfg[ruleId]?.thresholds?.[key];
  return typeof t === 'number' && t > 0 ? t : def;
}

// ─── M5.4: Sensitive data in HTTP response ─────────────────────────────────

function detectSensitiveDataInResponse(
  session: TraceSession,
  cfg:     Record<string, RuleConfig>,
): Finding[] {
  const ruleId = ANALYSE_RULES.SENSITIVE_DATA_IN_RESPONSE;
  if (isDisabled(ruleId, cfg)) return [];

  const findings: Finding[] = [];
  const seen = new Set<string>();

  for (const event of session.events) {
    if (event.type !== 'http_response') continue;
    if (!event.output || typeof event.output !== 'object' || Array.isArray(event.output)) continue;

    const fields = collectKeys(event.output as Record<string, unknown>);
    for (const field of fields) {
      if (!isSensitiveFieldName(field)) continue;

      const fingerprint = fp(ruleId, session.traceId, field);
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);

      findings.push({
        id:          `find_${fingerprint}`,
        fingerprint,
        ruleId,
        severity:    effectiveSeverity(ruleId, 'high', cfg),
        category:    'security_sensitive_data',
        title:       `Sensitive field in HTTP response: "${field}"`,
        description: `The field "${field}" appears in the HTTP response payload and may expose ` +
                     `sensitive data (password, token, secret, PII). Leaking such fields in API ` +
                     `responses is a security risk and may violate data-protection requirements.`,
        evidence:    [{ traceId: session.traceId, eventIds: event.eventId ? [event.eventId] : [] }],
        recommendation:
          `Remove "${field}" from the response or redact its value before sending. ` +
          `Use an API resource / serializer layer to explicitly whitelist the fields ` +
          `your API should expose.`,
        remediation: REMEDIATIONS[ruleId],
      });
    }
  }

  return findings;
}

// ─── M5.6: N+1 query detection ────────────────────────────────────────────────

function detectNPlusOneQuery(
  session: TraceSession,
  cfg:     Record<string, RuleConfig>,
): Finding[] {
  const ruleId = ANALYSE_RULES.N_PLUS_ONE_QUERY;
  if (isDisabled(ruleId, cfg)) return [];

  // N+1 detection assumes the session represents a single isolated request
  // lifecycle.  For cli_command traces (entire test suite run captured at
  // Level 1), independent tests naturally repeat the same queries — the
  // repetition is expected and not an N+1 pattern.  Per-test sessions
  // (test_case entrypoint, Level 5) are correctly isolated and this rule
  // applies there.
  if (session.entrypoint.type === 'cli_command') return [];

  const nPlusOneThreshold = threshold(ruleId, 'repetitionCount', DEFAULT_N_PLUS_ONE_THRESHOLD, cfg);
  const findings: Finding[] = [];

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
    if (entry.count < nPlusOneThreshold) continue;

    const fingerprint = fp(
      ruleId,
      session.traceId,
      `${entry.resourceType}\x00${entry.operation}`,
    );

    findings.push({
      id:          `find_${fingerprint}`,
      fingerprint,
      ruleId,
      severity:    effectiveSeverity(ruleId, 'medium', cfg),
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
      remediation: REMEDIATIONS[ruleId],
      resource:    entry.resourceType,
    });
  }

  return findings;
}

// ─── G12: HTTP call origin classifier ────────────────────────────────────────

/**
 * Classifies the origin of an outbound HTTP call URL so that duplicate-side-
 * effect detection can apply different severity levels and titles depending on
 * whether the call targets a local test server (supertest / app.listen style),
 * a real external service, or an unclassifiable URL.
 *
 * - `'test_client'`:  empty URL, relative path, or a loopback/LAN hostname
 *                     (localhost, 127.x, ::1, 0.0.0.0, *.local, 192.168.*, 10.*)
 * - `'external'`:     URL with a parseable, non-loopback hostname
 * - `'unknown'`:      URL that cannot be parsed as a valid URL
 */
function classifyHttpCallOrigin(url: string): 'test_client' | 'external' | 'unknown' {
  try {
    // Relative paths and empty strings always refer to the local test server.
    if (!url || url.startsWith('/') || !url.includes('://')) return 'test_client';

    const parsed   = new URL(url);
    const hostname = parsed.hostname.toLowerCase();

    if (
      hostname === 'localhost'   ||
      hostname === '127.0.0.1'  ||
      hostname === '0.0.0.0'    ||
      hostname === '::1'        ||
      hostname.endsWith('.local') ||
      /^127\.\d+\.\d+\.\d+$/.test(hostname)    ||
      /^192\.168\.\d+\.\d+$/.test(hostname)     ||
      /^10\.\d+\.\d+\.\d+$/.test(hostname)      ||
      /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(hostname)
    ) {
      return 'test_client';
    }

    return 'external';
  } catch {
    return 'unknown';
  }
}

// ─── M5.7: Duplicate side effects ─────────────────────────────────────────────

function detectDuplicateSideEffects(
  session: TraceSession,
  cfg:     Record<string, RuleConfig>,
): Finding[] {
  const ruleId = ANALYSE_RULES.DUPLICATE_SIDE_EFFECTS;
  if (isDisabled(ruleId, cfg)) return [];

  // Duplicate side-effect detection assumes the session represents a single
  // isolated request lifecycle.  For cli_command traces (full test suite run
  // at Level 1), independent tests naturally call the same outbound URLs and
  // dispatch the same jobs — the repetition is expected and not a bug.
  // Per-test sessions (test_case entrypoint, Level 5) are correctly isolated
  // and this rule applies there.
  if (session.entrypoint.type === 'cli_command') return [];

  const findings: Finding[] = [];

  type Entry = { count: number; eventIds: string[] };
  const queueGroups:      Map<string, Entry> = new Map();
  // G12: three buckets by HTTP call origin so severity/messaging is accurate
  const testClientGroups: Map<string, Entry> = new Map();
  const externalGroups:   Map<string, Entry> = new Map();
  const unknownGroups:    Map<string, Entry> = new Map();

  for (const event of session.events) {
    if (event.type === 'queue_event' && event.name) {
      addToGroup(queueGroups, event.name, event.eventId);
    }

    if (event.type === 'external_http_call') {
      const method = String(
        (event.metadata?.['method'] as string | undefined) ?? '',
      ).toUpperCase();
      if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) continue;

      const url    = String(
        (event.metadata?.['url'] as string | undefined) ?? event.name ?? '',
      );
      const origin = classifyHttpCallOrigin(url);
      const bucket = origin === 'test_client' ? testClientGroups
                   : origin === 'external'    ? externalGroups
                   : unknownGroups;
      addToGroup(bucket, `${method}:${url}`, event.eventId);
    }
  }

  // ── Queue duplicates ──────────────────────────────────────────────────────
  for (const [name, entry] of queueGroups) {
    if (entry.count < 2) continue;
    const fingerprint = fp(ruleId, session.traceId, `queue:${name}`);
    findings.push({
      id:          `find_${fingerprint}`,
      fingerprint,
      ruleId,
      severity:    effectiveSeverity(ruleId, 'medium', cfg),
      category:    'data_integrity',
      title:       `Duplicate queue dispatch: "${name}" × ${entry.count}`,
      description: `The job/event "${name}" was dispatched ${entry.count} times within a single ` +
                   `request. Unless this is intentional, consumers may process the same work ` +
                   `multiple times (e.g. duplicate emails, double charges, redundant notifications).`,
      evidence:    [{ traceId: session.traceId, eventIds: entry.eventIds }],
      recommendation:
        `Verify the dispatch is not inside a loop or on multiple code paths. ` +
        `Consider idempotency keys or a deduplication layer in the queue consumer.`,
      remediation: REMEDIATIONS[ruleId],
    });
  }

  // ── G12: Test-client HTTP duplicates (severity: info) ────────────────────
  // These calls target localhost / the in-process test server (e.g. supertest).
  // Repeated requests to the test server within a single test are expected in
  // integration test suites and do not indicate a production bug.
  const testClientRuleId = ANALYSE_RULES.DUPLICATE_TEST_CLIENT_REQUESTS;
  for (const [key, entry] of testClientGroups) {
    if (entry.count < 2) continue;
    const colonIdx = key.indexOf(':');
    const method   = key.slice(0, colonIdx);
    const url      = key.slice(colonIdx + 1);
    const fingerprint = fp(testClientRuleId, session.traceId, key);
    findings.push({
      id:          `find_${fingerprint}`,
      fingerprint,
      ruleId:      testClientRuleId,
      severity:    effectiveSeverity(testClientRuleId, 'info', cfg),
      category:    'data_integrity',
      title:       `Repeated test-client request: ${method} "${url}" × ${entry.count}`,
      description: `The test harness made ${entry.count} ${method} requests to "${url}" in a ` +
                   `single test session. This is typical for integration tests using a local ` +
                   `HTTP client (e.g. supertest, httptest) and is usually not a production concern.`,
      evidence:    [{ traceId: session.traceId, eventIds: entry.eventIds }],
      recommendation:
        `Verify that each request is intentional in the test scenario. ` +
        `If not, ensure the test setup does not accidentally repeat requests (e.g. ` +
        `duplicate beforeEach hooks or shared test clients that auto-retry).`,
      remediation: REMEDIATIONS[ruleId],
    });
  }

  // ── G12: External HTTP duplicates (severity: medium) ─────────────────────
  for (const [key, entry] of externalGroups) {
    if (entry.count < 2) continue;
    const colonIdx = key.indexOf(':');
    const method   = key.slice(0, colonIdx);
    const url      = key.slice(colonIdx + 1);
    const fingerprint = fp(ruleId, session.traceId, key);
    findings.push({
      id:          `find_${fingerprint}`,
      fingerprint,
      ruleId,
      severity:    effectiveSeverity(ruleId, 'medium', cfg),
      category:    'data_integrity',
      title:       `Duplicate outbound ${method}: "${url}" × ${entry.count}`,
      description: `An outbound ${method} request to the external service "${url}" was made ` +
                   `${entry.count} times in a single request. This may cause unintended duplicate ` +
                   `writes or side effects on the remote service.`,
      evidence:    [{ traceId: session.traceId, eventIds: entry.eventIds }],
      recommendation:
        `Check whether the call appears in a loop or on multiple branches. ` +
        `If idempotency is required, pass an idempotency key in the request headers.`,
      remediation: REMEDIATIONS[ruleId],
    });
  }

  // ── G12: Unknown-origin HTTP duplicates (severity: low) ──────────────────
  for (const [key, entry] of unknownGroups) {
    if (entry.count < 2) continue;
    const colonIdx = key.indexOf(':');
    const method   = key.slice(0, colonIdx);
    const url      = key.slice(colonIdx + 1);
    const fingerprint = fp(ruleId, session.traceId, `unknown:${key}`);
    findings.push({
      id:          `find_${fingerprint}`,
      fingerprint,
      ruleId,
      severity:    effectiveSeverity(ruleId, 'low', cfg),
      category:    'data_integrity',
      title:       `Possible duplicate outbound ${method}: "${url}" × ${entry.count}`,
      description: `An outbound ${method} request to "${url}" was made ${entry.count} times in a ` +
                   `single request. The URL could not be classified as a test-client or external ` +
                   `call — review whether duplicate calls are intentional.`,
      evidence:    [{ traceId: session.traceId, eventIds: entry.eventIds }],
      recommendation:
        `Check whether the call appears in a loop or on multiple branches. ` +
        `If idempotency is required, pass an idempotency key in the request headers.`,
      remediation: REMEDIATIONS[ruleId],
    });
  }

  return findings;
}

// ─── M5.8: Missing transaction boundary ───────────────────────────────────────

function detectMissingTransaction(
  session: TraceSession,
  cfg:     Record<string, RuleConfig>,
): Finding[] {
  const ruleId = ANALYSE_RULES.MISSING_TRANSACTION;
  if (isDisabled(ruleId, cfg)) return [];

  const hasTransaction = session.events.some(
    (e) =>
      e.type === 'transaction_start' ||
      e.type === 'transaction_commit' ||
      e.type === 'transaction_rollback',
  );
  if (hasTransaction) return [];

  const writeEvents = session.events.filter(
    (e) =>
      e.type === 'db_query' &&
      e.resource != null &&
      WRITE_OPERATIONS.has(e.resource.operation),
  );

  const tables = new Set(writeEvents.map((e) => e.resource!.type));
  if (tables.size < 2) return [];

  const sortedTables = [...tables].sort();
  const fingerprint  = fp(
    ruleId,
    session.traceId,
    sortedTables.join(','),
  );

  const tableList = sortedTables.join(', ');
  return [{
    id:          `find_${fingerprint}`,
    fingerprint,
    ruleId,
    severity:    effectiveSeverity(ruleId, 'medium', cfg),
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
    remediation: REMEDIATIONS[ruleId],
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

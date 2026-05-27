/**
 * TraceGraph — Trace Sanitizer
 *
 * Redacts sensitive fields and enforces size limits on values before
 * they enter the trace pipeline. Must run on ALL user-controlled data
 * (request bodies, response bodies, function arguments, DB rows).
 *
 * ARCHITECTURE.md §8: Behaviour Diff — Volatile Value Normalisation
 */

export type SanitizerConfig = {
  /** Maximum object nesting depth. Default: 4 */
  maxDepth?: number;
  /** Maximum array length (excess items dropped). Default: 50 */
  maxArrayLength?: number;
  /** Maximum string length (excess characters replaced with [TRUNCATED]). Default: 500 */
  maxStringLength?: number;
  /** Maximum number of object keys (excess keys replaced with a summary). Default: 100 */
  maxObjectKeys?: number;
  /** Additional keys to redact (merged with the built-in list). */
  redactKeys?: string[];
};

// ─── Built-in redact key list ─────────────────────────────────────────────────

const BUILTIN_REDACT_KEYS: ReadonlySet<string> = new Set([
  'password', 'passwd', 'pass',
  'token', 'accesstoken', 'refreshtoken', 'idtoken',
  'authorization', 'authorisation',
  'cookie', 'set-cookie',
  'session', 'sessionid', 'sessid',
  'secret', 'apisecret', 'clientsecret',
  'apikey', 'api_key', 'x-api-key',
  'privatekey', 'private_key',
  'cardnumber', 'card_number', 'creditcard', 'credit_card',
  'cvv', 'cvc', 'securitycode',
  'pin',
  'otp',
  'ssn', 'socialsecuritynumber',
  'dob', 'dateofbirth',
  'x-auth-token', 'x_auth_token',
]);

const REDACTED = '[REDACTED]';
const TRUNCATED_SUFFIX = '…[TRUNCATED]';
const MAX_DEPTH_MARKER = '[MAX_DEPTH]';
const UNSUPPORTED_MARKER = '[UNSUPPORTED]';

export type SanitizedValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | SanitizedObject
  | SanitizedArray;

type SanitizedObject = { [key: string]: SanitizedValue };
type SanitizedArray  = SanitizedValue[];

// ─── Core sanitize function ───────────────────────────────────────────────────

/**
 * Recursively redact sensitive keys and enforce size limits on a value.
 *
 * This function is a pure transform — it never mutates the input.
 */
export function sanitize(
  value: unknown,
  config: SanitizerConfig = {},
  _depth = 0,
): SanitizedValue {
  const {
    maxDepth       = 4,
    maxArrayLength = 50,
    maxStringLength = 500,
    maxObjectKeys  = 100,
    redactKeys     = [],
  } = config;

  // Depth guard — _depth 0 = root; maxDepth is the last level fully processed
  if (_depth >= maxDepth) return MAX_DEPTH_MARKER;

  // Primitives
  if (value === null || value === undefined) return value as null | undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value); // Infinity / NaN → string
  }
  if (typeof value === 'string') {
    return value.length > maxStringLength
      ? value.slice(0, maxStringLength) + TRUNCATED_SUFFIX
      : value;
  }

  // Arrays
  if (Array.isArray(value)) {
    const sliced = value.slice(0, maxArrayLength);
    return sliced.map((item) => sanitize(item, config, _depth + 1));
  }

  // Plain objects (dates, Maps, Sets → fallback to string representation)
  if (value instanceof Date)    return value.toISOString();
  if (value instanceof RegExp)  return value.toString();

  if (typeof value === 'object') {
    // Build combined redact set (lower-cased)
    const extraKeys  = redactKeys.map((k) => k.toLowerCase());
    const allRedact  = extraKeys.length > 0
      ? new Set([...BUILTIN_REDACT_KEYS, ...extraKeys])
      : BUILTIN_REDACT_KEYS;

    const result: SanitizedObject = {};
    const entries = Object.entries(value as Record<string, unknown>);
    let count = 0;

    for (const [k, v] of entries) {
      if (count >= maxObjectKeys) {
        result['[KEYS_TRUNCATED]'] =
          `…${entries.length - maxObjectKeys} more key(s) omitted`;
        break;
      }
      result[k] = allRedact.has(k.toLowerCase())
        ? REDACTED
        : sanitize(v, config, _depth + 1);
      count++;
    }
    return result;
  }

  // Functions, symbols, BigInt, etc.
  return UNSUPPORTED_MARKER;
}

// ─── Header sanitizer ─────────────────────────────────────────────────────────

/** Headers that are safe to retain verbatim in trace output. */
const SAFE_HEADERS: ReadonlySet<string> = new Set([
  'content-type',
  'content-length',
  'accept',
  'accept-encoding',
  'accept-language',
  'cache-control',
  'user-agent',
  'x-request-id',
  'x-correlation-id',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-tracegraph-correlation-id',
  'x-tracegraph-scenario-id',
  'traceparent',
  'tracestate',
]);

/** Headers that must always be redacted. */
const ALWAYS_REDACT_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
  'proxy-authorization',
]);

/**
 * Sanitize HTTP headers: redact auth/cookie headers, keep informational ones.
 *
 * Any header not in the safe list and not explicitly redacted is retained as-is
 * but truncated to maxStringLength if it's a string.
 */
export function sanitizeHeaders(
  headers: Record<string, unknown>,
  config: SanitizerConfig = {},
): Record<string, SanitizedValue> {
  const result: Record<string, SanitizedValue> = {};
  const maxLen = config.maxStringLength ?? 500;

  for (const [key, value] of Object.entries(headers)) {
    const lk = key.toLowerCase();
    if (ALWAYS_REDACT_HEADERS.has(lk)) {
      result[key] = REDACTED;
    } else if (typeof value === 'string' && value.length > maxLen) {
      result[key] = value.slice(0, maxLen) + TRUNCATED_SUFFIX;
    } else {
      result[key] = value as SanitizedValue;
    }
  }
  return result;
}

// ─── Volatile value normaliser (for diff stability) ───────────────────────────

const UUID_RE    = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_TS_RE  = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const NUMERIC_ID_RE = /^\d{1,18}$/;
const JWT_RE     = /^ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * Replace volatile values (UUIDs, timestamps, numeric IDs, JWTs) with stable
 * placeholders so that behaviour diffs don't flag constant structural changes.
 *
 * Used during baseline comparison (M2+), not during event capture.
 */
export function normaliseForDiff(value: unknown): unknown {
  if (typeof value === 'string') {
    if (UUID_RE.test(value))    return '<uuid>';
    if (ISO_TS_RE.test(value))  return '<timestamp>';
    if (JWT_RE.test(value))     return '<token>';
    if (NUMERIC_ID_RE.test(value)) return '<id>';
    return value;
  }
  if (typeof value === 'number') {
    // Large integers that look like timestamps (ms epoch)
    if (value > 1_000_000_000_000) return '<timestamp>';
    return value;
  }
  if (Array.isArray(value)) return value.map(normaliseForDiff);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, normaliseForDiff(v)])
    );
  }
  return value;
}

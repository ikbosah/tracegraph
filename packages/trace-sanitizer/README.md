# @tracegraph/trace-sanitizer

Value redaction and size-limiting for TraceGraph events. Ensures that sensitive data (passwords, tokens, API keys, card numbers, PII) is never written to trace files, and that captured payloads stay within configurable size limits. Also provides a `normaliseForDiff` function that replaces volatile values (UUIDs, timestamps, JWTs, numeric IDs) with stable placeholders so that behaviour diffs don't generate noise from non-deterministic values.

## What's in this package

| Export | Description |
|--------|-------------|
| `sanitize(value, config?)` | Recursively redacts sensitive keys and enforces size limits on any value |
| `sanitizeHeaders(headers, config?)` | Sanitizes HTTP headers: always redacts `authorization`, `cookie`, `set-cookie`, `x-api-key`; retains safe informational headers |
| `normaliseForDiff(value)` | Replaces UUIDs, ISO timestamps, JWTs, and large numeric IDs with stable placeholders (`<uuid>`, `<timestamp>`, `<token>`, `<id>`) for stable baseline comparisons |
| `SanitizerConfig` | Configuration type for `sanitize` and `sanitizeHeaders` |
| `SanitizedValue` | Return type of `sanitize` |

## Installation

```bash
npm install @tracegraph/trace-sanitizer
```

## Usage

### Sanitizing request/response bodies

```typescript
import { sanitize } from '@tracegraph/trace-sanitizer';

const body = {
  customerId: 'cust_123',
  password:   's3cr3t',          // ← will be redacted
  cardNumber: '4111111111111111', // ← will be redacted
  items: [{ sku: 'A1', qty: 2 }],
};

const safe = sanitize(body);
// {
//   customerId: 'cust_123',
//   password:   '[REDACTED]',
//   cardNumber: '[REDACTED]',
//   items: [{ sku: 'A1', qty: 2 }],
// }
```

### Custom configuration

```typescript
import { sanitize } from '@tracegraph/trace-sanitizer';

const safe = sanitize(value, {
  redactKeys:      ['internalToken', 'legacyPass'],  // merged with built-in list
  maxDepth:        3,
  maxStringLength: 200,
  maxArrayLength:  20,
  maxObjectKeys:   50,
});
```

### Sanitizing HTTP headers

```typescript
import { sanitizeHeaders } from '@tracegraph/trace-sanitizer';

const safeHeaders = sanitizeHeaders(req.headers);
// authorization → '[REDACTED]'
// cookie        → '[REDACTED]'
// content-type  → 'application/json'  (retained)
```

### Normalising for diff stability

```typescript
import { normaliseForDiff } from '@tracegraph/trace-sanitizer';

const raw = {
  id:        '550e8400-e29b-41d4-a716-446655440000',  // UUID
  createdAt: '2026-05-30T12:00:00.000Z',              // ISO timestamp
  userId:    12345678,                                 // large numeric ID
};

const stable = normaliseForDiff(raw);
// { id: '<uuid>', createdAt: '<timestamp>', userId: '<id>' }
```

Passing the normalised value to `JSON.stringify` and hashing it produces a stable identity hash that survives UUID rotation and timestamp drift between runs.

## Built-in redacted keys

The following key names (case-insensitive, separator-stripped) are always redacted regardless of configuration:

`password`, `token`, `accesstoken`, `refreshtoken`, `authorization`, `cookie`, `set-cookie`, `session`, `secret`, `apikey`, `privatekey`, `cardnumber`, `cvv`, `cvc`, `pin`, `otp`, `ssn`, `x-api-key`, `x-auth-token`, and more.

## Notes

- `sanitize()` is a **pure function** — it never mutates the input.
- Applied to **all user-controlled data** before it enters the trace pipeline: request bodies, response bodies, function arguments, DB rows.
- `normaliseForDiff` is used at **comparison time** (inside `@tracegraph/graph-engine`), not during event capture.

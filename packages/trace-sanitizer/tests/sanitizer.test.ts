import { describe, it, expect } from 'vitest';
import { sanitize, sanitizeHeaders, normaliseForDiff } from '../src/index';

describe('sanitize()', () => {
  it('passes through primitives unchanged', () => {
    expect(sanitize('hello')).toBe('hello');
    expect(sanitize(42)).toBe(42);
    expect(sanitize(true)).toBe(true);
    expect(sanitize(null)).toBeNull();
    expect(sanitize(undefined)).toBeUndefined();
  });

  it('redacts built-in sensitive keys', () => {
    const result = sanitize({
      username: 'alice',
      password: 'hunter2',
      token: 'abc123',
      authorization: 'Bearer xyz',
    }) as Record<string, unknown>;

    expect(result.username).toBe('alice');
    expect(result.password).toBe('[REDACTED]');
    expect(result.token).toBe('[REDACTED]');
    expect(result.authorization).toBe('[REDACTED]');
  });

  it('redacts keys case-insensitively', () => {
    const result = sanitize({ Password: 'secret', TOKEN: 'abc' }) as Record<string, unknown>;
    expect(result.Password).toBe('[REDACTED]');
    expect(result.TOKEN).toBe('[REDACTED]');
  });

  it('redacts custom extra keys', () => {
    const result = sanitize(
      { mySpecialField: 'sensitive', other: 'ok' },
      { redactKeys: ['mySpecialField'] },
    ) as Record<string, unknown>;
    expect(result.mySpecialField).toBe('[REDACTED]');
    expect(result.other).toBe('ok');
  });

  it('truncates long strings', () => {
    const long = 'a'.repeat(1000);
    const result = sanitize(long) as string;
    expect(result.length).toBeLessThan(600);
    expect(result).toContain('[TRUNCATED]');
  });

  it('respects maxStringLength config', () => {
    const result = sanitize('hello world', { maxStringLength: 5 }) as string;
    expect(result).toBe('hello…[TRUNCATED]');
  });

  it('limits array length', () => {
    const arr = Array.from({ length: 100 }, (_, i) => i);
    const result = sanitize(arr) as unknown[];
    expect(result.length).toBe(50);
  });

  it('respects maxArrayLength config', () => {
    const arr = [1, 2, 3, 4, 5];
    const result = sanitize(arr, { maxArrayLength: 3 }) as unknown[];
    expect(result.length).toBe(3);
  });

  it('enforces depth limit', () => {
    // maxDepth:2 means: depth-0 (root) and depth-1 (a) are processed,
    // depth-2 (b) hits the guard and becomes '[MAX_DEPTH]'.
    const deep = { a: { b: { c: { d: { e: { f: 'too deep' } } } } } };
    const result = sanitize(deep, { maxDepth: 2 }) as Record<string, unknown>;
    expect((result.a as Record<string, unknown>).b).toBe('[MAX_DEPTH]');
  });

  it('limits object keys', () => {
    const obj = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`k${i}`, i]));
    const result = sanitize(obj, { maxObjectKeys: 10 }) as Record<string, unknown>;
    const keys = Object.keys(result).filter((k) => !k.startsWith('['));
    expect(keys.length).toBe(10);
    expect(result['[KEYS_TRUNCATED]']).toBeDefined();
  });

  it('handles nested objects with sensitive keys', () => {
    const result = sanitize({
      user: {
        name: 'alice',
        credentials: { password: 'secret', pin: '1234' },
      },
    }) as Record<string, unknown>;

    const user = result.user as Record<string, unknown>;
    const creds = user.credentials as Record<string, unknown>;
    expect(user.name).toBe('alice');
    expect(creds.password).toBe('[REDACTED]');
    expect(creds.pin).toBe('[REDACTED]');
  });

  it('handles arrays of objects', () => {
    const result = sanitize([
      { name: 'alice', token: 'abc' },
      { name: 'bob',   token: 'def' },
    ]) as Record<string, unknown>[];
    expect(result[0]?.name).toBe('alice');
    expect(result[0]?.token).toBe('[REDACTED]');
    expect(result[1]?.name).toBe('bob');
    expect(result[1]?.token).toBe('[REDACTED]');
  });

  it('serialises Date objects to ISO string', () => {
    const d = new Date('2024-01-01T00:00:00Z');
    expect(sanitize(d)).toBe('2024-01-01T00:00:00.000Z');
  });

  it('marks unsupported values', () => {
    expect(sanitize(() => {})).toBe('[UNSUPPORTED]');
  });

  it('handles Infinity and NaN', () => {
    expect(sanitize(Infinity)).toBe('Infinity');
    expect(sanitize(NaN)).toBe('NaN');
  });
});

describe('sanitizeHeaders()', () => {
  it('redacts authorization header', () => {
    const result = sanitizeHeaders({ Authorization: 'Bearer token123', 'Content-Type': 'application/json' });
    expect(result.Authorization).toBe('[REDACTED]');
    expect(result['Content-Type']).toBe('application/json');
  });

  it('redacts cookie header', () => {
    const result = sanitizeHeaders({ cookie: 'session=abc123', 'user-agent': 'curl/7.x' });
    expect(result.cookie).toBe('[REDACTED]');
    expect(result['user-agent']).toBe('curl/7.x');
  });

  it('redacts set-cookie header', () => {
    const result = sanitizeHeaders({ 'set-cookie': 'session=xyz; HttpOnly' });
    expect(result['set-cookie']).toBe('[REDACTED]');
  });

  it('redacts x-api-key header', () => {
    const result = sanitizeHeaders({ 'x-api-key': 'my-key' });
    expect(result['x-api-key']).toBe('[REDACTED]');
  });

  it('preserves traceparent and tracegraph correlation headers', () => {
    const result = sanitizeHeaders({
      traceparent: '00-abc-def-01',
      'x-tracegraph-scenario-id': 'scen_123',
      'x-tracegraph-correlation-id': 'corr_456',
    });
    expect(result.traceparent).toBe('00-abc-def-01');
    expect(result['x-tracegraph-scenario-id']).toBe('scen_123');
  });

  it('truncates very long header values', () => {
    const long = 'x'.repeat(1000);
    const result = sanitizeHeaders({ 'x-custom': long }, { maxStringLength: 20 });
    expect((result['x-custom'] as string).length).toBeLessThan(40);
    expect(result['x-custom']).toContain('[TRUNCATED]');
  });
});

describe('normaliseForDiff()', () => {
  it('normalises UUIDs', () => {
    expect(normaliseForDiff('550e8400-e29b-41d4-a716-446655440000')).toBe('<uuid>');
  });

  it('normalises ISO timestamps', () => {
    expect(normaliseForDiff('2024-01-15T12:00:00Z')).toBe('<timestamp>');
    expect(normaliseForDiff('2024-01-15T12:00:00.123Z')).toBe('<timestamp>');
  });

  it('normalises large epoch timestamps', () => {
    expect(normaliseForDiff(1705312800000)).toBe('<timestamp>');
  });

  it('normalises small numeric IDs', () => {
    expect(normaliseForDiff('12345')).toBe('<id>');
    expect(normaliseForDiff('1')).toBe('<id>');
  });

  it('normalises JWT tokens', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    expect(normaliseForDiff(jwt)).toBe('<token>');
  });

  it('normalises values inside objects', () => {
    const result = normaliseForDiff({
      id: '550e8400-e29b-41d4-a716-446655440000',
      name: 'Alice',
    }) as Record<string, unknown>;
    expect(result.id).toBe('<uuid>');
    expect(result.name).toBe('Alice');
  });

  it('normalises values inside arrays', () => {
    const result = normaliseForDiff(['550e8400-e29b-41d4-a716-446655440000', 'hello']) as unknown[];
    expect(result[0]).toBe('<uuid>');
    expect(result[1]).toBe('hello');
  });

  it('leaves normal strings alone', () => {
    expect(normaliseForDiff('hello world')).toBe('hello world');
    expect(normaliseForDiff('user@example.com')).toBe('user@example.com');
  });
});

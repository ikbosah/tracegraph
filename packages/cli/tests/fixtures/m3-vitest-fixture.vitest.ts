/**
 * M3 integration test fixture — Vitest test file with a known structure.
 *
 * This file is run by the M3 integration test using:
 *   tracegraph run -- vitest run --config vitest.m3-integration.config.ts <this-file>
 *
 * NOTE: This file uses .vitest.ts extension (not .test.ts) so it is NOT picked
 * up by the workspace-root vitest run. It is only run explicitly by the integration test.
 *
 * Intentional structure (verified by integration tests):
 *   describe('Calculator')
 *     it('adds two numbers')          → PASS
 *     it('subtracts two numbers')     → PASS
 *     it('divides by zero returns Infinity') → PASS
 *   describe('StringUtils')
 *     it('trims whitespace')          → PASS
 *     it('fails intentionally')       → FAIL  (always fails)
 *     it.skip('skipped test')         → SKIP
 *
 * Total: 6 tests, 4 pass, 1 fail, 1 skip
 */
import { describe, it, expect } from 'vitest';

describe('Calculator', () => {
  it('adds two numbers', () => {
    expect(1 + 2).toBe(3);
  });

  it('subtracts two numbers', () => {
    expect(10 - 4).toBe(6);
  });

  it('divides by zero returns Infinity', () => {
    expect(1 / 0).toBe(Infinity);
  });
});

describe('StringUtils', () => {
  it('trims whitespace', () => {
    expect('  hello  '.trim()).toBe('hello');
  });

  it('fails intentionally', () => {
    expect(1).toBe(999);   // always fails — intentional for fixture
  });

  it.skip('skipped test', () => {
    expect(true).toBe(true);
  });
});

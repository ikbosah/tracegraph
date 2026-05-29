/**
 * M7A T7A.1 — diff-parser unit tests
 *
 * Tests parseDiff() for:
 *  - Empty / whitespace-only diff returns []
 *  - TypeScript function declarations (named, async, exported)
 *  - Const arrow function expressions
 *  - Class method declarations (with class context tracking)
 *  - PHP function declarations
 *  - Class method in PHP
 *  - Ignores removed lines (-)
 *  - Deduplicates same function across multiple hunks
 *  - Multiple files in one diff
 *  - Ignores control-flow keywords
 */

import { describe, it, expect } from 'vitest';
import { parseDiff }            from '../src/diff-parser';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Wrap a snippet in a minimal unified-diff envelope for a TypeScript file.
 * `hunks` is an array of { start, lines } where lines is an array of
 * strings prefixed with '+', '-', or ' '.
 */
function makeDiff(
  file:   string,
  hunks:  Array<{ start?: number; lines: string[] }>,
): string {
  const parts = [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
  ];
  let lineNum = 1;
  for (const hunk of hunks) {
    const start = hunk.start ?? lineNum;
    parts.push(`@@ -${start},${hunk.lines.length} +${start},${hunk.lines.length} @@`);
    for (const l of hunk.lines) {
      parts.push(l);
      if (!l.startsWith('-')) lineNum++;
    }
  }
  return parts.join('\n');
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('parseDiff() — empty inputs', () => {
  it('returns [] for empty string', () => {
    expect(parseDiff('')).toEqual([]);
  });

  it('returns [] for whitespace-only string', () => {
    expect(parseDiff('   \n  ')).toEqual([]);
  });

  it('returns [] when diff has only removed lines', () => {
    const diff = makeDiff('src/a.ts', [{ lines: ['-function oldFn() {'] }]);
    const result = parseDiff(diff);
    expect(result).toEqual([]);
  });
});

describe('parseDiff() — TypeScript named functions', () => {
  it('extracts a simple named function declaration', () => {
    const diff = makeDiff('src/invoice.ts', [
      { lines: ['+function createInvoice(data: unknown) {'] },
    ]);
    const result = parseDiff(diff);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ file: 'src/invoice.ts', functionName: 'createInvoice' });
  });

  it('extracts an async named function', () => {
    const diff = makeDiff('src/service.ts', [
      { lines: ['+async function fetchUser(id: string) {'] },
    ]);
    const result = parseDiff(diff);
    expect(result[0]).toMatchObject({ functionName: 'fetchUser' });
  });

  it('extracts an exported async function', () => {
    const diff = makeDiff('src/api.ts', [
      { lines: ['+export async function processOrder(order: Order) {'] },
    ]);
    const result = parseDiff(diff);
    expect(result[0]).toMatchObject({ functionName: 'processOrder' });
  });
});

describe('parseDiff() — TypeScript arrow functions', () => {
  it('extracts a const arrow function', () => {
    const diff = makeDiff('src/utils.ts', [
      { lines: ['+const validateEmail = (email: string) => {'] },
    ]);
    const result = parseDiff(diff);
    expect(result[0]).toMatchObject({ functionName: 'validateEmail' });
  });

  it('extracts an async const arrow function', () => {
    const diff = makeDiff('src/utils.ts', [
      { lines: ['+const fetchData = async (url: string) => {'] },
    ]);
    const result = parseDiff(diff);
    expect(result[0]).toMatchObject({ functionName: 'fetchData' });
  });
});

describe('parseDiff() — class methods', () => {
  it('extracts a class method with class context from context line', () => {
    const diff = makeDiff('src/invoice.ts', [
      {
        lines: [
          ' class InvoiceService {',
          '+  create(data: unknown) {',
        ],
      },
    ]);
    const result = parseDiff(diff);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      file:       'src/invoice.ts',
      className:  'InvoiceService',
      methodName: 'create',
    });
    expect(result[0]?.functionName).toBeUndefined();
  });

  it('extracts a public async class method', () => {
    const diff = makeDiff('src/service.ts', [
      {
        lines: [
          ' class UserService {',
          '+  async findById(id: string): Promise<User> {',
        ],
      },
    ]);
    const result = parseDiff(diff);
    expect(result[0]).toMatchObject({ className: 'UserService', methodName: 'findById' });
  });
});

describe('parseDiff() — PHP', () => {
  it('extracts a PHP function declaration', () => {
    const diff = makeDiff('app/Http/Controllers/InvoiceController.php', [
      { lines: ['+    public function store(Request $request) {'] },
    ]);
    const result = parseDiff(diff);
    expect(result[0]).toMatchObject({ functionName: 'store' });
  });

  it('extracts a static PHP function', () => {
    const diff = makeDiff('src/Helper.php', [
      { lines: ['+    public static function formatCurrency(float $amount): string {'] },
    ]);
    const result = parseDiff(diff);
    expect(result[0]).toMatchObject({ functionName: 'formatCurrency' });
  });
});

describe('parseDiff() — deduplication', () => {
  it('deduplicates the same function across multiple hunks', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,1 +1,1 @@',
      '+function doSomething() {',
      '@@ -10,1 +10,1 @@',
      '+function doSomething() {',  // duplicate — same file + same name
    ].join('\n');

    const result = parseDiff(diff);
    const count  = result.filter(f => f.functionName === 'doSomething').length;
    expect(count).toBe(1);
  });
});

describe('parseDiff() — multiple files', () => {
  it('extracts functions from multiple files in one diff', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,1 +1,1 @@',
      '+function alpha() {',
      'diff --git a/src/b.ts b/src/b.ts',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -1,1 +1,1 @@',
      '+function beta() {',
    ].join('\n');

    const result = parseDiff(diff);
    expect(result.map(f => f.functionName)).toEqual(
      expect.arrayContaining(['alpha', 'beta']),
    );
  });
});

describe('parseDiff() — noise filtering', () => {
  it('does not extract control-flow keywords', () => {
    const diff = makeDiff('src/a.ts', [
      { lines: ['+if (condition) {', '+for (let i = 0; i < n; i++) {'] },
    ]);
    expect(parseDiff(diff)).toEqual([]);
  });

  it('does not include single-character names', () => {
    // Some patterns could inadvertently match "n" or "i"
    const diff = makeDiff('src/a.ts', [
      { lines: ['+const x = (n: number) => n * 2;'] },
    ]);
    const result = parseDiff(diff);
    const bad = result.filter(f => (f.functionName ?? '').length <= 1);
    expect(bad).toHaveLength(0);
  });
});

describe('parseDiff() — startLine', () => {
  it('records the correct new-file line number', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -5,3 +5,3 @@',
      ' // context',
      ' // context',
      '+function atLine7() {',
    ].join('\n');

    const result = parseDiff(diff);
    expect(result[0]).toMatchObject({ startLine: 7 });
  });
});

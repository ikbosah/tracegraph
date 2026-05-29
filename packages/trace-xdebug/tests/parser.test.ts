/**
 * Unit tests for the Xdebug streaming parser.
 *
 * XP1: Parses a minimal trace with one entry/exit pair
 * XP2: Infers depth from leading whitespace
 * XP3: Detects tracegraph_xdebug_marker entries and extracts eventId
 * XP4: Extracts TRACE START timestamp
 * XP5: Tolerates missing file/line on exit lines
 * XP6: Skips header metadata lines (Version, File format)
 * XP7: Handles empty lines gracefully
 */
import { describe, test, expect } from 'vitest';
import { parseXdebugString } from '../src/parser';

// ─── XP1 ──────────────────────────────────────────────────────────────────────

test('XP1: parses a minimal trace with one entry/exit pair', () => {
  const content = `
TRACE START [2024-01-01 12:00:00.000000]
    0.0001    262064   -> {main}()  /app/index.php:1
      0.0002    263088     -> App\\Controller->index()  /app/Controller.php:42
      0.0003    263088     <- App\\Controller->index()  /app/Controller.php:42
    0.0004    262064   <- {main}()  /app/index.php:1
TRACE END   [2024-01-01 12:00:00.123000]
  `.trim();

  const result = parseXdebugString(content);

  expect(result.entries).toHaveLength(4);
  expect(result.entries[0]!.kind).toBe('entry');
  expect(result.entries[0]!.fnName).toBe('{main}');
  expect(result.entries[1]!.kind).toBe('entry');
  expect(result.entries[1]!.fnName).toBe('App\\Controller->index');
  expect(result.entries[2]!.kind).toBe('exit');
  expect(result.entries[3]!.kind).toBe('exit');
});

// ─── XP2 ──────────────────────────────────────────────────────────────────────

test('XP2: infers depth from leading whitespace', () => {
  const content = [
    'TRACE START [2024-01-01]',
    '    0.0001    100   -> level0() /a.php:1',
    '      0.0002    100     -> level1() /a.php:2',
    '        0.0003    100       -> level2() /a.php:3',
  ].join('\n');

  const result = parseXdebugString(content);

  // Depths should increase with indentation
  const depths = result.entries.map((e) => e.depth);
  expect(depths[0]!).toBeLessThan(depths[1]!);
  expect(depths[1]!).toBeLessThan(depths[2]!);
});

// ─── XP3 ──────────────────────────────────────────────────────────────────────

test('XP3: detects tracegraph_xdebug_marker and extracts eventId', () => {
  const content = [
    'TRACE START [2024-01-01]',
    "    0.0001    100   -> tracegraph_xdebug_marker('evt_abc123') /app/Svc.php:10",
    '    0.0002    100   <- tracegraph_xdebug_marker() /app/Svc.php:10',
  ].join('\n');

  const result = parseXdebugString(content);

  const markers = result.entries.filter((e) => e.kind === 'marker');
  expect(markers).toHaveLength(1);
  expect(markers[0]!.markerEventId).toBe('evt_abc123');
});

// ─── XP4 ──────────────────────────────────────────────────────────────────────

test('XP4: extracts TRACE START timestamp', () => {
  const content = `
TRACE START [2024-06-15 09:30:00.123456]
    0.0001    100   -> main() /a.php:1
TRACE END   [2024-06-15 09:30:01.000000]
  `.trim();

  const result = parseXdebugString(content);

  expect(result.traceStart).toBe('2024-06-15 09:30:00.123456');
  expect(result.traceEnd).toBe('2024-06-15 09:30:01.000000');
});

// ─── XP5 ──────────────────────────────────────────────────────────────────────

test('XP5: tolerates exit lines with no file/line info', () => {
  const content = [
    'TRACE START [2024-01-01]',
    '    0.0001    100   -> fn() /a.php:1',
    '    0.0002    100   <- fn()',    // no file:line
  ].join('\n');

  const result = parseXdebugString(content);

  expect(result.entries).toHaveLength(2);
  const exitEntry = result.entries[1]!;
  expect(exitEntry.kind).toBe('exit');
  expect(exitEntry.file).toBeUndefined();
  expect(exitEntry.line).toBeUndefined();
});

// ─── XP6 ──────────────────────────────────────────────────────────────────────

test('XP6: skips Version and File format header lines', () => {
  const content = [
    'TRACE START [2024-01-01]',
    'Version: 3.2.0',
    'File format: 4',
    '    0.0001    100   -> fn() /a.php:1',
  ].join('\n');

  const result = parseXdebugString(content);
  expect(result.entries).toHaveLength(1);
});

// ─── XP7 ──────────────────────────────────────────────────────────────────────

test('XP7: handles empty lines and whitespace-only lines gracefully', () => {
  const content = `
TRACE START [2024-01-01]

    0.0001    100   -> fn() /a.php:1

    0.0002    100   <- fn() /a.php:1

TRACE END   [2024-01-01]
  `;

  const result = parseXdebugString(content);
  expect(result.entries).toHaveLength(2);
});

// ─── Parser — async stream API ────────────────────────────────────────────────

describe('parseXdebugStream', () => {
  test('produces the same result as parseXdebugString', async () => {
    const { parseXdebugStream } = await import('../src/parser');

    const lines = [
      'TRACE START [2024-01-01]',
      "    0.0001    100   -> tracegraph_xdebug_marker('evt_xyz') /a.php:1",
      '    0.0002    100   <- tracegraph_xdebug_marker() /a.php:1',
      '    0.0003    100   -> doWork() /a.php:2',
      '    0.0004    100   <- doWork() /a.php:2',
      'TRACE END   [2024-01-01]',
    ];

    async function* makeAsyncIter(arr: string[]): AsyncIterable<string> {
      for (const item of arr) yield item;
    }

    const syncResult  = parseXdebugString(lines.join('\n'));
    const asyncResult = await parseXdebugStream(makeAsyncIter(lines));

    expect(asyncResult.entries.length).toBe(syncResult.entries.length);
    expect(asyncResult.traceStart).toBe(syncResult.traceStart);
  });
});

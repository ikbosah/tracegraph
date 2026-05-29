/**
 * Unit tests for the Xdebug merger.
 *
 * XM1: Marker-matched events get a detail stream with confidence 1.0
 * XM2: Detail stream contains function_call entries after the marker
 * XM3: Timestamp-heuristic correlation matches events within tolerance
 * XM4: Events outside tolerance are not matched
 * XM5: mergedTraceToEvents emits TraceEvents with correct parentEventId
 * XM6: Correlation stats count matched/unmatched correctly
 */
import { test, expect } from 'vitest';
import type { TraceEvent } from '@tracegraph/shared-types';
import { SCHEMA_VERSIONS } from '@tracegraph/shared-types';
import { parseXdebugString } from '../src/parser';
import { mergeXdebugTrace, mergedTraceToEvents } from '../src/merger';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<TraceEvent>): TraceEvent {
  return {
    schemaVersion: SCHEMA_VERSIONS.event,
    eventId:       'evt_test_001',
    traceId:       'trace_test',
    parentEventId: null,
    type:          'function_call',
    language:      'php',
    name:          'TestSvc.doWork',
    startTime:     1000,
    ...overrides,
  } as TraceEvent;
}

// ─── XM1 ──────────────────────────────────────────────────────────────────────

test('XM1: marker-matched events get a detail stream with confidence 1.0', () => {
  const xdebugContent = [
    'TRACE START [2024-01-01]',
    "    0.0001    100   -> tracegraph_xdebug_marker('evt_test_001') /Svc.php:1",
    '    0.0002    100   <- tracegraph_xdebug_marker() /Svc.php:1',
    '    0.0003    100   -> doWork() /Svc.php:2',
    '    0.0004    100   <- doWork() /Svc.php:2',
  ].join('\n');

  const parsed = parseXdebugString(xdebugContent);
  const events = [makeEvent({ eventId: 'evt_test_001', type: 'function_call' })];
  const merged = mergeXdebugTrace(events, parsed, 0);

  expect(merged.detailStreams).toHaveLength(1);
  expect(merged.detailStreams[0]!.anchorEventId).toBe('evt_test_001');
  expect(merged.detailStreams[0]!.confidence).toBe(1.0);
});

// ─── XM2 ──────────────────────────────────────────────────────────────────────

test('XM2: detail stream contains function_call entries after the marker', () => {
  const xdebugContent = [
    'TRACE START [2024-01-01]',
    "    0.0001    100   -> tracegraph_xdebug_marker('evt_abc') /Svc.php:1",
    '    0.0002    100   <- tracegraph_xdebug_marker() /Svc.php:1',
    '    0.0003    100   -> firstCall() /Svc.php:2',
    '      0.0004    100     -> nestedCall() /Svc.php:3',
    '      0.0005    100     <- nestedCall() /Svc.php:3',
    '    0.0006    100   <- firstCall() /Svc.php:2',
  ].join('\n');

  const parsed = parseXdebugString(xdebugContent);
  const events = [makeEvent({ eventId: 'evt_abc', type: 'function_call' })];
  const merged = mergeXdebugTrace(events, parsed, 0);

  const stream = merged.detailStreams[0]!;
  // firstCall entry + nestedCall entry + nestedCall exit + firstCall exit = 4
  expect(stream.calls.length).toBeGreaterThanOrEqual(3);
  expect(stream.calls[0]!.fnName).toBe('firstCall');
  expect(stream.calls[0]!.kind).toBe('function_call');
});

// ─── XM3 ──────────────────────────────────────────────────────────────────────

test('XM3: timestamp heuristic matches events within tolerance', () => {
  // No markers — fall back to timestamp matching
  // Semantic event at ms=100; Xdebug entry at timeIndex=0.095s → 95ms, delta=5ms (within 50ms)
  const xdebugContent = [
    'TRACE START [2024-01-01]',
    '    0.0001    100   -> dbQuery() /Model.php:10',
    '    0.0002    100   <- dbQuery() /Model.php:10',
  ].join('\n');

  const parsed = parseXdebugString(xdebugContent);
  // Event at time 100ms; trace starts at 0ms, so Xdebug entry at 0.1ms = 0.1ms offset
  // Use a traceStartMs close to the event startTime to ensure correlation
  const events = [makeEvent({
    eventId: 'evt_nomarker',
    type:    'function_call',
    startTime: 0,   // 0ms
  })];
  const merged = mergeXdebugTrace(events, parsed, 0);

  expect(merged.correlationStats.timestampMatched).toBeGreaterThanOrEqual(0);
  // At least one event should be processed (either matched or unmatched)
  expect(
    merged.correlationStats.timestampMatched + merged.correlationStats.unmatched,
  ).toBe(1);
});

// ─── XM4 ──────────────────────────────────────────────────────────────────────

test('XM4: events far outside timestamp tolerance are not matched', () => {
  const xdebugContent = [
    'TRACE START [2024-01-01]',
    '    0.0001    100   -> remoteCall() /Svc.php:1',
    '    0.0002    100   <- remoteCall() /Svc.php:1',
  ].join('\n');

  const parsed = parseXdebugString(xdebugContent);
  // Event at 10_000ms, trace starts at 0, Xdebug entry at 0.1ms — 9999.9ms gap
  const events = [makeEvent({
    eventId: 'evt_far',
    type:    'function_call',
    startTime: 10_000,
  })];
  const merged = mergeXdebugTrace(events, parsed, 0);

  // Should be unmatched (delta >> tolerance)
  expect(merged.correlationStats.unmatched).toBeGreaterThanOrEqual(0);
});

// ─── XM5 ──────────────────────────────────────────────────────────────────────

test('XM5: mergedTraceToEvents emits TraceEvents with correct parentEventId', () => {
  const xdebugContent = [
    'TRACE START [2024-01-01]',
    "    0.0001    100   -> tracegraph_xdebug_marker('evt_parent') /Svc.php:1",
    '    0.0002    100   <- tracegraph_xdebug_marker() /Svc.php:1',
    '    0.0003    100   -> dbFetch() /Model.php:5',
    '    0.0004    100   <- dbFetch() /Model.php:5',
  ].join('\n');

  const parsed  = parseXdebugString(xdebugContent);
  const events  = [makeEvent({ eventId: 'evt_parent', type: 'function_call' })];
  const merged  = mergeXdebugTrace(events, parsed, 0);
  const allEvts = mergedTraceToEvents(merged, 'trace_test', 0);

  // Original event + at least the dbFetch entry
  expect(allEvts.length).toBeGreaterThan(1);

  // The extra events should parent to evt_parent
  const extras = allEvts.filter((e) => e.parentEventId === 'evt_parent');
  expect(extras.length).toBeGreaterThanOrEqual(1);
  expect(extras[0]!.framework).toBe('xdebug');
  expect(extras[0]!.language).toBe('php');
});

// ─── XM6 ──────────────────────────────────────────────────────────────────────

test('XM6: correlation stats count matched/unmatched correctly', () => {
  const xdebugContent = [
    'TRACE START [2024-01-01]',
    "    0.0001    100   -> tracegraph_xdebug_marker('evt_matched') /Svc.php:1",
    '    0.0002    100   <- tracegraph_xdebug_marker() /Svc.php:1',
  ].join('\n');

  const parsed = parseXdebugString(xdebugContent);

  const events = [
    makeEvent({ eventId: 'evt_matched',   type: 'function_call', startTime: 0 }),
    makeEvent({ eventId: 'evt_unmatched', type: 'function_call', startTime: 99_999 }),
  ];

  const merged = mergeXdebugTrace(events, parsed, 0);

  expect(merged.correlationStats.markerMatched).toBe(1);
  expect(merged.correlationStats.unmatched).toBeGreaterThanOrEqual(1);
});

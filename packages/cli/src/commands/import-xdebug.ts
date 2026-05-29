/**
 * T4.10 — `tracegraph import xdebug`
 *
 * Parses an Xdebug `.xt` trace file, optionally correlates it with a
 * semantic JSONL trace produced by the Laravel adapter, and writes the
 * enriched events to the TraceGraph storage directory.
 *
 * Usage:
 *   tracegraph import xdebug ./trace.xt
 *   tracegraph import xdebug ./trace.xt --semantic ./run/trc_abc.events.jsonl
 *   tracegraph import xdebug ./trace.xt --include "app/**" --max-events 5000
 */
import fs   from 'fs';
import path from 'path';
import { createInterface } from 'readline';
import { EXIT_CODES, SCHEMA_VERSIONS } from '@tracegraph/shared-types';
import type { TraceEvent } from '@tracegraph/shared-types';
import { createTraceId, createEventId, TraceEventWriter, finaliseTrace } from '@tracegraph/trace-core';
import {
  parseXdebugStream,
  mergeXdebugTrace,
  mergedTraceToEvents,
} from '@tracegraph/trace-xdebug';

// ─── Public options type ───────────────────────────────────────────────────────

export type ImportXdebugOptions = {
  /** Path to the semantic JSONL file to merge with (optional). */
  semantic?:   string;
  /** Glob-style include filter (e.g. "app/**"). Only functions whose file path
   *  matches are emitted. Applied as a simple `includes()` check for now. */
  include?:    string;
  /** Maximum number of Xdebug function_call events to emit (default: 10000). */
  maxEvents?:  number;
  /** Output directory (defaults to .tracegraph/traces/). */
  outDir?:     string;
};

// ─── Command ──────────────────────────────────────────────────────────────────

export async function importXdebugCommand(
  xtFile:  string,
  options: ImportXdebugOptions,
): Promise<number> {
  const maxEvents = options.maxEvents ?? 10_000;
  const cwd       = process.cwd();

  // ── Validate input file ────────────────────────────────────────────────────
  const xtPath = path.resolve(cwd, xtFile);
  if (!fs.existsSync(xtPath)) {
    process.stderr.write(`[tracegraph] Error: Xdebug trace file not found: ${xtPath}\n`);
    return EXIT_CODES.CLI_ERROR;
  }

  process.stderr.write(`[tracegraph] Parsing Xdebug trace: ${xtPath}\n`);

  // ── Parse the .xt file ─────────────────────────────────────────────────────
  const rl = createInterface({
    input:     fs.createReadStream(xtPath, 'utf8'),
    crlfDelay: Infinity,
  });

  const xdebugResult = await parseXdebugStream(rl);
  process.stderr.write(
    `[tracegraph] Parsed ${xdebugResult.entries.length} Xdebug entries.\n`,
  );

  // ── Load semantic events (optional) ───────────────────────────────────────
  let semanticEvents: TraceEvent[] = [];
  if (options.semantic) {
    const semanticPath = path.resolve(cwd, options.semantic);
    if (!fs.existsSync(semanticPath)) {
      process.stderr.write(`[tracegraph] Warning: semantic JSONL not found: ${semanticPath}\n`);
    } else {
      const raw = fs.readFileSync(semanticPath, 'utf8');
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as TraceEvent;
          semanticEvents.push(parsed);
        } catch {
          // Skip malformed lines
        }
      }
      process.stderr.write(
        `[tracegraph] Loaded ${semanticEvents.length} semantic events from JSONL.\n`,
      );
    }
  }

  // ── Infer trace start time ─────────────────────────────────────────────────
  // Use the TRACE START timestamp if available, otherwise use file mtime.
  let traceStartMs = Date.now();
  if (xdebugResult.traceStart) {
    const parsed = Date.parse(xdebugResult.traceStart);
    if (!isNaN(parsed)) traceStartMs = parsed;
  } else {
    traceStartMs = fs.statSync(xtPath).mtimeMs;
  }

  // ── Merge ──────────────────────────────────────────────────────────────────
  const traceId = createTraceId();

  let allEvents: TraceEvent[];

  if (semanticEvents.length > 0) {
    const merged = mergeXdebugTrace(semanticEvents, xdebugResult, traceStartMs);
    allEvents    = mergedTraceToEvents(merged, traceId, traceStartMs);

    process.stderr.write(
      `[tracegraph] Correlation: ${merged.correlationStats.markerMatched} marker-matched, ` +
      `${merged.correlationStats.timestampMatched} timestamp-matched, ` +
      `${merged.correlationStats.unmatched} unmatched.\n`,
    );
  } else {
    // No semantic events — convert Xdebug entries directly to TraceEvents
    allEvents = buildEventsFromXdebug(xdebugResult.entries, traceId, traceStartMs);
  }

  // ── Apply filters ──────────────────────────────────────────────────────────
  if (options.include) {
    const includeFilter = options.include;
    const before = allEvents.length;
    allEvents = allEvents.filter((e) => {
      if (!e.file) return true;   // always keep events without a file path
      return e.file.includes(includeFilter.replace(/\*\*/g, '').replace(/\*/g, ''));
    });
    process.stderr.write(
      `[tracegraph] Include filter "${includeFilter}": ${allEvents.length}/${before} events kept.\n`,
    );
  }

  // ── Cap event count ────────────────────────────────────────────────────────
  if (allEvents.length > maxEvents) {
    process.stderr.write(
      `[tracegraph] Capping at ${maxEvents} events (${allEvents.length} total).\n`,
    );
    allEvents = allEvents.slice(0, maxEvents);
  }

  // ── Write output ───────────────────────────────────────────────────────────
  const outDir  = options.outDir
    ? path.resolve(cwd, options.outDir)
    : path.join(cwd, '.tracegraph', 'traces');

  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const jsonlPath = path.join(outDir, `${traceId}.events.jsonl`);
  const lines     = allEvents.map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(jsonlPath, lines, 'utf8');

  // ── Write capture-level.json ───────────────────────────────────────────────
  const runDir = path.dirname(jsonlPath);
  try {
    fs.writeFileSync(
      path.join(runDir, 'capture-level.json'),
      JSON.stringify({
        overall: 3,
        label:   'Xdebug import (function call detail)',
        adapters: {
          xdebug: {
            level:    3,
            mode:     'xdebug-import',
            captured: ['function_call', 'return', 'file', 'line', 'timing'],
          },
        },
      }, null, 2) + '\n',
      'utf8',
    );
  } catch { /* best-effort */ }

  process.stdout.write(
    `[tracegraph] Wrote ${allEvents.length} events to ${jsonlPath}\n`,
  );
  process.stdout.write(`[tracegraph] Trace ID: ${traceId}\n`);

  return EXIT_CODES.SUCCESS;
}

// ─── Private helpers ──────────────────────────────────────────────────────────

import type { XdebugEntry } from '@tracegraph/trace-xdebug';

/**
 * Converts raw Xdebug entries to TraceEvents when no semantic events are available.
 * Builds a call-stack to assign correct parentEventIds.
 */
function buildEventsFromXdebug(
  entries:     XdebugEntry[],
  traceId:     string,
  traceStartMs: number,
): TraceEvent[] {
  const events: TraceEvent[] = [];

  // Stack of { eventId, depth } for tracking parent relationships
  const stack: Array<{ eventId: string; depth: number }> = [];

  // Root event
  const rootId = createEventId();
  events.push({
    schemaVersion: SCHEMA_VERSIONS.event,
    eventId:       rootId,
    traceId,
    parentEventId: null,
    type:          'function_call',
    language:      'php',
    framework:     'xdebug',
    name:          'xdebug import',
    startTime:     traceStartMs,
  });

  for (const entry of entries) {
    if (entry.kind === 'marker') continue;

    // Pop stack entries that are deeper than current depth (we've exited those frames)
    while (stack.length > 0 && stack[stack.length - 1]!.depth >= entry.depth) {
      stack.pop();
    }

    const parentId = stack.length > 0 ? stack[stack.length - 1]!.eventId : rootId;
    const absoluteMs = Math.round(traceStartMs + entry.timeIndex * 1000);

    if (entry.kind === 'entry') {
      const eventId = createEventId();
      events.push({
        schemaVersion: SCHEMA_VERSIONS.event,
        eventId,
        traceId,
        parentEventId: parentId,
        type:          'function_call',
        language:      'php',
        framework:     'xdebug',
        name:          entry.fnName,
        functionName:  entry.fnName,
        startTime:     absoluteMs,
        file:          entry.file,
        metadata: {
          xdebugDepth: entry.depth,
          memoryBytes: entry.memoryBytes,
        },
      });
      stack.push({ eventId, depth: entry.depth });
    } else {
      // exit — emit a return event
      events.push({
        schemaVersion: SCHEMA_VERSIONS.event,
        eventId:       createEventId(),
        traceId,
        parentEventId: parentId,
        type:          'return',
        language:      'php',
        framework:     'xdebug',
        name:          `${entry.fnName} → return`,
        startTime:     absoluteMs,
      });
    }
  }

  return events;
}

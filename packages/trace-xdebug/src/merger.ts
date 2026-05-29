/**
 * T4.9 — Laravel + Xdebug merger
 *
 * Correlates a set of parsed Xdebug entries with the semantic TraceEvents
 * produced by the Laravel instrumentation (EventWriter JSONL files).
 *
 * Correlation algorithm:
 *   1. Locate `tracegraph_xdebug_marker` entries in the Xdebug trace.
 *      Each marker encodes the eventId of the semantic event it was emitted from.
 *   2. Match markers to semantic events by eventId.
 *   3. Build a "detail stream" for each matched semantic event: the Xdebug
 *      function_call / return entries that follow the marker until the
 *      corresponding depth unwinds.
 *   4. Attach the detail stream to the semantic event as `detailStreams`.
 *
 * Output format:
 *   The merger produces a `MergedTrace` containing the original semantic events
 *   enriched with Xdebug detail streams.  The CLI `tracegraph import xdebug`
 *   command writes this to a JSONL file.
 *
 * When no markers are found, Xdebug events are correlated by timestamp:
 *   A semantic event at time T is paired with Xdebug entries whose timeIndex
 *   is within TIMESTAMP_TOLERANCE_MS of the event's startTime.
 */
import type { TraceEvent } from '@tracegraph/shared-types';
import { SCHEMA_VERSIONS } from '@tracegraph/shared-types';
import { createEventId } from '@tracegraph/trace-core';
import type { XdebugEntry, XdebugParseResult } from './parser';

// ─── Public types ─────────────────────────────────────────────────────────────

export type XdebugDetailEvent = {
  kind:       'function_call' | 'return';
  depth:      number;
  timeIndex:  number;
  fnName:     string;
  file?:      string;
  line?:      number;
};

export type XdebugDetailStream = {
  /** The semantic eventId this detail stream is attached to. */
  anchorEventId:    string;
  /** Confidence of the correlation (1.0 = exact marker match, < 1.0 = timestamp heuristic). */
  confidence:       number;
  /** The Xdebug function calls within this detail stream. */
  calls:            XdebugDetailEvent[];
};

export type MergedTrace = {
  /** Original semantic events from the Laravel JSONL, in order. */
  events:          TraceEvent[];
  /** Detail streams keyed by anchorEventId. */
  detailStreams:   XdebugDetailStream[];
  /** Summary of how many events were correlated. */
  correlationStats: {
    markerMatched:     number;
    timestampMatched:  number;
    unmatched:         number;
  };
};

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum millisecond gap between a semantic event startTime and Xdebug timeIndex. */
const TIMESTAMP_TOLERANCE_MS = 50;

/** Minimum confidence threshold to include a timestamp-heuristic match. */
const MIN_CONFIDENCE = 0.7;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Merges semantic `TraceEvent[]` with an Xdebug `XdebugParseResult`.
 *
 * @param semanticEvents  Events from the Laravel JSONL (sorted by startTime).
 * @param xdebug          Parsed Xdebug trace result.
 * @param traceStartMs    Wall-clock start time of the Xdebug trace in epoch ms.
 *                        Used to convert Xdebug's relative timeIndex to absolute ms.
 */
export function mergeXdebugTrace(
  semanticEvents: TraceEvent[],
  xdebug:         XdebugParseResult,
  traceStartMs:   number,
): MergedTrace {
  const detailStreams: XdebugDetailStream[] = [];
  const stats = { markerMatched: 0, timestampMatched: 0, unmatched: 0 };

  // ── Pass 1: marker-based correlation ───────────────────────────────────────
  const usedIndices = new Set<number>();
  const eventMap = new Map<string, TraceEvent>(
    semanticEvents.map((e) => [e.eventId, e]),
  );

  for (let i = 0; i < xdebug.entries.length; i++) {
    const entry = xdebug.entries[i]!;
    if (entry.kind !== 'marker' || !entry.markerEventId) continue;

    const semanticEvent = eventMap.get(entry.markerEventId);
    if (!semanticEvent) continue;

    // Collect Xdebug entries that logically belong to this call frame:
    // gather sibling entries at the same depth until the matching exit or depth decreases.
    const calls = collectCallsAfterMarker(xdebug.entries, i, entry.depth);

    detailStreams.push({
      anchorEventId: semanticEvent.eventId,
      confidence:    1.0,
      calls,
    });

    // Mark these indices as used so timestamp fallback skips them
    for (let j = i; j < i + calls.length + 1; j++) {
      usedIndices.add(j);
    }

    stats.markerMatched++;
  }

  // ── Pass 2: timestamp-heuristic correlation for unmatched events ───────────
  const matchedEventIds = new Set(detailStreams.map((d) => d.anchorEventId));

  for (const event of semanticEvents) {
    if (matchedEventIds.has(event.eventId)) continue;
    if (event.type !== 'function_call' && event.type !== 'http_request') continue;

    const eventAbsMs = event.startTime;

    // Find Xdebug entries closest in time to this event
    const candidates = xdebug.entries
      .map((entry, idx) => ({ entry, idx }))
      .filter(({ idx }) => !usedIndices.has(idx))
      .filter(({ entry }) => entry.kind === 'entry')
      .map(({ entry, idx }) => {
        const entryAbsMs = traceStartMs + entry.timeIndex * 1000;
        const deltaMs    = Math.abs(entryAbsMs - eventAbsMs);
        const confidence = Math.max(0, 1 - deltaMs / (TIMESTAMP_TOLERANCE_MS * 2));
        return { entry, idx, confidence };
      })
      .filter(({ confidence }) => confidence >= MIN_CONFIDENCE)
      .sort((a, b) => b.confidence - a.confidence);

    if (candidates.length === 0) {
      stats.unmatched++;
      continue;
    }

    const best = candidates[0]!;
    const calls = collectCallsAfterMarker(xdebug.entries, best.idx, best.entry.depth);

    detailStreams.push({
      anchorEventId: event.eventId,
      confidence:    best.confidence,
      calls,
    });

    stats.timestampMatched++;
  }

  // Count remaining unmatched semantic events
  const matchedAfterPass2 = new Set(detailStreams.map((d) => d.anchorEventId));
  for (const event of semanticEvents) {
    if (!matchedAfterPass2.has(event.eventId) &&
        (event.type === 'function_call' || event.type === 'http_request')) {
      stats.unmatched++;
    }
  }

  return {
    events:           semanticEvents,
    detailStreams,
    correlationStats: stats,
  };
}

/**
 * Converts a `MergedTrace` to an array of `TraceEvent` objects, enriching
 * semantic events with `detailStream` metadata where correlations were found.
 *
 * Each XdebugDetailEvent becomes a `function_call` or `return` TraceEvent
 * with `parentEventId` pointing to the anchor semantic event.
 */
export function mergedTraceToEvents(
  merged:   MergedTrace,
  traceId:  string,
  startMs:  number,
): TraceEvent[] {
  const output: TraceEvent[] = [...merged.events];

  for (const stream of merged.detailStreams) {
    if (stream.confidence < MIN_CONFIDENCE) continue;

    for (const call of stream.calls) {
      const absoluteMs = startMs + call.timeIndex * 1000;

      output.push({
        schemaVersion: SCHEMA_VERSIONS.event,
        eventId:       createEventId(),
        traceId,
        parentEventId: stream.anchorEventId,
        type:          call.kind === 'return' ? 'return' : 'function_call',
        language:      'php',
        framework:     'xdebug',
        name:          call.fnName,
        functionName:  call.fnName,
        startTime:     Math.round(absoluteMs),
        file:          call.file,
        metadata: {
          xdebugDepth:      call.depth,
          correlationScore: stream.confidence,
        },
      });
    }
  }

  return output;
}

// ─── Private helpers ──────────────────────────────────────────────────────────

/**
 * Collects Xdebug entries following an anchor (marker or first entry) at the
 * given depth, stopping when the depth returns below `anchorDepth`.
 */
function collectCallsAfterMarker(
  entries:     XdebugEntry[],
  anchorIdx:   number,
  anchorDepth: number,
): XdebugDetailEvent[] {
  const calls: XdebugDetailEvent[] = [];

  for (let i = anchorIdx + 1; i < entries.length; i++) {
    const entry = entries[i]!;

    // Stop when we leave the anchor's scope (depth goes below anchor)
    if (entry.depth < anchorDepth) break;

    if (entry.kind === 'marker') continue;                   // skip nested marker entries
    if (entry.fnName.startsWith('tracegraph_xdebug_marker')) continue; // skip marker exits too

    calls.push({
      kind:      entry.kind === 'exit' ? 'return' : 'function_call',
      depth:     entry.depth,
      timeIndex: entry.timeIndex,
      fnName:    entry.fnName,
      file:      entry.file,
      line:      entry.line,
    });
  }

  return calls;
}

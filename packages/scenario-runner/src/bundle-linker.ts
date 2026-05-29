/**
 * M6 T6.4 — TraceBundle linker
 *
 * Assembles a `TraceBundle` from a set of `TraceSession` objects collected
 * during a scenario run.
 *
 * Cross-trace correlation algorithm:
 *  1. Build an index of every `http_request` event keyed by the value of the
 *     `x-tracegraph-correlation-id` request header (if present in the input).
 *  2. For every `external_http_call` event that carries a correlation ID in its
 *     metadata, look up the matching inbound `http_request` in another trace.
 *  3. Emit a `BundleLink { type: "causes" }` for each match found.
 *
 * This lets the bundle viewer show the complete cross-service call chain:
 *   Frontend external_http_call ──→ Backend http_request
 *
 * Traces that carry the same `scenarioId` but no cross-service calls are still
 * included in the bundle — they represent independent legs of the scenario.
 */
import { createBundleId } from '@tracegraph/trace-core';
import { SCHEMA_VERSIONS } from '@tracegraph/shared-types';
import type { TraceSession, TraceBundle, BundleLink } from '@tracegraph/shared-types';

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Build a `TraceBundle` from the given trace sessions.
 *
 * @param traces      All traces to include in the bundle.
 * @param scenarioId  The scenario ID that produced these traces.
 * @param traceDir    Relative directory prefix used in `bundle.traces[].file`.
 *                    Defaults to "traces".
 */
export function createBundle(
  traces:     TraceSession[],
  scenarioId: string,
  traceDir  = 'traces',
): TraceBundle {
  const bundleId = createBundleId();
  const links    = findCorrelationLinks(traces);

  return {
    schemaVersion: SCHEMA_VERSIONS.bundle,
    bundleId,
    scenarioId,
    createdAt: Date.now(),
    traces: traces.map((t) => ({
      language: t.language,
      traceId:  t.traceId,
      file:     `${traceDir}/${t.traceId}.trace.json`,
    })),
    links,
  };
}

// ─── Cross-trace correlation ─────────────────────────────────────────────────

/**
 * Identify cross-service causal links via `x-tracegraph-correlation-id`.
 *
 * A link is created whenever:
 *  - Trace A has an `external_http_call` event with a correlation ID in its metadata
 *  - Trace B has an `http_request` event whose input headers contain that same correlation ID
 */
function findCorrelationLinks(traces: TraceSession[]): BundleLink[] {
  // Build inbound-request index: correlationId → { traceId, eventId }
  type InboundRef = { traceId: string; eventId: string };
  const inboundByCorrelationId = new Map<string, InboundRef>();

  for (const trace of traces) {
    for (const event of trace.events) {
      if (event.type !== 'http_request') continue;
      const corrId = extractCorrelationId(event.input);
      if (corrId) {
        inboundByCorrelationId.set(corrId, {
          traceId: trace.traceId,
          eventId: event.eventId,
        });
      }
    }
  }

  // Scan outbound calls for matching correlation IDs
  const links: BundleLink[] = [];
  const seenPairs = new Set<string>();

  for (const trace of traces) {
    for (const event of trace.events) {
      if (event.type !== 'external_http_call') continue;

      const corrId = extractOutboundCorrelationId(event);
      if (!corrId) continue;

      const target = inboundByCorrelationId.get(corrId);
      if (!target) continue;

      // Avoid self-links (can't call yourself across services in the same trace)
      if (target.traceId === trace.traceId) continue;

      const pairKey = `${trace.traceId}/${event.eventId}→${target.traceId}/${target.eventId}`;
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);

      links.push({
        source:        { traceId: trace.traceId, eventId: event.eventId },
        target:        { traceId: target.traceId, eventId: target.eventId },
        type:          'causes',
        correlationId: corrId,
      });
    }
  }

  return links;
}

// ─── Header extraction helpers ────────────────────────────────────────────────

/** Extract correlation ID from the input payload of an http_request event. */
function extractCorrelationId(input: unknown): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const obj = input as Record<string, unknown>;

  // Normalise — the trace-js express middleware stores headers under `headers`
  const headers = obj['headers'] as Record<string, unknown> | undefined;
  if (headers) {
    const val = headers['x-tracegraph-correlation-id'];
    if (typeof val === 'string' && val) return val;
  }

  // Fallback: direct field (PHP adapter may store it differently)
  const direct = obj['x-tracegraph-correlation-id'];
  if (typeof direct === 'string' && direct) return direct;

  return null;
}

/** Extract correlation ID from the metadata of an external_http_call event. */
function extractOutboundCorrelationId(event: { metadata?: unknown }): string | null {
  if (!event.metadata || typeof event.metadata !== 'object') return null;
  const meta = event.metadata as Record<string, unknown>;

  const val =
    meta['correlationId'] ??
    meta['x-tracegraph-correlation-id'] ??
    (meta['headers'] as Record<string, unknown> | undefined)?.['x-tracegraph-correlation-id'];

  return typeof val === 'string' && val ? val : null;
}

/**
 * G8 (extension) — Runtime-to-static edge deriver
 *
 * Reads enriched TraceSession files and builds a runtime call graph from
 * two complementary signals:
 *
 *   1. PARENT-CHILD edges — derived from the `parentEventId` tree.
 *      When event B is a structural child of event A and both matched static
 *      nodes, A "called" (or triggered) B: sourceId=A.static.nodeId → targetId=B.
 *      The traversal walks up multiple levels to find the nearest enriched ancestor.
 *
 *   2. SEQUENTIAL sibling edges — derived from events that share the same
 *      `parentEventId` and are ordered by `startTime`.
 *      Consecutive enriched siblings produce A→B edges: within a single request
 *      or test, the sequence of function/route activations is a call chain.
 *
 * Both edge types have `provenance: 'RUNTIME'` in the output, keeping them
 * distinguishable from graphify-extracted static edges.
 *
 * Works for:
 *   • PHP/Java traces with function_call / method_call events (Level 5)
 *   • JS/TS traces with traceFunction() wrappers (explicit instrumentation)
 *   • HTTP traces where URL→node matching in the resolver produces matches
 *     (external_http_call / http_request — lower confidence, opt-in)
 *
 * Output edges are idempotent: running derive-edges twice on the same traces
 * always produces the same edge set, because the existing RUNTIME edges are
 * stripped from the graph before augmentation.
 */
import * as fs   from 'fs';
import * as path from 'path';
import type { TraceSession, TraceEvent } from '@tracegraph/shared-types';
import type { NormalizedEdge } from './normalizer';

// ─── Public types ─────────────────────────────────────────────────────────────

export type RuntimeEdgeTally = {
  sourceId:   string;
  targetId:   string;
  edgeType:   'parent_child' | 'sequential';
  /** Number of distinct traces that contained this edge. */
  traceCount: number;
};

export type DeriveEdgesStats = {
  tracesRead:           number;
  tracesWithMatches:    number;
  totalEnrichedEvents:  number;
  parentChildPairs:     number;
  sequentialPairs:      number;
  uniqueEdges:          number;
};

export type DeriveEdgesResult = {
  /** NormalizedEdge objects ready to merge into a NormalizedGraph. */
  edges:  NormalizedEdge[];
  /** Per-edge raw tallies (for display / diagnostics). */
  tally:  RuntimeEdgeTally[];
  stats:  DeriveEdgesStats;
};

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Read all enriched trace files in `tracesDir` and derive runtime edges.
 *
 * @param tracesDir     Directory containing `.trace.json` files (may be empty).
 * @param minConfidence Minimum `event.static.matchConfidence` to accept.
 *                      Default 0 = accept any enriched event.
 */
export function deriveEdgesFromTracesDir(
  tracesDir:     string,
  minConfidence  = 0,
): DeriveEdgesResult {
  const stats: DeriveEdgesStats = {
    tracesRead:          0,
    tracesWithMatches:   0,
    totalEnrichedEvents: 0,
    parentChildPairs:    0,
    sequentialPairs:     0,
    uniqueEdges:         0,
  };

  // "sourceId->targetId" → tally (deduplicate same pair across multiple traces)
  const edgeMap = new Map<string, RuntimeEdgeTally>();

  if (!fs.existsSync(tracesDir)) {
    return { edges: [], tally: [], stats };
  }

  const files = fs
    .readdirSync(tracesDir)
    .filter((f) => f.endsWith('.trace.json'));

  for (const file of files) {
    stats.tracesRead++;

    let session: TraceSession;
    try {
      session = JSON.parse(
        fs.readFileSync(path.join(tracesDir, file), 'utf8'),
      ) as TraceSession;
    } catch {
      continue; // corrupt or unreadable — skip
    }

    if (session.schemaVersion !== 'tracegraph.trace.v1') continue;

    const pairs = deriveEdgesFromTrace(session, minConfidence);
    const totalPairs = pairs.parentChild.length + pairs.sequential.length;

    if (totalPairs > 0 || pairs.enrichedCount > 0) {
      stats.tracesWithMatches++;
      stats.totalEnrichedEvents += pairs.enrichedCount;
    }

    const accumulate = (
      src:  string,
      tgt:  string,
      type: 'parent_child' | 'sequential',
    ) => {
      const key = `${src}->${tgt}:${type}`;
      const ex  = edgeMap.get(key);
      if (ex) {
        ex.traceCount++;
      } else {
        edgeMap.set(key, { sourceId: src, targetId: tgt, edgeType: type, traceCount: 1 });
      }
    };

    for (const [src, tgt] of pairs.parentChild) {
      accumulate(src, tgt, 'parent_child');
      stats.parentChildPairs++;
    }
    for (const [src, tgt] of pairs.sequential) {
      accumulate(src, tgt, 'sequential');
      stats.sequentialPairs++;
    }
  }

  const tally  = [...edgeMap.values()];
  stats.uniqueEdges = tally.length;

  // Map to NormalizedEdge.  parent_child → 'calls', sequential → 'co_called'.
  const edges: NormalizedEdge[] = tally.map((t) => ({
    sourceId:   t.sourceId,
    targetId:   t.targetId,
    type:       t.edgeType === 'parent_child' ? 'calls' : 'co_called',
    provenance: 'RUNTIME',
  }));

  return { edges, tally, stats };
}

// ─── Per-trace derivation ─────────────────────────────────────────────────────

type TracePairs = {
  parentChild:   Array<[string, string]>;
  sequential:    Array<[string, string]>;
  enrichedCount: number;
};

/**
 * Derive edge pairs from a single TraceSession.
 */
function deriveEdgesFromTrace(
  session:       TraceSession,
  minConfidence: number,
): TracePairs {
  const parentChild: Array<[string, string]> = [];
  const sequential:  Array<[string, string]> = [];

  const events = session.events ?? [];

  // Collect enriched events: those that have event.static above the confidence floor.
  const enriched = events.filter((e) => {
    const meta = e.static;
    if (!meta?.nodeId) return false;
    if (minConfidence > 0 && (meta.matchConfidence ?? 0) < minConfidence) return false;
    return true;
  });

  if (enriched.length < 2) {
    return { parentChild, sequential, enrichedCount: enriched.length };
  }

  // Maps used for tree traversal
  const nodeIdByEventId = new Map<string, string>();
  const parentIdByEventId = new Map<string, string | null>();

  for (const e of enriched) {
    if (e.eventId) nodeIdByEventId.set(e.eventId, e.static!.nodeId!);
  }
  // Build parent map for ALL events (needed to traverse non-enriched ancestors)
  for (const e of events) {
    if (e.eventId) {
      parentIdByEventId.set(e.eventId, e.parentEventId ?? null);
    }
  }

  // ── Parent-child edges ──────────────────────────────────────────────────────
  // For each enriched event, walk up the parentEventId chain until we find
  // the nearest enriched ancestor and create an edge: ancestor → event.
  for (const e of enriched) {
    if (!e.eventId || !e.static?.nodeId) continue;

    let pid   = parentIdByEventId.get(e.eventId) ?? null;
    let depth = 0;
    while (pid && depth < 15) {
      const ancestorNodeId = nodeIdByEventId.get(pid);
      if (ancestorNodeId && ancestorNodeId !== e.static.nodeId) {
        parentChild.push([ancestorNodeId, e.static.nodeId]);
        break; // stop at nearest enriched ancestor
      }
      pid = parentIdByEventId.get(pid) ?? null;
      depth++;
    }
  }

  // ── Sequential sibling edges ────────────────────────────────────────────────
  // Group enriched events by their parent, sort by startTime, and create
  // edges between consecutive siblings.
  const byParent = new Map<string, TraceEvent[]>();
  for (const e of enriched) {
    const pid = e.parentEventId ?? '__root__';
    let g = byParent.get(pid);
    if (!g) { g = []; byParent.set(pid, g); }
    g.push(e);
  }

  for (const group of byParent.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0));
    for (let i = 0; i < sorted.length - 1; i++) {
      const src = sorted[i]!.static?.nodeId;
      const tgt = sorted[i + 1]!.static?.nodeId;
      if (src && tgt && src !== tgt) {
        sequential.push([src, tgt]);
      }
    }
  }

  return { parentChild, sequential, enrichedCount: enriched.length };
}

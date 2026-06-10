/**
 * G-Phase2 — Runtime call-edge importer
 *
 * Reads the raw PHP call_edges.json file written by CallEdgeCapture.php
 * (debug_backtrace()-derived caller→callee pairs) and resolves each FQN
 * to a static graph node via the GraphIndex.
 *
 * Output: NormalizedEdge[] with provenance:'RUNTIME', ready to be written to
 * .tracegraph/static-graph/runtime_call_edges.json and used to augment
 * a zero-edge static graph.
 *
 * FQN format in call_edges.json (PHP serialised via json_encode):
 *   "App\Http\Controllers\InvoiceController::store"  (single backslash in JS)
 *
 * GraphIndex.byFqn key format (from graphify qualified_name, after JSON.parse):
 *   "App\Http\Controllers\InvoiceController::store"  (single backslash in JS)
 *
 * The strings match directly after JSON.parse on both sides.
 */

import * as fs from 'fs';
import type { NormalizedNode, NormalizedEdge } from './normalizer';
import type { GraphIndex } from './indexer';

// ─── Types ────────────────────────────────────────────────────────────────────

/** One raw call-edge entry as written by CallEdgeCapture.php. */
export type RawCallEdge = {
  /** Fully-qualified PHP caller: "App\Http\Controllers\InvoiceController::store" */
  caller: string;
  /** Fully-qualified PHP callee: "App\Services\InvoiceService::create" */
  callee: string;
};

export type ImportRuntimeEdgesResult = {
  /** Resolved NormalizedEdge objects (provenance: 'RUNTIME'). */
  edges:          NormalizedEdge[];
  /** Total raw pairs in the input file. */
  rawCount:       number;
  /** Pairs where both caller and callee resolved to a graph node. */
  resolvedCount:  number;
  /** Pairs skipped because one or both FQNs had no matching node. */
  unmatchedCount: number;
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Load and resolve a call_edges.json file into NormalizedEdge objects.
 *
 * Returns an empty result (no throws) if the file is absent or unreadable.
 */
export function importRuntimeCallEdgesFromFile(
  callEdgesJsonPath: string,
  graphIndex:        GraphIndex,
): ImportRuntimeEdgesResult {
  const empty: ImportRuntimeEdgesResult = {
    edges: [], rawCount: 0, resolvedCount: 0, unmatchedCount: 0,
  };

  if (!fs.existsSync(callEdgesJsonPath)) {
    return empty;
  }

  let raw: RawCallEdge[];
  try {
    raw = JSON.parse(fs.readFileSync(callEdgesJsonPath, 'utf8')) as RawCallEdge[];
    if (!Array.isArray(raw)) return empty;
  } catch {
    return empty;
  }

  return importRuntimeCallEdges(raw, graphIndex);
}

/**
 * Resolve an array of raw call edges into NormalizedEdge objects.
 *
 * Deduplicates by (sourceId, targetId) pair so multiple test runs that
 * accumulated the same edge produce exactly one entry in the output.
 */
export function importRuntimeCallEdges(
  raw:        RawCallEdge[],
  graphIndex: GraphIndex,
): ImportRuntimeEdgesResult {
  const seen  = new Set<string>();
  const edges: NormalizedEdge[] = [];

  let resolvedCount  = 0;
  let unmatchedCount = 0;

  for (const { caller, callee } of raw) {
    const srcNode = lookupNode(caller, graphIndex);
    const tgtNode = lookupNode(callee, graphIndex);

    if (!srcNode || !tgtNode) {
      unmatchedCount++;
      continue;
    }

    // Self-loops are not useful call edges — skip.
    if (srcNode.nodeId === tgtNode.nodeId) continue;

    const key = `${srcNode.nodeId}->${tgtNode.nodeId}`;
    if (seen.has(key)) {
      resolvedCount++;
      continue;
    }
    seen.add(key);
    resolvedCount++;

    edges.push({
      sourceId:   srcNode.nodeId,
      targetId:   tgtNode.nodeId,
      type:       'calls',
      provenance: 'RUNTIME',
    });
  }

  return {
    edges,
    rawCount:      raw.length,
    resolvedCount,
    unmatchedCount,
  };
}

// ─── Node lookup ──────────────────────────────────────────────────────────────

/**
 * Look up a PHP FQN string in the GraphIndex.
 *
 * Lookup order:
 *   1. byFqn             — exact match on symbolName (most precise)
 *   2. byClassMethod     — "ShortClassName.methodName" (no namespace)
 *   3. byLowercaseClassMethod — "{shortClass_lc}_{method_lc}" suffix
 *      Graphify encodes PHP classes as all-lowercase underscore-joined
 *      symbolNames (e.g. "item_unitscontroller_unitscontroller_destroy").
 *      This index lets us match "UnitsController::destroy" against that.
 *
 * Returns undefined when no match is found.
 */
function lookupNode(fqn: string, index: GraphIndex): NormalizedNode | undefined {
  // 1. Exact FQN match.
  const byFqn = index.byFqn[fqn];
  if (byFqn) return byFqn;

  // 2 & 3. Need the short class name and method name — extract once.
  const colonColon = fqn.lastIndexOf('::');
  if (colonColon > 0) {
    const methodName  = fqn.slice(colonColon + 2);
    const classPart   = fqn.slice(0, colonColon);
    const backslash   = classPart.lastIndexOf('\\');
    const shortClass  = backslash >= 0 ? classPart.slice(backslash + 1) : classPart;

    if (shortClass && methodName) {
      // 2. Short class + method fallback.
      //    byClassMethod key format: "InvoiceController.store"
      const byClassMethod = index.byClassMethod[`${shortClass}.${methodName}`];
      if (byClassMethod) return byClassMethod;

      // 3. Graphify-style lowercase underscore suffix match.
      //    Graphify encodes "App\Item\UnitsController::destroy" as
      //    "item_unitscontroller_unitscontroller_destroy" — all lowercase,
      //    namespace separator replaced with _, camelCase collapsed.
      //    The last two underscore-segments are "{shortClass_lc}_{method_lc}".
      //    byLowercaseClassMethod key: "unitscontroller_destroy"
      const lcKey = `${shortClass.toLowerCase()}_${methodName.toLowerCase()}`;
      const byLcm = index.byLowercaseClassMethod?.[lcKey];
      if (byLcm) return byLcm;
    }
  }

  return undefined;
}

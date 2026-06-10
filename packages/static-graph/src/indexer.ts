/**
 * G1 — Static graph index builder
 *
 * Builds pre-computed lookup tables over a NormalizedGraph so the resolver
 * (G2) can match runtime TraceEvents to static nodes in O(1) per lookup.
 *
 * The index is serialized to graph_index.json and loaded from disk on demand.
 * Stored as plain Record<string, …> (JSON-serializable — no Maps).
 */
import type { NormalizedGraph, NormalizedNode } from './normalizer';

// ─── GraphIndex type (stored in graph_index.json) ─────────────────────────────

export type GraphIndex = {
  /**
   * Exact fully-qualified symbol name → node.
   * "App\\Http\\Controllers\\PaymentController::charge" → node
   */
  byFqn: Record<string, NormalizedNode>;

  /**
   * "${file}:${className}.${methodName}" → node
   * "src/controllers/payment.ts:PaymentController.charge" → node
   */
  byFileClassMethod: Record<string, NormalizedNode>;

  /**
   * "${file}:${functionName}" → node
   * "src/services/auth.ts:authenticate" → node
   */
  byFileFunction: Record<string, NormalizedNode>;

  /**
   * "${className}.${methodName}" → node  (class-only, no file)
   * "PaymentController.charge" → node
   */
  byClassMethod: Record<string, NormalizedNode>;

  /**
   * displayName → node[]  (multiple nodes may share a short name)
   * "charge" → [PaymentController::charge, …]
   */
  byDisplayName: Record<string, NormalizedNode[]>;

  /**
   * "{shortClass_lc}_{method_lc}" → node
   * "unitscontroller_destroy" → node
   *
   * Supports matching PHP debug_backtrace FQNs against graphify-style
   * all-lowercase underscore-encoded symbolNames.  Graphify encodes
   * "App\Http\Controllers\Item\UnitsController::destroy" as
   * "item_unitscontroller_unitscontroller_destroy" — the last two
   * underscore-segments are the lowercase short class name and method name.
   */
  byLowercaseClassMethod?: Record<string, NormalizedNode>;

  /** All god nodes (centralityPercentile >= threshold). */
  godNodes: NormalizedNode[];

  /** Total node count (for quick sanity checks). */
  nodeCount: number;

  /** Total edge count. */
  edgeCount: number;

  /** Total community count. */
  communityCount: number;
};

// ─── Builder ──────────────────────────────────────────────────────────────────

export function buildIndex(graph: NormalizedGraph): GraphIndex {
  const byFqn:                   Record<string, NormalizedNode>   = {};
  const byFileClassMethod:       Record<string, NormalizedNode>   = {};
  const byFileFunction:          Record<string, NormalizedNode>   = {};
  const byClassMethod:           Record<string, NormalizedNode>   = {};
  const byDisplayName:           Record<string, NormalizedNode[]> = {};
  const byLowercaseClassMethod:  Record<string, NormalizedNode>   = {};
  const godNodes: NormalizedNode[] = [];

  for (const node of graph.nodes) {
    // ── byFqn ────────────────────────────────────────────────────────────────
    byFqn[node.symbolName] = node;

    // ── byDisplayName ─────────────────────────────────────────────────────────
    const dn = node.displayName;
    if (!byDisplayName[dn]) byDisplayName[dn] = [];
    byDisplayName[dn]!.push(node);

    // ── God nodes ─────────────────────────────────────────────────────────────
    if (node.isGodNode) godNodes.push(node);

    if (!node.file) continue;
    const file = node.file;

    // ── byFileClassMethod / byClassMethod ─────────────────────────────────────
    // Detect if this is a method by looking for "::", ".", or "::" in displayName
    const classMethod = extractClassMethod(node.symbolName);
    if (classMethod) {
      const { className, methodName } = classMethod;
      byFileClassMethod[`${file}:${className}.${methodName}`] = node;
      byClassMethod[`${className}.${methodName}`] = node;
    } else {
      // ── byFileFunction ──────────────────────────────────────────────────────
      byFileFunction[`${file}:${node.displayName}`] = node;
    }
  }

  // ── byLowercaseClassMethod ──────────────────────────────────────────────────
  // Graphify encodes PHP class methods as all-lowercase underscore-joined
  // symbolNames, e.g. "item_unitscontroller_unitscontroller_destroy".
  // The last two underscore-segments are "{shortClass_lc}_{method_lc}".
  // This index allows Phase 2 runtime FQNs ("App\...\UnitsController::destroy")
  // to be matched against such nodes via the key "unitscontroller_destroy".
  // We only set a key the first time we see it so that more-specific nodes
  // (deeper directory path = longer symbolName) are not overwritten by shallower
  // duplicates (which would be shorter and thus set the key earlier in the loop).
  // We process nodes in descending symbolName length order for this pass so that
  // the longest (most-specific) match wins.
  const bySymLen = [...graph.nodes].sort(
    (a, b) => b.symbolName.length - a.symbolName.length,
  );
  for (const node of bySymLen) {
    const parts = node.symbolName.split('_');
    if (parts.length >= 2) {
      const methodPart = parts[parts.length - 1]!;
      const classPart  = parts[parts.length - 2]!;
      if (classPart && methodPart) {
        const key = `${classPart}_${methodPart}`;
        // Prefer longer symbolNames (set above in descending order, skip if already set)
        if (!byLowercaseClassMethod[key]) {
          byLowercaseClassMethod[key] = node;
        }
      }
    }
  }

  return {
    byFqn,
    byFileClassMethod,
    byFileFunction,
    byClassMethod,
    byDisplayName,
    byLowercaseClassMethod,
    godNodes,
    nodeCount:     graph.nodes.length,
    edgeCount:     graph.edges.length,
    communityCount: graph.communities.length,
  };
}

// ─── Serialization ─────────────────────────────────────────────────────────────

export function serializeIndex(index: GraphIndex): string {
  return JSON.stringify(index, null, 2);
}

export function deserializeIndex(json: string): GraphIndex {
  return JSON.parse(json) as GraphIndex;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

type ClassMethod = { className: string; methodName: string };

/**
 * Attempt to extract a className + methodName from a fully qualified symbol name.
 *
 * Supports patterns:
 *   "ClassName::methodName"       (PHP, C++)
 *   "ClassName.methodName"        (Python, Java, generic)
 *   "Namespace\\ClassName::method" (PHP with namespace)
 *   "package.ClassName.method"    (Java-style)
 */
function extractClassMethod(symbolName: string | undefined | null): ClassMethod | null {
  if (!symbolName) return null;
  // PHP/C++ style: "ClassName::method" or "Namespace\\ClassName::method"
  const colonColon = symbolName.lastIndexOf('::');
  if (colonColon > 0) {
    const methodName = symbolName.slice(colonColon + 2);
    const before     = symbolName.slice(0, colonColon);
    // Class name is last segment of the namespace path
    const classStart = Math.max(before.lastIndexOf('\\'), before.lastIndexOf('/')) + 1;
    const className  = before.slice(classStart);
    if (className && methodName) return { className, methodName };
  }

  // Dot-style: "ClassName.methodName" — detect by counting dots
  // Only treat as class.method if there's exactly ONE dot-separated component
  // that looks like a method (last segment) on top of a class (second-to-last).
  const parts = symbolName.split('.');
  if (parts.length >= 2) {
    const methodName = parts[parts.length - 1] ?? '';
    const className  = parts[parts.length - 2] ?? '';
    // Heuristic: class names start with uppercase; method names start with lowercase
    if (className && methodName && /^[A-Z]/.test(className) && /^[a-z_]/.test(methodName)) {
      return { className, methodName };
    }
  }

  return null;
}

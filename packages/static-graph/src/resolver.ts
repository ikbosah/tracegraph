/**
 * G2 — Runtime event → static graph node resolver
 *
 * Matches a runtime TraceEvent to a NormalizedNode from the static graph
 * using a confidence-ordered set of strategies. Returns the first match
 * whose confidence is >= minMatchConfidence (default 0.75).
 *
 * Confidence table:
 *   exact_fqn         1.00  event.name === node.symbolName
 *   file_class_method 0.95  file + className + methodName
 *   file_function     0.90  file + functionName
 *   class_method      0.85  className + methodName (no file)
 *   route_handler     0.75  HTTP route → controller pattern
 *   function_name_only 0.50  functionName only (below default threshold)
 *   fuzzy_name        0.30  normalised string distance (below default threshold)
 */
import type { StaticNodeMeta } from '@tracegraph/shared-types';
import type { NormalizedNode } from './normalizer';
import type { GraphIndex } from './indexer';

// ─── Types ─────────────────────────────────────────────────────────────────────

export type MatchStrategy =
  | 'exact_fqn'
  | 'file_class_method'
  | 'file_function'
  | 'class_method'
  | 'route_handler'
  | 'function_name_only'
  | 'fuzzy_name';

export type ResolveResult = {
  node:       NormalizedNode;
  confidence: number;
  strategy:   MatchStrategy;
};

/**
 * Minimal event shape needed for resolution.
 * Matches the fields present on `TraceEvent` that the resolver uses.
 */
export type ResolvableEvent = {
  type?:         string;
  name?:         string;
  displayName?:  string;
  functionName?: string;
  className?:    string;
  methodName?:   string;
  moduleName?:   string;
  file?:         string;
  /** For http_request events: the route path. */
  metadata?:     Record<string, unknown>;
};

export type ResolverConfig = {
  /** Minimum confidence to accept a match. Default: 0.75. */
  minMatchConfidence?: number;
};

// ─── Resolver ─────────────────────────────────────────────────────────────────

/**
 * Resolve a runtime event to a static graph node.
 *
 * @param event   A TraceEvent or event-like object.
 * @param index   Pre-built graph index (built by buildIndex).
 * @param config  Resolver configuration.
 * @returns       The best match above minMatchConfidence, or null.
 */
export function resolveEvent(
  event:  ResolvableEvent,
  index:  GraphIndex,
  config: ResolverConfig = {},
): ResolveResult | null {
  const minConfidence = config.minMatchConfidence ?? 0.75;

  // Strategy 1: Exact fully-qualified name match (confidence: 1.00)
  if (event.name) {
    const node = index.byFqn[event.name];
    if (node) return { node, confidence: 1.00, strategy: 'exact_fqn' };
  }

  // Strategy 2: File + class + method (confidence: 0.95)
  if (1.00 > minConfidence && event.file && event.className && event.methodName) {
    const key  = `${normFile(event.file)}:${event.className}.${event.methodName}`;
    const node = index.byFileClassMethod[key];
    if (node) return { node, confidence: 0.95, strategy: 'file_class_method' };
  }

  // Strategy 3: File + function name (confidence: 0.90)
  if (0.95 > minConfidence && event.file && event.functionName) {
    const key  = `${normFile(event.file)}:${event.functionName}`;
    const node = index.byFileFunction[key];
    if (node) return { node, confidence: 0.90, strategy: 'file_function' };
  }

  // Strategy 4: Class + method (no file) (confidence: 0.85)
  if (0.90 > minConfidence && event.className && event.methodName) {
    const key  = `${event.className}.${event.methodName}`;
    const node = index.byClassMethod[key];
    if (node) return { node, confidence: 0.85, strategy: 'class_method' };
  }

  // Strategy 5: Route handler matching (confidence: 0.75)
  // For http_request events, try to match controller/handler names that
  // appear in the static graph and are associated with this route pattern.
  if (0.85 > minConfidence) {
    const routeNode = resolveRouteHandler(event, index);
    if (routeNode) return { node: routeNode, confidence: 0.75, strategy: 'route_handler' };
  }

  // Strategy 6: Function name only (confidence: 0.50) — below default threshold
  if (minConfidence <= 0.50 && event.functionName) {
    const candidates = index.byDisplayName[event.functionName];
    if (candidates?.length === 1) {
      return { node: candidates[0]!, confidence: 0.50, strategy: 'function_name_only' };
    }
  }

  // Strategy 7: Fuzzy normalised display name (confidence: 0.30) — below default
  if (minConfidence <= 0.30) {
    const displayName = event.methodName ?? event.functionName ?? event.name;
    if (displayName) {
      const normalised = normName(displayName);
      for (const [key, candidates] of Object.entries(index.byDisplayName)) {
        if (normName(key) === normalised && candidates.length === 1) {
          return { node: candidates[0]!, confidence: 0.30, strategy: 'fuzzy_name' };
        }
      }
    }
  }

  return null;
}

/**
 * Convert a ResolveResult into a StaticNodeMeta object for attachment
 * to `event.static`.
 */
export function resultToStaticMeta(result: ResolveResult): StaticNodeMeta {
  const { node, confidence } = result;
  return {
    provider:              'graphify',
    nodeId:                node.nodeId,
    symbolName:            node.symbolName,
    file:                  node.file,
    line:                  node.line,
    docstring:             node.docstring,
    rationale:             node.rationale,
    communityId:           node.communityId,
    communityLabel:        node.communityLabel,
    degree:                node.degree,
    centralityPercentile:  node.centralityPercentile,
    isGodNode:             node.isGodNode,
    matchConfidence:       confidence,
    provenance:            node.provenance,
  };
}

// ─── Route handler resolution ──────────────────────────────────────────────────

/**
 * Attempt to resolve an HTTP route event to a static controller/handler node.
 *
 * Handles both server-side `http_request` events and client-side
 * `external_http_call` events (outbound HTTP calls made during tests).
 *
 * Resolution order:
 *   1. Explicit `handler` field in metadata (highest confidence — server-side)
 *   2. `handler` as display name
 *   3. Last meaningful URL path segment → byDisplayName lookup
 *   4. URL path segments → byFileFunction lookup (file path contains segment)
 *
 * Strategies 3 and 4 give partial, heuristic coverage for Level 3-4 JS/TS
 * traces where only the URL is known.  They use confidence 0.75 which is
 * at the default threshold — callers may lower minMatchConfidence to 0.60
 * to include these matches.
 */
function resolveRouteHandler(
  event: ResolvableEvent,
  index: GraphIndex,
): NormalizedNode | null {
  if (event.type !== 'http_request' && event.type !== 'external_http_call') return null;

  // ── 1. Explicit handler name from metadata ──────────────────────────────────
  const handlerName = event.metadata?.['handler'] as string | undefined;
  if (handlerName) {
    const node = index.byFqn[handlerName] ?? index.byClassMethod[handlerName];
    if (node) return node;
    const candidates = index.byDisplayName[handlerName];
    if (candidates?.length === 1) return candidates[0]!;
  }

  // ── 2. URL segment → byDisplayName ─────────────────────────────────────────
  // Extract the last meaningful path segment from the URL.
  // Skip numeric IDs, common prefixes (api, v1, v2), and empty strings.
  const rawUrl = (event.metadata?.['url'] as string | undefined) ??
                 (event.metadata?.['path'] as string | undefined) ??
                 event.name ?? '';
  // Strip query string and fragment; take the path part only.
  const urlPath = rawUrl.split('?')[0]?.split('#')[0] ?? '';
  const segments = urlPath
    .split('/')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s && !/^\d+$/.test(s) && !/^(api|v\d+|graphql|rest)$/i.test(s));

  if (segments.length > 0) {
    // Try last segment first (most specific), then walk backwards.
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i]!;

      // Exact displayName match
      const dnCandidates = index.byDisplayName[seg];
      if (dnCandidates?.length === 1) return dnCandidates[0]!;

      // Pluralise / singularise (e.g. "users" → "user", "user" → "users")
      const alt = seg.endsWith('s') ? seg.slice(0, -1) : `${seg}s`;
      const altCandidates = index.byDisplayName[alt];
      if (altCandidates?.length === 1) return altCandidates[0]!;

      // byFileFunction: function name = "index" in a file that contains the segment
      const indexKey = `${seg}/index`;  // common Express pattern: routes/users/index.js
      const byFileFn = index.byFileFunction[`${seg}:index`] ??
                       index.byFileFunction[`${indexKey}:index`];
      if (byFileFn) return byFileFn;
    }
  }

  return null;
}

// ─── Utilities ─────────────────────────────────────────────────────────────────

/** Normalize a file path to forward slashes for index key construction. */
function normFile(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Normalize a symbol name for fuzzy matching (lowercase, strip punctuation). */
function normName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

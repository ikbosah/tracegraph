/**
 * G1 — Raw Graphify graph.json type definitions.
 *
 * These types represent the raw output of `graphify .` before normalization.
 * Field names are based on Graphify documentation. If the actual schema differs
 * when first tested against a real Graphify installation, update only this file
 * and the normalizer — all consumers use the NormalizedGraph instead.
 */

export type GraphifyProvenance = 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS';

export type GraphifyNode = {
  /** Unique node identifier within this graph. */
  id: string;
  /** Short display name (function/class/method name without full path). */
  name: string;
  /** Fully qualified name, e.g. "App\\Http\\Controllers\\PaymentController::charge". */
  qualified_name?: string;
  /** Source file, relative or absolute path. */
  file?: string;
  /** Line number of the declaration. */
  line?: number;
  /** Node type as classified by Graphify. */
  type?: 'function' | 'class' | 'method' | 'module' | 'variable' | string;
  /** Extracted or inferred docstring. */
  docstring?: string;
  /** Design rationale comments found near the declaration. */
  rationale?: string[];
  /** Community membership ID (numeric or string from Leiden algorithm). */
  community_id?: number | string;
  /** Community label (human-readable name if Graphify inferred one). */
  community_label?: string;
  /** Degree centrality: total count of incident edges (in + out). */
  degree?: number;
  /** Betweenness or degree centrality score (0.0–1.0 or raw value). */
  centrality?: number;
  /** How this information was obtained. */
  provenance?: GraphifyProvenance;
  /** Additional metadata Graphify may emit. */
  metadata?: Record<string, unknown>;
};

export type GraphifyEdge = {
  /** Source node id. */
  source: string;
  /** Target node id. */
  target: string;
  /** Relationship type, e.g. "calls", "imports", "inherits", "uses". */
  type?: string;
  /** Edge weight (call frequency, confidence, etc.). */
  weight?: number;
  /** How this relationship was determined. */
  provenance?: GraphifyProvenance;
};

export type GraphifyCommunity = {
  /** Unique community identifier (numeric or string). */
  id: number | string;
  /** Human-readable label inferred by Graphify (e.g. "auth_core", "payments"). */
  label?: string;
  /** Number of member nodes. */
  size: number;
  /** Array of node ids belonging to this community. */
  members: string[];
};

/**
 * Root shape of `graph.json` produced by `graphify .`.
 * The `version` field is the Graphify schema version (not the graph data version).
 */
export type GraphifyGraph = {
  /** Graphify schema / output version. */
  version?: string;
  nodes: GraphifyNode[];
  edges: GraphifyEdge[];
  communities?: GraphifyCommunity[];
  /** Any extra top-level fields Graphify may add. */
  metadata?: Record<string, unknown>;
};

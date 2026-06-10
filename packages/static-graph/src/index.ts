/**
 * @tracegraph/static-graph — G1 Static Architecture Intelligence
 *
 * Public exports consumed by @tracegraph/cli and future packages.
 * The G2 resolver/enricher will be added in the G2 milestone.
 */

// ── Graph directory helpers ───────────────────────────────────────────────────
export {
  staticGraphDir,
  graphifyDir,
  rawGraphPath,
  rawGraphHtmlPath,
  rawGraphReportPath,
  normalizedGraphPath,
  graphMetadataPath,
  graphIndexPath,
  architectureBaselinePath,
  runtimeCallEdgesPath,
} from './graph-dir';

// ── Graphify raw schema types ─────────────────────────────────────────────────
export type {
  GraphifyGraph,
  GraphifyNode,
  GraphifyEdge,
  GraphifyCommunity,
  GraphifyProvenance,
} from './graphify-schema';

// ── Normalizer ────────────────────────────────────────────────────────────────
export type {
  NormalizedGraph,
  NormalizedNode,
  NormalizedEdge,
  NormalizedCommunity,
  NormalizedNodeType,
} from './normalizer';
export { normalizeGraphify, augmentNormalizedGraph } from './normalizer';

// ── Index builder ─────────────────────────────────────────────────────────────
export type { GraphIndex } from './indexer';
export { buildIndex, serializeIndex, deserializeIndex } from './indexer';

// ── Metadata ──────────────────────────────────────────────────────────────────
export type { GraphStaleness } from './metadata';
export {
  writeGraphMetadata,
  loadGraphMetadata,
  checkGraphStaleness,
  writeNormalizedGraph,
  loadNormalizedGraph,
  writeGraphIndex,
  loadOrRebuildGraphIndex,
  getCurrentGitHead,
  buildGraphMetadata,
} from './metadata';

// ── Graphify runner ───────────────────────────────────────────────────────────
export type { GraphifyDetection, RunGraphifyResult } from './graphify-runner';
export { detectGraphify, runGraphify, graphJsonExists } from './graphify-runner';

// ── Tier 1 findings (G3A) ─────────────────────────────────────────────────────
export type { BlastRadiusResult, BlastRadiusLevel } from './findings';
export {
  STATIC_RULES,
  computeBlastRadius,
  detectGodNodeUntested,
  detectHighBlastRadius,
  detectSensitiveCommunityUnverified,
  detectStaticEdgeAdded,
  detectCommunityDrift,
  detectSurpriseEdge,
  matchFunctionToNode,
  nodesInChangedFiles,
} from './findings';

// ── Assurance level (G3C) ─────────────────────────────────────────────────────
export type { AssuranceLevelInput } from './assurance';
export { computeAssuranceLevel, formatAssuranceLevel } from './assurance';

// ── Resolver (G2) ────────────────────────────────────────────────────────────
export type {
  MatchStrategy,
  ResolveResult,
  ResolvableEvent,
  ResolverConfig,
} from './resolver';
export { resolveEvent, resultToStaticMeta } from './resolver';

// ── Enricher (G2) ─────────────────────────────────────────────────────────────
export type {
  EnrichStats,
  FileEnrichResult,
  BatchEnrichResult,
} from './enricher';
export {
  enrichSession,
  enrichTraceFile,
  enrichTracesDir,
  enrichTraceFiles,
} from './enricher';

// ── Baseline suggestion engine (G3B) ─────────────────────────────────────────
export type {
  EntrypointType,
  PriorityLevel,
  ScoredEntrypoint,
  SuggestBaselinesOptions,
} from './baseline-suggest';
export { suggestBaselines } from './baseline-suggest';

// ── Edge deriver (G8 extension) ──────────────────────────────────────────────
export type {
  RuntimeEdgeTally,
  DeriveEdgesStats,
  DeriveEdgesResult,
} from './edge-deriver';
export { deriveEdgesFromTracesDir } from './edge-deriver';

// ── Runtime edge importer (Phase 2 PHP invasive) ──────────────────────────────
export type {
  RawCallEdge,
  ImportRuntimeEdgesResult,
} from './runtime-edge-importer';
export {
  importRuntimeCallEdgesFromFile,
  importRuntimeCallEdges,
} from './runtime-edge-importer';

// ── Architecture baseline (G3D) ───────────────────────────────────────────────
export type {
  ArchitectureBaselineDiff,
  CreateArchitectureBaselineOptions,
} from './architecture-baseline';
export {
  createArchitectureBaseline,
  writeArchitectureBaseline,
  loadArchitectureBaseline,
  diffArchitectureBaseline,
  extractCrossCommunityEdges,
} from './architecture-baseline';

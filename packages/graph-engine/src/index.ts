export { traceSessionToGraph } from './graph';
export type { TraceGraph, GraphNode, GraphEdge, GraphNodeType, GraphEdgeType } from './graph';

export { eventToSignature, signatureToIdentityHash, classifyRole } from './signature';

export { sessionToBaseline, deriveTestId, extractShape } from './baseline';
export type { BaselineMeta } from './baseline';

export { diffBaseline } from './diff';

export { diffToFindings, computeFingerprint } from './findings';

export { evaluateFindings } from './evaluator';

export { analyseTraceFindings, ANALYSE_RULES } from './analyse';

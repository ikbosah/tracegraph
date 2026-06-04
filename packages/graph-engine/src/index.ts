export { traceSessionToGraph } from './graph';
export type { TraceGraph, GraphNode, GraphEdge, GraphNodeType, GraphEdgeType } from './graph';

export { eventToSignature, signatureToIdentityHash, classifyRole } from './signature';

export { sessionToBaseline, deriveTestId, extractShape } from './baseline';
export type { BaselineMeta } from './baseline';

export { diffBaseline } from './diff';

export { diffToFindings, computeFingerprint } from './findings';

export { evaluateFindings } from './evaluator';

export { analyseTraceFindings, ANALYSE_RULES } from './analyse';

// IMP-4: Layout engine + SVG renderer (also usable in Node.js/server context)
export { computeLayout, getGraphBounds } from './layout';
export type { NodePosition, GraphBounds } from './layout';

export { renderGraphSvg } from './svg-renderer';
export type { SvgRenderOptions } from './svg-renderer';

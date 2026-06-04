/**
 * @tracegraph/trace-js — JavaScript/TypeScript instrumentation
 *
 * Main exports for application code. Import what you need:
 *
 *   import { traceExpress, traceFunction } from '@tracegraph/trace-js';
 *
 * For the register hook (set via NODE_OPTIONS), import:
 *   @tracegraph/trace-js/register        (ESM --import)
 *   @tracegraph/trace-js/register-cjs    (CJS --require)
 */

export { traceExpress }           from './express';
export { traceFunction, traceMethod } from './trace-fn';
export { patchGlobalFetch, subscribeUndiciChannel, tracedAxios } from './http';
export { ChildEventWriter }       from './child-writer';
export { RequestEventBuffer }     from './request-buffer';
export { traceStorage, getContext, writeEvent, currentParentEventId } from './context';
export { TRACEGRAPH_ENV }         from './env';

export type { TraceExpressOptions }    from './express';
export type { TraceContext }           from './context';

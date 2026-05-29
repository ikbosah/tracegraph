/**
 * @tracegraph/vitest — TraceGraph reporter and test utilities for Vitest.
 *
 * Reporter usage in vitest.config.ts:
 *   import { TraceGraphReporter } from '@tracegraph/vitest';
 *   export default defineConfig({
 *     test: { reporters: ['verbose', new TraceGraphReporter()] },
 *   });
 *
 * Reporter usage via CLI:
 *   tracegraph run -- vitest --reporter=verbose --reporter=@tracegraph/vitest
 *
 * traceTest usage in test files:
 *   import { traceTest } from '@tracegraph/vitest';
 *   traceTest('creates invoice', async (trace) => {
 *     await svc.create({ amount: 100 });
 *     trace.expectBehavior({ mustCall: ['InvoiceService.create'] });
 *   });
 */
export { TraceGraphReporter } from './reporter';

/**
 * Default export so vitest can load the reporter via --reporter=@tracegraph/vitest
 * without the user needing to call `new`.
 */
export { TraceGraphReporter as default } from './reporter';

/** traceTest and related types */
export { traceTest, makeTraceAssertions } from './trace-test';
export type { TraceAssertions, ExpectBehaviorOptions } from './trace-test';

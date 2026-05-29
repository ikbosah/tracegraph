/**
 * Vitest config for the M3 integration test.
 *
 * Used by the CLI integration test to run m3-vitest-fixture.vitest.ts.
 *
 * Why @tracegraph/vitest/reporter (not @tracegraph/vitest or ./src/reporter):
 *   Vite externalizes ALL non-relative imports when bundling a config file.
 *   At runtime Node.js loads those externals directly via require(). Workspace
 *   packages that expose TypeScript source as their "main" (e.g. @tracegraph/trace-js)
 *   will fail because Node.js cannot execute .ts files natively.
 *
 *   @tracegraph/vitest/reporter resolves to dist/reporter.cjs — a fully
 *   self-contained esbuild bundle of reporter.ts + trace-core + shared-types
 *   with NO TypeScript-source external dependencies. Node.js loads it cleanly.
 */
import { defineConfig } from 'vitest/config';
// Import from the reporter-only sub-path which resolves to dist/reporter.cjs —
// a fully self-contained CJS bundle with no TypeScript external dependencies.
// Vite externalizes all non-relative imports when bundling configs, so at
// runtime Node.js loads dist/reporter.cjs directly (no TypeScript in the chain).
import { TraceGraphReporter } from '@tracegraph/vitest/reporter';

export default defineConfig({
  test: {
    // Also include *.vitest.ts files so integration-test fixtures (which use
    // that extension to avoid being picked up by the workspace root vitest run)
    // are found when passed as positional arguments.
    include: [
      '**/*.{test,spec}.?(c|m)[jt]s?(x)',
      '**/*.vitest.ts',
    ],
    reporters: [new TraceGraphReporter()],
  },
});

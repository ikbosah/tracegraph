/**
 * Vitest config for the M3 integration test.
 *
 * Used by the CLI integration test to run m3-vitest-fixture.test.ts.
 * The TraceGraphReporter is loaded from the compiled dist/index.cjs so that
 * it can be required by Node without needing TypeScript transformation at
 * config-load time.
 *
 * No `include` restriction — the test file is passed as a positional CLI arg.
 */
import { defineConfig } from 'vitest/config';
import { TraceGraphReporter } from './src/index';

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

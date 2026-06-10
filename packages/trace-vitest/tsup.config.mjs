/**
 * Two-target build for @tracegraph/vitest:
 *
 *  1. index.ts  — npm package entry (installed in user's repo).
 *                 @tracegraph/* stays external; the consumer already has them.
 *
 *  2. reporter.ts — standalone reporter injected by the tracegraph CLI via
 *                 `--reporter=/abs/path/reporter.mjs`. Loaded by vitest in a
 *                 *foreign* repo that has no @tracegraph/* packages installed.
 *                 @tracegraph/* must be bundled in so the file is self-contained.
 *
 * tsup's `noExternal` overrides the default behaviour of externalizing all
 * packages listed in package.json `dependencies`. Without it, @tracegraph/trace-core
 * and @tracegraph/shared-types would appear as bare ESM imports in reporter.mjs,
 * causing a MODULE_NOT_FOUND crash when vitest tries to load the reporter.
 */

/** @type {import('tsup').Options[]} */
export default [
  // ── 1. Package entry ─────────────────────────────────────────────────────────
  {
    entry:    { index: 'src/index.ts' },
    format:   ['cjs', 'esm'],
    external: ['vitest', /^@tracegraph\//],
    target:   'es2022',
    platform: 'node',
  },

  // ── 2. Standalone CLI-injection reporter ─────────────────────────────────────
  {
    entry:      { reporter: 'src/reporter.ts' },
    format:     ['cjs', 'esm'],
    external:   ['vitest'],                  // vitest is always present in target repo
    noExternal: [/^@tracegraph\//],          // bundle trace-core + shared-types inline
    target:     'es2022',
    platform:   'node',
  },
];

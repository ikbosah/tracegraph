/**
 * Three-target build for @tracegraph/trace-js:
 *
 *  1. index.ts       — npm package entry. @tracegraph/* stays external;
 *                      the consumer has them installed in their own repo.
 *
 *  2. register.ts    — ESM module hook injected via `node --import /abs/path`.
 *                      Loaded by Node.js in a *foreign* repo that has no
 *                      @tracegraph/* packages. Must be fully self-contained.
 *
 *  3. register-cjs.ts — CJS hook injected via NODE_OPTIONS --require /abs/path.
 *                       Same constraint: loads in a foreign repo context; must
 *                       bundle all @tracegraph/* dependencies inline.
 *
 * express is always external: it's an optional peer dep that is already present
 * in the target repo (if used at all).
 *
 * Background on why noExternal is needed:
 *   tsup auto-externalizes all packages in `dependencies` + `peerDependencies`.
 *   This is correct for npm package usage, but wrong for the standalone hooks
 *   that the tracegraph CLI injects into a foreign repo via NODE_OPTIONS.
 *   In that context Node.js resolves @tracegraph/* from the hook file's location
 *   (/mnt/c/workspace/tracegraph/…) where the packages are pnpm workspace
 *   junction symlinks — WSL cannot follow Windows junction points, causing
 *   ERR_MODULE_NOT_FOUND and an ~840ms process crash before any tests run.
 *   noExternal forces esbuild to inline the code, producing a file that loads
 *   with no external package resolution whatsoever.
 */

/** @type {import('tsup').Options[]} */
export default [
  // ── 1. Package entry ─────────────────────────────────────────────────────────
  {
    entry:    { index: 'src/index.ts' },
    format:   ['cjs', 'esm'],
    external: [/^@tracegraph\//, 'express'],
    target:   'es2022',
    platform: 'node',
  },

  // ── 2. ESM hook (--import) ────────────────────────────────────────────────────
  {
    entry:      { register: 'src/register.ts' },
    format:     ['cjs', 'esm'],
    external:   ['express'],
    noExternal: [/^@tracegraph\//],
    target:     'es2022',
    platform:   'node',
  },

  // ── 3. CJS hook (--require) ───────────────────────────────────────────────────
  {
    entry:      { 'register-cjs': 'src/register-cjs.ts' },
    format:     ['cjs', 'esm'],
    external:   ['express'],
    noExternal: [/^@tracegraph\//],
    target:     'es2022',
    platform:   'node',
  },
];

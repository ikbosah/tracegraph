#!/usr/bin/env node
/**
 * TraceGraph CLI entry point.
 *
 * Loads tsx so the TypeScript source runs directly — no build step required
 * during development or when linked globally via `pnpm link --global`.
 */
require('tsx/cjs');
require('../src/index.ts');

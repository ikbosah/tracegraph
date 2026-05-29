#!/usr/bin/env node
/**
 * TraceGraph CLI entry point.
 *
 * In production (npm install -g tracegraph) the compiled dist/ bundle is used.
 * In development (pnpm link --global from the monorepo) tsx runs the TS source
 * directly so no build step is required.
 */
const path = require('path');
const fs   = require('fs');

const distEntry = path.join(__dirname, '..', 'dist', 'index.js');

if (fs.existsSync(distEntry)) {
  require(distEntry);
} else {
  // Development fallback — tsx must be available
  try {
    require('tsx/cjs');
  } catch {
    console.error(
      'tracegraph: dist/index.js not found and tsx is not available.\n' +
      'Run `pnpm build` inside packages/cli, or install tsx globally.',
    );
    process.exit(1);
  }
  require(path.join(__dirname, '..', 'src', 'index.ts'));
}

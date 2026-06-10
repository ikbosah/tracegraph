#!/usr/bin/env node
/**
 * postinstall — attempt to install Graphify silently after `npm install -g @tracegraph/cli`.
 *
 * This file is intentionally plain CommonJS (no TypeScript build step) so it
 * runs immediately from node_modules without requiring a prior compile.
 *
 * Rules:
 *   - Always exits 0. A Graphify install failure must never break npm install.
 *   - Skips silently if Graphify is already available in PATH.
 *   - Respects TRACEGRAPH_SKIP_GRAPHIFY_INSTALL=1 for CI environments that
 *     want to manage Python dependencies themselves.
 *   - PyPI package: graphifyy (double-y). CLI command: graphify (single-y).
 *   - Installer order: uv → pipx → pip → pip3 → py -m pip.
 */
'use strict';

const { spawnSync } = require('child_process');

if (process.env['TRACEGRAPH_SKIP_GRAPHIFY_INSTALL'] === '1') {
  process.exit(0);
}

function probe(bin, args) {
  try {
    const r = spawnSync(bin, args, {
      encoding: 'utf8', timeout: 5_000, stdio: 'pipe',
      shell: process.platform === 'win32',
    });
    return r.status === 0;
  } catch { return false; }
}

function tryInstall(bin, args) {
  try {
    const r = spawnSync(bin, args, {
      encoding: 'utf8', timeout: 120_000, stdio: 'pipe',
      shell: process.platform === 'win32',
    });
    return r.status === 0;
  } catch { return false; }
}

try {
  // Already installed — nothing to do
  if (probe('graphify', ['--version'])) {
    process.stderr.write('  [tracegraph] Graphify already installed — architecture analysis ready\n');
    process.exit(0);
  }

  const installers = [
    // uv: recommended by Graphify docs; fastest installer
    { bin: 'uv',   args: ['tool', 'install', 'graphifyy'] },
    // pipx: isolated env for CLI tools
    { bin: 'pipx', args: ['install', 'graphifyy'] },
    // pip / pip3 with --user (no sudo needed); -q suppresses progress noise
    { bin: 'pip',  args: ['install', 'graphifyy', '--user', '-q'] },
    { bin: 'pip3', args: ['install', 'graphifyy', '--user', '-q'] },
    // Windows py launcher
    { bin: 'py',   args: ['-m', 'pip', 'install', 'graphifyy', '--user', '-q'] },
  ];

  let installedWith = null;
  for (const { bin, args } of installers) {
    if (tryInstall(bin, args) && probe('graphify', ['--version'])) {
      installedWith = bin;
      break;
    }
  }

  if (installedWith) {
    process.stderr.write(
      `  [tracegraph] ✅ Graphify installed via ${installedWith} — architecture analysis enabled\n` +
      `  [tracegraph]    Run: tracegraph graph build  to build the static graph\n`,
    );
  } else {
    process.stderr.write(
      '  [tracegraph] ℹ  Graphify not installed (Python/pip not found in PATH).\n' +
      '  [tracegraph]    After installing Python 3.10+, run:\n' +
      '  [tracegraph]      pip install graphify\n' +
      '  [tracegraph]    Or run:  tracegraph graph doctor --install\n',
    );
  }
} catch (_err) {
  // Silently ignore all errors — postinstall must never fail npm install
}

process.exit(0);

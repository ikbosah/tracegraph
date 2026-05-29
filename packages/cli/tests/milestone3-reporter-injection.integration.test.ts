/**
 * Integration tests for T3.4 — CLI auto-detect + inject reporter
 *
 * Exit criterion (IMPLEMENTATION_PLAN.md M3, T3.4):
 *   `tracegraph run -- npx vitest` on a project without the reporter →
 *   recommendation shown in stderr; with a project that has the reporter
 *   already, injection is skipped.
 *
 * Tests:
 *   I1: vitest binary in args → stderr says "injecting @tracegraph/vitest reporter"
 *   I2: vitest config already has reporter → injection skipped ("already present")
 *   I3: "vitest" as a positional word in the command → detected and injected
 *   I4: plain node command with no test runner → warns "no test reporter detected"
 *   I5: --config <path> with reporter in that file → injection skipped
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs   from 'fs';
import path from 'path';
import os   from 'os';

// ── Helpers ───────────────────────────────────────────────────────────────────

const WORKSPACE_ROOT = path.resolve(__dirname, '../../..');

const _TSX_BIN = path.join(WORKSPACE_ROOT, 'node_modules/.bin');
const TSX = process.platform === 'win32'
  ? path.join(_TSX_BIN, 'tsx.CMD')
  : path.join(_TSX_BIN, 'tsx');

const VITEST_BIN = process.platform === 'win32'
  ? path.join(WORKSPACE_ROOT, 'node_modules/.bin/vitest.CMD')
  : path.join(WORKSPACE_ROOT, 'node_modules/.bin/vitest');

const CLI     = path.resolve(WORKSPACE_ROOT, 'packages/cli/src/index.ts');
const VITEST_CONFIG = path.resolve(WORKSPACE_ROOT, 'packages/trace-vitest/vitest.m3-integration.config.ts');

function runCli(args: string[], cwd: string): ReturnType<typeof spawnSync> {
  return spawnSync(TSX, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0' },
    timeout: 60_000,
  });
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracegraph-inject-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('T3.4 — Reporter auto-injection', () => {

  // I1: vitest binary detected → injection message emitted ──────────────────
  it('I1: vitest binary in args → stderr contains injection message', () => {
    // We run vitest --version (exits immediately with the version number and status 0).
    // The important thing: no vitest.config.ts in tmpDir, so injection should fire.
    const result = runCli(
      ['run', '--', VITEST_BIN, '--version'],
      tmpDir,
    );

    // The injection message goes to stderr (process.stderr.write)
    expect(result.stderr).toContain('TraceGraph: detected Vitest');
    expect(result.stderr).toContain('injecting @tracegraph/vitest reporter');
  });

  // I2: reporter already in vitest.config.ts → injection skipped ────────────
  it('I2: vitest.config.ts with @tracegraph/vitest → injection is skipped', () => {
    // Write a vitest.config.ts that already references @tracegraph/vitest
    fs.writeFileSync(
      path.join(tmpDir, 'vitest.config.ts'),
      `import { TraceGraphReporter } from '@tracegraph/vitest';\n` +
      `export default { test: { reporters: [new TraceGraphReporter()] } };\n`,
      'utf8',
    );

    const result = runCli(
      ['run', '--', VITEST_BIN, '--version'],
      tmpDir,
    );

    // Should say "already present, skipping injection" (not inject)
    expect(result.stderr).toContain('already present');
    expect(result.stderr).not.toContain('injecting @tracegraph/vitest');
  });

  // I3: "vitest" as a positional word → detected ───────────────────────────
  it('I3: vitest as a positional word in the command args is detected', () => {
    // Simulate `npx vitest run` — the first command is npx (or tsx), and "vitest"
    // appears as a positional arg. We use vitest --version (exits quickly).
    // Here we use TSX (not VITEST_BIN) as the executable, with "vitest" as an arg
    // in a way that makes sense (we run vitest --version via tsx):
    const result = runCli(
      [
        'run', '--',
        // Use tsx to run vitest as a module — "vitest" appears as a plain arg,
        // not as the binary basename. TSX basename is 'tsx' or 'tsx.CMD'.
        TSX,
        'node_modules/vitest/vitest.mjs',
        '--version',
      ],
      WORKSPACE_ROOT,
    );

    // "vitest" appears in args (in the path node_modules/vitest/...)
    // \bvitest\b matches in "node_modules/vitest/vitest.mjs"
    expect(result.stderr).toContain('TraceGraph: detected Vitest');
  });

  // I4: no test runner → warns user ─────────────────────────────────────────
  it('I4: plain node command with no test runner → warns "no test reporter detected"', () => {
    const nodeExe = process.execPath;  // path to current node binary
    const result = runCli(
      ['run', '--', nodeExe, '-e', 'process.exit(0)'],
      tmpDir,
    );

    expect(result.stderr).toContain('no test reporter detected');
    expect(result.stderr).toContain('Recommendation');
  });

  // I5: --config <path> with @tracegraph/vitest → injection skipped ─────────
  it('I5: --config <path> already containing @tracegraph/vitest → injection skipped', () => {
    // The VITEST_CONFIG already contains `new TraceGraphReporter()` (from @tracegraph/vitest)
    const result = runCli(
      ['run', '--', VITEST_BIN, '--version', '--config', VITEST_CONFIG],
      tmpDir,
    );

    // Injection should be skipped because the config references @tracegraph/vitest
    expect(result.stderr).toContain('already present');
    expect(result.stderr).not.toContain('injecting @tracegraph/vitest');
  });
});

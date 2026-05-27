/**
 * Milestone 1 — Express Vertical Slice integration test
 *
 * Exit criteria (IMPLEMENTATION_PLAN.md M1):
 *   T1: tracegraph run produces ≥5 events and captureLevel.overall ≥ 1
 *       when a script that uses traceFunction is wrapped.
 *   T2: The trace.json contains function_call events with correct parentEventId nesting.
 *   T3: tracegraph open --html produces a valid self-contained HTML file.
 *   T4: The HTML embeds the trace JSON and the webview IIFE bundle.
 *   T5: tracegraph init adds all four scripts to package.json.
 *   T6: tracegraph init creates tracegraph.config.json.
 *   T7: tracegraph init updates .gitignore.
 *   T8: tracegraph init is idempotent on re-runs.
 *
 * Architecture notes:
 *   - The CLI is spawned via tsx (TypeScript, no build step).
 *   - The wrapped command uses the fixture script (absolute path) so module
 *     resolution walks up from packages/cli/tests/fixtures/ to the workspace
 *     root — workspace packages resolve even though CLI cwd is an isolated tmpDir.
 *   - TRACEGRAPH_WEBVIEW_BUNDLE is set so the open command finds the built bundle.
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

const CLI     = path.resolve(WORKSPACE_ROOT, 'packages/cli/src/index.ts');
const FIXTURE = path.resolve(__dirname, 'fixtures/m1-traced-script.ts');
const BUNDLE  = path.resolve(WORKSPACE_ROOT, 'apps/webview/dist/tracegraph-viewer.iife.js');

type CliLine = {
  protocol:     string;
  type:         string;
  runId:        string;
  timestamp:    number;
  traceId?:     string;
  captureLevel?: { overall: number; label: string };
  [k: string]:  unknown;
};

type SpawnResult = ReturnType<typeof spawnSync> & {
  stdoutLines: CliLine[];
};

function runCli(
  args: string[],
  cwd: string,
  extraEnv: Record<string, string> = {},
): SpawnResult {
  const result = spawnSync(TSX, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      ...extraEnv,
    },
    timeout: 30_000,
  });

  const stdoutLines: CliLine[] = [];
  for (const line of (result.stdout ?? '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { stdoutLines.push(JSON.parse(t) as CliLine); } catch { /* passthrough */ }
  }

  return Object.assign(result, { stdoutLines });
}

function findFiles(dir: string, suffix: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...findFiles(full, suffix));
    else if (entry.name.endsWith(suffix)) results.push(full);
  }
  return results;
}

// ── Test setup ────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracegraph-m1-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Milestone 1 — Express Vertical Slice', () => {

  // ── T1: run produces ≥5 events + captureLevel ≥ 1 ─────────────────────────
  it('T1: run -- tsx <fixture> produces ≥5 events and captureLevel.overall ≥ 1', () => {
    const result = runCli(['run', '--', TSX, FIXTURE], tmpDir);

    expect(
      result.status,
      `CLI exited ${result.status ?? 'null'}\nstderr: ${result.stderr}\nstdout: ${result.stdout}`,
    ).toBe(0);

    // ── Trace file exists ──────────────────────────────────────────────────
    const traceFiles = findFiles(path.join(tmpDir, '.tracegraph', 'traces'), '.trace.json');
    expect(traceFiles.length, 'Expected at least one .trace.json').toBeGreaterThanOrEqual(1);

    const trace = JSON.parse(fs.readFileSync(traceFiles[0]!, 'utf8')) as {
      events: Array<{ type: string; name: string; eventId: string; parentEventId: string | null }>;
      captureLevel: { overall: number; label: string };
    };

    // ── ≥5 events ─────────────────────────────────────────────────────────
    expect(
      trace.events.length,
      `Expected ≥5 events, got ${trace.events.length}:\n${JSON.stringify(trace.events.map((e) => e.type))}`,
    ).toBeGreaterThanOrEqual(5);

    // ── Event types present ────────────────────────────────────────────────
    const types = new Set(trace.events.map((e) => e.type));
    expect(types.has('trace_start'), 'Missing trace_start event').toBe(true);
    expect(types.has('function_call'), 'Missing function_call event').toBe(true);
    expect(types.has('return'), 'Missing return event').toBe(true);
    expect(types.has('trace_end'), 'Missing trace_end event').toBe(true);

    // ── captureLevel ≥ 1 (register.ts ran and wrote capture-level.json) ───
    expect(
      trace.captureLevel.overall,
      `captureLevel.overall should be ≥1, got ${trace.captureLevel.overall}`,
    ).toBeGreaterThanOrEqual(1);

    expect(trace.captureLevel.label).toMatch(/framework|level/i);

    // ── trace.completed stdout line carries captureLevel ──────────────────
    const completedLine = result.stdoutLines.find((l) => l.type === 'trace.completed');
    expect(completedLine, 'trace.completed stdout line missing').toBeDefined();
    expect(completedLine!.captureLevel?.overall).toBeGreaterThanOrEqual(1);
  });

  // ── T2: function_call events have correct parentEventId nesting ────────────
  it('T2: function_call events nest correctly under trace_start', () => {
    const result = runCli(['run', '--', TSX, FIXTURE], tmpDir);
    expect(result.status).toBe(0);

    const traceFiles = findFiles(path.join(tmpDir, '.tracegraph', 'traces'), '.trace.json');
    const trace = JSON.parse(fs.readFileSync(traceFiles[0]!, 'utf8')) as {
      events: Array<{ type: string; name: string; eventId: string; parentEventId: string | null }>;
    };

    const traceStart   = trace.events.find((e) => e.type === 'trace_start');
    const functionCalls = trace.events.filter((e) => e.type === 'function_call');

    expect(traceStart, 'trace_start event missing').toBeDefined();
    expect(functionCalls.length, 'Expected ≥1 function_call events').toBeGreaterThanOrEqual(1);

    // The fixture runs pipeline(5) → inner calls to add() and multiply()
    const names = functionCalls.map((e) => e.name);
    expect(names, 'Expected "pipeline" function_call').toContain('pipeline');
    expect(names, 'Expected "add" function_call').toContain('add');
    expect(names, 'Expected "multiply" function_call').toContain('multiply');

    // "pipeline" should be parented to the trace root (ChildEventWriter.rootEventId = traceStartEventId)
    const pipelineCall = functionCalls.find((e) => e.name === 'pipeline')!;
    expect(pipelineCall.parentEventId).toBe(traceStart!.eventId);

    // "add" and "multiply" should be parented under "pipeline"
    const addCall = functionCalls.find((e) => e.name === 'add')!;
    expect(addCall.parentEventId).toBe(pipelineCall.eventId);

    const mulCall = functionCalls.find((e) => e.name === 'multiply')!;
    expect(mulCall.parentEventId).toBe(pipelineCall.eventId);
  });

  // ── T3: tracegraph open --html produces an HTML file ──────────────────────
  it('T3: open --html produces a self-contained HTML file', () => {
    // First produce a trace
    const runResult = runCli(['run', '--', TSX, FIXTURE], tmpDir);
    expect(runResult.status).toBe(0);

    const traceFiles = findFiles(path.join(tmpDir, '.tracegraph', 'traces'), '.trace.json');
    expect(traceFiles.length).toBeGreaterThanOrEqual(1);
    const traceFile = traceFiles[0]!;

    const outHtml = path.join(tmpDir, 'report.html');

    const openResult = runCli(
      ['open', '--html', '--no-open', '--out', outHtml, traceFile],
      tmpDir,
      { TRACEGRAPH_WEBVIEW_BUNDLE: BUNDLE },
    );

    expect(
      openResult.status,
      `open exited ${openResult.status ?? 'null'}\nstderr: ${openResult.stderr}\nstdout: ${openResult.stdout}`,
    ).toBe(0);

    expect(fs.existsSync(outHtml), 'HTML report not found').toBe(true);
  });

  // ── T4: HTML is self-contained with embedded trace JSON and JS bundle ──────
  it('T4: HTML embeds trace JSON and viewer JS', () => {
    const runResult = runCli(['run', '--', TSX, FIXTURE], tmpDir);
    expect(runResult.status).toBe(0);

    const traceFiles = findFiles(path.join(tmpDir, '.tracegraph', 'traces'), '.trace.json');
    const traceFile  = traceFiles[0]!;
    const trace      = JSON.parse(fs.readFileSync(traceFile, 'utf8')) as { traceId: string };

    const outHtml = path.join(tmpDir, 'report.html');
    runCli(
      ['open', '--html', '--no-open', '--out', outHtml, traceFile],
      tmpDir,
      { TRACEGRAPH_WEBVIEW_BUNDLE: BUNDLE },
    );

    const html = fs.readFileSync(outHtml, 'utf8');

    // Has correct DOCTYPE and structure
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<div id="root">');

    // Embeds trace data in a script tag
    expect(html).toContain('id="tracegraph-data"');
    expect(html).toContain(trace.traceId);

    // Bundles the viewer JS inline (first 100 chars of the IIFE bundle)
    const bundleStart = fs.readFileSync(BUNDLE, 'utf8').slice(0, 100);
    expect(html).toContain(bundleStart.slice(0, 50));
  });

  // ── T5–T8: tracegraph init ─────────────────────────────────────────────────
  describe('tracegraph init', () => {

    it('T5: adds all four trace:* scripts to package.json', () => {
      // Create a minimal package.json in tmpDir
      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({ name: 'test-project', version: '1.0.0', scripts: {} }, null, 2),
        'utf8',
      );

      const result = runCli(['init'], tmpDir);
      expect(result.status).toBe(0);

      const pkg = JSON.parse(fs.readFileSync(path.join(tmpDir, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      };

      expect(pkg.scripts['trace:test'],     'trace:test missing').toBeDefined();
      expect(pkg.scripts['trace:baseline'], 'trace:baseline missing').toBeDefined();
      expect(pkg.scripts['trace:compare'],  'trace:compare missing').toBeDefined();
      expect(pkg.scripts['trace:report'],   'trace:report missing').toBeDefined();

      expect(pkg.scripts['trace:test']).toContain('tracegraph run');
      expect(pkg.scripts['trace:report']).toContain('tracegraph open --html');
    });

    it('T6: creates tracegraph.config.json with language and storage keys', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({ name: 'test-project', dependencies: { express: '^4.0.0' } }, null, 2),
        'utf8',
      );

      const result = runCli(['init'], tmpDir);
      expect(result.status).toBe(0);

      const configPath = path.join(tmpDir, 'tracegraph.config.json');
      expect(fs.existsSync(configPath), 'tracegraph.config.json not found').toBe(true);

      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        language: string;
        framework: string;
        storage: { maxRuns: number };
        sanitize: { maxDepth: number };
      };

      expect(cfg.language).toBe('typescript');
      expect(cfg.framework).toBe('express');
      expect(typeof cfg.storage.maxRuns).toBe('number');
      expect(typeof cfg.sanitize.maxDepth).toBe('number');
    });

    it('T7: adds TraceGraph entries to .gitignore', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({ name: 'test-project' }, null, 2),
        'utf8',
      );

      const result = runCli(['init'], tmpDir);
      expect(result.status).toBe(0);

      const gitignore = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');
      expect(gitignore).toContain('.tracegraph/runs/');
      expect(gitignore).toContain('.tracegraph/traces/');
      expect(gitignore).toContain('.tracegraph/reports/');
    });

    it('T8: is idempotent — does not duplicate scripts or gitignore entries on re-runs', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({ name: 'test-project', scripts: {} }, null, 2),
        'utf8',
      );

      // Run twice
      runCli(['init'], tmpDir);
      runCli(['init'], tmpDir);

      const pkg      = JSON.parse(fs.readFileSync(path.join(tmpDir, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      };
      const gitignore = fs.readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');

      // Each script should appear exactly once
      const scriptKeys = Object.keys(pkg.scripts).filter((k) => k.startsWith('trace:'));
      expect(scriptKeys.length, 'scripts duplicated').toBe(4);

      // .tracegraph/runs/ should appear exactly once
      const count = (gitignore.match(/\.tracegraph\/runs\//g) ?? []).length;
      expect(count, '.tracegraph/runs/ duplicated in .gitignore').toBe(1);
    });
  });
});

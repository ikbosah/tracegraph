/**
 * Milestone 0 — CLI file protocol integration test
 *
 * Exit criterion: all assertions in this file pass.
 * See: docs/MILESTONE_0_CHECKLIST.md
 *
 * These tests spawn the CLI via tsx (no build step required).
 * Each test gets its own isolated tmpDir so runs do not interfere.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Path to the tsx binary in the monorepo root node_modules. */
const _TSX_BIN = path.resolve(__dirname, '../../../node_modules/.bin');
const TSX = process.platform === 'win32'
  ? path.join(_TSX_BIN, 'tsx.CMD')
  : path.join(_TSX_BIN, 'tsx');

/** Absolute path to the CLI entry point. */
const CLI = path.resolve(__dirname, '../src/index.ts');

type SpawnResult = ReturnType<typeof spawnSync> & { stdoutLines: CliLine[]; parsedLines: unknown[] };
type CliLine = { protocol: string; type: string; runId: string; timestamp: number; [k: string]: unknown };

function runCli(args: string[], cwd: string): SpawnResult {
  const result = spawnSync(TSX, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0' },
    timeout: 20_000,
  });

  const stdoutLines: CliLine[] = [];
  for (const line of (result.stdout ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      stdoutLines.push(JSON.parse(trimmed) as CliLine);
    } catch {
      // Non-JSON stdout line (e.g. child process passthrough)
    }
  }

  return Object.assign(result, { stdoutLines, parsedLines: stdoutLines });
}

function findFiles(dir: string, suffix: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findFiles(full, suffix));
    } else if (entry.name.endsWith(suffix)) {
      results.push(full);
    }
  }
  return results;
}

function allFilesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...allFilesUnder(full));
    else results.push(full);
  }
  return results;
}

// ── Test setup ────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracegraph-m0-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Milestone 0 — CLI file protocol', () => {

  it('T1: produces a valid .trace.json with correct schemaVersion', () => {
    const result = runCli(['run', '--', 'node', '-e', "console.log('hello')"], tmpDir);

    expect(result.status, `CLI exited ${result.status}\nstderr: ${result.stderr}`).toBe(0);

    const traceFiles = findFiles(path.join(tmpDir, '.tracegraph', 'traces'), '.trace.json');
    expect(traceFiles.length, 'Expected at least one .trace.json').toBeGreaterThanOrEqual(1);

    const trace = JSON.parse(fs.readFileSync(traceFiles[0]!, 'utf8'));
    expect(trace.schemaVersion).toBe('tracegraph.trace.v1');
    expect(trace.traceId).toMatch(/^trace_[0-9a-f]+$/);
    expect(trace.runId).toMatch(/^run_[0-9a-f]+$/);
    expect(trace.sessionId).toMatch(/^sess_[0-9a-f]+$/);
    expect(Array.isArray(trace.events)).toBe(true);
    expect(trace.events.length).toBeGreaterThanOrEqual(2); // trace_start + trace_end
    expect(trace.status).toBe('passed');
    expect(trace.captureLevel.overall).toBe(0);
  });

  it('T2: leaves no .tmp files after a successful run', () => {
    runCli(['run', '--', 'node', '-e', 'process.exit(0)'], tmpDir);

    const tmpFiles = allFilesUnder(path.join(tmpDir, '.tracegraph'))
      .filter((f) => f.endsWith('.tmp'));

    expect(tmpFiles, `Orphaned .tmp files found: ${tmpFiles.join(', ')}`).toHaveLength(0);
  });

  it('T3: stdout emits only protocol control events — no raw trace.event lines', () => {
    const result = runCli(['run', '--', 'node', '-e', "console.log('hi')"], tmpDir);

    // Every parsed stdout line must be a protocol envelope
    const rawEventLines = result.stdoutLines.filter((l) => l.type === 'trace.event');
    expect(rawEventLines, 'Found raw trace.event lines on stdout').toHaveLength(0);

    const types = result.stdoutLines.map((l) => l.type);
    expect(types).toContain('run.started');
    expect(types).toContain('trace.started');
    expect(types).toContain('trace.completed');
    expect(types).toContain('run.completed');
  });

  it('T4: every stdout line carries the correct protocol envelope fields', () => {
    const result = runCli(['run', '--', 'node', '-e', 'process.exit(0)'], tmpDir);

    expect(result.stdoutLines.length).toBeGreaterThan(0);

    for (const line of result.stdoutLines) {
      expect(line.protocol, `Missing protocol field on: ${JSON.stringify(line)}`).toBe('tracegraph.cli.v1');
      expect(typeof line.runId,    'runId must be a string').toBe('string');
      expect(typeof line.timestamp, 'timestamp must be a number').toBe('number');
    }
  });

  it('T5: trace.completed event references an existing finalised file', () => {
    const result = runCli(['run', '--', 'node', '-e', "console.log('done')"], tmpDir);

    const completed = result.stdoutLines.find((l) => l.type === 'trace.completed');
    expect(completed, 'No trace.completed event found on stdout').toBeDefined();

    const relFile = (completed!.payload as { file?: string }).file;
    expect(relFile, 'trace.completed.payload.file must be defined').toBeDefined();
    expect(relFile, 'file must end with .trace.json').toMatch(/\.trace\.json$/);

    const absFile = path.join(tmpDir, relFile!);
    expect(fs.existsSync(absFile), `Finalised trace file not found: ${absFile}`).toBe(true);
  });

  it('T6: exits with code 1 when the wrapped command fails', () => {
    const result = runCli(['run', '--', 'node', '-e', 'process.exit(1)'], tmpDir);
    expect(result.status).toBe(1);

    // Trace should record status: failed
    const traceFiles = findFiles(path.join(tmpDir, '.tracegraph', 'traces'), '.trace.json');
    if (traceFiles.length > 0) {
      const trace = JSON.parse(fs.readFileSync(traceFiles[0]!, 'utf8'));
      expect(trace.status).toBe('failed');
    }
  });

  it('T7: tracegraph clean --all-runs removes all run directories', () => {
    // First, produce a run
    runCli(['run', '--', 'node', '-e', 'process.exit(0)'], tmpDir);

    const runsDir = path.join(tmpDir, '.tracegraph', 'runs');
    expect(fs.existsSync(runsDir) && fs.readdirSync(runsDir).length).toBeGreaterThan(0);

    // Clean
    const cleanResult = runCli(['clean', '--all-runs'], tmpDir);
    expect(cleanResult.status).toBe(0);

    // All run directories should be gone
    if (fs.existsSync(runsDir)) {
      const remaining = fs.readdirSync(runsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory());
      expect(remaining, 'Run directories remain after clean --all-runs').toHaveLength(0);
    }
  });

  it('T8: tracegraph storage status reports the run count', () => {
    runCli(['run', '--', 'node', '-e', 'process.exit(0)'], tmpDir);

    const result = runCli(['storage', 'status'], tmpDir);
    expect(result.status).toBe(0);

    const output = result.stdout ?? '';
    expect(output, 'storage status output must mention "Runs"').toMatch(/Runs:/i);
    expect(output, 'storage status output must mention "Traces"').toMatch(/Traces:/i);
    expect(output, 'storage status output must mention ".tracegraph"').toContain('.tracegraph');
  });

  it('T9: trace events carry correct schemaVersion and traceId', () => {
    runCli(['run', '--', 'node', '-e', "console.log('events')"], tmpDir);

    const traceFiles = findFiles(path.join(tmpDir, '.tracegraph', 'traces'), '.trace.json');
    expect(traceFiles.length).toBeGreaterThanOrEqual(1);

    const trace = JSON.parse(fs.readFileSync(traceFiles[0]!, 'utf8'));
    const { events } = trace;

    expect(Array.isArray(events)).toBe(true);
    for (const event of events) {
      expect(event.schemaVersion).toBe('tracegraph.event.v1');
      expect(event.traceId).toBe(trace.traceId);
      expect(event.eventId).toMatch(/^evt_[0-9a-f]+$/);
    }

    // First event must be trace_start
    expect(events[0].type).toBe('trace_start');
    // Last event must be trace_end
    expect(events[events.length - 1].type).toBe('trace_end');
  });

  it('T10: run.completed carries captureLevel in the stdout envelope', () => {
    const result = runCli(['run', '--', 'node', '-e', 'process.exit(0)'], tmpDir);

    const completed = result.stdoutLines.find((l) => l.type === 'run.completed');
    expect(completed).toBeDefined();
    expect(completed!.captureLevel).toBeDefined();
    expect(completed!.captureLevel).toMatchObject({ overall: 0, label: expect.any(String) });
  });
});

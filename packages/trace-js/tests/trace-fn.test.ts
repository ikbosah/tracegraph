/**
 * Unit tests for traceFunction and traceMethod.
 *
 * Top-level imports so module cache is stable across tests.
 * ChildEventWriter singleton is reset via _resetForTest() in afterEach.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { traceFunction, traceMethod } from '../src/trace-fn';
import { traceStorage } from '../src/context';
import { ChildEventWriter } from '../src/child-writer';

const TRACE_ID = 'trace_testid';

let tmpDir: string;
let jsonlPath: string;

beforeEach(() => {
  tmpDir    = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-trace-fn-'));
  jsonlPath = path.join(tmpDir, `${TRACE_ID}.events.jsonl.tmp`);

  process.env.TRACEGRAPH_ENABLED    = '1';
  process.env.TRACEGRAPH_RUN_DIR    = tmpDir;
  process.env.TRACEGRAPH_TRACE_ID   = TRACE_ID;
  process.env.TRACEGRAPH_RUN_ID     = 'run_testid';
  process.env.TRACEGRAPH_SESSION_ID = 'sess_testid';
  // Reset the singleton so it re-reads env vars for each test
  ChildEventWriter._resetForTest();
});

afterEach(() => {
  ChildEventWriter._resetForTest();
  delete process.env.TRACEGRAPH_ENABLED;
  delete process.env.TRACEGRAPH_RUN_DIR;
  delete process.env.TRACEGRAPH_TRACE_ID;
  delete process.env.TRACEGRAPH_RUN_ID;
  delete process.env.TRACEGRAPH_SESSION_ID;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function readEvents(): unknown[] {
  if (!fs.existsSync(jsonlPath)) return [];
  return fs.readFileSync(jsonlPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe('traceFunction()', () => {
  it('emits function_call + return for a sync function', () => {
    const double = traceFunction('double', (x: number) => x * 2);
    const result = double(5);

    expect(result).toBe(10);

    const events = readEvents() as Array<{
      type: string; name: string; eventId: string; parentEventId: string | null;
    }>;
    const callEvt   = events.find((e) => e.type === 'function_call');
    const returnEvt = events.find((e) => e.type === 'return');

    expect(callEvt,   'function_call event missing').toBeDefined();
    expect(callEvt!.name).toBe('double');
    expect(returnEvt, 'return event missing').toBeDefined();
    expect(returnEvt!.parentEventId).toBe(callEvt!.eventId);
  });

  it('emits function_call + error for a throwing sync function', () => {
    const boom = traceFunction('boom', () => { throw new Error('kaboom'); });

    expect(() => boom()).toThrow('kaboom');

    const events = readEvents() as Array<{ type: string; name: string; error?: { message: string } }>;
    expect(events.find((e) => e.type === 'function_call'), 'function_call missing').toBeDefined();
    const errEvt = events.find((e) => e.type === 'error');
    expect(errEvt, 'error event missing').toBeDefined();
    expect(errEvt!.error?.message).toBe('kaboom');
  });

  it('emits function_call + return for an async function', async () => {
    const asyncDouble = traceFunction('asyncDouble', async (x: number) => {
      await Promise.resolve();
      return x * 2;
    });

    const result = await asyncDouble(7);
    expect(result).toBe(14);

    const events = readEvents() as Array<{ type: string }>;
    expect(events.find((e) => e.type === 'function_call'), 'function_call missing').toBeDefined();
    expect(events.find((e) => e.type === 'return'), 'return missing').toBeDefined();
  });

  it('emits error for a rejecting async function', async () => {
    const asyncBoom = traceFunction('asyncBoom', async () => {
      await Promise.resolve();
      throw new Error('async kaboom');
    });

    await expect(asyncBoom()).rejects.toThrow('async kaboom');

    const events = readEvents() as Array<{ type: string; error?: { message: string } }>;
    const errEvt = events.find((e) => e.type === 'error');
    expect(errEvt, 'error event missing').toBeDefined();
    expect(errEvt!.error?.message).toBe('async kaboom');
  });

  it('maintains correct parentEventId for nested calls', () => {
    const inner = traceFunction('inner', () => 42);
    const outer = traceFunction('outer', () => inner());

    const ctx = {
      traceId:   TRACE_ID,
      runId:     'run_testid',
      callStack: ['evt_root'],
    };

    traceStorage.run(ctx, () => { outer(); });

    const events = readEvents() as Array<{
      type: string; name: string; eventId: string; parentEventId: string | null;
    }>;
    const outerCall = events.find((e) => e.type === 'function_call' && e.name === 'outer');
    const innerCall = events.find((e) => e.type === 'function_call' && e.name === 'inner');

    expect(outerCall, 'outer call event missing').toBeDefined();
    expect(innerCall, 'inner call event missing').toBeDefined();
    expect(outerCall!.parentEventId).toBe('evt_root');
    expect(innerCall!.parentEventId).toBe(outerCall!.eventId);
  });

  it('is a no-op when TRACEGRAPH_ENABLED is not set', () => {
    ChildEventWriter._resetForTest();
    delete process.env.TRACEGRAPH_ENABLED;

    const fn = traceFunction('noop', (x: number) => x * 3);
    expect(fn(4)).toBe(12);
    expect(readEvents()).toHaveLength(0);
  });
});

describe('traceMethod()', () => {
  it('emits method_call event with className and functionName', () => {
    const method = traceMethod(
      'InvoiceService',
      'create',
      (amount: number) => ({ id: 1, amount }),
    );
    const result = method(100);

    expect((result as { amount: number }).amount).toBe(100);

    const events = readEvents() as Array<{
      type: string; className?: string; functionName?: string;
    }>;
    const callEvt = events.find((e) => e.type === 'method_call');
    expect(callEvt, 'method_call event missing').toBeDefined();
    expect(callEvt!.className).toBe('InvoiceService');
    expect(callEvt!.functionName).toBe('create');
  });
});

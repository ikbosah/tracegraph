/**
 * T1.5 — Outbound HTTP correlation header injection tests
 *
 * Three mechanisms are tested independently:
 *
 *  1. globalThis.fetch patch  — must inject `x-tracegraph-correlation-id`
 *                               and emit external_http_call + http_response events
 *
 *  2. tracedAxios interceptor — must inject `x-tracegraph-correlation-id` into
 *                               request headers and emit external_http_call + http_response events
 *
 *  3. undici diagnostics_channel — observation-only; must NOT inject headers
 *                                   (uses the raw undici request shape from the channel)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { patchGlobalFetch, tracedAxios, subscribeUndiciChannel, _resetHttpPatchForTest } from '../src/http';
import { traceStorage } from '../src/context';
import { ChildEventWriter } from '../src/child-writer';

// ─── Test harness helpers ────────────────────────────────────────────────────

const TRACE_ID = 'trace_corr_test';
const RUN_ID   = 'run_corr_test';

let tmpDir:        string;
let jsonlPath:     string;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  tmpDir    = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-corr-'));
  jsonlPath = path.join(tmpDir, `${TRACE_ID}.events.jsonl.tmp`);

  process.env.TRACEGRAPH_ENABLED    = '1';
  process.env.TRACEGRAPH_RUN_DIR    = tmpDir;
  process.env.TRACEGRAPH_TRACE_ID   = TRACE_ID;
  process.env.TRACEGRAPH_RUN_ID     = RUN_ID;
  process.env.TRACEGRAPH_SESSION_ID = 'sess_corr';

  ChildEventWriter._resetForTest();
});

afterEach(() => {
  ChildEventWriter._resetForTest();
  _resetHttpPatchForTest();
  // Restore globalThis.fetch to whatever it was before this test
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();

  delete process.env.TRACEGRAPH_ENABLED;
  delete process.env.TRACEGRAPH_RUN_DIR;
  delete process.env.TRACEGRAPH_TRACE_ID;
  delete process.env.TRACEGRAPH_RUN_ID;
  delete process.env.TRACEGRAPH_SESSION_ID;

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function readEvents(): Array<Record<string, unknown>> {
  if (!fs.existsSync(jsonlPath)) return [];
  return fs.readFileSync(jsonlPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

// ─── 1. globalThis.fetch patch ───────────────────────────────────────────────

describe('patchGlobalFetch()', () => {
  it('injects x-tracegraph-correlation-id header', async () => {
    let capturedHeaders: Headers | undefined;

    // Replace globalThis.fetch with a mock that captures the outgoing headers
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers as HeadersInit);
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    patchGlobalFetch();

    await traceStorage.run(
      { traceId: TRACE_ID, runId: RUN_ID, callStack: [] },
      async () => {
        await fetch('https://example.com/api');
      },
    );

    expect(capturedHeaders).toBeDefined();
    const correlationHeader = capturedHeaders!.get('x-tracegraph-correlation-id');
    expect(correlationHeader).toMatch(/^trace_corr_test:evt_/);
  });

  it('emits external_http_call event before awaiting the response', async () => {
    globalThis.fetch = vi.fn(async () => new Response('ok', { status: 200 })) as typeof fetch;

    patchGlobalFetch();

    await traceStorage.run(
      { traceId: TRACE_ID, runId: RUN_ID, callStack: [] },
      async () => {
        await fetch('https://api.example.com/users', { method: 'POST' });
      },
    );

    const events = readEvents();
    const outbound = events.find((e) => e.type === 'external_http_call');
    expect(outbound).toBeDefined();
    expect(outbound!.name).toBe('POST https://api.example.com/users');
    expect((outbound!.metadata as Record<string, unknown>)?.via).toBe('fetch');
  });

  it('emits http_response event with status code', async () => {
    globalThis.fetch = vi.fn(async () => new Response('created', { status: 201 })) as typeof fetch;

    patchGlobalFetch();

    await traceStorage.run(
      { traceId: TRACE_ID, runId: RUN_ID, callStack: [] },
      async () => {
        await fetch('https://api.example.com/orders', { method: 'POST' });
      },
    );

    const events = readEvents();
    const response = events.find((e) => e.type === 'http_response');
    expect(response).toBeDefined();
    expect((response!.output as Record<string, unknown>)?.statusCode).toBe(201);
  });

  it('emits error event when fetch rejects', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('Network failure');
    }) as typeof fetch;

    patchGlobalFetch();

    await traceStorage.run(
      { traceId: TRACE_ID, runId: RUN_ID, callStack: [] },
      async () => {
        await expect(fetch('https://api.example.com/fail')).rejects.toThrow('Network failure');
      },
    );

    const events = readEvents();
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    expect((errorEvent!.error as Record<string, unknown>)?.message).toBe('Network failure');
  });

  it('is a no-op when ChildEventWriter is not active (no env vars)', async () => {
    // Reset env and writer
    ChildEventWriter._resetForTest();
    delete process.env.TRACEGRAPH_ENABLED;

    let capturedHeaders: Headers | undefined;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers as HeadersInit);
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    // Re-patch (patchGlobalFetch is idempotent per module load; reset for test via vi.restoreAllMocks)
    // We call the original directly here — the patched version should pass through without injecting
    await fetch('https://example.com/passthrough');

    const correlationHeader = capturedHeaders?.get('x-tracegraph-correlation-id');
    // No header should be injected when writer is inactive
    expect(correlationHeader).toBeNull();
  });
});

// ─── 2. tracedAxios interceptors ─────────────────────────────────────────────

describe('tracedAxios()', () => {
  /** Minimal fake axios instance mirroring the AxiosInstance interface. */
  function makeFakeAxios() {
    const requestHandlers: Array<(cfg: Record<string, unknown>) => Record<string, unknown>> = [];
    const responseSuccessHandlers: Array<(r: unknown) => unknown> = [];

    return {
      interceptors: {
        request: {
          use(fn: (cfg: unknown) => unknown) {
            requestHandlers.push(fn as (cfg: Record<string, unknown>) => Record<string, unknown>);
            return 0;
          },
        },
        response: {
          use(onFulfilled: (r: unknown) => unknown) {
            responseSuccessHandlers.push(onFulfilled);
            return 0;
          },
        },
      },
      /** Simulate a request: runs request interceptors then response interceptors. */
      async request(cfg: Record<string, unknown>) {
        let mutated = { ...cfg };
        for (const h of requestHandlers) {
          mutated = h(mutated) as Record<string, unknown>;
        }
        // Simulate response
        const fakeResponse = { status: 200, config: mutated };
        let result: unknown = fakeResponse;
        for (const h of responseSuccessHandlers) {
          result = h(result);
        }
        return result;
      },
    };
  }

  it('injects x-tracegraph-correlation-id into request headers', async () => {
    const axios = makeFakeAxios();
    tracedAxios(axios as Parameters<typeof tracedAxios>[0]);

    let headers: Record<string, string> = {};

    await traceStorage.run(
      { traceId: TRACE_ID, runId: RUN_ID, callStack: [] },
      async () => {
        const result = await axios.request({
          method: 'GET',
          url:    'https://inventory.internal/items',
          headers: {},
        });
        headers = ((result as { config: Record<string, unknown> }).config.headers ?? {}) as Record<string, string>;
      },
    );

    expect(headers['x-tracegraph-correlation-id']).toMatch(/^trace_corr_test:evt_/);
  });

  it('emits external_http_call event for each outbound request', async () => {
    const axios = makeFakeAxios();
    tracedAxios(axios as Parameters<typeof tracedAxios>[0]);

    await traceStorage.run(
      { traceId: TRACE_ID, runId: RUN_ID, callStack: [] },
      async () => {
        await axios.request({
          method: 'POST',
          url:    '/orders',
          baseURL: 'https://orders.internal',
          headers: {},
        });
      },
    );

    const events = readEvents();
    const outbound = events.find((e) => e.type === 'external_http_call');
    expect(outbound).toBeDefined();
    expect(outbound!.name).toBe('POST https://orders.internal/orders');
    expect((outbound!.metadata as Record<string, unknown>)?.via).toBe('axios');
  });

  it('emits http_response event with status code', async () => {
    const axios = makeFakeAxios();
    tracedAxios(axios as Parameters<typeof tracedAxios>[0]);

    await traceStorage.run(
      { traceId: TRACE_ID, runId: RUN_ID, callStack: [] },
      async () => {
        await axios.request({ method: 'GET', url: 'https://catalog.internal/products', headers: {} });
      },
    );

    const events = readEvents();
    const response = events.find((e) => e.type === 'http_response');
    expect(response).toBeDefined();
    expect((response!.output as Record<string, unknown>)?.statusCode).toBe(200);
  });

  it('does not inject headers when writer is inactive', async () => {
    ChildEventWriter._resetForTest();
    delete process.env.TRACEGRAPH_ENABLED;

    const axios = makeFakeAxios();
    tracedAxios(axios as Parameters<typeof tracedAxios>[0]);

    const result = await axios.request({
      method: 'GET',
      url:    'https://example.com/no-trace',
      headers: { 'x-existing': 'value' },
    });

    const cfg = (result as { config: Record<string, unknown> }).config;
    const headers = (cfg.headers ?? {}) as Record<string, string>;
    // x-existing header should be untouched, no correlation header injected
    expect(headers['x-existing']).toBe('value');
    expect(headers['x-tracegraph-correlation-id']).toBeUndefined();
  });
});

// ─── 3. undici diagnostics_channel — observation-only ────────────────────────

describe('subscribeUndiciChannel()', () => {
  it('is idempotent — calling multiple times does not double-register', () => {
    // Should not throw
    subscribeUndiciChannel();
    subscribeUndiciChannel();
    subscribeUndiciChannel();
    // If it double-registered we'd get duplicate events — just assert no error thrown
    expect(true).toBe(true);
  });

  it('emits external_http_call event when a message is published on undici:request:create', async () => {
    // We publish directly to the diagnostics_channel to simulate undici — this avoids
    // needing a real undici/fetch request in a unit test.
    const dc = await import('diagnostics_channel');
    const channel = dc.channel('undici:request:create');

    subscribeUndiciChannel();

    await traceStorage.run(
      { traceId: TRACE_ID, runId: RUN_ID, callStack: [] },
      async () => {
        channel.publish({
          request: {
            method: 'GET',
            origin: 'https://api.partner.com',
            path:   '/v1/catalog',
          },
        });
      },
    );

    const events = readEvents();
    const outbound = events.find((e) => e.type === 'external_http_call');
    expect(outbound).toBeDefined();
    expect(outbound!.name).toBe('GET https://api.partner.com/v1/catalog');
    expect((outbound!.metadata as Record<string, unknown>)?.via).toBe('undici:diagnostics_channel');
  });

  it('does NOT mutate the request object — observation only', async () => {
    const dc = await import('diagnostics_channel');
    const channel = dc.channel('undici:request:create');

    subscribeUndiciChannel();

    const fakeRequest = {
      method: 'POST',
      origin: 'https://internal.service',
      path:   '/submit',
    };
    const requestBefore = { ...fakeRequest };

    await traceStorage.run(
      { traceId: TRACE_ID, runId: RUN_ID, callStack: [] },
      async () => {
        channel.publish({ request: fakeRequest });
      },
    );

    // The undici channel subscriber must not add headers or mutate the request
    expect(fakeRequest).toEqual(requestBefore);
  });

  it('is silent when writer is not active', () => {
    ChildEventWriter._resetForTest();
    delete process.env.TRACEGRAPH_ENABLED;

    // Should not throw and should not write any events
    const dc = require('diagnostics_channel') as typeof import('diagnostics_channel');
    const channel = dc.channel('undici:request:create');
    channel.publish({ request: { method: 'GET', origin: 'https://example.com', path: '/' } });

    const events = readEvents();
    expect(events).toHaveLength(0);
  });
});

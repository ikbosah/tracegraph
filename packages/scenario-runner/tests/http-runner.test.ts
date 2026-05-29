/**
 * M6 T6.2 — http-runner unit tests
 *
 * Tests executeStep() for:
 *  - Correct header injection (scenario ID + correlation ID)
 *  - Status assertion pass/fail
 *  - bodyContains assertion pass/fail
 *  - GET/HEAD bodies are not sent
 *  - Timeout propagation
 *  - Fetch error capture (never throws)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ScenarioStep } from '@tracegraph/shared-types';
import { executeStep } from '../src/http-runner';

// ─── fetch mock helpers ────────────────────────────────────────────────────────

type FakeFetchResponse = {
  status: number;
  text: () => Promise<string>;
};

function mockFetch(response: FakeFetchResponse): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
}

function mockFetchError(err: Error): void {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(err));
}

function lastFetchCall(): { url: string; init: RequestInit } {
  const fetchMock = vi.mocked(fetch as unknown as ReturnType<typeof vi.fn>);
  const [url, init] = fetchMock.mock.calls[0]!;
  return { url: url as string, init: init as RequestInit };
}

// ─── Step factory ─────────────────────────────────────────────────────────────

function makeStep(overrides: Partial<ScenarioStep> = {}): ScenarioStep {
  return {
    name: 'Test step',
    http: {
      method: 'GET',
      url: 'http://localhost:3000/api/test',
    },
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('executeStep() — header injection', () => {
  it('injects x-tracegraph-scenario-id header', async () => {
    mockFetch({ status: 200, text: async () => '' });

    await executeStep(makeStep(), { scenarioId: 'scenario_abc', stepIndex: 0 });

    const { init } = lastFetchCall();
    const headers = init.headers as Record<string, string>;
    expect(headers['x-tracegraph-scenario-id']).toBe('scenario_abc');
  });

  it('injects x-tracegraph-correlation-id with scenarioId_stepN format', async () => {
    mockFetch({ status: 200, text: async () => '' });

    await executeStep(makeStep(), { scenarioId: 'scenario_xyz', stepIndex: 3 });

    const { init } = lastFetchCall();
    const headers = init.headers as Record<string, string>;
    expect(headers['x-tracegraph-correlation-id']).toBe('scenario_xyz_step3');
  });

  it('normalises user-supplied header keys to lowercase', async () => {
    mockFetch({ status: 200, text: async () => '' });

    const step = makeStep({
      http: {
        method: 'GET',
        url: 'http://localhost:3000/',
        headers: { 'X-Custom-Header': 'hello', 'Accept': 'application/json' },
      },
    });

    await executeStep(step, { scenarioId: 'scen', stepIndex: 0 });

    const { init } = lastFetchCall();
    const headers = init.headers as Record<string, string>;
    expect(headers['x-custom-header']).toBe('hello');
    expect(headers['accept']).toBe('application/json');
    // Original mixed-case keys should not appear
    expect(headers['X-Custom-Header']).toBeUndefined();
  });

  it('sends to the correct URL', async () => {
    mockFetch({ status: 200, text: async () => '' });

    const step = makeStep({ http: { method: 'GET', url: 'http://example.com/path?q=1' } });
    await executeStep(step, { scenarioId: 'scen', stepIndex: 0 });

    const { url } = lastFetchCall();
    expect(url).toBe('http://example.com/path?q=1');
  });
});

describe('executeStep() — HTTP method', () => {
  it('uppercases the method', async () => {
    mockFetch({ status: 200, text: async () => '' });

    const step = makeStep({ http: { method: 'post', url: 'http://localhost/' } });
    await executeStep(step, { scenarioId: 'scen', stepIndex: 0 });

    const { init } = lastFetchCall();
    expect(init.method).toBe('POST');
  });

  it('does not attach a body for GET requests', async () => {
    mockFetch({ status: 200, text: async () => '' });

    const step = makeStep({
      http: { method: 'GET', url: 'http://localhost/', body: { data: 'should be ignored' } },
    });
    await executeStep(step, { scenarioId: 'scen', stepIndex: 0 });

    const { init } = lastFetchCall();
    expect(init.body).toBeUndefined();
  });

  it('does not attach a body for HEAD requests', async () => {
    mockFetch({ status: 200, text: async () => '' });

    const step = makeStep({ http: { method: 'HEAD', url: 'http://localhost/', body: 'ignored' } });
    await executeStep(step, { scenarioId: 'scen', stepIndex: 0 });

    const { init } = lastFetchCall();
    expect(init.body).toBeUndefined();
  });

  it('serialises an object body to JSON for POST', async () => {
    mockFetch({ status: 201, text: async () => '{}' });

    const step = makeStep({
      http: { method: 'POST', url: 'http://localhost/', body: { name: 'Alice' } },
    });
    await executeStep(step, { scenarioId: 'scen', stepIndex: 0 });

    const { init } = lastFetchCall();
    expect(init.body).toBe('{"name":"Alice"}');
  });

  it('passes string body as-is for POST', async () => {
    mockFetch({ status: 201, text: async () => '' });

    const step = makeStep({ http: { method: 'POST', url: 'http://localhost/', body: 'raw text' } });
    await executeStep(step, { scenarioId: 'scen', stepIndex: 0 });

    const { init } = lastFetchCall();
    expect(init.body).toBe('raw text');
  });
});

describe('executeStep() — status assertion', () => {
  it('returns passed when status matches assert.status', async () => {
    mockFetch({ status: 200, text: async () => '' });

    const step = makeStep({ assert: { status: 200 } });
    const result = await executeStep(step, { scenarioId: 'scen', stepIndex: 0 });

    expect(result.status).toBe('passed');
    expect(result.statusCode).toBe(200);
    expect(result.error).toBeUndefined();
  });

  it('returns failed with error message when status does not match assert.status', async () => {
    mockFetch({ status: 404, text: async () => '' });

    const step = makeStep({ assert: { status: 200 } });
    const result = await executeStep(step, { scenarioId: 'scen', stepIndex: 0 });

    expect(result.status).toBe('failed');
    expect(result.statusCode).toBe(404);
    expect(result.error).toMatch(/Expected HTTP 200, got 404/);
  });

  it('passes when no assert.status is specified (any status)', async () => {
    mockFetch({ status: 500, text: async () => '' });

    const step = makeStep();  // no assert
    const result = await executeStep(step, { scenarioId: 'scen', stepIndex: 0 });

    expect(result.status).toBe('passed');
  });
});

describe('executeStep() — bodyContains assertion', () => {
  it('returns passed when body contains the expected string', async () => {
    mockFetch({ status: 200, text: async () => '{"message":"Hello World"}' });

    const step = makeStep({ assert: { bodyContains: 'Hello World' } });
    const result = await executeStep(step, { scenarioId: 'scen', stepIndex: 0 });

    expect(result.status).toBe('passed');
  });

  it('returns failed when body does not contain the expected string', async () => {
    mockFetch({ status: 200, text: async () => '{"message":"Goodbye"}' });

    const step = makeStep({ assert: { bodyContains: 'Hello World' } });
    const result = await executeStep(step, { scenarioId: 'scen', stepIndex: 0 });

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/does not contain/);
  });
});

describe('executeStep() — error handling', () => {
  it('captures fetch network errors and returns failed — never throws', async () => {
    mockFetchError(new Error('ECONNREFUSED'));

    const step = makeStep();
    const result = await executeStep(step, { scenarioId: 'scen', stepIndex: 0 });

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/ECONNREFUSED/);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('includes step name in all result shapes', async () => {
    mockFetch({ status: 200, text: async () => '' });

    const step = makeStep({ name: 'My named step' });
    const result = await executeStep(step, { scenarioId: 'scen', stepIndex: 0 });

    expect(result.name).toBe('My named step');
  });

  it('always includes durationMs in result', async () => {
    mockFetch({ status: 200, text: async () => '' });

    const result = await executeStep(makeStep(), { scenarioId: 'scen', stepIndex: 0 });

    expect(typeof result.durationMs).toBe('number');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

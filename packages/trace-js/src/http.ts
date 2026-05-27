/**
 * T1.5 — Outbound HTTP tracking
 *
 * Three tracking mechanisms, used together or independently:
 *
 *  1. `undici` diagnostics_channel subscriber — observation-only, no mutation.
 *     Emits `external_http_call` events for any undici/fetch request.
 *
 *  2. `globalThis.fetch` patch — wraps fetch to inject a correlation header
 *     AND emit an event. Overrides undici's channel for fetch specifically.
 *
 *  3. `tracedAxios(instance)` — attaches request + response interceptors
 *     to any axios instance.
 *
 * All three write into the current AsyncLocalStorage context.
 */
import { createEventId } from '@tracegraph/trace-core';
import { SCHEMA_VERSIONS } from '@tracegraph/shared-types';
import type { TraceEvent } from '@tracegraph/shared-types';
import { ChildEventWriter } from './child-writer';
import { writeEvent, currentParentEventId } from './context';
import { sanitize } from '@tracegraph/trace-sanitizer';

// ─── undici diagnostics_channel ──────────────────────────────────────────────

let undiciSubscribed = false;

/**
 * Subscribes to undici's diagnostics_channel for observation-only HTTP tracking.
 * Safe to call multiple times (idempotent).
 */
export function subscribeUndiciChannel(): void {
  if (undiciSubscribed) return;
  undiciSubscribed = true;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const dc = require('diagnostics_channel') as typeof import('diagnostics_channel');

    // undici emits on these channels
    const requestChannel = dc.channel('undici:request:create');

    if (!requestChannel.hasSubscribers) {
      requestChannel.subscribe((message: unknown) => {
        const writer = ChildEventWriter.get();
        if (!writer) return;

        const msg = message as {
          request?: { method?: string; origin?: string; path?: string };
        };
        const req = msg.request;
        if (!req) return;

        const event: TraceEvent = {
          schemaVersion: SCHEMA_VERSIONS.event,
          eventId:       createEventId(),
          traceId:       writer.traceId,
          parentEventId: currentParentEventId(),
          type:          'external_http_call',
          language:      'javascript',
          name:          `${req.method ?? 'GET'} ${req.origin ?? ''}${req.path ?? ''}`,
          startTime:     Date.now(),
          metadata: {
            method: req.method,
            url:    `${req.origin ?? ''}${req.path ?? ''}`,
            via:    'undici:diagnostics_channel',
          },
        };
        writeEvent(event);
      });
    }
  } catch {
    // diagnostics_channel not available or undici not installed — skip
  }
}

// ─── globalThis.fetch patch ───────────────────────────────────────────────────

let fetchPatched = false;

/**
 * Wraps `globalThis.fetch` to inject the TraceGraph correlation header
 * and emit `external_http_call` events.
 *
 * Safe to call multiple times (idempotent).
 */
export function patchGlobalFetch(): void {
  if (fetchPatched) return;
  if (typeof globalThis.fetch !== 'function') return;
  fetchPatched = true;

  const originalFetch = globalThis.fetch.bind(globalThis);

  (globalThis as Record<string, unknown>).fetch = async function tracedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const writer = ChildEventWriter.get();
    if (!writer) return originalFetch(input, init);

    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : (input as Request).url;

    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');

    const eventId   = createEventId();
    const parentId  = currentParentEventId();
    const startTime = Date.now();

    // Inject correlation header
    const headers = new Headers(
      init?.headers as HeadersInit ?? (input instanceof Request ? input.headers : {}),
    );
    headers.set('x-tracegraph-correlation-id', `${writer.traceId}:${eventId}`);

    writeEvent({
      schemaVersion: SCHEMA_VERSIONS.event,
      eventId,
      traceId:       writer.traceId,
      parentEventId: parentId,
      type:          'external_http_call',
      language:      'javascript',
      name:          `${method} ${url}`,
      startTime,
      metadata:      { method, url, via: 'fetch' },
    });

    try {
      const response = await originalFetch(input, { ...init, headers });
      const endTime = Date.now();
      // Update the event with response info by appending a companion event
      writeEvent({
        schemaVersion: SCHEMA_VERSIONS.event,
        eventId:       createEventId(),
        traceId:       writer.traceId,
        parentEventId: eventId,
        type:          'http_response',
        language:      'javascript',
        name:          `${method} ${url} → ${response.status}`,
        startTime,
        endTime,
        durationMs:    endTime - startTime,
        output: sanitize({ statusCode: response.status }) as TraceEvent['output'],
      });
      return response;
    } catch (err) {
      const endTime = Date.now();
      const e = err instanceof Error ? err : new Error(String(err));
      writeEvent({
        schemaVersion: SCHEMA_VERSIONS.event,
        eventId:       createEventId(),
        traceId:       writer.traceId,
        parentEventId: eventId,
        type:          'error',
        language:      'javascript',
        name:          `${method} ${url} → error`,
        startTime,
        endTime,
        durationMs:    endTime - startTime,
        error: { type: e.constructor?.name ?? 'Error', message: e.message, stack: e.stack },
      });
      throw err;
    }
  };
}

// ─── axios interceptors ───────────────────────────────────────────────────────

/** Minimal axios instance shape (avoid hard dep on axios types). */
interface AxiosInstance {
  interceptors: {
    request:  { use(fn: (cfg: unknown) => unknown): number };
    response: { use(onFulfilled: (r: unknown) => unknown, onRejected: (e: unknown) => unknown): number };
  };
}

interface AxiosConfig {
  method?: string;
  url?: string;
  baseURL?: string;
  headers?: Record<string, string>;
  _traceEventId?: string;
  _traceStartTime?: number;
}

interface AxiosResponse {
  status: number;
  config: AxiosConfig;
}

/**
 * Attaches TraceGraph interceptors to an axios instance.
 * Returns the same instance so calls can be chained.
 */
export function tracedAxios<T extends AxiosInstance>(instance: T): T {
  instance.interceptors.request.use((config: unknown) => {
    const cfg = config as AxiosConfig;
    const writer = ChildEventWriter.get();
    if (!writer) return cfg;

    const eventId   = createEventId();
    const startTime = Date.now();
    const url       = cfg.url ? (cfg.baseURL ? cfg.baseURL + cfg.url : cfg.url) : 'unknown';
    const method    = (cfg.method ?? 'GET').toUpperCase();

    cfg._traceEventId   = eventId;
    cfg._traceStartTime = startTime;

    // Inject correlation header
    cfg.headers = cfg.headers ?? {};
    cfg.headers['x-tracegraph-correlation-id'] = `${writer.traceId}:${eventId}`;

    writeEvent({
      schemaVersion: SCHEMA_VERSIONS.event,
      eventId,
      traceId:       writer.traceId,
      parentEventId: currentParentEventId(),
      type:          'external_http_call',
      language:      'javascript',
      name:          `${method} ${url}`,
      startTime,
      metadata:      { method, url, via: 'axios' },
    });

    return cfg;
  });

  instance.interceptors.response.use(
    (response: unknown) => {
      const res = response as AxiosResponse;
      const writer = ChildEventWriter.get();
      if (writer && res.config._traceEventId) {
        const endTime   = Date.now();
        const startTime = res.config._traceStartTime ?? endTime;
        writeEvent({
          schemaVersion: SCHEMA_VERSIONS.event,
          eventId:       createEventId(),
          traceId:       writer.traceId,
          parentEventId: res.config._traceEventId,
          type:          'http_response',
          language:      'javascript',
          name:          `${(res.config.method ?? 'GET').toUpperCase()} ${res.config.url ?? ''} → ${res.status}`,
          startTime,
          endTime,
          durationMs:    endTime - startTime,
          output: sanitize({ statusCode: res.status }) as TraceEvent['output'],
        });
      }
      return res;
    },
    (error: unknown) => {
      const writer = ChildEventWriter.get();
      const e = error instanceof Error ? error : new Error(String(error));
      const cfg = (error as { config?: AxiosConfig }).config ?? {};
      if (writer && cfg._traceEventId) {
        const endTime   = Date.now();
        const startTime = cfg._traceStartTime ?? endTime;
        writeEvent({
          schemaVersion: SCHEMA_VERSIONS.event,
          eventId:       createEventId(),
          traceId:       writer.traceId,
          parentEventId: cfg._traceEventId,
          type:          'error',
          language:      'javascript',
          name:          `${(cfg.method ?? 'GET').toUpperCase()} ${cfg.url ?? ''} → error`,
          startTime,
          endTime,
          durationMs:    endTime - startTime,
          error: { type: e.constructor?.name ?? 'Error', message: e.message, stack: e.stack },
        });
      }
      return Promise.reject(error);
    },
  );

  return instance;
}

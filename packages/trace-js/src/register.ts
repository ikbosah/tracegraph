/**
 * T1.4 — ESM register hook
 *
 * Load via: NODE_OPTIONS='--import @tracegraph/trace-js/register'
 *
 * This module runs once at process startup (import time) and:
 *  1. Verifies TRACEGRAPH_ENABLED=1 is set.
 *  2. Verifies the ChildEventWriter can initialise (env vars present).
 *  3. Patches globalThis.fetch for outbound HTTP correlation.
 *  4. Subscribes to undici diagnostics_channel.
 *  5. Captures console.error → log events.
 *  6. Captures uncaughtException → error events.
 *  7. Writes a capture-level file on process exit so the CLI can read it.
 *
 * Safe to import multiple times — all operations are idempotent.
 */
import fs from 'fs';
import path from 'path';
import { SCHEMA_VERSIONS } from '@tracegraph/shared-types';
import { createEventId } from '@tracegraph/trace-core';
import { ChildEventWriter } from './child-writer';
import { writeEvent, currentParentEventId } from './context';
import { patchGlobalFetch, subscribeUndiciChannel, patchHttpRequest } from './http';
import { TRACEGRAPH_ENV } from './env';

let initialised = false;

export function init(): void {
  if (initialised) return;
  initialised = true;

  const writer = ChildEventWriter.get();
  if (!writer) {
    // Instrumentation disabled or env vars missing — transparent no-op
    return;
  }

  // ── Patch globalThis.fetch ────────────────────────────────────────────────
  patchGlobalFetch();

  // ── Subscribe to undici diagnostics_channel ───────────────────────────────
  subscribeUndiciChannel();

  // ── Patch http.request / https.request ────────────────────────────────────
  patchHttpRequest();

  // ── Capture console.error → log event ────────────────────────────────────
  const originalConsoleError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    originalConsoleError(...args);
    const w = ChildEventWriter.get();
    if (w) {
      writeEvent({
        schemaVersion: SCHEMA_VERSIONS.event,
        eventId:       createEventId(),
        traceId:       w.traceId,
        parentEventId: currentParentEventId(),
        type:          'log',
        language:      'javascript',
        name:          'console.error',
        startTime:     Date.now(),
        metadata:      { level: 'error', message: args.map(String).join(' ') },
      });
    }
  };

  // ── Capture uncaughtException → error event ───────────────────────────────
  process.on('uncaughtException', (err: Error) => {
    const w = ChildEventWriter.get();
    if (w) {
      writeEvent({
        schemaVersion: SCHEMA_VERSIONS.event,
        eventId:       createEventId(),
        traceId:       w.traceId,
        parentEventId: currentParentEventId(),
        type:          'error',
        language:      'javascript',
        name:          'uncaughtException',
        startTime:     Date.now(),
        error: {
          type:    err.constructor?.name ?? 'Error',
          message: err.message,
          stack:   err.stack,
        },
      });
    }
    // If we're the only uncaughtException listener (production), exit with a
    // non-zero code so the process terminates as expected.
    // If other listeners are registered (Mocha, Jest, Vitest, etc.), let them
    // handle the process lifecycle — re-throwing here would crash with our
    // stack frame on top before the test runner can record the failure.
    if (process.listenerCount('uncaughtException') <= 1) {
      process.exit(1);
    }
  });

  // ── Flush buffered events before exit ────────────────────────────────────
  // The ChildEventWriter buffers events for performance.  We must flush
  // synchronously here so no events are lost when the process exits.
  process.on('exit', () => {
    ChildEventWriter.get()?._flushSync();
  });

  // ── Write capture-level file on exit ─────────────────────────────────────
  process.on('exit', () => {
    const runDir = process.env[TRACEGRAPH_ENV.RUN_DIR];
    if (!runDir) return;
    try {
      fs.writeFileSync(
        path.join(runDir, 'capture-level.json'),
        JSON.stringify({
          overall: 1,
          label:   'Framework-level tracing',
          adapters: {
            express: {
              level:          1,
              mode:           'middleware',
              captured:       ['http_request', 'http_response', 'error'],
              notCaptured:    ['db_query', 'cache_operation'],
              recommendation: 'Add traceFunction() wrappers to capture business logic calls',
            },
          },
        }),
        'utf8',
      );
    } catch {
      // Best-effort
    }
  });
}

// Auto-initialise when --imported as an ESM hook
init();

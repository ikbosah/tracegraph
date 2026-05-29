/**
 * M6 T6.2 — HTTP step executor
 *
 * Executes a single scenario step: makes the HTTP request, injects the
 * TraceGraph correlation headers, and validates any assertions.
 *
 * Correlation headers injected automatically on every request:
 *   x-tracegraph-scenario-id    — links all steps in the same scenario run
 *   x-tracegraph-correlation-id — unique per step; used by the bundle linker
 *                                   to join outbound calls to inbound traces
 */
import type { ScenarioStep, ScenarioStepResult } from '@tracegraph/shared-types';

// ─── Public API ───────────────────────────────────────────────────────────────

export type StepContext = {
  scenarioId: string;
  stepIndex:  number;
};

/**
 * Execute a single scenario step, returning a structured result.
 * Never throws — errors are captured in `result.error`.
 */
export async function executeStep(
  step: ScenarioStep,
  ctx:  StepContext,
): Promise<ScenarioStepResult> {
  const startTime     = Date.now();
  const correlationId = `${ctx.scenarioId}_step${ctx.stepIndex}`;

  try {
    const headers: Record<string, string> = {
      'content-type':                     'application/json',
      'x-tracegraph-scenario-id':         ctx.scenarioId,
      'x-tracegraph-correlation-id':      correlationId,
      ...normaliseHeaders(step.http.headers ?? {}),
    };

    const requestInit: RequestInit = {
      method:  step.http.method.toUpperCase(),
      headers,
      signal:  AbortSignal.timeout(step.http.timeoutMs ?? 30_000),
    };

    const body = step.http.body;
    if (body !== undefined && !['GET', 'HEAD'].includes(requestInit.method as string)) {
      requestInit.body = typeof body === 'string' ? body : JSON.stringify(body);
    }

    const res = await fetch(step.http.url, requestInit);
    const durationMs = Date.now() - startTime;

    // ── Assertions ────────────────────────────────────────────────────────────
    if (step.assert?.status !== undefined && res.status !== step.assert.status) {
      return {
        name:       step.name,
        status:     'failed',
        statusCode: res.status,
        durationMs,
        error: `Expected HTTP ${step.assert.status}, got ${res.status}`,
      };
    }

    if (step.assert?.bodyContains !== undefined) {
      const text = await res.text();
      if (!text.includes(step.assert.bodyContains)) {
        return {
          name:       step.name,
          status:     'failed',
          statusCode: res.status,
          durationMs,
          error: `Response body does not contain "${step.assert.bodyContains}"`,
        };
      }
    }

    return {
      name:       step.name,
      status:     'passed',
      statusCode: res.status,
      durationMs,
    };
  } catch (err: unknown) {
    return {
      name:      step.name,
      status:    'failed',
      durationMs: Date.now() - startTime,
      error:     String(err),
    };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Normalise header keys to lowercase so user-supplied headers don't collide. */
function normaliseHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k.toLowerCase()] = v;
  }
  return out;
}

import type { CliEventEnvelope, CliEventType, CaptureLevel } from '@tracegraph/shared-types';

/**
 * Emit a single CLI protocol event to stdout as a JSON Line.
 *
 * Rules (from ARCHITECTURE.md §6):
 *  - stdout is a LOW-VOLUME control channel only.
 *  - Raw trace events are NEVER emitted here by default.
 *  - Every line is a valid JSON object with `protocol: "tracegraph.cli.v1"`.
 *  - VS Code and CI parse these lines; do not add prose or ANSI colours to stdout.
 *
 * Progress and debug text goes to stderr.
 */
export function emit(
  fields: Omit<CliEventEnvelope, 'protocol' | 'timestamp'> & {
    timestamp?: number;
    captureLevel?: Pick<CaptureLevel, 'overall' | 'label'>;
  },
): void {
  const envelope: CliEventEnvelope = {
    protocol: 'tracegraph.cli.v1',
    timestamp: Date.now(),
    ...fields,
  };
  process.stdout.write(JSON.stringify(envelope) + '\n');
}

/**
 * Emit a structured error and write a human-readable message to stderr.
 * Does NOT call process.exit — callers decide the exit code.
 */
export function emitError(runId: string, message: string, detail?: unknown): void {
  process.stderr.write(`[tracegraph] Error: ${message}\n`);
  if (detail) {
    process.stderr.write(`[tracegraph] Detail: ${String(detail)}\n`);
  }
  emit({
    type: 'error',
    runId,
    payload: { message, detail: String(detail ?? '') },
  });
}

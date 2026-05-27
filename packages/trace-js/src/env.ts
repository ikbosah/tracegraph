/**
 * Environment variable keys used to communicate between the CLI host process
 * and the instrumented child process.
 *
 * The CLI sets these before spawning the child; the trace-js adapters read them.
 */
export const TRACEGRAPH_ENV = {
  /** Set to '1' to activate instrumentation in the child process. */
  ENABLED:       'TRACEGRAPH_ENABLED',
  /** Absolute path to the run directory (where .events.jsonl.tmp lives). */
  RUN_DIR:       'TRACEGRAPH_RUN_DIR',
  /** The trace ID for the current run. */
  TRACE_ID:      'TRACEGRAPH_TRACE_ID',
  /** The run ID for the current run. */
  RUN_ID:        'TRACEGRAPH_RUN_ID',
  /** The session ID for the current run. */
  SESSION_ID:    'TRACEGRAPH_SESSION_ID',
  /** Event ID of the trace_start event (used as parent for top-level events). */
  ROOT_EVENT_ID: 'TRACEGRAPH_ROOT_EVENT_ID',
} as const;

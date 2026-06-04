/**
 * Error Path view — shows every error event with its full causal chain.
 *
 * Design:
 *  - All blocks collapsed by default; click to expand.
 *  - Heading: status badge (coloured by 4xx/5xx) + RFC phrase + endpoint chip
 *    + request duration + test chip + repeat count.
 *  - Expanded view shows each chain step with input/output and a raw-event
 *    escape hatch.
 *  - HTTP errors with no stack show the RFC description + common causes list
 *    instead of a blank error box.
 *  - Temporal test/HTTP context scan for traces where test events live in
 *    separate per-test trace files (Laravel / PHPUnit isolation).
 */

import React, { useMemo, useState } from 'react';
import type { TraceSession, TraceEvent } from '@tracegraph/shared-types';

// ─── HTTP Status Intelligence ─────────────────────────────────────────────────

type HttpStatusInfo = {
  phrase:      string;
  /** Shown as a paragraph in the expanded error box. */
  description: string;
  /** Bullet points for the "Common causes" list in the expanded error box. */
  causes:      string[];
  /** Controls badge colour: amber for client errors, red for server errors. */
  category:    '4xx' | '5xx';
};

const HTTP_STATUS: Record<number, HttpStatusInfo> = {
  // ── 4xx Client Errors ───────────────────────────────────────────────────────
  400: {
    phrase:      'Bad Request',
    description: 'The server could not understand the request due to invalid syntax or malformed parameters.',
    causes:      ['Malformed JSON body', 'Missing required fields', 'Invalid query parameters'],
    category:    '4xx',
  },
  401: {
    phrase:      'Unauthorized',
    description: 'Authentication is required. The provided credentials are missing, invalid, or expired.',
    causes:      ['Missing or expired token / session', 'Invalid API key', 'CSRF token mismatch'],
    category:    '4xx',
  },
  403: {
    phrase:      'Forbidden',
    description: 'The server understood the request but the authenticated user does not have permission to perform this action.',
    causes:      ['Insufficient role or permissions', 'Authorization policy rejected the action', 'Resource belongs to a different user'],
    category:    '4xx',
  },
  404: {
    phrase:      'Not Found',
    description: 'The requested resource could not be found. The URL may be wrong or the record may not exist.',
    causes:      ['Wrong URL or route pattern', 'Dynamic segment has no matching record in the database', 'Resource was deleted'],
    category:    '4xx',
  },
  405: {
    phrase:      'Method Not Allowed',
    description: 'The HTTP method used (GET, POST, PUT, …) is not supported for this endpoint.',
    causes:      ['Using POST on a GET-only route', 'Missing route registration for this HTTP verb', 'Typo in method name'],
    category:    '4xx',
  },
  408: {
    phrase:      'Request Timeout',
    description: 'The server timed out waiting for the client to finish sending the request.',
    causes:      ['Slow or incomplete file upload', 'Client disconnected mid-request'],
    category:    '4xx',
  },
  409: {
    phrase:      'Conflict',
    description: 'The request could not be processed because of a conflict with the current state of the resource.',
    causes:      ['Duplicate unique key violation', 'Concurrent modification detected', 'State machine transition not allowed from current state'],
    category:    '4xx',
  },
  410: {
    phrase:      'Gone',
    description: 'The resource has been permanently removed and is no longer available.',
    causes:      ['Hard-deleted record (no soft-delete)', 'Deprecated or retired API endpoint'],
    category:    '4xx',
  },
  413: {
    phrase:      'Payload Too Large',
    description: 'The request body exceeds the maximum size configured on the server.',
    causes:      ['File upload too large', 'JSON body exceeds server body-size limit', 'Web server (nginx/apache) upload_max_filesize setting'],
    category:    '4xx',
  },
  415: {
    phrase:      'Unsupported Media Type',
    description: 'The server does not support the media type specified in the Content-Type header.',
    causes:      ['Missing Content-Type header', 'Sending JSON when multipart/form-data is expected', 'Wrong encoding'],
    category:    '4xx',
  },
  422: {
    phrase:      'Unprocessable Entity',
    description: 'The request body is syntactically valid but contains semantic or validation errors.',
    causes:      ['Validation rule failed (required field, format, range…)', 'Business constraint violated', 'Database schema constraint error'],
    category:    '4xx',
  },
  423: {
    phrase:      'Locked',
    description: 'The resource is locked and cannot be modified right now.',
    causes:      ['Pessimistic lock held by another request', 'Distributed lock (Redis/DB) not released'],
    category:    '4xx',
  },
  429: {
    phrase:      'Too Many Requests',
    description: 'The client has been rate-limited — too many requests in a short time window.',
    causes:      ['Rate limiter threshold exceeded', 'Retry storm from an upstream caller', 'Missing exponential back-off on the client side'],
    category:    '4xx',
  },
  // ── 5xx Server Errors ───────────────────────────────────────────────────────
  500: {
    phrase:      'Internal Server Error',
    description: 'The server encountered an unexpected condition. This almost always means an unhandled exception or programming error reached the framework.',
    causes:      ['Unhandled exception propagated to the top-level handler', 'Null / undefined access at runtime', 'Misconfigured service dependency (DB, cache, queue)', 'Divide-by-zero or type coercion error'],
    category:    '5xx',
  },
  501: {
    phrase:      'Not Implemented',
    description: 'The server does not support the functionality needed to fulfil this request.',
    causes:      ['Feature not yet implemented (stub returning 501)', 'Unsupported HTTP feature or extension'],
    category:    '5xx',
  },
  502: {
    phrase:      'Bad Gateway',
    description: 'The server, while acting as a gateway or proxy, received an invalid or incomplete response from an upstream service.',
    causes:      ['Upstream service crashed or restarting', 'Upstream returned malformed HTTP (missing status line, truncated body)', 'Network partition between services'],
    category:    '5xx',
  },
  503: {
    phrase:      'Service Unavailable',
    description: 'The server is temporarily unable to handle the request — usually because it is overloaded or down for maintenance.',
    causes:      ['Server overloaded (too many concurrent connections)', 'Application is in maintenance mode', 'Database connection pool exhausted', 'Service not yet ready after a cold start or deploy'],
    category:    '5xx',
  },
  504: {
    phrase:      'Gateway Timeout',
    description: 'The server, while acting as a gateway, did not receive a timely response from an upstream service.',
    causes:      ['Upstream service too slow (long-running query, heavy computation)', 'Third-party API timeout', 'Network latency spike between services'],
    category:    '5xx',
  },
  507: {
    phrase:      'Insufficient Storage',
    description: 'The server cannot store the data needed to complete the request.',
    causes:      ['Disk full on the server', 'Storage quota exceeded'],
    category:    '5xx',
  },
  508: {
    phrase:      'Loop Detected',
    description: 'The server detected an infinite loop while processing the request.',
    causes:      ['Circular redirect chain', 'Recursive service call without a termination condition'],
    category:    '5xx',
  },
};

/**
 * Tries to find an HTTP status code associated with this error event.
 * Checks the error message first ("HTTP 503"), then looks at
 * http_request / http_response output.status in the causal chain.
 */
function extractHttpStatus(
  terminal: TraceEvent,
  chain:    TraceEvent[],
): { code: number; info: HttpStatusInfo } | null {
  // 1. Parse "HTTP 503", "503 …", or bare "503" from error.message
  const msg = terminal.error?.message ?? '';
  const m   = msg.match(/\b([4-5]\d{2})\b/);
  let code: number | null = m ? parseInt(m[1]!, 10) : null;

  // 2. Scan chain for http_request / http_response with output.status
  if (code === null) {
    for (const e of chain) {
      if (e.type === 'http_request' || e.type === 'http_response') {
        const out = e.output as Record<string, unknown> | null | undefined;
        const raw = out?.['status'] ?? out?.['statusCode'];
        const n   = typeof raw === 'number' ? raw
                  : typeof raw === 'string' ? parseInt(raw, 10)
                  : NaN;
        if (!isNaN(n) && n >= 400) { code = n; break; }
      }
    }
  }

  if (code === null) return null;

  const known = HTTP_STATUS[code];
  if (known) return { code, info: known };

  // Synthesise a basic entry for unknown codes
  const category: '4xx' | '5xx' = code >= 500 ? '5xx' : '4xx';
  return {
    code,
    info: {
      phrase:      category === '5xx' ? 'Server Error' : 'Client Error',
      description: `HTTP ${code} — no additional description is available for this status code.`,
      causes:      [],
      category,
    },
  };
}

function formatDuration(ms: number): string {
  if (ms < 1)    return '<1ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ─── Types ────────────────────────────────────────────────────────────────────

type ErrorPath = {
  chain:       TraceEvent[];
  count:       number;
  testContext: TraceEvent | null;
  httpContext: TraceEvent | null;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const NOISE_TYPES = new Set(['trace_start', 'trace_end']);
const SHOW_LIMIT  = 10;

function buildErrorPaths(events: TraceEvent[]): ErrorPath[] {
  const byId = new Map<string, TraceEvent>(
    events.filter((e) => e.eventId).map((e) => [e.eventId, e]),
  );

  const testRuns = events
    .filter((e) => e.type === 'test_run' && e.startTime != null)
    .sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0));

  const httpRequests = events
    .filter((e) => e.type === 'http_request' && e.startTime != null)
    .sort((a, b) => (a.startTime ?? 0) - (b.startTime ?? 0));

  const errorEvents = events.filter(
    (e) => e.type === 'error' || e.error != null,
  );
  if (errorEvents.length === 0) return [];

  const rawChains = errorEvents.map((errorEvent) => {
    const chain: TraceEvent[] = [errorEvent];
    const seen  = new Set<string>([errorEvent.eventId]);
    let current = errorEvent;
    while (true) {
      const parentId = current.causalParentEventId ?? current.parentEventId;
      if (!parentId || seen.has(parentId)) break;
      const parent = byId.get(parentId);
      if (!parent) break;
      chain.unshift(parent);
      seen.add(parentId);
      current = parent;
    }
    const filtered   = chain.filter((e) => !NOISE_TYPES.has(e.type));
    const cleanChain = filtered.length > 0 ? filtered : chain;

    const errorTime = errorEvent.startTime ?? 0;

    // ── Test context ─────────────────────────────────────────────────────────
    let testContext: TraceEvent | null =
      cleanChain.find((e) => e.type === 'test_run') ?? null;

    if (!testContext) {
      for (const tr of testRuns) {
        const start = tr.startTime ?? 0;
        const end   = tr.endTime ?? Infinity;
        if (start <= errorTime && errorTime <= end) {
          testContext = tr;
          break;
        }
      }
    }

    if (!testContext && testRuns.length > 0) {
      for (let i = testRuns.length - 1; i >= 0; i--) {
        if ((testRuns[i]!.startTime ?? 0) <= errorTime) {
          testContext = testRuns[i]!;
          break;
        }
      }
    }

    // ── HTTP context ─────────────────────────────────────────────────────────
    const chainHasHttp = cleanChain.some((e) => e.type === 'http_request');
    let httpContext: TraceEvent | null = null;
    if (!chainHasHttp) {
      for (let i = httpRequests.length - 1; i >= 0; i--) {
        if ((httpRequests[i]!.startTime ?? 0) <= errorTime) {
          httpContext = httpRequests[i]!;
          break;
        }
      }
    }

    return { chain: cleanChain, testContext, httpContext };
  });

  function chainKey(
    chain:       TraceEvent[],
    testContext: TraceEvent | null,
  ): string {
    return [
      ...chain.map(
        (e) =>
          `${e.type}:${e.displayName ?? e.name}:${e.error?.type ?? ''}:${e.error?.message ?? ''}`,
      ),
      `test:${testContext?.name ?? ''}`,
    ].join('||');
  }

  const grouped = new Map<string, ErrorPath & { count: number }>();
  for (const { chain, testContext, httpContext } of rawChains) {
    const key = chainKey(chain, testContext);
    const ex  = grouped.get(key);
    if (ex) {
      ex.count += 1;
    } else {
      grouped.set(key, { chain, testContext, httpContext, count: 1 });
    }
  }

  return [...grouped.values()].sort((a, b) => a.count - b.count);
}

// ─── Component ────────────────────────────────────────────────────────────────

interface ErrorPathViewProps {
  trace:         TraceSession;
  onOpenSource?: (file: string, line: number) => void;
}

export function ErrorPathView({
  trace,
  onOpenSource,
}: ErrorPathViewProps): React.ReactElement {
  const paths = useMemo(() => buildErrorPaths(trace.events), [trace]);

  const [expandedSet, setExpandedSet] = useState<Set<number>>(() => new Set());
  const [showAll, setShowAll]         = useState(false);

  if (paths.length === 0) {
    return (
      <div className="error-path-empty">
        <div className="error-path-empty-icon">✓</div>
        <p>No errors found in this trace.</p>
      </div>
    );
  }

  const totalErrors  = paths.reduce((n, p) => n + p.count, 0);
  const uniqueErrors = paths.length;
  const displayed    = showAll ? paths : paths.slice(0, SHOW_LIMIT);

  const toggle = (idx: number): void => {
    setExpandedSet((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  return (
    <div className="error-path-container">

      {/* ── Summary bar ─────────────────────────────────────────────────── */}
      <div className="error-path-summary">
        <span className="error-path-summary-count">{totalErrors}</span>
        <span className="error-path-summary-label">
          {totalErrors === 1 ? 'error' : 'errors'}
          {uniqueErrors < totalErrors && (
            <span style={{ color: 'var(--text-muted)', marginLeft: 6 }}>
              ({uniqueErrors} unique{' '}
              {uniqueErrors === 1 ? 'pattern' : 'patterns'})
            </span>
          )}
        </span>
      </div>

      {/* ── Error blocks ────────────────────────────────────────────────── */}
      {displayed.map(({ chain, count, testContext, httpContext }, pi) => {
        const terminal   = chain[chain.length - 1]!;
        const errMsg     = terminal.error?.message ?? terminal.error?.type;
        const errType    = terminal.error?.type;
        const isExpanded = expandedSet.has(pi);

        // HTTP status intelligence — drives badge colour and phrase in heading
        const httpStatus = extractHttpStatus(terminal, chain);

        // Best endpoint: prefer http_request in chain, then httpContext
        const httpEvent = chain.find((e) => e.type === 'http_request') ?? httpContext;
        const endpoint  = httpEvent ? (httpEvent.displayName ?? httpEvent.name) : null;
        const testName  = testContext ? (testContext.displayName ?? testContext.name) : null;

        // Request duration (amber >1s, red >5s)
        const duration = httpEvent?.durationMs ?? null;
        const durationClass =
          duration == null        ? ''
          : duration > 5000       ? 'error-path-duration-slow'
          : duration > 1000       ? 'error-path-duration-warn'
          : '';

        return (
          <div key={pi} className="error-path-block">

            {/* ── Heading (clickable) ─────────────────────────────────── */}
            <button
              className="error-path-heading error-path-heading-btn"
              onClick={() => toggle(pi)}
              aria-expanded={isExpanded}
            >
              <div className="error-path-heading-left">
                <span className="error-path-number">
                  {uniqueErrors > 1 ? `Error #${pi + 1}` : 'Error'}
                </span>

                {/* HTTP errors: coloured status badge + RFC phrase */}
                {httpStatus ? (
                  <>
                    <span
                      className={`error-path-status-badge error-path-status-badge-${httpStatus.info.category}`}
                      title={`HTTP ${httpStatus.code} — ${httpStatus.info.phrase}`}
                    >
                      {httpStatus.code}
                    </span>
                    <span className="error-path-status-phrase">
                      {httpStatus.info.phrase}
                    </span>
                  </>
                ) : (
                  /* Non-HTTP exceptions: type badge + truncated message */
                  <>
                    {errType && (
                      <span className="error-path-errtype-badge">{errType}</span>
                    )}
                    {errMsg && errMsg !== errType && (
                      <span className="error-path-heading-msg">{errMsg}</span>
                    )}
                  </>
                )}
              </div>

              <div className="error-path-heading-right">
                {endpoint && (
                  <span
                    className="error-path-endpoint-chip"
                    title={endpoint}
                  >
                    {endpoint.length > 48
                      ? `${endpoint.slice(0, 48)}…`
                      : endpoint}
                  </span>
                )}

                {duration != null && (
                  <span
                    className={`error-path-duration-chip${durationClass ? ` ${durationClass}` : ''}`}
                    title="Request duration"
                  >
                    {formatDuration(duration)}
                  </span>
                )}

                {testName && (
                  <span
                    className="error-path-test-chip"
                    title={testName}
                  >
                    {testName.length > 36
                      ? `${testName.slice(0, 36)}…`
                      : testName}
                  </span>
                )}

                {count > 1 && (
                  <span className="error-path-repeat-badge">×{count}</span>
                )}

                <span className="error-path-chevron">
                  {isExpanded ? '▲' : '▼'}
                </span>
              </div>
            </button>

            {/* ── Expanded chain ──────────────────────────────────────── */}
            {isExpanded && (
              <div className="error-path-chain">

                {testContext && !chain.includes(testContext) && (
                  <>
                    <StepNode
                      event={testContext}
                      isError={false}
                      isSynthetic={true}
                      onOpenSource={onOpenSource}
                    />
                    <Connector label="test contained" />
                  </>
                )}

                {httpContext && !chain.includes(httpContext) && (
                  <>
                    <StepNode
                      event={httpContext}
                      isError={false}
                      isSynthetic={true}
                      onOpenSource={onOpenSource}
                    />
                    <Connector label="preceded by" />
                  </>
                )}

                {chain.map((e, ei) => {
                  const isError = e.type === 'error' || !!e.error;
                  return (
                    <React.Fragment key={e.eventId ?? ei}>
                      {ei > 0 && (
                        <Connector
                          label={e.causalParentEventId ? 'caused by' : 'called by'}
                        />
                      )}
                      <StepNode
                        event={e}
                        isError={isError}
                        onOpenSource={onOpenSource}
                      />
                    </React.Fragment>
                  );
                })}

                {chain.length === 1 && !httpContext && !testContext && (
                  <p className="error-path-no-context">
                    No ancestor chain available — the parent event was not
                    captured or belongs to a separate trace file (common when
                    test isolation mode writes test events to per-test traces).
                  </p>
                )}
              </div>
            )}
          </div>
        );
      })}

      {/* ── Show more ───────────────────────────────────────────────────── */}
      {!showAll && paths.length > SHOW_LIMIT && (
        <button
          className="error-path-show-more"
          onClick={() => setShowAll(true)}
        >
          Show {paths.length - SHOW_LIMIT} more{' '}
          {paths.length - SHOW_LIMIT === 1 ? 'pattern' : 'patterns'}
        </button>
      )}
    </div>
  );
}

// ─── Connector ────────────────────────────────────────────────────────────────

function Connector({ label }: { label: string }): React.ReactElement {
  return (
    <div className="error-path-connector">
      <span className="error-path-arrow">↓</span>
      <span className="error-path-causal-label">{label}</span>
    </div>
  );
}

// ─── StepNode ─────────────────────────────────────────────────────────────────

interface StepNodeProps {
  event:         TraceEvent;
  isError:       boolean;
  isSynthetic?:  boolean;
  onOpenSource?: (file: string, line: number) => void;
}

function StepNode({
  event,
  isError,
  isSynthetic = false,
  onOpenSource,
}: StepNodeProps): React.ReactElement {
  const [showInput,  setShowInput]  = useState(false);
  const [showOutput, setShowOutput] = useState(false);
  const [showRaw,    setShowRaw]    = useState(false);

  const hasLoc   = !!(event.file && event.line != null);
  const basename = event.file ? event.file.replace(/^.*[/\\]/, '') : null;
  const duration =
    event.durationMs != null
      ? event.durationMs < 1
        ? '<1ms'
        : `${Math.round(event.durationMs)}ms`
      : null;

  const hasInput  = event.input  != null;
  const hasOutput = event.output != null;
  const hasStack  = !!(event.error?.stack);

  // HTTP status info for the error box — parsed from error.message
  const httpStatus = isError ? extractHttpStatus(event, [event]) : null;

  return (
    <div
      className={[
        'error-path-step',
        isError     ? 'error-path-step-error'     : '',
        isSynthetic ? 'error-path-step-synthetic' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {/* ── Top row: type · name · duration · location ────────────────── */}
      <div className="error-path-step-inner">
        <span className="error-path-type-badge">
          {event.type.replace(/_/g, ' ')}
        </span>

        <span className="error-path-name">{event.displayName ?? event.name}</span>

        {duration && (
          <span className="error-path-duration">{duration}</span>
        )}

        {hasLoc && (
          <span className="error-path-loc">
            {basename}:{event.line}
            {onOpenSource && (
              <button
                className="open-source-btn"
                onClick={() => onOpenSource(event.file!, event.line!)}
                title={`Open ${event.file}:${event.line}`}
                aria-label="Open in editor"
              >
                ↗
              </button>
            )}
          </span>
        )}

        {isSynthetic && (
          <span className="error-path-synthetic-label">inferred</span>
        )}
      </div>

      {/* ── Error detail box ──────────────────────────────────────────── */}
      {isError && event.error && (
        <div className="error-path-error-box">
          <div className="error-path-error-header">
            {event.error.type && (
              <span className="error-path-error-type">{event.error.type}</span>
            )}
            {event.error.message && (
              <span className="error-path-error-msg">
                {/* For HTTP errors, show the RFC phrase next to the raw message */}
                {httpStatus
                  ? `${event.error.message} — ${httpStatus.info.phrase}`
                  : event.error.message}
              </span>
            )}
          </div>

          {hasStack ? (
            <pre className="error-path-error-stack">{event.error.stack}</pre>
          ) : httpStatus ? (
            /* HTTP error — show description + common causes */
            <div className="error-path-http-detail">
              <p className="error-path-http-desc">
                {httpStatus.info.description}
              </p>
              {httpStatus.info.causes.length > 0 && (
                <div className="error-path-causes">
                  <span className="error-path-causes-label">
                    Common causes
                  </span>
                  <ul className="error-path-causes-list">
                    {httpStatus.info.causes.map((cause) => (
                      <li key={cause}>{cause}</li>
                    ))}
                  </ul>
                </div>
              )}
              <p className="error-path-no-stack">
                No stack trace — HTTP-level error captured at framework
                level (Level&nbsp;1). Add{' '}
                <code>Tracegraph::trace()</code> wrappers or enable Xdebug
                for full call-stack detail.
              </p>
            </div>
          ) : (
            /* Generic error — no stack trace */
            <p className="error-path-no-stack">
              No stack trace — HTTP-level error captured at framework level
              (Level&nbsp;1). Add{' '}
              <code>Tracegraph::trace()</code> wrappers or enable Xdebug
              for full call-stack detail.
            </p>
          )}
        </div>
      )}

      {/* ── Input section (collapsible) ───────────────────────────────── */}
      {hasInput && (
        <div className="error-path-section">
          <button
            className="error-path-section-toggle"
            onClick={() => setShowInput((v) => !v)}
          >
            <span className="error-path-section-label">Input</span>
            <span className="error-path-section-chevron">
              {showInput ? '▲' : '▼'}
            </span>
          </button>
          {showInput && (
            <pre className="error-path-detail-json">
              {JSON.stringify(event.input, null, 2)}
            </pre>
          )}
        </div>
      )}

      {/* ── Output section (collapsible) ──────────────────────────────── */}
      {hasOutput && (
        <div className="error-path-section">
          <button
            className="error-path-section-toggle"
            onClick={() => setShowOutput((v) => !v)}
          >
            <span className="error-path-section-label">Output</span>
            <span className="error-path-section-chevron">
              {showOutput ? '▲' : '▼'}
            </span>
          </button>
          {showOutput && (
            <pre className="error-path-detail-json">
              {JSON.stringify(event.output, null, 2)}
            </pre>
          )}
        </div>
      )}

      {/* ── Raw event (collapsible, always available) ─────────────────── */}
      <div className="error-path-section error-path-section-raw">
        <button
          className="error-path-section-toggle"
          onClick={() => setShowRaw((v) => !v)}
        >
          <span className="error-path-section-label error-path-section-label-muted">
            Raw event
          </span>
          <span className="error-path-section-chevron">
            {showRaw ? '▲' : '▼'}
          </span>
        </button>
        {showRaw && (
          <pre className="error-path-detail-json">
            {JSON.stringify(event, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}

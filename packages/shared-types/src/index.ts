// =============================================================================
// TraceGraph — Canonical Type Definitions
// All architecture decisions governing these types are in ARCHITECTURE.md.
// =============================================================================

// ─── Schema versions ─────────────────────────────────────────────────────────

export const SCHEMA_VERSIONS = {
  trace:           'tracegraph.trace.v1',
  event:           'tracegraph.event.v1',
  baseline:        'tracegraph.baseline.v1',
  bundle:          'tracegraph.bundle.v1',
  report:          'tracegraph.report.v1',
  diff:            'tracegraph.diff.v1',
  suppression:     'tracegraph.suppressions.v1',
  findingApproval: 'tracegraph.finding-approvals.v1',
  scenario:        'tracegraph.scenario.v1',
  index:           'tracegraph.index.v1',
  coverage:        'tracegraph.coverage.v1',
} as const;

export type SchemaVersions = typeof SCHEMA_VERSIONS;

// ─── TraceEntrypoint ─────────────────────────────────────────────────────────

export type TraceEntrypoint =
  | { type: 'http_request';  method: string; path: string; handler?: string }
  | { type: 'test_case';     testName: string; testFile?: string }
  | { type: 'function';      functionName: string; file?: string; line?: number }
  | { type: 'cli_command';   command: string };

// ─── CaptureLevel ────────────────────────────────────────────────────────────

/**
 * Levels:
 *  0 = runner metadata only (zero config)
 *  1 = framework adapters (Express middleware, Laravel hooks)
 *  2 = manual traceFunction wrappers
 *  3 = CJS require hook auto-instrumentation
 *  4 = ESM --import hook (limited — cannot replace live bindings)
 *  5 = build-time transform (Vitest reporter, Babel/SWC plugin)
 */
export type CaptureLevelValue = 0 | 1 | 2 | 3 | 4 | 5;

export type AdapterCaptureInfo = {
  level: number;
  mode: string;
  captured: string[];
  notCaptured: string[];
  recommendation?: string;
};

export type CaptureLevel = {
  overall: CaptureLevelValue;
  label: string;
  adapters: Record<string, AdapterCaptureInfo>;
};

// ─── TraceEvent ──────────────────────────────────────────────────────────────

export type TraceEventType =
  | 'trace_start'
  | 'trace_end'
  | 'http_request'
  | 'http_response'
  | 'function_call'
  | 'method_call'
  | 'db_query'
  | 'external_http_call'
  | 'file_operation'
  | 'cache_operation'
  | 'queue_event'
  | 'log'
  | 'error'
  | 'branch'
  | 'return'
  | 'auth_check'
  | 'authorization_check'
  | 'rate_limit_check'
  | 'lock_acquire'
  | 'lock_release'
  | 'transaction_start'
  | 'transaction_commit'
  | 'transaction_rollback'
  // ── Test runner events (M3) ───────────────────────────────────────────────
  /** One per test file; parent = trace_start. */
  | 'test_file'
  /** One per describe() block; parent = test_file or enclosing test_suite. */
  | 'test_suite'
  /** One per it()/test() call; parent = nearest test_suite or test_file. */
  | 'test_run';

export type ConcurrencyType =
  | 'sequential'
  | 'parallel'
  | 'promise_all'
  | 'race'
  | 'background';

export type LanguageId = 'typescript' | 'javascript' | 'php';
export type FrameworkId = 'express' | 'nestjs' | 'nextjs' | 'fastify' | 'laravel' | 'symfony' | 'vitest' | 'jest' | 'xdebug' | 'plain';

/** Cross-trace event reference for causal links (e.g. HTTP request → dispatched job). */
export type EventRef = { traceId: string; eventId: string };

export type TraceError = {
  type: string;
  message: string;
  stack?: string;
};

export type TraceResource = {
  type: string;
  key: string;
  operation: string;
};

export type SanitizedValue = Record<string, unknown> | unknown[] | string | number | null;
export type SecurityMetadata  = Record<string, unknown>;
export type ReliabilityMetadata = Record<string, unknown>;

export type TraceEvent = {
  schemaVersion: 'tracegraph.event.v1';
  eventId: string;
  traceId: string;

  /** Structural parent: the containing call in the call stack. */
  parentEventId?: string | null;

  /**
   * Causal parent: the event that caused this one.
   * Same as parentEventId for synchronous calls; different for async/queue scenarios.
   */
  causalParentEventId?: string | null;

  /**
   * Cross-trace causal reference.
   * Used when a job's causal parent is an event in a different trace (e.g. HTTP → queue worker).
   */
  causalParentRef?: EventRef | null;

  /** Parallel execution grouping (Promise.all, concurrent requests). */
  asyncGroupId?: string;
  branchId?: string;
  concurrencyType?: ConcurrencyType;

  type: TraceEventType;
  language: LanguageId;
  name: string;
  displayName?: string;

  file?: string;
  line?: number;
  column?: number;
  className?: string;
  functionName?: string;
  moduleName?: string;
  framework?: FrameworkId;

  startTime: number;
  endTime?: number;
  durationMs?: number;

  input?: SanitizedValue;
  output?: SanitizedValue;
  error?: TraceError;
  resource?: TraceResource;

  security?: SecurityMetadata;
  reliability?: ReliabilityMetadata;

  tags?: string[];
  metadata?: Record<string, unknown>;
};

// ─── DetailStreams (Xdebug enrichment) ───────────────────────────────────────

export type DetailStreams = {
  xdebug?: {
    events: TraceEvent[];
    /** Map from semantic event ID → attached Xdebug event IDs. */
    attachedTo: Record<string, string[]>;
  };
};

// ─── TraceSession ─────────────────────────────────────────────────────────────

export type TraceSessionStatus = 'running' | 'passed' | 'failed' | 'error';

export type TraceSession = {
  schemaVersion: 'tracegraph.trace.v1';
  traceId: string;
  sessionId: string;
  runId: string;
  scenarioId?: string;
  projectId?: string;
  workspaceRoot: string;
  language: LanguageId;
  framework?: string;
  entrypoint: TraceEntrypoint;
  startedAt: number;
  endedAt?: number;
  status: TraceSessionStatus;
  captureLevel: CaptureLevel;
  events: TraceEvent[];
  detailStreams?: DetailStreams;
  metadata?: Record<string, unknown>;
};

// ─── Trace index ──────────────────────────────────────────────────────────────

export type TraceIndexEntry = {
  traceId: string;
  runId: string;
  file: string;           // relative to workspaceRoot
  status: TraceSessionStatus;
  createdAt: number;
  entrypoint: TraceEntrypoint;
};

export type TraceIndex = {
  schemaVersion: 'tracegraph.index.v1';
  traces: TraceIndexEntry[];
};

// ─── TraceBundle (multi-language) ────────────────────────────────────────────

export type BundleLink = {
  source: EventRef;
  target: EventRef;
  type: 'causes' | 'correlates' | 'spawns';
  correlationId: string;
};

export type TraceBundle = {
  schemaVersion: 'tracegraph.bundle.v1';
  bundleId: string;
  scenarioId: string;
  createdAt: number;
  traces: Array<{
    language: LanguageId;
    traceId: string;
    file: string;
  }>;
  links: BundleLink[];
};

// ─── CLI stdout protocol ──────────────────────────────────────────────────────

export type CliEventType =
  | 'run.started'
  | 'run.progress'
  | 'run.completed'
  | 'trace.started'
  | 'trace.progress'
  | 'trace.completed'
  | 'finding'
  | 'report.created'
  | 'approval.required'
  | 'error';

export type CliEventEnvelope = {
  protocol: 'tracegraph.cli.v1';
  type: CliEventType;
  runId: string;
  traceId?: string;
  timestamp: number;
  captureLevel?: Pick<CaptureLevel, 'overall' | 'label'>;
  payload?: Record<string, unknown>;
};

// ─── Semantic signature (baseline identity) ──────────────────────────────────

export type EventRole =
  | 'validation'
  | 'authorization'
  | 'business_logic'
  | 'db'
  | 'external_call';

export type SemanticSignature = {
  eventType: string;
  language: LanguageId;
  framework?: string;
  className?: string;
  methodName?: string;
  functionName?: string;
  moduleName?: string;
  routeMethod?: string;
  routePathPattern?: string;
  resourceType?: string;
  resourceKey?: string;
  resourceOperation?: 'read' | 'write' | 'update' | 'delete';
  role?: EventRole;
};

// ─── JSON shape (response shape capture) ─────────────────────────────────────

export type JsonShape = {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null' | 'unknown';
  properties?: Record<string, JsonShape>;
  items?: JsonShape;
};

// ─── CompactBaseline ──────────────────────────────────────────────────────────

export type CompactBaseline = {
  schemaVersion: 'tracegraph.baseline.v1';
  baselineId: string;
  testId: string;
  entrypoint: TraceEntrypoint;
  approvedAt: number;
  approvedBy: string;
  reason: string;
  captureLevel: number;
  events: Array<{
    signature: SemanticSignature;
    role: string;
    count: number;
    critical?: boolean;
  }>;
  resources: Array<{
    type: string;
    key: string;
    operation: string;
    count: number;
  }>;
  responseShape: JsonShape;
};

// ─── Finding ──────────────────────────────────────────────────────────────────

export type FindingSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export type FindingCategory =
  | 'behavior_change'
  | 'race_condition'
  | 'rate_limit'
  | 'idempotency'
  | 'retry_storm'
  | 'security_authentication'
  | 'security_authorization'
  | 'security_sensitive_data'
  | 'security_injection'
  | 'security_mass_assignment'
  | 'performance'
  | 'data_integrity'
  | 'tracegraph_policy_change';

export type Finding = {
  id: string;
  /** Stable hash of (ruleId + semantic target + risk resource/action) — never includes file path. */
  fingerprint: string;
  ruleId: string;
  severity: FindingSeverity;
  category: FindingCategory;
  title: string;
  description: string;
  evidence: Array<{
    traceId: string;
    eventIds: string[];
    file?: string;
    line?: number;
  }>;
  recommendation?: string;
};

export type FindingFingerprintInput = {
  ruleId: string;
  semanticTarget: {
    routeMethod?: string;
    routePathPattern?: string;
    resourceType?: string;
    resourceKey?: string;
    resourceOperation?: 'read' | 'write' | 'update' | 'delete';
    className?: string;
    methodName?: string;
    functionName?: string;
    role?: EventRole;
  };
  findingKind: string;
};

// ─── Suppression ──────────────────────────────────────────────────────────────

export type Suppression = {
  id: string;
  ruleId: string;
  semanticTarget: Partial<SemanticSignature>;
  requiresEvidence?: Array<{ type: string; name: string }>;
  reason: string;
  expiresAt: string;
  approvedBy: string;
  createdAt: string;
};

export type SuppressionsFile = {
  schemaVersion: 'tracegraph.suppressions.v1';
  suppressions: Suppression[];
};

// ─── Finding approval ─────────────────────────────────────────────────────────

export type FindingApproval = {
  findingFingerprint: string;
  ruleId: string;
  semanticTarget: Partial<SemanticSignature>;
  approvedBy: string;
  reason: string;
  expiresAt: string;
  createdAt: string;
};

export type FindingApprovalsFile = {
  schemaVersion: 'tracegraph.finding-approvals.v1';
  approvals: FindingApproval[];
};

// ─── BehaviorDiff ─────────────────────────────────────────────────────────────

export type SignatureChange = {
  signature:    SemanticSignature;
  identityHash: string;
  role:         EventRole;
  critical:     boolean;
  /** Present for added signatures (candidate eventId). */
  eventId?:     string;
  eventName?:   string;
};

export type ResourceChange = {
  type:           string;
  key:            string;
  operation:      string;
  baselineCount:  number;
  candidateCount: number;
};

export type ResponseShapeChange = {
  addedFields:   string[];
  removedFields: string[];
  typeChanges:   Array<{ field: string; from: string; to: string }>;
};

export type BehaviorDiff = {
  traceId:        string;
  baselineId:     string;
  addedSignatures:   SignatureChange[];
  removedSignatures: SignatureChange[];
  changedResources:  ResourceChange[];
  responseShapeChange?: ResponseShapeChange;
};

// ─── EvaluatedFinding ─────────────────────────────────────────────────────────

export type FindingStatus = 'open' | 'approved' | 'suppressed';

export type EvaluatedFinding = Finding & {
  status:        FindingStatus;
  suppressedBy?: string;
  approvedBy?:   string;
  approvedReason?: string;
};

// ─── TraceReport ──────────────────────────────────────────────────────────────

export type ReportSummary = {
  tracesCompared:       number;
  findingsBySeverity:   Record<FindingSeverity, number>;
  hasOpenCritical:      boolean;
  suppressionsModified: boolean;
};

export type TraceReport = {
  schemaVersion:        'tracegraph.report.v1';
  reportId:             string;
  createdAt:            number;
  baselineDir:          string;
  candidateFiles:       string[];
  diffs:                BehaviorDiff[];
  findings:             EvaluatedFinding[];
  summary:              ReportSummary;
};

// ─── Latest pointer (written by tracegraph run) ──────────────────────────────

/**
 * Written to `.tracegraph/latest.json` after every successful `tracegraph run`.
 * Provides a stable, cross-platform pointer to the most recent run's artifacts
 * without relying on symlinks (Windows-safe).
 */
export type LatestPointer = {
  /** The run ID of the most recent `tracegraph run` invocation. */
  latestRunId:    string;
  /** All trace IDs produced by the latest run (main + per-test). */
  latestTraceIds: string[];
  /** Report ID written by the most recent `tracegraph compare`, or null. */
  latestReportId: string | null;
  /** Unix epoch ms when this file was last written. */
  updatedAt:      number;
};

// ─── Scenario ─────────────────────────────────────────────────────────────────

/**
 * A TraceGraph scenario — a declarative definition of one or more servers to
 * start plus an ordered sequence of HTTP steps to execute against them.
 *
 * Stored in `.tracegraph/scenarios/<name>.scenario.json`.
 */
export type ScenarioDefinition = {
  schemaVersion: 'tracegraph.scenario.v1';
  scenarioId:    string;
  name:          string;
  description?:  string;
  servers?:      ScenarioServer[];
  steps:         ScenarioStep[];
  tags?:         string[];
};

/**
 * A server that the scenario runner will start and manage.
 * The process is spawned with `TRACEGRAPH_ENABLED=1` and related env vars so
 * that the server's instrumentation can write trace files automatically.
 */
export type ScenarioServer = {
  name:           string;
  /** Shell command to start the server (e.g. "node dist/server.js"). */
  command:        string;
  port:           number;
  env?:           Record<string, string>;
  /** Maximum milliseconds to wait for the server to pass its health check. Default 30000. */
  readyTimeoutMs?: number;
  healthCheck?: {
    /** URL path to poll (e.g. "/health"). Default "/health". */
    path:            string;
    method?:         string;
    /** Expected HTTP status code. Default 200. */
    expectedStatus?: number;
    /** Poll interval in milliseconds. Default 500. */
    intervalMs?:     number;
    /** Maximum number of poll attempts before giving up. Default 60. */
    maxAttempts?:    number;
  };
};

/** One HTTP step in a scenario. */
export type ScenarioStep = {
  name:         string;
  description?: string;
  http: {
    method:     string;
    url:        string;
    headers?:   Record<string, string>;
    body?:      unknown;
    /** Request timeout in milliseconds. Default 30000. */
    timeoutMs?: number;
  };
  assert?: {
    /** Expected HTTP status code. */
    status?:        number;
    /** String that must appear in the response body. */
    bodyContains?:  string;
  };
  /** Milliseconds to pause after this step before continuing. */
  delayMs?: number;
};

/** Result of a single scenario step execution. */
export type ScenarioStepResult = {
  name:        string;
  status:      'passed' | 'failed' | 'skipped';
  statusCode?: number;
  durationMs:  number;
  error?:      string;
};

/** Aggregate result of a full scenario run. */
export type ScenarioRunResult = {
  scenarioId:  string;
  runId:       string;
  bundleFile?: string;
  steps:       ScenarioStepResult[];
  passed:      boolean;
  durationMs:  number;
};

// ─── AI Change Coverage (M7A T7A.1) ──────────────────────────────────────────

/**
 * A function or method identified as changed by a git diff.
 * Either `functionName` (standalone) or `className`+`methodName` (class method) is set.
 */
export type ChangedFunction = {
  /** File path relative to workspace root (forward slashes). */
  file:          string;
  /** Standalone function name — mutually exclusive with className/methodName. */
  functionName?: string;
  /** Class that owns the method — set together with methodName. */
  className?:    string;
  /** Method name within the class — set together with className. */
  methodName?:   string;
  /** Line number within the new (post-diff) file where the declaration starts. */
  startLine:     number;
};

/**
 * A changed function that was matched by at least one runtime trace event.
 */
export type CoverageEntry = {
  changed:    ChangedFunction;
  coveredBy:  Array<{
    traceId:   string;
    eventId:   string;
    traceFile: string;
  }>;
};

/**
 * Output of the AI change coverage analysis.
 * Stored in `.tracegraph/reports/<id>.coverage.json`.
 */
export type ChangeCoverageReport = {
  schemaVersion: 'tracegraph.coverage.v1';
  reportId:      string;
  createdAt:     number;
  /** Git ref used as the diff base (e.g. "HEAD~1", "main"). */
  baseRef:       string;
  /** Git ref used as the diff head (e.g. "HEAD"). */
  headRef:       string;
  covered:       CoverageEntry[];
  uncovered:     ChangedFunction[];
  summary: {
    changedFunctions:  number;
    coveredCount:      number;
    uncoveredCount:    number;
    /** 0–100, integer. */
    coveragePercent:   number;
  };
};

// ─── Prompt Pack Builder (M7A T7A.3) ─────────────────────────────────────────

/** AI tool format that the pack targets. */
export type PromptPackFormat = 'cursor' | 'claude-code' | 'copilot' | 'mcp';

/**
 * A generated AI context pack for a specific tool format.
 */
export type PromptPack = {
  format:   PromptPackFormat;
  /** Rendered pack content (markdown, XML, or JSON). */
  content:  string;
  /** Conventional file name for the pack (e.g. ".cursor/tracegraph-context.md"). */
  fileName: string;
};

// ─── CLI exit codes ───────────────────────────────────────────────────────────

export const EXIT_CODES = {
  /** Wrapped command and compare both passed cleanly. */
  SUCCESS:                    0,
  /** Wrapped command (npm test, etc.) exited with non-zero. */
  COMMAND_FAILURE:            1,
  /** Bad arguments, missing file, or internal CLI error. */
  CLI_ERROR:                  2,
  /** Open findings at or above the severity threshold (--fail-on-critical). */
  FINDINGS_THRESHOLD:         3,
  /** Suppressions file was modified since the last approved baseline. */
  POLICY_REVIEW:              4,
  /** Trace or baseline schema version does not match the current CLI. */
  SCHEMA_MIGRATION:           5,
  /** Capture level is below the project-configured minimum requirement. */
  CAPTURE_LEVEL_INSUFFICIENT: 6,
} as const;

export type ExitCode = typeof EXIT_CODES[keyof typeof EXIT_CODES];

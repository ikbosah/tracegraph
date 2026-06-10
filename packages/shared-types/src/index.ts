// =============================================================================
// TraceGraph — Canonical Type Definitions
// All architecture decisions governing these types are in ARCHITECTURE.md.
// =============================================================================

// ─── Schema versions ─────────────────────────────────────────────────────────

export const SCHEMA_VERSIONS = {
  trace:                'tracegraph.trace.v1',
  event:                'tracegraph.event.v1',
  baseline:             'tracegraph.baseline.v1',
  bundle:               'tracegraph.bundle.v1',
  report:               'tracegraph.report.v1',
  diff:                 'tracegraph.diff.v1',
  suppression:          'tracegraph.suppressions.v1',
  findingApproval:      'tracegraph.finding-approvals.v1',
  scenario:             'tracegraph.scenario.v1',
  index:                'tracegraph.index.v1',
  coverage:             'tracegraph.coverage.v1',
  // G-series: Static Architecture Intelligence
  staticGraph:          'tracegraph.static-graph.v1',
  architectureBaseline: 'tracegraph.architecture-baseline.v1',
} as const;

export type SchemaVersions = typeof SCHEMA_VERSIONS;

// ─── TraceEntrypoint ─────────────────────────────────────────────────────────

export type TraceEntrypoint =
  | { type: 'http_request';  method: string; path: string; handler?: string }
  | { type: 'test_case';     testName: string; testFile?: string }
  | { type: 'function';      functionName: string; file?: string; line?: number }
  | { type: 'cli_command';   command: string }
  | { type: 'server';        host: string; port: number; startedAt: number };

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

  /**
   * G2: Static architecture metadata attached during post-run enrichment.
   * Never set at capture time — only written by the static-graph enricher.
   * Present only when a static graph exists and the event matched a static
   * node above minMatchConfidence.
   */
  static?: StaticNodeMeta;
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
  | 'external_call'
  /** G6: test_file / test_run events emitted by PHPUnit/Jest test reporters. */
  | 'test_artifact';

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
  | 'tracegraph_policy_change'
  // G-series: static architecture findings
  | 'architecture_risk'       // god node, blast radius, surprise edge
  | 'architecture_inferred'   // inferred missing auth / expected path violated
  // G6: evidence continuity — test/trace evidence expected but not observed
  | 'evidence_continuity'
  // G7: audit self-diagnostics — graph quality, capture level drop
  | 'audit_quality'
  ;

/** IMP-3.3: Remediation guidance attached to a Finding. */
export type RemediationSnippet = {
  /** Plain-English description of what to fix. */
  text:  string;
  /**
   * Per-framework code examples.
   * Keys match `TraceEvent.framework` values ('express', 'laravel', 'spring', 'fastapi', …).
   */
  code?: Partial<Record<string, string>>;
  /** Documentation URL. */
  docs?: string;
};

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
  /** IMP-3.3: Structured remediation guidance with per-framework code examples. */
  remediation?: RemediationSnippet;
  /**
   * IMP-3.2: Route context for scoped suppression matching.
   * Set when the finding is associated with a specific HTTP route ("GET /invoices").
   */
  route?: string;
  /**
   * IMP-3.2: Resource context for scoped suppression matching.
   * Set when the finding is associated with a specific DB table or resource.
   */
  resource?: string;

  // ── G-series fields (backwards-compatible — all optional) ─────────────────

  /**
   * G-series: how confident TraceGraph is that this finding is correct.
   * 1.00 = runtime baseline comparison (certain).
   * < 1.00 = static or inferred evidence.
   * Omitted for existing runtime-baseline findings (implicitly 1.00).
   */
  confidence?: number;

  /**
   * G-series: the evidence sources that produced this finding.
   * A finding backed by both a static graph and a coverage gap has two sources.
   */
  evidenceSources?: FindingEvidenceSource[];

  /**
   * G6: canonical test identity for evidence_continuity findings.
   * Populated when the removed event was a test_file or test_run artifact.
   */
  testIdentity?: TestIdentity;
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
  // IMP-3.2: contextual scope fields — all specified fields must match (AND logic)
  /** Suppress only when finding route matches this exact string or glob pattern ("GET /health*"). */
  route?:    string;
  /** Suppress only when the affected DB table / resource matches this identifier. */
  resource?: string;
  /** Suppress only when the affected source file matches this glob pattern ("src/legacy/**"). */
  file?:     string;
};

export type SuppressionsFile = {
  schemaVersion: 'tracegraph.suppressions.v1';
  suppressions: Suppression[];
};

// ─── TracegraphConfig (tracegraph.config.json) ────────────────────────────────

/**
 * IMP-3.1: Per-rule configuration block.
 * Allows teams to tune findings rules without changing code.
 */
export type RuleConfig = {
  /** Override the default severity. */
  severity?:    FindingSeverity;
  /** Disable the rule entirely — no findings are produced for it. */
  disabled?:    boolean;
  /**
   * Override rule-specific numeric thresholds.
   * Keys are rule-documented names; e.g. N+1 uses "repetitionCount".
   */
  thresholds?:  Record<string, number>;
};

/** Root shape of `tracegraph.config.json`. Only `rules` is fully typed here; */
export type TracegraphConfig = {
  /** Per-rule configuration. Keys are rule IDs (e.g. "reliability.n_plus_one_query"). */
  rules?:    Record<string, RuleConfig>;
  /** Replay configuration (IMP-5.2). */
  replay?: {
    baseUrl?:           string;
    stripHeaders?:      string[];
    allowDestructive?:  boolean;
    environments?:      Record<string, { baseUrl: string }>;
  };
  /** Analytics configuration (IMP-7). */
  analytics?: {
    optIn?: boolean;
  };
  /** G1: Static graph enrichment configuration. */
  staticGraph?: StaticGraphConfig;
  /** G3C: Assurance level CI gating. */
  assurance?: {
    /** Fail CI if overall assurance level is below this value. */
    minLevel?: AssuranceLevelValue;
    /** Fail CI if any changed god node has assurance below this value. */
    godNodeMinLevel?: AssuranceLevelValue;
  };
  // Allow extension fields without losing type safety.
  [key: string]: unknown;
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
  /**
   * G13: human-readable name for the test or request that produced this diff.
   * Populated by `tracegraph compare` from the session entrypoint.
   * Used by the CI reporter instead of the opaque traceId.
   */
  testName?: string;
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
  /** G3C: Evidence quality for this report's analysis. */
  assurance?:           AssuranceLevel;
  /** G7: Overall release-gate verdict. */
  verdict?:             AuditVerdict;
  /** G6: Cross-run test set comparison (baseline vs candidate test coverage). */
  testDelta?:           TestDelta;
  /** G6: How baseline traces were matched to candidate traces. */
  traceMatching?:       TraceMatchingSummary;
  /** G8: PR metadata and changed files (populated by `tracegraph audit`). */
  prContext?:           PrContext;
  /**
   * G18: Overall capture level of the candidate run (minimum across all candidate
   * sessions).  Populated by `tracegraph compare` and rendered in the CI report's
   * "Capture Level" section so reviewers can see what depth of evidence was collected.
   */
  captureLevel?:        Pick<CaptureLevel, 'overall' | 'label'>;
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

// ─── AdoptionReport ───────────────────────────────────────────────────────────

/**
 * Written to `.tracegraph/BASELINE_ASSUMPTIONS.md` (human-readable) and
 * `.tracegraph/adoption-report.json` (machine-readable) after `tracegraph adopt`.
 */
export type AdoptionReport = {
  adoptedAt:          number;
  adoptedBy:          string;
  tracesAdopted:      number;
  findingsAdopted:    { severity: FindingSeverity; ruleId: string; route?: string }[];
  findingsSuppressed: { severity: FindingSeverity; ruleId: string; reason: string }[];
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
  /**
   * G3: Set when a static graph is available and this function matched a static node.
   * Includes architecture risk metadata (god-node status, community, centrality).
   */
  staticNode?: Pick<StaticNodeMeta,
    'symbolName' | 'communityId' | 'communityLabel' |
    'centralityPercentile' | 'isGodNode' | 'degree'
  >;
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
  /**
   * G3: Present when a static graph was available during coverage analysis.
   * Provides architecture risk assessment for changed functions.
   */
  architectureRisk?: {
    godNodesChanged:   number;
    godNodesUncovered: number;
    criticalNodes:     Array<{
      symbolName:           string;
      centralityPercentile: number;
      communityLabel?:      string;
      covered:              boolean;
    }>;
  };
  /** G3C: Evidence quality assessment for this coverage analysis. */
  assurance?: AssuranceLevel;
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
  // G-series exit codes
  /** G3: --fail-on-uncovered-god: uncovered god nodes exist. */
  GOD_NODE_UNCOVERED:         7,
  /** G3C: assurance.minLevel requirement not met. */
  ASSURANCE_INSUFFICIENT:     8,
} as const;

export type ExitCode = typeof EXIT_CODES[keyof typeof EXIT_CODES];

// =============================================================================
// G-Series — Static Architecture Intelligence types
// =============================================================================

// ─── StaticNodeMeta (attached to TraceEvent.static after enrichment) ──────────

/**
 * Static architecture metadata attached to a runtime TraceEvent after
 * enrichment by the static-graph resolver (G2).
 *
 * Never set at capture time — only added by the post-run enricher.
 * All fields are optional; `provider` is always set when the field is present.
 */
export type StaticNodeMeta = {
  /** Which static graph provider produced this metadata. */
  provider: 'graphify';
  /** Provider-internal node ID. */
  nodeId?: string;
  /** Fully qualified symbol name (e.g. "App\\Http\\Controllers\\PaymentController::charge"). */
  symbolName?: string;
  file?: string;
  line?: number;
  /** Extracted or inferred docstring. */
  docstring?: string;
  /** Design rationale comments near the declaration. */
  rationale?: string[];
  communityId?: string;
  communityLabel?: string;
  /** Total count of incident edges (in + out). */
  degree?: number;
  /** 0–100: 99 = top 1% by degree, 50 = median. */
  centralityPercentile?: number;
  /** True when centralityPercentile >= godNodeThresholdPercentile config value. */
  isGodNode?: boolean;
  /** Immediately adjacent symbol names. */
  neighbors?: string[];
  /** 0.0–1.0 confidence of the runtime event → static node match. */
  matchConfidence?: number;
  /** Provenance of the static information. */
  provenance?: 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS';
};

// ─── GraphMetadata ────────────────────────────────────────────────────────────

/**
 * Written to .tracegraph/static-graph/graph_metadata.json after a successful
 * `tracegraph graph build`. Committed by teams for reproducibility.
 */
export type GraphMetadata = {
  provider: 'graphify';
  graphifyVersion: string;
  builtAt: number;
  /** Git commit SHA at the time the graph was built. */
  commit: string;
  nodeCount: number;
  edgeCount: number;
  communityCount: number;
  godNodeCount: number;
  /** Relative path to the static-graph directory from the project root. */
  graphDir: string;
  /**
   * Number of runtime-observed call edges derived from PHP debug_backtrace()
   * during a tracegraph audit run (Phase 2 invasive).  Only present when
   * runtime_call_edges.json has been written.  Used to supplement the static
   * edge count when graphify reports 0 edges (common for PHP dynamic dispatch).
   */
  runtimeEdgeCount?: number;
};

// ─── StaticGraphConfig ────────────────────────────────────────────────────────

/**
 * Configuration for static graph enrichment.
 * Added to TracegraphConfig.staticGraph (see below).
 */
export type StaticGraphConfig = {
  /** Enable static graph enrichment. Default: false. */
  enabled: boolean;
  /** Static graph provider. Only 'graphify' is supported. Default: 'graphify'. */
  provider?: 'graphify';
  /** Directory to store static graph artifacts. Default: '.tracegraph/static-graph'. */
  graphDir?: string;
  /** Shell command used to build the graph. Default: 'graphify .' */
  buildCommand?: string;
  /** Automatically rebuild the graph when stale. Default: false. */
  autoBuild?: boolean;
  /** What to do when the graph commit differs from HEAD. Default: 'warn'. */
  staleGraphPolicy?: 'warn' | 'error' | 'ignore';
  /**
   * Minimum resolver confidence to attach static metadata to a runtime event.
   * 0.0–1.0. Default: 0.75.
   */
  minMatchConfidence?: number;
  /**
   * A node is a "god node" when its centralityPercentile is >= this value.
   * 95 means top 5%. Default: 95.
   */
  godNodeThresholdPercentile?: number;
  /**
   * Community labels containing these strings are flagged as sensitive.
   * New edges crossing into these communities produce higher-severity findings.
   * Default: ['auth', 'billing', 'payments', 'identity'].
   */
  sensitiveCommunities?: string[];
  /**
   * Automatically enrich runtime trace events with static metadata after
   * `tracegraph run` completes. Requires enrichTraces !== false. Default: true.
   */
  enrichTraces?: boolean;
};

// ─── G6: TestIdentity ────────────────────────────────────────────────────────

/**
 * Canonical identity for a single test case.
 * Used in TestDelta, TraceMatchingSummary, and evidence_continuity findings.
 */
export type TestIdentity = {
  /** Full display name e.g. "CalculationToQuantityTest::testItAcceptsCommaDecimalQuantities" */
  testName:      string;
  /** Source file relative to repo root (when known). */
  testFile?:     string;
  /** PHPUnit class / Jest describe block. */
  className?:    string;
  /** Test method / it() label. */
  method?:       string;
  /** Test runner framework: 'phpunit' | 'pest' | 'jest' | 'vitest' | 'mocha' */
  framework?:    string;
  /** Stable 12-char SHA-256 hash — matches the baseline filename prefix. */
  identityHash:  string;
  /**
   * Run outcome — populated for candidate tests from the trace session status.
   * Absent for baseline-derived TestIdentity objects (baseline approval does not
   * track per-run outcomes).
   */
  status?:       'passed' | 'failed' | 'skipped';
  /**
   * First non-empty line of the test failure message, taken from the
   * test_run event's error.message field.  Only populated for status='failed'.
   */
  failureMessage?: string;
};

// ─── G6: TestDelta ───────────────────────────────────────────────────────────

/**
 * G6 — Cross-run test set comparison.
 * Answers: did the candidate run cover the same tests as the baseline?
 */
export type TestDelta = {
  baselineTests:      TestIdentity[];  // all tests that have a stored baseline
  candidateTests:     TestIdentity[];  // all tests observed in the candidate run
  matchedTests:       TestIdentity[];  // present in both baseline and candidate
  baselineOnlyTests:  TestIdentity[];  // baselined but not seen in candidate
  candidateOnlyTests: TestIdentity[];  // seen in candidate but never baselined
};

// ─── G6: TraceMatchingSummary ────────────────────────────────────────────────

/**
 * G6 — How successfully baseline traces were paired with candidate traces.
 */
export type TraceMatchingSummary = {
  /** Total baselines stored in .tracegraph/baselines/ */
  baselineCount:      number;
  /** Total candidate sessions loaded for this compare run */
  candidateCount:     number;
  /** Candidates that found an exact testId match in the baseline store */
  exactMatches:       number;
  /** Baselines with no matching candidate (evidence disappeared) */
  unmatchedBaseline:  number;
  /** Candidates with no baseline (new tests, no expected-behaviour reference) */
  unmatchedCandidate: number;
  /** Matching strategy used */
  matchStrategy:      'exact';
  /** Overall confidence that the comparison covers the intended test scope */
  confidence:         'high' | 'medium' | 'low';
  /**
   * G19: false when all candidate traces were captured at Level 0 (runner metadata only).
   * In that case the match is structural (same test IDs) but carries no behavioral content —
   * "high confidence" is misleading. The CI reporter uses this to show a more accurate note.
   */
  comparableContent?: boolean;
};

// ─── G6: ArchitectureQualityLevel ────────────────────────────────────────────

/**
 * G6 — Static graph quality tier.
 *
 * A0 = No graph
 * A1 = Node list only (0 edges) — file/symbol index, no relationships
 * A2 = Nodes + edges (0 communities) — import/call graph, no community detection
 * A3 = Nodes + edges + communities — full structural topology available
 * A4 = Communities + centrality (god nodes computed)
 * A5 = Static graph linked to runtime traces (future)
 */
export type ArchitectureQualityLevel = 'A0' | 'A1' | 'A2' | 'A3' | 'A4' | 'A5';

// ─── G7: AuditVerdict ────────────────────────────────────────────────────────

/**
 * G7 — The overall release-gate verdict for this audit.
 *
 * pass                = no open findings; adequate evidence coverage
 * review_required     = findings or evidence gaps that need human sign-off
 * conditional_go      = only low/medium findings; no blocking issues
 * no_go               = critical findings that must be resolved before merge
 * insufficient_evidence = could not gather enough traces to render a verdict
 */
export type AuditVerdictStatus =
  | 'pass'
  | 'review_required'
  | 'conditional_go'
  | 'no_go'
  | 'insufficient_evidence';

export type AuditVerdict = {
  status:  AuditVerdictStatus;
  /** Human-readable reasons supporting the verdict. */
  reasons: string[];
};

// ─── G8: PrContext ───────────────────────────────────────────────────────────

/**
 * G8 — PR metadata passed from `tracegraph audit` into the compare pipeline
 * and stored in the report for display and relevance analysis.
 */
export type PrContext = {
  prNumber?:         number;
  prTitle?:          string;
  prAuthor?:         string;
  additions?:        number;
  deletions?:        number;
  changedFiles?:     number;
  /** Actual file paths changed by the PR (fetched from GitHub /pulls/:id/files). */
  changedFilePaths?: string[];
  /**
   * G15: Project language inferred from the stack detector during audit.
   * Overrides session-level language detection in `compare` for more accurate
   * language hints when the project language differs from the test runner language.
   */
  language?: string;
  /**
   * G14: Exit code of the PR-branch test run.
   * Non-zero means tests failed or errored during the audit run.
   * Omitted (or 0) when the run succeeded.
   */
  testRunExitCode?: number;
  /**
   * G14: Exit code of the base-branch (baseline) test run.
   * Non-zero means the baseline test run itself was unhealthy.
   * Omitted (or 0) when the baseline run succeeded.
   */
  baselineRunExitCode?: number;
  /**
   * G19: First meaningful boot/startup error extracted from the PR-branch test run
   * output.  Set when the PR run exits at Level 0 (no test events captured) due to
   * a framework boot failure (PHP artisan crash, Node.js module error, etc.).
   *
   * Example: "Call to undefined method Nwidart\\Modules\\Providers\\ConsoleServiceProvider::defaultCommands()"
   *
   * Used by the CI reporter to show reviewers the root cause directly in the report
   * without them having to scroll through the raw terminal output.
   */
  bootError?: string;
};

// ─── AssuranceLevel ───────────────────────────────────────────────────────────

/**
 * G3C — Evidence quality for a function, route, module, or the whole project.
 *
 * 0 = Unknown        — no static graph, no runtime trace
 * 1 = Static-known   — appears in Graphify graph (symbol, file, relationships)
 * 2 = Risk-classified — god-node, community, blast-radius computed
 * 3 = Runtime-observed — at least one runtime trace exercised it
 * 4 = Runtime-baselined — expected behavior approved and stored
 * 5 = Contract-protected — runtime contract enforces must-call/must-not
 */
export type AssuranceLevelValue = 0 | 1 | 2 | 3 | 4 | 5;

export type AssuranceLevel = {
  level:                    AssuranceLevelValue;
  /** Human-readable label for the level. */
  label:                    string;
  staticGraphAvailable:     boolean;
  runtimeTraceAvailable:    boolean;
  runtimeBaselineAvailable: boolean;
  contractAvailable:        boolean;
  /** G6: Architecture graph quality tier (A0–A5). Absent when no static graph. */
  architectureQualityLevel?: ArchitectureQualityLevel;
  /** G6: Raw graph metrics from graph_metadata.json. */
  architectureNodes?:        number;
  architectureEdges?:        number;
  architectureCommunities?:  number;
  /**
   * G18: True when ALL candidate traces were captured at Level 0 (runner metadata
   * only).  Used by the CI reporter to show "not comparable" rather than "not
   * created" for runtime baselines — baselines may exist from the base branch
   * but a Level 0 PR run makes comparison vacuous.
   */
  allTracesLevel0?:          boolean;
};

// ─── FindingEvidenceSource ────────────────────────────────────────────────────

/**
 * G-series: the evidence source that produced a finding.
 * Multiple sources may apply (e.g. static_graph + coverage_gap).
 */
export type FindingEvidenceSource =
  | 'runtime_baseline'    // Runtime diff — strongest evidence (confidence: 1.00)
  | 'runtime_contract'    // Must-call/must-not contract triggered (confidence: 0.95)
  | 'scenario_trace'      // Scenario runner trace expectation (confidence: 0.90)
  | 'static_graph'        // Pure Graphify static relationship (confidence: 0.60–0.85)
  | 'static_inferred'     // Graphify + partial runtime path reconstruction (confidence: 0.65–0.80)
  | 'coverage_gap'        // Static node in diff but no matching runtime trace event (confidence: 0.80)
  | 'manual'              // Manually annotated contract or suppression
  ;

// ─── ArchitectureBaseline ─────────────────────────────────────────────────────

/**
 * G3D — Static architecture baseline.
 * Written to .tracegraph/static-graph/architecture-baseline.json.
 * Separate from runtime baselines (.tracegraph/baselines/).
 * Commit this file for team-wide architecture drift detection.
 */
export type ArchitectureBaselineGodNode = {
  symbolName:           string;
  communityId:          string;
  communityLabel:       string;
  centralityPercentile: number;
  file?:                string;
};

export type ArchitectureBaselineCommunity = {
  communityId:  string;
  label:        string;
  size:         number;
  isSensitive:  boolean;
};

export type ArchitectureBaselineCrossEdge = {
  fromCommunityId:    string;
  fromCommunityLabel: string;
  toCommunityId:      string;
  toCommunityLabel:   string;
  callerSymbol:       string;
  calleeSymbol:       string;
  /** Number of runtime traces that observed this edge at baseline time. 0 = static-only. */
  traceCount:         number;
  /** True when only the static graph (not runtime) confirmed this edge at baseline time. */
  staticOnly:         boolean;
};

export type ArchitectureBaseline = {
  schemaVersion:       'tracegraph.architecture-baseline.v1';
  createdAt:           number;
  createdBy:           string;
  commit:              string;
  provider:            'graphify';
  graphifyVersion:     string;
  nodeCount:           number;
  edgeCount:           number;
  communityCount:      number;
  godNodes:            ArchitectureBaselineGodNode[];
  communities:         ArchitectureBaselineCommunity[];
  crossCommunityEdges: ArchitectureBaselineCrossEdge[];
  /**
   * Static call paths inferred from the graph for sensitive routes/functions.
   * Used by G2 Tier 2 (inferred runtime expectations) to detect probable missing auth.
   */
  inferredCallPaths?:  Array<{
    /** Route or function entry point (e.g. "POST /orders", "OrderController.store"). */
    entrypoint:   string;
    /** Ordered list of symbol names expected in the call chain. */
    expectedPath: string[];
    confidence:   number;
    source:       'static_graph';
  }>;
};

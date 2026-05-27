# TraceGraph — Canonical Architecture

> This document is the single source of truth for TraceGraph's architecture and product design.
> It supersedes all prior Q&A documents. Every engineer reads this first.

---

## 1. Product Identity

TraceGraph is a **CLI-first runtime assurance platform** that captures actual execution behaviour,
visualises code paths, compares behaviour across code changes, and surfaces quality, reliability,
and security findings — with AI-generated code review as the primary commercial wedge.

### What it is

- A wrapper around existing developer commands that captures what the code *actually did* at runtime
- A behaviour diff engine that compares traces across PRs and flags meaningful changes
- A local + CI tool that works without changing how developers run tests

### What it is not

- Not a debugger (no breakpoints, no stepping)
- Not a static analyser (all findings are runtime-derived)
- Not an APM or observability dashboard (no production metrics, no aggregation)
- Not a test framework replacement (it wraps existing test runners)

### Interface hierarchy

| Layer | Role |
|-------|------|
| **CLI** | Canonical runtime engine — runs traces, diffs, scenarios, reports |
| **VS Code extension** | Viewer and launcher — spawns CLI, reads artifacts, visualises graphs |
| **CI / PR layer** | Commercial value centre — behaviour assurance before merge |

The CLI is the only layer that performs work. VS Code and CI consume its output.

---

## 2. Architecture Overview

```
tracegraph/
├── CLI (tracegraph)
│   ├── Command parser
│   ├── Run orchestrator
│   ├── Trace session manager
│   ├── Storage manager
│   └── Report generator
│
├── Language Adapters (decoupled from VS Code)
│   ├── @tracegraph/js        — JS/TS adapter (Node.js)
│   ├── tracegraph/laravel    — Laravel-native hooks
│   └── tracegraph/php        — Xdebug parser + PHP normaliser
│
├── Core Platform (internal packages)
│   ├── @tracegraph/schema    — Canonical type definitions + JSON schema
│   ├── @tracegraph/core      — Trace writer, reader, atomic finaliser
│   ├── @tracegraph/sanitizer — Redaction, normalisation, size limits
│   ├── @tracegraph/graph-engine — Trace→graph, diff, findings
│   ├── @tracegraph/reporter  — Markdown, JSON, HTML, OTLP export
│   └── @tracegraph/config    — Config loading, validation
│
├── VS Code Extension (viewer/launcher)
│   ├── Spawns CLI as child process
│   ├── Reads finalised *.trace.json / *.report.json / *.tgbundle.json
│   ├── Hosts React/Reagraph Webview
│   └── Source navigation (open file:line)
│
└── CI / PR Integration
    ├── GitHub Action (community + pro)
    ├── GitHub App (hosted PR intelligence — pro/enterprise)
    └── GitLab CI / Bitbucket (community)
```

---

## 3. Monorepo Structure

```
tracegraph/
├── apps/
│   ├── vscode-extension/     — VS Code extension host
│   ├── webview/              — React + Reagraph graph UI
│   └── docs/                 — Product documentation site
│
├── packages/
│   ├── shared-types/         — Canonical TypeScript types (published as @tracegraph/schema)
│   ├── trace-core/           — Trace writer, reader, storage, atomic finaliser
│   ├── trace-sanitizer/      — Redactor, normaliser, size limiter
│   ├── graph-engine/         — Trace→graph, diff engine, finding generator
│   ├── trace-js/             — JS/TS adapter (@tracegraph/js)
│   ├── trace-php/            — PHP adapter (Xdebug parser + normaliser)
│   ├── scenario-runner/      — Scenario executor, concurrency, fault injection
│   ├── ci-reporter/          — Report generators (markdown, JSON, HTML, SARIF)
│   └── cli/                  — CLI binary (tracegraph)
│
├── sample-projects/
│   ├── express-typescript/
│   ├── plain-javascript/
│   ├── fastify-api/
│   ├── next-api/
│   ├── laravel-app/
│   └── phpunit-app/
│
├── integrations/
│   ├── github-action/
│   ├── gitlab-ci/
│   └── vscode-marketplace/
│
└── schemas/
    ├── trace-event.schema.json
    ├── scenario.schema.json
    ├── report.schema.json
    ├── baseline.schema.json
    ├── bundle.schema.json
    └── suppressions.schema.json
```

**Toolchain:** pnpm workspaces, TypeScript, Vitest (unit), Playwright (UI), tsup/esbuild (bundling).

---

## 4. Core Data Model

All artifact files carry a `schemaVersion` string. A version mismatch fails loudly — never silently.

### 4.1 TraceSession

```typescript
type TraceSession = {
  schemaVersion: "tracegraph.trace.v1";
  traceId: string;
  sessionId: string;
  runId: string;
  scenarioId?: string;
  projectId?: string;
  workspaceRoot: string;
  language: "typescript" | "javascript" | "php";
  framework?: string;
  entrypoint: TraceEntrypoint;
  startedAt: number;
  endedAt?: number;
  status: "running" | "passed" | "failed" | "error";
  captureLevel: CaptureLevel;
  events: TraceEvent[];
  detailStreams?: DetailStreams;
  metadata?: Record<string, unknown>;
};

type TraceEntrypoint =
  | { type: "http_request"; method: string; path: string; handler?: string }
  | { type: "test_case"; testName: string; testFile?: string }
  | { type: "function"; functionName: string; file?: string; line?: number }
  | { type: "cli_command"; command: string };
```

### 4.2 CaptureLevel

```typescript
type CaptureLevel = {
  overall: 0 | 1 | 2 | 3 | 4 | 5;
  label: string;
  adapters: Record<string, {
    level: number;
    mode: string;
    captured: string[];
    notCaptured: string[];
    recommendation?: string;
  }>;
};
```

Capture levels:

| Level | Approach | Captured |
|-------|----------|----------|
| 0 | Runner metadata only | Process lifecycle, exit code, external calls |
| 1 | Framework adapters | HTTP req/res, DB queries, errors (Express/Laravel middleware) |
| 2 | Manual `traceFunction` | Explicitly wrapped business logic |
| 3 | CJS `require` hook | Automatic CJS module instrumentation |
| 4 | ESM `--import` hook | Context, globals, diagnostics_channel, safe patches |
| 5 | Build-time transform | Babel/SWC/Vite/Vitest plugin — reliable deep function tracing |

**TraceGraph must never silently provide a weak trace.** Capture level is always reported in the
trace artifact, CLI stdout, and HTML/PR report.

### 4.3 TraceEvent — DAG Model

The trace model is a **directed acyclic graph**, not a strict tree. Concurrent async branches
and cross-trace causal links require DAG semantics.

```typescript
type TraceEvent = {
  schemaVersion: "tracegraph.event.v1";
  eventId: string;
  traceId: string;

  // Structural parent: the event that contains this one in the call stack
  parentEventId?: string | null;

  // Causal parent: the event that caused this one (may be in a different trace)
  causalParentEventId?: string | null;

  // Cross-trace causal link (e.g., HTTP request → dispatched job in a queue worker trace)
  causalParentRef?: { traceId: string; eventId: string } | null;

  // Concurrency grouping
  asyncGroupId?: string;        // ID of the Promise.all / concurrency group
  branchId?: string;            // Which branch within the group
  concurrencyType?: "sequential" | "parallel" | "promise_all" | "race" | "background";

  type: TraceEventType;
  language: "typescript" | "javascript" | "php";
  name: string;
  displayName?: string;
  file?: string;
  line?: number;
  column?: number;
  className?: string;
  functionName?: string;
  moduleName?: string;
  framework?: "express" | "nestjs" | "nextjs" | "fastify" | "laravel" | "symfony" | "plain";

  startTime: number;
  endTime?: number;
  durationMs?: number;

  input?: SanitizedValue;
  output?: SanitizedValue;
  error?: TraceError;
  resource?: TraceResource;
  dataFlow?: DataFlowChange[];
  security?: SecurityMetadata;
  reliability?: ReliabilityMetadata;

  tags?: string[];
  metadata?: Record<string, unknown>;
};
```

**Promise.all walk-through** (canonical example):

```
GET /users/:id/summary → Promise.all([getUser(id), getOrders(id)])

Event            parentEventId   causalParentId   asyncGroupId        branchId   concurrencyType
─────────────    ─────────────   ──────────────   ─────────────────   ────────   ───────────────
evt_http         null            null             null                null       sequential
evt_get_user     evt_http        evt_http         ag_promise_all_001  br_user    promise_all
evt_get_orders   evt_http        evt_http         ag_promise_all_001  br_orders  promise_all
evt_db_user      evt_get_user    evt_get_user     ag_promise_all_001  br_user    promise_all
evt_db_orders    evt_get_orders  evt_get_orders   ag_promise_all_001  br_orders  promise_all
```

**Cross-trace causal link** (queue job case):

```typescript
// In HTTP trace — the dispatch event
{
  traceId: "trace_http_001",
  eventId: "evt_dispatch_email_job",
  type: "queue_event",
  parentEventId: "evt_order_service_create",
  metadata: { jobId: "job_789", causedTraceId: "trace_job_001" }
}

// In job trace — no structural parent, but has a causal reference
{
  traceId: "trace_job_001",
  eventId: "evt_job_start",
  type: "queue_event",
  parentEventId: null,
  causalParentRef: { traceId: "trace_http_001", eventId: "evt_dispatch_email_job" },
  metadata: { jobId: "job_789" }
}
```

### 4.4 TraceBundle (multi-language)

```typescript
type TraceBundle = {
  schemaVersion: "tracegraph.bundle.v1";
  bundleId: string;
  scenarioId: string;
  createdAt: number;
  traces: Array<{
    language: "typescript" | "javascript" | "php";
    traceId: string;
    file: string;
  }>;
  links: Array<{
    source: { traceId: string; eventId: string };
    target: { traceId: string; eventId: string };
    type: "causes" | "correlates" | "spawns";
    correlationId: string;
  }>;
};
```

File extension: `.tgbundle.json`

### 4.5 SemanticSignature (baseline identity)

```typescript
type SemanticSignature = {
  eventType: string;
  language: "typescript" | "javascript" | "php";
  framework?: string;
  className?: string;
  methodName?: string;
  functionName?: string;
  moduleName?: string;
  routeMethod?: string;
  routePathPattern?: string;
  resourceType?: string;
  resourceKey?: string;
  resourceOperation?: "read" | "write" | "update" | "delete";
  role?: "validation" | "authorization" | "business_logic" | "db" | "external_call";
};

// File path is supplementary metadata only — excluded from identity hash
type SignatureMetadata = {
  file?: string;
  line?: number;
  packageName?: string;
  sourceHash?: string;
};
```

**File path is never part of the identity hash.** Moving `InvoiceService.php` to a subdirectory
does not produce false-positive diff findings.

### 4.6 CompactBaseline

```typescript
type CompactBaseline = {
  schemaVersion: "tracegraph.baseline.v1";
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

// Nested shape with configurable depth
type JsonShape = {
  type: "string" | "number" | "boolean" | "object" | "array" | "null" | "unknown";
  properties?: Record<string, JsonShape>;
  items?: JsonShape;         // array element shape (one representative shape)
};
// maxShapeDepth = 4, maxArrayElementShapes = 1, maxObjectKeys = 100
```

### 4.7 Finding

```typescript
type Finding = {
  id: string;
  fingerprint: string;    // hash(ruleId + semantic target + risk resource/action) — no file paths
  ruleId: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
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

type FindingFingerprintInput = {
  ruleId: string;
  semanticTarget: {
    routeMethod?: string;
    routePathPattern?: string;
    resourceType?: string;
    resourceKey?: string;
    resourceOperation?: "read" | "write" | "update" | "delete";
    className?: string;
    methodName?: string;
    functionName?: string;
    role?: "authorization" | "validation" | "db_write" | "external_call";
  };
  findingKind: string;
};
```

### 4.8 The Three Approval Concepts

These concepts are **strictly separate and must never collapse into one mechanism**.

| Concept | Meaning | Command | Effect |
|---------|---------|---------|--------|
| **Baseline approval** | This is now the expected runtime behaviour | `tracegraph baseline approve` | Rewrites expected state; absence of removed events is no longer flagged |
| **Finding approval** | This specific finding instance is acceptable | `tracegraph finding approve <id>` | One-time acceptance; does not update expected behaviour |
| **Suppression** | Never report this rule for this target while compensating evidence is present | `tracegraph.suppressions.json` | Conditional silence; self-invalidates when `requiresEvidence` is absent |

```typescript
type Suppression = {
  schemaVersion: "tracegraph.suppressions.v1";
  id: string;
  ruleId: string;
  semanticTarget: Partial<FindingFingerprintInput["semanticTarget"]>;
  requiresEvidence?: Array<{ type: string; name: string }>;
  reason: string;
  expiresAt: string;    // ISO date — enforced at analysis time every run
  approvedBy: string;
  createdAt: string;
};
```

**`requiresEvidence` is evaluated per trace, on every run.** If `RolePolicy.update` disappears
in a later PR, the suppression self-invalidates and the finding reopens at Critical severity.

**Suppression file is a security surface.** Any PR that modifies `tracegraph.suppressions.json`
causes TraceGraph to emit a distinct finding (High/Critical) and — in team mode — exit with
code 4 (policy review required) unless approved by a designated reviewer.

```typescript
type FindingApproval = {
  schemaVersion: "tracegraph.finding-approvals.v1";
  findingFingerprint: string;
  ruleId: string;
  semanticTarget: Partial<FindingFingerprintInput["semanticTarget"]>;
  approvedBy: string;
  reason: string;
  expiresAt: string;
  createdAt: string;
};
```

---

## 5. File and Storage Protocol

### 5.1 Directory layout

```
.tracegraph/
├── runs/
│   └── {runId}/
│       ├── {traceId}.events.jsonl.tmp    ← active write (never read by VS Code)
│       ├── server.stdout.log
│       └── server.stderr.log
├── traces/
│   └── {traceId}.trace.json              ← finalised (atomic rename from .tmp)
├── bundles/
│   └── {scenarioId}.tgbundle.json
├── reports/
│   └── {runId}.report.json
├── baselines/
│   └── {testId}.baseline.json            ← committed to git
├── approvals/
│   └── findings.json                     ← committed to git
├── suppressions/
│   └── tracegraph.suppressions.json      ← committed to git — security-sensitive
├── scenarios/
│   └── *.scenario.json                   ← committed to git
└── index.json                            ← trace index (not committed)
```

**Git commit policy:**

```gitignore
# .gitignore — add to project root
.tracegraph/runs/
.tracegraph/traces/
.tracegraph/reports/
.tracegraph/index.json
```

Commit only: `baselines/`, `approvals/`, `suppressions/`, `scenarios/`, `tracegraph.config.json`

### 5.2 Atomic finalisation protocol

```
1. Adapter writes events → .tracegraph/runs/{runId}/{traceId}.events.jsonl.tmp
2. On run completion: post-processor reads events.jsonl.tmp
3. Produces .tracegraph/traces/{traceId}.trace.json.tmp
4. fsync
5. Atomic rename: .trace.json.tmp → .trace.json
6. CLI emits stdout: { "type": "trace.completed", "file": "..." }
7. VS Code reads only after receiving trace.completed
```

VS Code must **never** read `.tmp` files. The atomic rename + stdout event is the contract.

### 5.3 PHP dual-stream merge

Laravel-native and Xdebug produce separate streams. Merge happens post-processing, not during
streaming parse or at render time.

```
Laravel adapter  →  laravel.events.jsonl.tmp
Xdebug parser    →  xdebug.events.jsonl.tmp
                         ↓
              post-processor (after both complete)
                         ↓
              trace_001.trace.json
              {
                "events": [...],          ← Laravel semantic events (primary)
                "detailStreams": {
                  "xdebug": {
                    "events": [...],
                    "attachedTo": {
                      "evt_controller_store": ["xd_evt_1", "xd_evt_2"]
                    }
                  }
                }
              }
```

`tracegraph_xdebug_marker(traceId, phase)` is a real PHP stub function. The Xdebug parser
recognises it by name, uses it as a correlation anchor, and strips it from the user-facing graph.
Pass `--show-internal` to include it for debugging.

### 5.4 Storage management

Default storage configuration:

```json
{
  "storage": {
    "compressCompletedRuns": true,
    "maxRuns": 20,
    "maxAgeDays": 7,
    "maxSizeMB": 500,
    "keepFailedRuns": 50,
    "pruneOnRun": true
  }
}
```

Commands:

```
tracegraph clean
tracegraph clean --older-than 7d
tracegraph clean --keep-last 20
tracegraph clean --all-runs
tracegraph storage status
```

Baselines and approved artifacts are **never pruned** by default.

---

## 6. CLI stdout Protocol

stdout is a **low-volume JSONL control channel only**. Raw trace events are not streamed to stdout
by default. Files contain data; stdout contains status.

```typescript
type CliEventEnvelope = {
  protocol: "tracegraph.cli.v1";
  type:
    | "run.started"
    | "run.progress"
    | "trace.started"
    | "trace.progress"       // periodic count summary only
    | "trace.completed"
    | "finding"
    | "report.created"
    | "approval.required"
    | "run.completed"
    | "error";
  runId: string;
  traceId?: string;
  timestamp: number;
  captureLevel?: { overall: number; label: string };
  payload?: Record<string, unknown>;
};
```

Raw event streaming is opt-in only:

```
tracegraph run -- npm test                   # control events only (default)
tracegraph run -- npm test --stream-events=summary  # count summaries
tracegraph run -- npm test --stream-events=raw      # every event (debug only)
```

The CLI **never blocks on stdin** by default. Interactive mode is explicit:

```
tracegraph baseline approve --interactive
tracegraph baseline approve --yes --reason "..."
tracegraph baseline approve --approval-file approvals.json
```

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Test or command failure |
| 2 | CLI error |
| 3 | Approval required (non-interactive mode) |
| 4 | Policy review required (suppression file modified in PR) |
| 5 | Baseline schema migration required |

---

## 7. JS/TS Instrumentation Strategy

### 7.1 Zero-config launch

```bash
tracegraph run -- npm test
# sets NODE_OPTIONS="--import @tracegraph/js/register" for ESM
# or NODE_OPTIONS="--require @tracegraph/js/register-cjs" for CJS
# auto-detected from package.json "type" field and test runner
```

### 7.2 What `--import @tracegraph/js/register` gives you (Level 4)

- Initialises `AsyncLocalStorage` trace context
- Subscribes to `undici diagnostics_channel` (observation only — cannot inject headers)
- Patches `globalThis.fetch` as a propagation fallback
- Captures `console.error` and uncaught exceptions
- Hooks test lifecycle events where available

**ESM live-binding limitation:** `--import` cannot reliably replace exports from ESM modules
(e.g., `express`, `prisma`). ESM auto-instrumentation gives Level 4 for globals and fetch;
full function-level tracing requires framework adapters or a build-time plugin.

### 7.3 Outbound HTTP header propagation

| Mechanism | Captures | Can Inject Headers |
|-----------|----------|--------------------|
| `undici diagnostics_channel` | method, URL, status, duration | No |
| `axios` interceptors | same + correlation propagation | Yes |
| `tracedFetch` wrapper | same + correlation propagation | Yes |
| `globalThis.fetch` patch | same + correlation propagation | Yes (fallback) |

Use `axios` interceptors for axios. Use `tracedFetch` where possible. Patch `globalThis.fetch`
as a fallback. Use `diagnostics_channel` as observation-only.

### 7.4 Vitest / Vite projects

`--import` hooks do not instrument code that Vite compiles internally. For Vitest projects,
the reliable integration is the `@tracegraph/vitest` reporter:

```bash
# Auto-injected by tracegraph run when Vitest is detected:
npx vitest --reporter=default --reporter=@tracegraph/vitest
```

A Vitest project without the reporter gives Level 0–1 only. TraceGraph reports this explicitly;
it does not silently claim deeper coverage.

### 7.5 Non-determinism handling in diffs

Structure mode (default) **does not compare volatile values**. Normalised before diff:

| Pattern | Normalised to |
|---------|---------------|
| UUID / ULID | `<uuid>` |
| ISO timestamp | `<timestamp>` |
| Numeric ID patterns | `<id>` |
| JWT / token-looking strings | `<token>` |
| Random hex | `<hash>` |

`invoiceId: "INV-001"` vs `invoiceId: "INV-523"` → **no diff finding** (both are `<id>`).
Response shape (`invoiceId: string`) is compared, not the value.

Value-sensitive comparison is opt-in per field:

```json
{ "diff": { "valueSensitiveFields": ["status", "role", "currency", "amount"] } }
```

---

## 8. PHP / Laravel Instrumentation Strategy

### 8.1 Laravel-native hooks (primary — semantic anchors)

| Hook | Captures |
|------|----------|
| HTTP middleware | Route, method, auth user, middleware chain |
| `DB::listen()` | SQL, bindings, duration, table, operation |
| `Gate::before()` / `Gate::after()` | Ability, user, arguments, result |
| Policy class inference | `Order + update` → likely `OrderPolicy::update` |
| Queue lifecycle | Dispatched, started, succeeded, failed, retried |
| Exception handler | Type, message, file, line |

Exact policy method names require Layer 3 (Xdebug or explicit proxy wrapper).

### 8.2 Xdebug enrichment (optional, post-processed)

```
tracegraph run -- php artisan test --xdebug-trace
```

- Target: Xdebug 3, human-readable format (`.xt`)
- Streaming parser — filtering applied **during** parse, never after
- `tracegraph_xdebug_marker(traceId, phase)` stub provides correlation anchors
- Merge rule: Laravel events = primary nodes; Xdebug = expandable detail via `detailStreams.xdebug`
- Low correlation confidence → Xdebug kept as a separate expandable lane

### 8.3 Future PHP instrumentation

v2 target: `zend_observer`-based low-overhead runtime instrumentation (PHP 8.0+), replacing
Xdebug for production-adjacent use cases.

---

## 9. Graph Engine

```typescript
// Single-session entry point (Milestones 1–3)
function traceSessionToGraph(session: TraceSession): TraceGraph

// Multi-language bundle entry point (Milestone 4+)
function traceBundleToGraph(bundle: TraceBundle): TraceGraph

type TraceGraph = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  findings: Finding[];
  captureLevel: CaptureLevel;
};

type GraphNode = {
  id: string;
  label: string;
  type: TraceEventType;
  language: "typescript" | "javascript" | "php";
  size?: number;
  data: TraceEvent;
};

type GraphEdge = {
  id: string;
  source: string;
  target: string;
  label?: string;
  type: "calls" | "returns" | "queries" | "passes_data" | "throws" |
        "awaits" | "writes" | "reads" | "conflicts" | "parallel_branch" | "causes";
};
```

**Collapse rules** (configurable):
- `node_modules/**` — collapsed by default
- `vendor/**` — collapsed by default
- Framework boot noise (Laravel container, Symfony kernel) — filtered
- `tracegraph_xdebug_marker` — always hidden

---

## 10. Behaviour Diff Engine

### 10.1 Diff modes

| Mode | What is compared | Default? |
|------|-----------------|----------|
| **Structure** | Event presence, signatures, resources, security events, response shape | Yes |
| **Input-shape** | Structure + top-level field additions/removals/type changes | No |
| **Value-sensitive** | Structure + configured field values (status, role, currency, amount) | No |

### 10.2 BehaviorDiff schema

```typescript
type BehaviorDiff = {
  schemaVersion: "tracegraph.diff.v1";
  baselineId: string;
  candidateTraceId: string;
  addedEvents: SemanticSignature[];
  removedEvents: SemanticSignature[];
  changedResources: ResourceChange[];
  changedResponseShape: ShapeChange[];
  riskFindings: Finding[];
};
```

### 10.3 Finding severities

| Finding | Default severity |
|---------|-----------------|
| Removed authorisation check | Critical |
| Removed validation function | High |
| Added DB write | High |
| Added external call | High |
| Response field removed | High |
| Response field added | Medium |
| Duration increased > 50% | Medium |
| DB query count increased | Medium |
| Log line changed | Low |

---

## 11. Security Analysis (MVP)

Three detection types, all in MVP:

**Detection A** — Structural diff: route had auth middleware in baseline trace, absent in candidate.
Implementation: compare middleware chain in `TraceSession.events` for `authorization_check` type.

**Detection B** — Single-trace analysis for configured protected routes:
Algorithm: protected-route filter → walk `parentEventId` + `causalParentEventId` ancestor chain
from each sensitive DB write event → look for `authorization_check`, `auth_check`, or
security-critical classified event → fallback to HTTP request middleware metadata scan →
fallback to chronological pre-write scan (low confidence).

```json
{ "security": { "protectedRoutes": ["/admin/**", "/payments/**", "/users/*/role"] } }
```

**Detection C** — Diff + security classification: `OrderPolicy.update` called in baseline, absent
in candidate. Classification sources: Laravel Gate events, `tracegraph.config.json`, code
annotations, heuristic fallback.

---

## 12. Scenario Runner

```typescript
type TraceScenario = {
  schemaVersion: "tracegraph.scenario.v1";
  name: string;
  type: "input_variation" | "fault_injection" | "concurrency" |
        "rate_limit" | "idempotency" | "security";
  server?: ServerConfig;
  requests?: ScenarioRequest[];
  inputMatrix?: Record<string, unknown>[];
  faults?: FaultDefinition[];
  concurrency?: ConcurrencyDefinition;
  expectations?: ScenarioExpectations;
};

type ServerConfig = {
  startCommand: string;
  url: string;
  healthCheck?: { url: string; timeoutMs: number; intervalMs: number };
  readyPattern?: string;
  readinessMode?: "all" | "any" | "health" | "pattern" | "sleep";
  env?: Record<string, string>;
};
```

**Server readiness:** default `readinessMode: "all"` — both `readyPattern` AND `healthCheck` must
pass when both are configured. CLI captures both stdout and stderr for pattern matching.

---

## 13. VS Code Extension

The extension is a **thin viewer and launcher only**.

```
VS Code Extension
  ↓ spawns
CLI process
  ↓ writes
.tracegraph/*.trace.json (atomic)
  ↓ on trace.completed stdout event
VS Code reads file → renders graph
```

**Rules:**
- Extension only reads: `*.trace.json`, `*.report.json`, `*.tgbundle.json`
- Extension never reads: `*.tmp`, `*.jsonl.tmp`, `*.events.jsonl`
- Notification channel: `trace.completed` stdout event → then read the file

**Views:**
- Graph (Reagraph — call graph, data-flow, errors, DB)
- Timeline (execution order, duration, overlap)
- Sequence (request-oriented)
- Data Flow (field transformation)
- Error Path (minimal causal path to failure)
- Diff View (baseline vs. candidate)
- Security / Reliability findings panels
- Raw JSON (debug)

---

## 14. HTML Viewer

`tracegraph open --html <trace-file> --out <output.html>`

**Self-contained for MVP** — no server required. The React/Reagraph app is compiled into a
single JS/CSS blob embedded in the HTML file. Trace data is inlined:

```html
<script id="tracegraph-data" type="application/json">
  { /* full trace JSON */ }
</script>
```

Opens offline, shareable via Slack/email, attachable to PR artifacts, committable to `demo/`.

---

## 15. Multi-Language CI Workflow

See `.github/workflows/tracegraph-ci.yml` for the canonical three-job template.

Architecture:
- **Job 1 (trace-node):** runs JS/TS tests with TraceGraph, uploads `.tracegraph/` artifacts
- **Job 2 (trace-php):** runs PHP/Laravel tests with TraceGraph, uploads `.tracegraph/` artifacts
- **Job 3 (merge-and-report):** downloads both artifact sets, runs `tracegraph bundle merge`,
  runs `tracegraph compare`, publishes GitHub step summary and PR comment (pro)

Traces are linked via shared `--scenario-id pr-{PR_NUMBER}` and correlation headers
(`x-tracegraph-scenario-id`, `x-tracegraph-correlation-id`, `traceparent`).

---

## 16. Configuration File

```json
{
  "projectName": "invoice-api",
  "languages": ["typescript", "php"],
  "trace": {
    "include": ["src/**", "app/**", "routes/**", "tests/**"],
    "exclude": ["node_modules/**", "vendor/**", "dist/**", "storage/**"],
    "maxEvents": 5000,
    "captureInputs": true,
    "captureOutputs": true,
    "captureLogs": true
  },
  "sanitize": {
    "maxDepth": 4,
    "maxArrayLength": 50,
    "maxStringLength": 500,
    "redactKeys": [
      "password", "token", "authorization", "cookie",
      "secret", "apiKey", "accessToken", "refreshToken",
      "cardNumber", "cvv", "pin"
    ]
  },
  "diff": {
    "mode": "structure",
    "valueSensitiveFields": ["status", "role", "currency", "amount"]
  },
  "security": {
    "protectedRoutes": ["/admin/**", "/users/*/role", "/payments/**"],
    "sensitiveFields": ["password", "passwordHash", "remember_token", "accessToken"]
  },
  "behavior": {
    "failOnCritical": true,
    "failOnHigh": false,
    "allowBehaviorChangesWithApproval": true
  },
  "storage": {
    "compressCompletedRuns": true,
    "maxRuns": 20,
    "maxAgeDays": 7,
    "maxSizeMB": 500,
    "pruneOnRun": true
  }
}
```

---

## 17. Developer Onboarding (Express + TypeScript)

Four steps. Two files touched.

```bash
# Step 1 — install
npm install -D tracegraph @tracegraph/js

# Step 2 — add one middleware line to src/app.ts
import { traceExpress } from "@tracegraph/js/express";
app.use(traceExpress());

# Step 3 — create baseline
npx tracegraph run -- npm test
npx tracegraph baseline create

# Step 4 — compare after a code change
npx tracegraph run -- npm test
npx tracegraph compare --baseline .tracegraph/baselines --candidate .tracegraph/latest
npx tracegraph open --html .tracegraph/reports/latest.report.json
```

Optionally, `npx tracegraph init` adds `trace:test`, `trace:baseline`, `trace:compare`,
`trace:report` scripts to `package.json`.

---

## 18. Build Milestones

| Milestone | Scope | Exit Criterion |
|-----------|-------|----------------|
| **0 — File Protocol** | Schema types, JSONL writer, atomic finalise, storage, `tracegraph clean` | `milestone0-cli-file-protocol.integration.test.ts` passes |
| **1 — Express Vertical Slice** | Express adapter, one real trace, `tracegraph open --html`, basic graph render | Real Express request traced and rendered in browser HTML |
| **2 — Diff and Baseline** | Structured signatures, compact baselines, behaviour diff, finding fingerprints, approval/suppression | `tracegraph compare` flags a removed validation function |
| **3 — Vitest / Jest Adapters** | Reporter plugin, capture level reporting, no silent weak traces | Vitest test lifecycle traced; capture level in report |
| **4 — Laravel Semantic Adapter** | Middleware, DB listener, Gate hooks, policy inference, optional Xdebug enrichment | Laravel request traced with auth + DB events |
| **5 — VS Code Viewer** | Spawn CLI, read finalised artifacts, graph / timeline / source navigation | VS Code opens trace and navigates to source line |
| **6 — Security / Reliability Findings** | Auth path detection, sensitive field detection, DB write change, retry/idempotency risk | CI report flags missing auth on protected route |
| **7 — Commercial Labs** | Reliability Lab, Security Lab, AI Code Assurance, Team Server, policy engine | AI-generated PR produces runtime assurance report |

---

## 19. Closing Principles

1. **Files contain data. stdout contains status.**
2. **Never read `.tmp` files from VS Code.**
3. **Capture level is always reported — never silent.**
4. **Baseline approval sets new expected state; it does not acknowledge a deviation.**
5. **`requiresEvidence` is evaluated per trace, every run.**
6. **Suppression file changes are security events — fail CI loudly.**
7. **Structure mode ignores volatile values — no UUID noise.**
8. **File path is not part of any identity hash.**
9. **Schema version mismatches fail loudly — never silently.**
10. **Onboarding must stay within 4 steps and 2 touched files.**

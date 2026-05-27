# TraceGraph — Full Implementation Plan (M1 → M7)

> Milestone 0 is fully specified in `docs/MILESTONE_0_CHECKLIST.md`.
> This document covers M1 through M7.
> All architecture decisions referenced here are final and documented in `ARCHITECTURE.md`.

---

## Reading this document

Each milestone is structured as:
- **Goal** — the single user-visible outcome that defines the milestone
- **Packages touched** — what gets created or modified
- **Tasks** — specific engineering units, each buildable and testable independently
- **Exit criteria** — the precise, testable definition of done

Tasks are ordered by dependency within each milestone. Where tasks are independent,
they can be parallelised across engineers.

---

## Milestone 1 — Express Vertical Slice + HTML Viewer

**Goal:** A developer installs two packages, adds one middleware line, runs
`tracegraph run -- npm test`, and sees a real call graph in the browser.

### Packages

| Package | Status |
|---------|--------|
| `packages/trace-sanitizer` | New |
| `packages/trace-js` | New |
| `packages/graph-engine` | New (basic) |
| `apps/webview` | New |
| `packages/cli` | Extend (open --html, init) |
| `sample-projects/express-typescript` | New |

---

### Tasks

#### T1.1 — Trace sanitizer (`packages/trace-sanitizer`)

Build the redaction and size-limiting layer that runs before any event is written.
This must exist before real user data enters the trace pipeline.

- `sanitize(value, config: SanitizerConfig): SanitizedValue`
- Default redact keys: `password`, `passwd`, `token`, `accessToken`, `refreshToken`,
  `authorization`, `cookie`, `set-cookie`, `session`, `secret`, `apiKey`, `clientSecret`,
  `privateKey`, `cardNumber`, `cvv`, `pin`, `otp`
- Depth limiting (`maxDepth: 4`)
- Array length limiting (`maxArrayLength: 50`)
- String length limiting (`maxStringLength: 500`)
- Object key limiting (`maxObjectKeys: 100`)
- Redacted fields replaced with `"[REDACTED]"`; structure preserved
- `sanitizeHeaders(headers)`: redact auth, cookie, set-cookie; keep content-type, accept, user-agent
- Unit tests: redaction, depth, size limits, nested objects, arrays of objects

#### T1.2 — Express adapter (`packages/trace-js`)

The primary adoption hook. Must work with a single `app.use(traceExpress())` line.

- `traceExpress(options?: TraceExpressOptions)` middleware
- Creates `AsyncLocalStorage<TraceContext>` context per request
- On request enter: emit `http_request` event
  - `method`, `path`, `params`, `query`, sanitised `body`, sanitised `headers`
  - Extract `x-tracegraph-scenario-id`, `x-tracegraph-correlation-id`, `traceparent`
  - Set `captureLevel: { overall: 1, label: "Framework-level tracing" }`
- On `res.on('finish')`: emit `http_response` event (statusCode, duration)
- On `next(err)` / unhandled error in middleware: emit `error` event (type, message, sanitised stack)
- Late registration warning: if routes are already registered when `traceExpress()` is called,
  emit a `console.warn` and a `captureLevel.recommendation`
- Integration test: real Express server on random port → POST /invoices → verify
  trace file contains `http_request` + `http_response` events

#### T1.3 — `traceFunction` wrapper (`packages/trace-js`)

Manual wrapping for explicit business-critical flows.

- `traceFunction(name, fn, metadata?)` wraps a function
- Reads current `AsyncLocalStorage` context
- On call: emit `function_call` / `method_call` event with `parentEventId` from context
- On return: emit `return` event
- On throw: emit `error` event, re-throw
- Updates `callStack` in context during execution
- `traceMethod(className, methodName, fn)` variant for class methods
- Unit tests: nesting, error propagation, async functions, context isolation

#### T1.4 — Register hooks (`packages/trace-js`)

Zero-config injection via `NODE_OPTIONS`.

- `@tracegraph/js/register` (ESM `--import` hook):
  - Initialise `AsyncLocalStorage` global
  - Subscribe to `undici` `diagnostics_channel` (observation only)
  - Patch `globalThis.fetch` for outbound correlation header injection
  - Capture `console.error` → emit `log` event
  - Capture `process.on('uncaughtException')` → emit `error` event
  - Capture level: 4 (ESM import hook) for globals + fetch; does not auto-patch ESM modules
- `@tracegraph/js/register-cjs` (CJS `--require` equivalent): same, via `Module._resolveFilename`
- `tracegraph run` auto-detects CJS vs ESM from `package.json "type"` and sets `NODE_OPTIONS`
- Test: `tracegraph run -- node -e "fetch('https://example.com')"` → `external_http_call` in trace

#### T1.5 — Basic outbound HTTP tracking (`packages/trace-js`)

- `undici` `diagnostics_channel` subscriber: `method`, `URL`, `statusCode`, `duration`, `error`
  → emit `external_http_call` event (observation mode — no header mutation)
- `globalThis.fetch` patch: wrap with header injection (`x-tracegraph-correlation-id`) + event emit
- `tracedAxios(axiosInstance)`: attach request + response interceptors to any axios instance
- All three write `external_http_call` events into the current `AsyncLocalStorage` context

#### T1.6 — Basic graph engine (`packages/graph-engine`)

Converts a `TraceSession` into a graph structure for rendering.

- `traceSessionToGraph(session: TraceSession): TraceGraph`
- `eventToNode(event)`: derive `label`, `type`, `language`, `size` from event
- Edge creation from `parentEventId` chain: one edge per parent → child relationship
- `asyncGroupId` grouping: mark edges between sibling events sharing a group as `parallel_branch`
- Collapse rules: events from `node_modules` or `vendor` → collapse into single node per package
- Strip `tracegraph_xdebug_marker` events entirely
- Return `{ nodes, edges, captureLevel }`
- Unit tests: single HTTP trace, Promise.all trace, error trace, empty trace

#### T1.7 — Webview app — basic graph (`apps/webview`)

The React + Reagraph app compiled to a single self-contained bundle.

- Vite config: `build.lib` output as single IIFE bundle (`tracegraph-viewer.js` + inline CSS)
- Data injection: reads `document.getElementById('tracegraph-data').textContent` on load
- Graph view: Reagraph `GraphCanvas` with `nodes` and `edges` from `traceSessionToGraph`
- Node colours by type: `http_request/response` = blue, `db_query` = orange,
  `authorization_check/auth_check` = red, `external_http_call` = purple,
  `function_call/method_call` = grey, `error` = crimson, `queue_event` = teal
- Node click → detail panel (right sidebar):
  - Event type, name, file:line, duration, framework
  - Input (sanitised, collapsible JSON)
  - Output (sanitised, collapsible JSON)
  - Error (message + stack)
- Capture level banner: if `captureLevel.overall < 2`, show amber warning with recommendation
- Parallel branch visual: asyncGroup members rendered as side-by-side lanes

#### T1.8 — CLI: `tracegraph open --html` (`packages/cli`)

The first user-visible demo command.

- `tracegraph open --html <trace-file> [--out <output.html>] [--no-open]`
- Read trace JSON → validate `schemaVersion`
- Read compiled webview bundle (embedded into CLI binary at build time via `tsup` asset injection)
- Produce self-contained HTML:
  ```html
  <!DOCTYPE html><html>
  <head><meta charset="utf-8"><title>TraceGraph</title><style>/* bundled CSS */</style></head>
  <body>
  <script id="tracegraph-data" type="application/json">{ ...trace }</script>
  <script>/* bundled JS */</script>
  </body></html>
  ```
- Default `--out`: `.tracegraph/reports/{traceId}.html`
- Auto-open in default browser unless `--no-open` (uses `open`/`xdg-open`/`start`)
- Also works on report JSON: `tracegraph open --html .tracegraph/reports/latest.report.json`

#### T1.9 — CLI: `tracegraph init` (`packages/cli`)

One-command project setup.

- Detect package manager: check for `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`, else `npm`
- Detect test runner: check `devDependencies` for `vitest`, `jest`, `playwright`
- Add to `package.json scripts`:
  ```json
  {
    "trace:test": "tracegraph run -- {pm} test",
    "trace:baseline": "tracegraph baseline create",
    "trace:compare": "tracegraph compare --baseline .tracegraph/baselines --candidate .tracegraph/latest",
    "trace:report": "tracegraph open --html .tracegraph/reports/latest.report.json"
  }
  ```
- Create `tracegraph.config.json` from template with project-detected language/framework
- Append to `.gitignore` (idempotent, only if entries not already present)

#### T1.10 — Sample project (`sample-projects/express-typescript`)

A realistic Express TypeScript API that demonstrates the full M1 onboarding path.

- Express 4, TypeScript 5, Vitest, tsx
- Routes: `POST /invoices`, `GET /invoices/:id`, `PUT /invoices/:id`, `DELETE /invoices/:id`
- Services: `InvoiceService`, `TaxService`
- Repository: `InvoiceRepository` (in-memory store for simplicity)
- Middleware: `express.json()`, then `traceExpress()`
- Tests: 4–6 Vitest tests covering happy path and one error case
- `README.md`: the 4-step onboarding walkthrough, expected output screenshots

---

### Exit criteria — M1

- [ ] `tracegraph run -- npm test` on sample project produces `.trace.json` with ≥ 5 events
- [ ] `tracegraph open --html` produces valid self-contained HTML that opens offline
- [ ] Graph renders HTTP request → handler → response with correct node colours
- [ ] Clicking a node with a `file`+`line` field shows those values in the detail panel
- [ ] Capture level banner shows "Level 1 — Framework-level tracing" with recommendation
- [ ] No `.tmp` files remain after run completes
- [ ] `tracegraph init` adds all four scripts to `package.json`
- [ ] Sanitizer redacts `authorization` header from request input in trace

---

## Milestone 2 — Behaviour Diff and Baseline

**Goal:** `tracegraph compare` flags "validation step removed from POST /invoices" as High;
the finding fingerprint survives moving the file to a subdirectory; a suppression with
`requiresEvidence` self-invalidates when the compensating function disappears.

### Packages

| Package | Status |
|---------|--------|
| `packages/graph-engine` | Extend (diff, signatures, findings, approvals) |
| `packages/trace-sanitizer` | Extend (diff normaliser) |
| `packages/cli` | Extend (baseline, compare, finding, report commands) |
| `packages/ci-reporter` | New |
| `apps/webview` | Extend (diff view, findings panel) |

---

### Tasks

#### T2.1 — Semantic signature extraction (`packages/graph-engine`)

The identity layer that makes diffs file-path-agnostic.

- `eventToSignature(event: TraceEvent): SemanticSignature`
- Role classifier: map `event.type` + framework signals + name patterns to `EventRole`
  - `authorization_check` / `auth_check` + Gate/Policy signals → `"authorization"`
  - Function name matching `validate|verify|check|assert|ensure` + FormRequest → `"validation"`
  - `db_query` → `"db"`; `external_http_call` → `"external_call"`; else → `"business_logic"`
- `signatureToIdentityHash(sig: SemanticSignature): string`
  - Hash inputs: `eventType`, `language`, `framework`, `className`, `methodName`,
    `functionName`, `routeMethod`, `routePathPattern`, `resourceType`, `resourceKey`,
    `resourceOperation`, `role`
  - **Never include** `file`, `line`, `column`, `packageName`
- Unit tests: moving a file does not change the hash; renaming a route path does

#### T2.2 — CompactBaseline builder (`packages/graph-engine`)

- `sessionToBaseline(session, meta: { approvedBy, reason }): CompactBaseline`
- Aggregate events by signature (deduplicate, count)
- Mark security-critical events: `authorization_check`, `auth_check`, Gate/Policy events
- Response shape extraction (`extractShape(value, maxDepth)`):
  - Nested `JsonShape` up to `maxDepth: 4`
  - Arrays: capture one representative element shape (`maxArrayElementShapes: 1`)
  - Heterogeneous arrays: union shape
- Resource summary: group `db_query` events by table + operation
- Unit tests: two identical traces produce identical baselines; optional field addition produces only a shape warning

#### T2.3 — Diff normaliser (`packages/trace-sanitizer`)

Prevents non-determinism from producing diff noise.

- `normaliseForDiff(value: unknown, config): unknown`
- Patterns (applied to string values recursively):
  - UUID/ULID (8-4-4-4-12 hex or 26-char base32) → `"<uuid>"`
  - ISO 8601 timestamps → `"<timestamp>"`
  - Unix timestamp integers (10 or 13 digits) → `"<timestamp>"`
  - Pure numeric strings matching ID patterns (`INV-\d+`, `ORD-\d+`, bare integers) → `"<id>"`
  - JWT-shaped strings (`eyJ...`) → `"<token>"`
  - Hex strings > 16 chars → `"<hash>"`
- Value-sensitive fields exempt from normalisation (configurable per project)
- Unit tests: `invoiceId: "INV-001"` vs `invoiceId: "INV-523"` → no diff; `status: "active"` vs `status: "suspended"` → diff when in valueSensitiveFields

#### T2.4 — BehaviorDiff engine — Structure mode (`packages/graph-engine`)

- `diffBaseline(baseline: CompactBaseline, candidate: TraceSession): BehaviorDiff`
- Normalise candidate event outputs before comparison
- Added signatures: in candidate but not in baseline signature set
- Removed signatures: in baseline but not in candidate
- Changed resource operations: new table+operation, removed table+operation, changed count
  (count change > configured threshold)
- Changed response shape: added field, removed field, type changed
- Array ordering: shape-based comparison only; ordering within parallel branches is not significant
- Input-shape mode (opt-in): also compare top-level input field sets of matching events

#### T2.5 — Finding generator (`packages/graph-engine`)

- `diffToFindings(diff: BehaviorDiff): Finding[]`
- Finding fingerprint: `sha256(ruleId + routePathPattern + resourceType + resourceKey + resourceOperation + className + methodName + role).slice(0, 16)`
- One finding per distinct (ruleId + semantic target) combination
- Severity table (per ARCHITECTURE.md §10.3)
- Deterministic finding IDs: `find_${fingerprint}`
- Unit tests: same diff → identical fingerprints; file move → same fingerprint; different route → different fingerprint

#### T2.6 — Approval/suppression evaluator (`packages/graph-engine`)

- `evaluateFindings(findings, session, suppressions, approvals, baselineState): EvaluatedFinding[]`
- For each finding:
  1. Is the finding fingerprint in `approvals` with a non-expired `expiresAt`? → `status: "approved"`
  2. Does a suppression match (ruleId + semanticTarget)?
     - Is `expiresAt` in the future?
     - Does each `requiresEvidence` item exist as an event in the current trace? (per-trace check)
     - If all pass → `status: "suppressed"`
  3. Does the baseline already expect this state (baseline approval updated it)? → not re-flagged
  4. Else → `status: "open"`
- Suppression file change detection:
  - `isSuppressionsFileModified(workspaceRoot, baseBranch)`: compare git hash
  - If modified → add `tracegraph_policy_change` finding, severity: High

#### T2.7 — CLI: baseline commands (`packages/cli`)

- `tracegraph baseline create`
  - Read latest run trace files from `.tracegraph/traces/`
  - For each trace: call `sessionToBaseline()`, write to `.tracegraph/baselines/{testId}.baseline.json`
  - Interactive mode: prompt for reason per baseline
  - `--reason "..."` for non-interactive; `--all` to approve all without prompting
  - Emit `approval.required` (Exit 3) if neither `--yes` nor `--reason` given and not TTY

- `tracegraph baseline approve`
  - `tracegraph baseline approve [baselineId] --reason "..." [--expires <date>]`
  - `--interactive`: review each pending baseline one by one
  - `--yes --reason "..."`: approve all non-interactively
  - `--approval-file approvals.json`: batch approve from file

- `tracegraph baseline list`
  - Table: testId, captureLevel, approvedBy, approvedAt, eventCount, resourceCount

- `tracegraph baseline migrate`
  - Detect schema version of each `.baseline.json`
  - v1 → v2: derive new fields where possible; mark non-derivable as `null` with `migrationWarning`
  - Emit per-field warnings for unmigrated data
  - Exit 5 if schema mismatch detected in `compare` or `create` without prior migration

#### T2.8 — CLI: `tracegraph compare` (`packages/cli`)

- `tracegraph compare --baseline <dir> --candidate <trace.json|bundle.json> --out <report.json>`
- Load baseline files matching candidate traces
- Run `diffBaseline()` for each matched pair
- Run `diffToFindings()` on combined diffs
- Load suppressions + approvals
- Run `evaluateFindings()` per finding
- Detect suppression file changes vs `--base-ref` (default: `origin/main`)
- Write `.report.json` with `schemaVersion: "tracegraph.report.v1"`
- Exit codes: 0 (pass), 1 (critical open findings when `failOnCritical: true`), 4 (suppression file changed), 5 (schema migration needed)

#### T2.9 — CLI: finding commands (`packages/cli`)

- `tracegraph finding approve <fingerprint> --reason "..." --expires <ISO-date>`
  - Append to `.tracegraph/approvals/findings.json`
  - Validate fingerprint exists in latest report

- `tracegraph finding list`
  - Load latest report, list all findings with status (open/approved/suppressed), severity, title

- `tracegraph finding suppress <fingerprint> --reason "..." --expires <date> --requires-evidence "auth_check:RolePolicy.update"`
  - Append to `.tracegraph/suppressions/tracegraph.suppressions.json`

#### T2.10 — CI reporter (`packages/ci-reporter`)

- `tracegraph report --input <report.json> --format <format>`
- Formats:
  - `markdown`: full report with summary table, critical findings, behaviour changes, capture level warning
  - `json`: passthrough of report JSON (for machine consumption)
  - `github-step-summary`: markdown written to `$GITHUB_STEP_SUMMARY`
  - `html`: extend `tracegraph open --html` to accept a report file (not just a trace)
- Report sections:
  1. Summary: traces collected, changed traces, findings by severity
  2. Critical findings (if any): full detail, evidence, recommendation
  3. High findings
  4. Behaviour changes (medium/low)
  5. Capture level: current level + recommendation
  6. "Do not merge" block if `failOnCritical: true` and critical findings exist

#### T2.11 — Webview: diff view + findings panel (`apps/webview`)

- Load a report JSON (which contains baseline + candidate traces + findings)
- Diff view: render candidate graph with overlays
  - Added nodes/edges: green border
  - Removed nodes (from baseline): red, ghost opacity
  - Changed nodes: yellow border
- Findings panel (right sidebar):
  - List all findings sorted by severity
  - Click finding → highlight evidence nodes in graph
  - Status badge: open (red), approved (blue), suppressed (grey)
  - Show suppression `requiresEvidence` items and whether they're present in current trace
- Finding detail: rule ID, description, recommendation, evidence events, fingerprint

---

### Exit criteria — M2

- [ ] `tracegraph compare` on traces where `validateCouponExpiry()` was removed → `High: validation-like event removed`
- [ ] Move `InvoiceService.php` to a subdirectory → finding fingerprint unchanged between runs
- [ ] Suppression with `requiresEvidence: authorization_check:RolePolicy.update` → suppressed when policy present, Critical when policy absent
- [ ] Baseline-approve trace A (without `validateCouponExpiry`) → trace B (same absent function) is not re-flagged
- [ ] `invoiceId: "INV-001"` vs `"INV-523"` → no diff finding (normalised to `<id>`)
- [ ] CI markdown report is readable: summary table, findings with severity, capture level warning
- [ ] Exit code 1 on critical finding; exit code 4 on suppression file modified in PR

---

## Milestone 3 — Vitest / Jest / PHPUnit Adapters

**Goal:** Each Vitest test produces its own trace; capture level is accurately reported for
every test runner; no trace silently claims deeper coverage than it has.

### Packages

| Package | Status |
|---------|--------|
| `packages/trace-js` | Extend (Vitest reporter, Jest reporter, `traceTest` wrapper) |
| `packages/trace-php` | Extend (PHPUnit extension) |
| `packages/cli` | Extend (auto-detect + inject reporter, `tracegraph diagnose`) |

---

### Tasks

#### T3.1 — Vitest reporter (`@tracegraph/vitest`, within `packages/trace-js`)

- Implements Vitest's `Reporter` interface
- `onInit(ctx)` → initialise trace session writer for the run
- `onTestCaseStart(test)` → `startTrace({ type: 'test_case', testName: test.fullName })`; push new `AsyncLocalStorage` context
- `onTestCaseEnd(test)` → `endTrace()`; finalise per-test trace
- `onTestFailed(test, error)` → emit `error` event with stack before `endTrace()`
- `onFinished()` → write trace index; emit `run.completed`
- Per-test `captureLevel`: `{ overall: 5, label: "Test lifecycle via Vitest reporter" }`
- Export as `@tracegraph/vitest` (separate publishable entry point in `packages/trace-js`)

#### T3.2 — Jest reporter (`@tracegraph/jest`, within `packages/trace-js`)

- Implements Jest's `Reporter` interface
- `onTestStart(test)` → `startTrace()`
- `onTestResult(test, testResult)` → for each test case result, `endTrace()` / `captureError()`
- `onRunComplete()` → write index, emit `run.completed`
- Export as `@tracegraph/jest`

#### T3.3 — `traceTest` wrapper API (`@tracegraph/js`)

- `traceTest(name: string, fn: (ctx: { trace: TraceTestContext }) => Promise<void>)`
- Returns a Vitest/Jest-compatible test function
- Injects `trace.expectBehavior({ mustCall, mustNotCall, maxDbQueries })`:
  - At assertion time: scans current trace events
  - `mustCall`: each named function must appear in trace → fail test with diff if absent
  - `mustNotCall`: each named function must not appear → fail test if present
  - `maxDbQueries`: count `db_query` events → fail if exceeded
- Works alongside Vitest/Jest (not a replacement for `it()` / `test()`)

#### T3.4 — CLI: auto-detect and inject reporter (`packages/cli`)

- On `tracegraph run -- npx vitest`:
  - Detect `vitest` in `devDependencies` or `node_modules/.bin/vitest`
  - Append `--reporter=default --reporter=@tracegraph/vitest` to vitest command
  - Log: `"TraceGraph: detected Vitest — injecting @tracegraph/vitest reporter (Level 5)"`
- On `tracegraph run -- npx jest` or `tracegraph run -- jest`:
  - Append `--reporters=default --reporters=@tracegraph/jest`
- If neither detected:
  - Log: `"TraceGraph: no test reporter detected — capture level will be 0–1"`
  - Log: `"Recommendation: add @tracegraph/vitest or @tracegraph/jest for test-level tracing"`
- Auto-injection must not modify `vitest.config.ts` or `jest.config.*` permanently

#### T3.5 — Capture level in all outputs (`packages/cli`, `apps/webview`, `packages/ci-reporter`)

- `TraceSession.captureLevel`: populated by adapter (Level 5 from Vitest reporter, Level 1 from Express only)
- `run.completed` stdout envelope: `"captureLevel": { "overall": 5, "label": "..." }`
- HTML report banner: coloured badge — green (Level 4–5), amber (Level 2–3), red (Level 0–1)
- Markdown CI report: `"Capture Level: 1 — add @tracegraph/vitest for test-level tracing (Level 5)"`
- The capture level warning is the most visible element of the report for under-instrumented projects

#### T3.6 — PHPUnit extension (`tracegraph/phpunit`)

- `TraceGraphPHPUnitExtension` implementing PHPUnit's `AfterTestHook` and `BeforeTestHook`
- `executeBeforeTest(string $test)` → `TraceGraph::startTrace([ 'type' => 'test_case', 'name' => $test ])`
- `executeAfterTest(string $test, float $time)` → `TraceGraph::endTrace()`
- Registered via `phpunit.xml` `<extensions>` element
- Capture level: Level 1 (test lifecycle + Laravel hooks)
- One trace file per test case

#### T3.7 — CLI: `tracegraph diagnose` (`packages/cli`)

Tells a developer exactly what to install to improve their capture level.

- `tracegraph diagnose [--trace <traceId>]`
- Load latest trace (or specified trace)
- Output:
  ```
  TraceGraph Capture Report
  ─────────────────────────────────────────────────────
  Current capture level: 1 — Framework-level tracing
  Language:   TypeScript
  Framework:  Express (detected)
  Node:       v20.11.0
  Module type: ESM

  Captured:
    ✓ HTTP requests and responses
    ✓ Outbound fetch calls (observation)
    ✗ Internal function calls (not captured)
    ✗ Per-test isolation (not captured)

  Recommendations:
    1. Add @tracegraph/vitest reporter → Level 5 (test lifecycle + deep tracing)
       npm install -D @tracegraph/vitest
    2. Use traceFunction() for critical business logic → Level 2
       import { traceFunction } from "@tracegraph/js"
  ```

---

### Exit criteria — M3

- [ ] Vitest run produces one `.trace.json` per test case, not one per suite
- [ ] HTML report shows green "Level 5 — Vitest reporter" banner when reporter is active
- [ ] `tracegraph run -- npx vitest` on project without reporter → amber "Level 1" banner + recommendation shown in stdout
- [ ] `tracegraph diagnose` outputs actionable steps to reach higher capture level
- [ ] `traceTest` with `trace.expectBehavior({ mustCall: ["InvoiceService.create"] })` fails the test when the function is not called

---

## Milestone 4 — Laravel Semantic Adapter

**Goal:** A Laravel request trace shows the full semantic path: HTTP request →
middleware → auth check → controller → DB query → queue dispatch → response,
with enough detail for behaviour diff to work meaningfully.

### Packages

| Package | Status |
|---------|--------|
| `tracegraph/laravel` | New (Composer package) |
| `packages/trace-php` | New (Xdebug parser, PHP normaliser, merger) |
| `packages/cli` | Extend (`tracegraph import xdebug`) |
| `sample-projects/laravel-app` | New |

---

### Tasks

#### T4.1 — Laravel ServiceProvider (`tracegraph/laravel`)

The Composer package that developers install with `composer require tracegraph/laravel --dev`.

- `TraceGraphServiceProvider` extends `ServiceProvider`
- Auto-discovery via `extra.laravel.providers` in `composer.json`
- Registers: HTTP middleware, `DB::listen` hook, Gate hooks, exception handler integration,
  queue lifecycle hooks, `tracegraph_xdebug_marker` stub
- Publishes config: `php artisan vendor:publish --tag=tracegraph`
- `php artisan tracegraph:install`: publish config, add `.env.example` entries, add `.gitignore`

#### T4.2 — Laravel HTTP middleware

- `TraceGraphMiddleware` registered globally (or per-route group) in HTTP kernel
- On request:
  - Create `TraceSession` with `type: 'http_request'`, route, method, auth user ID/role
  - Extract `x-tracegraph-scenario-id`, `x-tracegraph-correlation-id`, `traceparent`
  - Call `tracegraph_xdebug_marker($traceId, 'request_start')` if Xdebug is active
  - Emit `http_request` event with sanitised request data
  - Store trace context in `app()->instance('tracegraph.context', ...)`
- On response (via `terminate()`):
  - Emit `http_response` event (statusCode, duration, sanitised response shape)
  - Finalise trace

#### T4.3 — `DB::listen()` integration

- Boot: `DB::listen(function ($query) { ... })`
- Emit `db_query` event per query:
  - SQL (with `?` placeholders)
  - Bindings (sanitised — redact password/secret fields)
  - Duration (ms)
  - Table (parsed from SQL: first token after FROM/INTO/UPDATE)
  - Operation (SELECT/INSERT/UPDATE/DELETE/BEGIN/COMMIT/ROLLBACK)
  - `parentEventId` from current trace context
- Transaction boundary detection: `BEGIN` → emit `transaction_start`; `COMMIT` → `transaction_commit`; `ROLLBACK` → `transaction_rollback`

#### T4.4 — Gate and Policy hooks

- Layer 1: `Gate::after(function ($user, $ability, $result, $arguments) { ... })`
  - Emit `authorization_check` event: `ability`, `userId`, `result`, `arguments` (sanitised)
  - Mark as `security.critical: true`
- Layer 2: Policy class inference
  - From `$arguments`: detect model class (e.g., `App\Models\Order`)
  - Infer policy: `App\Policies\OrderPolicy::update`
  - Set `displayName: "OrderPolicy::update"` on the event
- Gate events get `role: "authorization"` in semantic signature

#### T4.5 — Exception handler integration

- In `app/Exceptions/Handler.php` `report()` method (or via override instructions):
  - `TraceGraph::captureException($e)`
  - Emit `error` event: type, message, sanitised stack (strip vendor frames)
- Alternatively: auto-hook via ServiceProvider if `Handler` extends `Illuminate\Foundation\Exceptions\Handler`

#### T4.6 — Queue lifecycle hooks

- Boot: subscribe to `Queue::before()`, `Queue::after()`, `Queue::failing()`, `Queue::exceptionOccurred()`
- Dispatch detection: override `Bus::dispatch()` or use `BusServiceProvider` to capture dispatch event
  - Emit `queue_event` (type: dispatch) with `causedTraceId` metadata
- On job execute: emit `queue_event` (type: start) with `causalParentRef` pointing to dispatch event
- On job complete/fail: emit `queue_event` (type: succeeded/failed) with duration
- Correct `causalParentRef` cross-trace linkage as specified in ARCHITECTURE.md §4.3

#### T4.7 — `tracegraph_xdebug_marker()` PHP stub

```php
// Auto-loaded by ServiceProvider
function tracegraph_xdebug_marker(string $traceId, string $phase, array $meta = []): void
{
    // intentionally empty — Xdebug records this call as a correlation anchor
}
```

- Strip from user-visible graph (Xdebug parser recognises by function name)
- Show with `--show-internal` flag

#### T4.8 — Xdebug streaming parser (`packages/trace-php`)

Target: Xdebug 3 human-readable `.xt` format (two-space-indented function call log).

- Stream parser: process line by line, never load full file into memory
- Include/exclude rules applied **per line** during ingestion (not after)
- `maxEvents` limit applied during ingestion
- Parse columns: level, function name, class name, type (enter/exit), file, line, time, memory, params, return value
- Detect `tracegraph_xdebug_marker` lines → extract `traceId` and `phase`, store as correlation anchors, **do not emit as events**
- Emit `TraceEvent` for each included enter/exit pair
- Write events to `xdebug.events.jsonl.tmp` as they are produced (streaming)
- Unit tests: parse sample `.xt` file, verify event count, verify marker extraction

#### T4.9 — Laravel/Xdebug post-processor merger (`packages/trace-php`)

Runs after both streams are finalised. Produces a single unified trace file.

- Read `laravel.events.jsonl.tmp` → array of Laravel semantic events
- Read `xdebug.events.jsonl.tmp` → array of Xdebug function events
- Correlation algorithm:
  1. Find `tracegraph_xdebug_marker` anchor pairs (request_start / request_end) in Xdebug stream → define time window
  2. For each Laravel semantic event (e.g., `db_query`), find Xdebug events within ±5ms timestamp window and matching file
  3. Confidence score: timestamp match weight (0.6) + file match weight (0.3) + function name match weight (0.1)
  4. High confidence (>= 0.7): attach Xdebug events as `detailStreams.xdebug.attachedTo[semanticEventId]`
  5. Low confidence (< 0.7): append to `detailStreams.xdebug.events` as separate expandable lane
- Write merged `trace_001.trace.json.tmp` → atomic rename → `trace_001.trace.json`

#### T4.10 — CLI: `tracegraph import xdebug` (`packages/cli`)

```
tracegraph import xdebug ./trace.xt [--out .tracegraph/traces/] [--include "app/**"] [--max-events 5000]
```

- Runs T4.8 parser standalone on any `.xt` file
- Optional: filter with include/exclude patterns
- Produces valid `.trace.json` without needing a full Laravel test run
- Useful for importing traces from existing Xdebug-instrumented environments

#### T4.11 — Artisan commands (`tracegraph/laravel`)

```
php artisan tracegraph:install       — publish config, add .gitignore entries
php artisan tracegraph:test          — run test suite with TraceGraph active
php artisan tracegraph:baseline      — create baselines from latest run
php artisan tracegraph:compare       — compare against baselines, produce report
php artisan tracegraph:report        — open HTML report in browser
```

#### T4.12 — Sample Laravel project (`sample-projects/laravel-app`)

- Laravel 11, PHP 8.3, MySQL (via Docker Compose)
- Controllers: `InvoiceController`, `OrderController`
- Services: `InvoiceService`, `TaxService`
- Policies: `InvoicePolicy`, `OrderPolicy`
- FormRequests: `StoreInvoiceRequest`, `UpdateInvoiceRequest`
- Jobs: `SendOrderEmailJob`
- Tests: 6–8 PHPUnit/Pest tests covering happy path + auth + DB
- `docker-compose.yml` for local MySQL
- `README.md`: onboarding steps for Laravel

---

### Exit criteria — M4

- [ ] Laravel request trace contains ≥ 6 semantic events including `http_request`, `authorization_check`, `db_query`, `http_response`
- [ ] `Gate::allows('update', $order)` → `authorization_check` event with ability + result + inferred `OrderPolicy::update` displayName
- [ ] DB query events show parsed SQL (not just query hash), duration, table name, operation
- [ ] Queue job dispatch → `queue_event` with `causedTraceId`; job execution trace has `causalParentRef` pointing back
- [ ] `tracegraph import xdebug ./trace.xt` produces valid `.trace.json` with app-level events only (vendor filtered)
- [ ] Optional Xdebug: clicking a controller node in the HTML viewer shows expandable detail with function call list

---

## Milestone 5 — VS Code Viewer

**Goal:** Developer runs a test from VS Code, the graph auto-opens in a panel,
and clicking any node navigates to the correct source line.

### Packages

| Package | Status |
|---------|--------|
| `apps/vscode-extension` | New |
| `apps/webview` | Extend (timeline, error path, diff view, findings panel) |
| `integrations/vscode-marketplace` | New |

---

### Tasks

#### T5.1 — VS Code extension manifest and activation (`apps/vscode-extension`)

- `package.json` for VS Code extension:
  - `activationEvents`: `onCommand:tracegraph.*`, `onView:tracegraph.*`
  - Commands: Open Visualizer, Run Current Test with Trace, Import Trace File, Compare Traces, Run Scenario
  - Views: Recent Traces, Baselines, Findings, Scenarios, Settings (in sidebar container)
  - Language: TypeScript, bundled with `esbuild`
- Extension activates when a `.tracegraph/` directory is detected in workspace

#### T5.2 — CLI process management (`apps/vscode-extension`)

The extension's core behaviour: spawn and manage CLI processes.

- `CliRunner` class:
  - `run(args: string[]): CliProcess` — spawn `tracegraph` as child process
  - Parse stdout JSONL line-by-line: `readline` interface on `process.stdout`
  - On each `CliEventEnvelope`: route to handlers
  - `on('trace.completed', handler)` → read finalised `.trace.json`, send to Webview
  - `on('finding', handler)` → forward to Webview findings panel
  - `on('run.completed', handler)` → update sidebar tree + status bar
  - `on('error', handler)` → show VS Code error notification
  - **Never read `.tmp` files** — only read files referenced in `trace.completed` events

#### T5.3 — File system watcher

- `vscode.workspace.createFileSystemWatcher('.tracegraph/traces/*.trace.json')`
- `onDidCreate(uri)` → show notification "New trace available — Open in TraceGraph?" with Open button
- Never watch `*.tmp` or `*.jsonl.tmp` — these are explicitly excluded from the watcher pattern

#### T5.4 — Webview host (`apps/vscode-extension`)

- `TraceGraphPanel.createOrShow(context)` — create or reveal Webview panel
- `panel.webview.html` → load compiled webview bundle (asset bundled into extension VSIX)
- Message bridge:
  - Extension → Webview: `TRACE_LOADED`, `DIFF_LOADED`, `FINDING_LIST`, `RUN_SUMMARY`, `CAPTURE_LEVEL_WARNING`
  - Webview → Extension: `OPEN_SOURCE { file, line }`, `REQUEST_BASELINE_APPROVE { fingerprint }`, `REQUEST_FINDING_APPROVE { fingerprint }`
- Security: `webview.options.localResourceRoots` — restrict to extension asset directory only

#### T5.5 — Source navigation

- Extension handles `OPEN_SOURCE` messages from Webview:
  ```typescript
  const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, msg.file);
  const doc = await vscode.workspace.openTextDocument(uri);
  const line = msg.line > 0 ? msg.line - 1 : 0;
  await vscode.window.showTextDocument(doc, {
    selection: new vscode.Range(line, 0, line, 0),
    preserveFocus: false
  });
  ```
- Node detail panel shows `file:line` as a clickable hyperlink

#### T5.6 — Sidebar TreeDataProviders

- `RecentTracesProvider`: list `.tracegraph/traces/*.trace.json` sorted by `createdAt`, show status icon
- `BaselinesProvider`: list `.tracegraph/baselines/*.baseline.json`, show testId + approvedBy
- `FindingsProvider`: load from latest `.tracegraph/reports/*.report.json`, group by severity
- `ScenariosProvider`: list `.tracegraph/scenarios/*.scenario.json`
- Each tree item has context menu actions: Open, Compare, Approve, Delete

#### T5.7 — Webview: additional views (`apps/webview`)

Building on the M1 basic graph:

- **Timeline view**: horizontal swimlane diagram
  - X-axis: wall-clock time (or relative to trace start)
  - Each event: coloured bar with width proportional to `durationMs`
  - Parallel branches (`asyncGroupId`): rendered as separate horizontal lanes, overlapping in time
  - Click bar → highlight corresponding node in graph view

- **Error Path view**: minimal causal path to failure
  - Start from any `error` event
  - Walk `parentEventId` chain backward to root
  - Filter graph to only show ancestor nodes (hide unrelated branches)
  - Highlight path in red; dim everything else
  - Useful for tracing "what led to this exception"

- **Diff view** (extends M2 webview work into VS Code context):
  - Receive `DIFF_LOADED` message with diff report
  - Render with green/red/yellow overlays
  - Finding highlight: click finding → zoom to evidence nodes

- **Security panel**: list `security_*` findings, severity badges, evidence links
- **Reliability panel**: list `behavior_change`, `idempotency`, `retry_storm` findings

#### T5.8 — Extension packaging and publish pipeline

- `vsce package` → `.vsix`
- VSIX includes: compiled extension JS, compiled webview bundle, PHP trace-php package stubs
- GitHub Action in `integrations/vscode-marketplace/`:
  - On push to `releases/vscode/**` tag → run `vsce publish`
  - Requires `VSCE_PAT` secret

---

### Exit criteria — M5

- [ ] VS Code command "Run Current Test with Trace" spawns CLI, streams progress in status bar, auto-opens graph on completion
- [ ] Clicking a node with `file` + `line` opens the exact source line in the editor
- [ ] Timeline view shows parallel branch lanes for a `Promise.all` request
- [ ] Error Path view shows minimal ancestor chain from an error node to the HTTP request root
- [ ] Extension never reads a `.tmp` file (verified by checking watcher filter and CliRunner file reads)
- [ ] `.vsix` packages and installs cleanly on VS Code 1.85+

---

## Milestone 6 — Security and Reliability Findings

**Goal:** The CI report flags a missing auth check on a protected route as Critical,
an N+1 query in a single trace, and a duplicate DB insert from an idempotency scenario.

### Packages

| Package | Status |
|---------|--------|
| `packages/graph-engine` | Extend (security rules, reliability rules) |
| `packages/scenario-runner` | New |
| `packages/cli` | Extend (`tracegraph scenario run`) |

---

### Tasks

#### T6.1 — Security rule: `security.authorization.middleware_removed` (Detection A)

- Compare baseline trace and candidate trace middleware chains for the same route
- Baseline has `authorization_check` / `auth_check` in early middleware → candidate does not → Critical
- Works even when there are no findings in the diff (structural middleware check, not just event diff)

#### T6.2 — Security rule: `security.authorization.missing_before_sensitive_write` (Detection B)

Full algorithm:

1. Gate: is this route in `protectedRoutes` config, or does the baseline trace include auth events?
2. Find all `db_query` events with `operation: write | update | delete` in the candidate trace
3. For each write event, walk:
   - `parentEventId` chain backward to root
   - `causalParentEventId` chain backward
   - All events in `asyncGroupId` that share `branchId` ancestry
4. Look for: `type: authorization_check | auth_check`, or any event with `security.critical: true`,
   or any event classified as `role: "authorization"` in semantic signature
5. Fallback: scan all events with `startTime < writeEvent.startTime` chronologically
6. Confidence levels:
   - High: protected route + sensitive write + no auth in steps 3-4
   - Medium: protected route + no auth anywhere before write (step 5)
   - Low: missing instrumentation suspected (captureLevel < 2)

#### T6.3 — Security rule: `security.authorization.check_removed` (Detection C)

- Diff-based: any event with `role: "authorization"` or `security.critical: true` in baseline,
  absent in candidate → Critical
- Works for Gate events, Policy events, manually annotated events

#### T6.4 — Security rule: `security.sensitive_data.in_response`

- For each `http_response` or `log` event: scan `output` recursively against `sensitiveFields` config list
- Default fields: `passwordHash`, `password`, `remember_token`, `accessToken`, `refreshToken`,
  `refreshToken`, `cvv`, `pin`, `secret`, `apiKey`
- Pattern matching: exact key name (case-insensitive) + value heuristics (looks like hash/token)
- Severity: High

#### T6.5 — Security rule: `tracegraph_policy_change.suppressions_modified`

- Called from `evaluateFindings()` in T2.6 (already partially implemented there)
- Formalise as a named rule with its own fingerprint and severity (High default, Critical if adds security suppressions)
- CI exit code 4 in team mode

#### T6.6 — Reliability rule: `reliability.n_plus_one_query`

- Within a single trace: group `db_query` events by (table + operation + SQL shape)
- SQL shape normalisation: replace all literal values with `?` placeholders (same as Eloquent bindings format)
- Count per group within a single request trace
- Threshold: `> config.reliability.nPlusOneThreshold` (default: 3)
- Severity: Medium
- Evidence: list of duplicate query events

#### T6.7 — Reliability rule: `reliability.retry_storm`

- Group `external_http_call` events by (URL pattern + method) across the trace
- Count retry attempts (events with same URL within same `asyncGroupId` or sequential chain)
- Threshold: `> config.reliability.retryStormThreshold` (default: 5 retries to same host)
- Severity: High

#### T6.8 — Reliability rule: `reliability.idempotency_violation`

- Requires two traces from the same request inputs (produced by idempotency scenario)
- Compare `db_query` events with `operation: insert` across both traces
- Match by (table + SQL shape + input shape hash)
- If identical insert events in both traces → the operation is not idempotent → High
- Evidence: both event IDs from both traces

#### T6.9 — Reliability rule: `reliability.transaction_missing`

- Single-trace pattern detection (risk indicator, not a confirmed bug)
- Multiple `db_query` write events affecting different tables without a wrapping `transaction_start`
- Severity: Medium (risk pattern — not a proven issue)

#### T6.10 — Scenario runner: server lifecycle (`packages/scenario-runner`)

- `ServerManager` class:
  - `start(config: ServerConfig): Promise<void>`
  - Spawn server process: `child_process.spawn(config.startCommand, { shell: true })`
  - Capture stdout + stderr to `.tracegraph/runs/{runId}/server.stdout.log` and `server.stderr.log`
  - Readiness check (AND mode when both configured):
    - `readyPattern`: scan stdout + stderr lines for regex match
    - `healthCheck.url`: poll with `fetch()` at `intervalMs` up to `timeoutMs`
  - `readinessMode` override: `all | any | health | pattern | sleep`
  - `stop()`: SIGTERM → wait 5s → SIGKILL

#### T6.11 — Scenario runner: HTTP execution (`packages/scenario-runner`)

- `ScenarioRunner.run(scenario: TraceScenario, config): ScenarioResult`
- For `input_variation`: iterate `inputMatrix[]`, send each request, collect trace per request
- For `idempotency`: send the same request twice (same body, headers, idempotency key if configured)
- For `concurrency` (basic): `Promise.all([...requests])` with configurable parallelism
- Each request: inject `x-tracegraph-scenario-id` and `x-tracegraph-correlation-id` headers
- After all requests: wait for async jobs (`jobWaitMs` config)
- Collect traces by scenario + correlation ID
- Run `diffToFindings()` on collected traces (idempotency, concurrency violations)

#### T6.12 — CLI: `tracegraph scenario run` (`packages/cli`)

```
tracegraph scenario run ./scenarios/payment-idempotency.json [--server-url http://localhost:3000]
```

- Load and validate scenario JSON (`schemaVersion: "tracegraph.scenario.v1"`)
- Start server if `server.startCommand` configured (T6.10)
- Run `ScenarioRunner.run()` (T6.11)
- Collect all traces into bundle
- Run security + reliability rules on collected traces
- Write scenario report to `.tracegraph/reports/scenario-{name}.report.json`
- Emit findings over stdout (`finding` envelope)
- Exit 0/1/4 per standard exit codes

#### T6.13 — Sample scenarios (`sample-projects/express-typescript/scenarios/`)

```
scenarios/
├── invoice-idempotency.json      — send same invoice creation twice, expect no duplicate insert
├── invoice-input-variation.json  — missing fields, negative amount, unsupported currency
└── invoice-concurrent.json       — 3 concurrent invoice creations (basic concurrency)
```

---

### Exit criteria — M6

- [ ] `tracegraph compare` on trace where auth middleware removed → `Critical: authorization middleware removed from PUT /users/{id}/role`
- [ ] `tracegraph compare` on trace with `passwordHash` in response → `High: sensitive field in response`
- [ ] Single trace with 5 identical `SELECT * FROM products WHERE id = ?` → `Medium: N+1 query detected (5 repetitions)`
- [ ] `tracegraph scenario run ./scenarios/invoice-idempotency.json` → `High: duplicate DB insert detected on second request`
- [ ] Suppression file modified in PR → `High: suppression file modified` in CI report + exit 4
- [ ] Scenario runner starts a real Express server, sends requests, shuts it down cleanly

---

## Milestone 7 — Commercial Labs

**Goal:** AI Code Assurance explains a security regression in plain English on a PR;
Team Server manages baselines with reviewer approvals; Reliability Lab detects a
concurrent wallet debit race condition.

This milestone is the paid tier. All features behind `TRACEGRAPH_TOKEN` or self-hosted Team Server.

### Packages

| Package | Status |
|---------|--------|
| `@tracegraph/ai-code-assurance` | New (commercial) |
| `@tracegraph/reliability-lab` | New (commercial) |
| `@tracegraph/security-lab` | New (commercial) |
| `@tracegraph/team-server` | New (commercial) |
| `@tracegraph/github-app` | New (commercial) |

---

### Tasks

#### T7.1 — Full Reliability Lab (`@tracegraph/reliability-lab`)

Building on M6's basic scenario runner:

- **Advanced concurrency**: run N concurrent requests, collect traces simultaneously,
  detect read-before-write and write-write conflicts on the same resource key within overlapping time windows
- **Cache stampede**: concurrent cache miss → repeated identical DB queries within overlapping traces → High
- **Deadlock risk**: inconsistent lock ordering across overlapping traces (`lock_acquire` events on same resources in different order) → High
- **Queue race**: job dispatched before transaction commit (pre-commit dispatch detection); stale reads from job using pre-commit data
- **Full fault injection**: `FaultDefinition` types — DB error on N-th query, external API timeout after N ms, cache failure, queue failure, network partition
- **Rate limit test**: burst traffic scenario, verify 429 returned at threshold, detect fail-open (burst reaches protected logic without block)
- All scenarios produce `TraceBundle` with cross-request links for the bundled visualiser

#### T7.2 — Full Security Lab (`@tracegraph/security-lab`)

- **BOLA/IDOR detection with ownership config**:
  - Config: `{ "orders": { "ownerField": "user_id", "actorField": "auth.user.id" } }`
  - Compare actor ID from `authorization_check.metadata.userId` with owner field from `db_query.output`
  - Flag: actor accessed resource not owned by actor → Critical
- **Taint tracking v2** (lightweight):
  - `TaintedValue`: `{ valueHash, source, fieldPath, taintId }`
  - Track taint IDs through event `input` → `output` across function chain
  - Detect tainted value reaching `db_query.sql` (injection), `external_http_call.url`, `file_operation.path`
- **Full injection pattern library**: SQL concatenation heuristics, shell sink patterns, template injection markers, SSRF destination patterns
- **Automated security scenarios**: generate scenario files from ownership config for BOLA testing, auth bypass, mass assignment

#### T7.3 — AI Code Assurance (`@tracegraph/ai-code-assurance`)

- Input: behaviour diff report + git diff of changed files + project context
- Claude API integration (claude-sonnet-4-6, with prompt caching on diff context)
- Outputs per critical/high finding:
  - Plain-English explanation: "This PR removes the `RolePolicy.update` check from the update-user-role flow. An authenticated user can now escalate their own role to admin without authorisation."
  - Risk classification: data exposure, privilege escalation, broken auth, etc.
  - Suggested fix: "Re-add `$this->authorize('update', $user)` before the repository call"
- Missing edge case suggestions: "These input paths were never traced: amount < 0, amount = 0, currency = unsupported"
- AI-generated scenario JSON from finding:
  ```json
  {
    "name": "non-admin user cannot escalate role",
    "type": "security",
    "request": { "method": "PUT", "url": "/users/USER_200/role", ... },
    "expect": { "status": [401, 403], "mustNotWrite": ["users.role"] }
  }
  ```
- PR comment format: runtime assurance report + AI explanation + generated scenario + severity badge

#### T7.4 — Team Server (`@tracegraph/team-server`)

- REST API (Express or Fastify) + React web UI
- **Team baselines**: store, version (git-like history), approve/reject with diff preview
- **Reviewer assignment**: CODEOWNERS-style rules — `/payments/**` requires `@security-team`
- **RBAC**: developer (submit), reviewer (approve), security-owner (approve security suppressions), admin
- **Audit log**: every approval, rejection, suppression change logged with timestamp + user + PR link
- **Dashboard**: per-project finding trend (30-day rolling), capture level health, baseline staleness alerts
- **Suppression governance**: security suppressions require security-owner role + expiry + compensating evidence
- **Webhook notifications**: Slack/Teams on critical finding, reviewer assignment, expiry approaching
- **Self-hosted option**: Docker image + Helm chart for enterprise deployment

#### T7.5 — GitHub App (`@tracegraph/github-app`)

Architecture: receives merged report artifacts from CI (does not run tests itself).

- Webhook receiver: `pull_request.opened`, `pull_request.synchronized`, `check_run.completed`
- When merged report artifact is uploaded by CI → download + process
- Post rich PR comment:
  - Findings table with severity + affected route + fix recommendation
  - AI explanation per finding (from T7.3)
  - Capture level status
  - "Approve behaviour change" / "Suppress finding" buttons (team tier)
- Baseline approval UI: inline in PR comment, with reason + expiry input
- Self-hosted GitHub App: deploy alongside Team Server for enterprise
- Community limitation: basic PR comment without approval workflow (no Team Server needed)

#### T7.6 — OTLP export (`packages/ci-reporter`)

- `tracegraph export otlp <trace-file> --endpoint <otlp-endpoint>`
- Map `TraceSession.events` → OTLP spans:
  - `http_request` → root span
  - `function_call` / `method_call` → child spans
  - `db_query` → `db.*` semantic conventions
  - `external_http_call` → `http.*` semantic conventions
- Map findings → span attributes: `tracegraph.finding.severity`, `tracegraph.finding.ruleId`
- Support Datadog (`--format datadog`), Honeycomb, Jaeger, Grafana Tempo endpoints
- Useful for teams that want TraceGraph findings surfaced in existing observability dashboards

#### T7.7 — Trace replay (`packages/cli`)

- `tracegraph replay <traceId> [--server-url <url>] [--map-auth <env-var>]`
- Read captured `http_request` event: method, URL, query, sanitised body
- Reconstruct request: strip `x-tracegraph-*` headers, substitute auth token from env
- Send to `--server-url` (default: `tracegraph.config.json` `server.url`)
- Collect new trace → compare with original → show diff
- Safety guards:
  - Never replay `cardNumber`, `cvv`, `pin` fields (hard block)
  - Never replay to production URLs (check against `protectedRoutes` + `server.url` sanity check)
  - `--allow-external-calls` required to replay requests with outbound calls
  - Interactive confirmation in TTY mode

#### T7.8 — GitLab CI + Bitbucket support

- `tracegraph report --format gitlab-mr-comment` → outputs GitLab Merge Request note format
- `tracegraph report --format bitbucket-pr-comment` → outputs Bitbucket PR comment format
- `.gitlab/tracegraph-component.yml` — reusable GitLab CI component with `include:`
- Documentation: migration guide from GitHub Actions to GitLab CI

---

### Exit criteria — M7

- [ ] AI Code Assurance PR comment explains in plain English: "This PR removes RolePolicy.update, allowing privilege escalation"
- [ ] AI generates a valid `scenario.json` for a detected security finding
- [ ] Concurrent wallet debit scenario (2 simultaneous requests) → `High: concurrent write conflict detected on wallets.balance`
- [ ] Team Server shows baseline approval workflow: submit → reviewer assigned → approved with reason → audit log entry
- [ ] `tracegraph export otlp` produces OTLP spans visible in Jaeger UI with finding attributes
- [ ] `tracegraph replay <traceId>` re-sends the captured request and shows diff between original and replayed trace

---

## Cross-Cutting Work (All Milestones)

These items span multiple milestones and should be tracked separately.

| Item | Start | Notes |
|------|-------|-------|
| Schema versioning and `tracegraph baseline migrate` | M2 | `SCHEMA_VERSIONS` constant gates all reads |
| `tracegraph diagnose` | M3 | Print actionable capture level upgrade path |
| `.github/workflows/tracegraph-ci.yml` refinement | M2 | Update as CI features are added |
| Sample project parity | Each milestone | Each adapter milestone adds a matching sample project |
| Sanitizer audit | M1 | Review redact key list quarterly |
| Finding rule library | M2–M6 | Each rule gets its own unit test file with 5+ scenarios |
| `tracegraph.config.json` JSON schema | M1 | Publish schema to `schemas/` for IDE autocomplete |
| Performance: large traces | M3 | Profile graph engine on traces with 5,000+ events |
| Windows path handling | M1 | Verify atomic rename and file watcher on Windows |

---

## Dependency Graph (Milestones)

```
M0 (file protocol)
  └── M1 (Express + HTML viewer)
        ├── M2 (diff + baseline)
        │     ├── M3 (Vitest/Jest adapters)
        │     │     └── M6 (security + reliability)
        │     │           └── M7 (Commercial Labs)
        │     └── M4 (Laravel adapter)
        │           └── M6
        └── M5 (VS Code viewer) ─ depends on M1, benefits from M2
```

M3 and M4 can be developed in parallel after M2. M5 can begin in parallel with M3/M4
but benefits from having real multi-event traces (M4) to test the timeline and error path views.

---

## Milestone Summary

| Milestone | User-visible outcome | Key packages | Rough complexity |
|-----------|---------------------|--------------|-----------------|
| M0 | File protocol integration test passes | `shared-types`, `trace-core`, `cli` | S |
| M1 | Real Express trace rendered in browser | `trace-js`, `graph-engine`, `webview`, `cli` | M |
| M2 | `compare` flags removed validation | `graph-engine`, `ci-reporter`, `cli`, `webview` | L |
| M3 | Per-test traces, capture level banner | `trace-js` (Vitest/Jest), `cli` | M |
| M4 | Full Laravel semantic trace | `trace-php`, `tracegraph/laravel`, `cli` | L |
| M5 | VS Code graph + source navigation | `vscode-extension`, `webview` | M |
| M6 | Auth finding + N+1 + idempotency scenario | `graph-engine`, `scenario-runner`, `cli` | L |
| M7 | AI PR comment + Team Server + Reliability Lab | Commercial packages | XL |

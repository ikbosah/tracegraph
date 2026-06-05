<p align="center">
  <img src="assets/tracegraph_logo_transparent.png" alt="TraceGraph Logo" width="420" />
</p>

# TraceGraph

AI-generated code needs to be kept on a leash. A thousand-file diff is not useful if the human still has to manually inspect every change to understand what broke, what shifted, or what quietly changed behavior. That is the new bottleneck in software development: not generating code, but reviewing it with confidence. The real challenge is making sure AI-generated changes do not introduce bugs, remove important safeguards, or deviate from the system's expected behavior.

> A test tells you whether an assertion passed.

> TraceGraph shows you what the code actually did.

TraceGraph captures what your code actually does at runtime, turns execution into an interactive behavior graph, and helps teams detect risky changes before software reaches production. It is designed for modern development workflows where code is written by humans, AI coding tools, or both, and where passing tests alone may not be enough to know whether a release is safe.


## Core Feature

TraceGraph turns this:

```text
Tests passed.
```

Into this:

```text
Tests passed, but runtime behavior changed:

- validateCouponExpiry() was removed from POST /invoices
- invoices table write still occurred
- authorization check remained present
- response shape added discountOverride
- external call count unchanged
```

TraceGraph helps you move from simple pass/fail testing to **runtime evidence-based review**.


## Quick Start

Install TraceGraph:

```bash
npm install -D @tracegraph/cli @tracegraph/trace-js
```

Run your test suite under TraceGraph:

```bash
npx tracegraph run -- npm test
```

Create a baseline from the current behavior:

```bash
npx tracegraph baseline create
```

Make your changes, then run again and compare:

```bash
npx tracegraph run -- npm test
npx tracegraph compare
```

Open an interactive behavior graph in your browser:

```bash
npx tracegraph open --html
```

Or use the faster onboarding path that walks you through setup interactively:

```bash
npx tracegraph quick
```


## CLI Commands

```bash
# Core loop
tracegraph run -- <test command>      # Capture runtime traces
tracegraph baseline create            # Approve current behavior as baseline
tracegraph compare                    # Diff latest run against baseline
tracegraph report                     # Generate markdown / JSON / HTML report
tracegraph open --html                # Self-contained offline HTML report

# Onboarding
tracegraph quick                      # Interactive guided setup
tracegraph adopt                      # Analyse an existing project, suggest setup steps
tracegraph init                       # Add tracegraph scripts to package.json
tracegraph diagnose                   # Show capture level and improvement recommendations

# Baselines and findings
tracegraph baseline list              # List all baselines
tracegraph baseline approve <id>      # Approve a specific baseline
tracegraph baseline suggest-update    # AI-assisted baseline review
tracegraph finding list               # List all open findings
tracegraph finding approve <id>       # Accept a specific finding
tracegraph finding suppress <id>      # Suppress with optional evidence requirement
tracegraph finding explain <id>       # Human-readable finding detail + recommendation
tracegraph replay                     # Replay a previous trace through the current engine

# Scenarios
tracegraph scenario run <file>        # Run an HTTP scenario and write a TraceBundle
tracegraph scenario validate <file>   # Validate scenario file without running
tracegraph scenario list              # List all .scenario.json files

# AI coverage and code generation
tracegraph coverage                   # Map git diff to runtime coverage
tracegraph pack                       # Export prompt packs for Cursor / Claude / Copilot / MCP
tracegraph testgen                    # Generate missing tests from uncovered changed functions

# Auditing external repositories
tracegraph audit <github-url>         # Clone a GitHub repo, audit an open PR, report findings

# Team server
tracegraph server start               # Start local Team Server
tracegraph upload                     # Upload trace artifacts to Team Server
tracegraph pull                       # Pull shared baselines and suppressions

# Utilities
tracegraph schema doctor              # Check artifact schema versions
tracegraph baseline migrate           # Upgrade baseline schema versions
tracegraph import xdebug <file>       # Import a PHP Xdebug .xt trace file
tracegraph ci-summary                 # Write GitHub Actions step summary
tracegraph clean                      # Remove old run directories
```


## Capture Levels

Every trace includes a capture level that describes how deeply the runtime was instrumented:

| Level | Mechanism | What is captured |
|-------|-----------|-----------------|
| 0 | Runner metadata only | Test names, pass/fail counts |
| 1 | Framework adapters | Express middleware, Laravel hooks — HTTP, DB, auth, queue events |
| 2 | Manual wrappers | `traceFunction()` / `traceMethod()` on specific functions |
| 3 | CJS require hook | All `require()`-loaded modules — function and method calls |
| 4 | ESM import hook | ESM-native modules (`.mts`, `.mjs`) alongside Level 3 |
| 5 | Test runner reporter | Per-test traces via Vitest / Jest / PHPUnit reporters |

Levels 3–5 are injected non-invasively via `NODE_OPTIONS` or the `--reporter` flag — no source files are modified.

The capture level appears in every trace artifact, CLI output, HTML report, and CI summary.


## Language and Framework Support

### Node.js / TypeScript

```bash
# Express middleware — HTTP, outbound calls, errors (Level 1)
import { traceExpress } from '@tracegraph/trace-js/express';
app.use(traceExpress());

# CJS hook — all require()'d modules (Level 3, non-invasive)
NODE_OPTIONS='--require @tracegraph/trace-js/register-cjs' npm test

# ESM hook — ESM-native modules (Level 4, non-invasive)
NODE_OPTIONS='--import @tracegraph/trace-js/register' npm test

# Manual wrappers (Level 2)
import { traceFunction } from '@tracegraph/trace-js';
const traced = traceFunction(myFunction, { name: 'myFunction' });
```

Supported test runners:

| Runner | Integration | Notes |
|--------|-------------|-------|
| **Vitest 1–4** | `@tracegraph/vitest` reporter | Per-test traces; Level 5; ESM and CJS builds |
| **Jest** | `@tracegraph/jest` reporter | Per-test traces; Level 5 |
| **Mocha** | Level 3 hook | HTTP and function events in one combined trace |

### PHP / Laravel

```bash
# Composer install
composer require tracegraph/laravel

# Laravel auto-discovery registers TraceServiceProvider automatically
# Adds: HTTP middleware, DB::listen, Gate hooks, Queue lifecycle
```

```xml
<!-- PHPUnit 10/11 — add to phpunit.xml for per-test traces (Level 5) -->
<extensions>
  <bootstrap class="Tracegraph\Laravel\Testing\TraceGraphPhpUnitExtension"/>
</extensions>
```

```bash
# Run tests with per-test traces
php artisan test

# Import an Xdebug .xt trace for deep call-stack detail
tracegraph import xdebug ./storage/logs/trace.xt
```

Supported:

| Framework | Events captured |
|-----------|----------------|
| **Laravel** | HTTP request/response, DB queries (SQL + table + operation), Gate/Policy checks, Queue dispatch + job lifecycle, exceptions |
| **PHPUnit 10/11** | Per-test JSONL traces via PHPUnit Extension API |
| **Pest** | Compatible (Pest wraps PHPUnit 10/11) |
| **Xdebug** | Full call stack merged with semantic Laravel events |


## Example Finding

```text
High Risk: Validation step removed

Route:
POST /invoices

Baseline behavior:
InvoiceController.store
 → validateCustomer
 → validateCouponExpiry
 → InvoiceService.create
 → DB write: invoices

Candidate behavior:
InvoiceController.store
 → validateCustomer
 → InvoiceService.create
 → DB write: invoices

Impact:
The candidate release removed validateCouponExpiry() while still creating invoices.

Recommendation:
Confirm whether coupon expiry validation was moved elsewhere.
If intentional, approve the new baseline with compensating evidence.
```


## Security and Reliability Rules

TraceGraph analyses runtime traces for security and reliability problems automatically:

| Rule | Category | Trigger |
|------|----------|---------|
| `security.authorization.middleware_removed` | Security | Route-level auth middleware removed from a protected endpoint |
| `security.sensitive_data.in_response` | Security | `password`, `api_key`, `accessToken` or similar fields in response output |
| `behavior.authorization.removed` | Security | Authorization check present in baseline is absent in candidate |
| `reliability.n_plus_one_query` | Reliability | ≥5 identical (table, operation) DB queries in a single trace |
| `reliability.duplicate_side_effects` | Reliability | Duplicate queue dispatches or repeated non-idempotent outbound calls |
| `reliability.missing_transaction` | Reliability | Writes to ≥2 tables without a wrapping transaction event |
| `policy.suppressions_modified` | Policy | Suppressions file modified since last baseline (reopens if evidence disappears) |

Each finding has a stable fingerprint based on rule, route, class, and method — not file path — so it survives refactors.


## Approvals and Suppressions

TraceGraph separates three distinct concepts:

```text
Baseline approval  = updates expected behavior going forward.
Finding approval   = accepts one specific finding instance.
Suppression        = conditionally hides a recurring finding
                     only while compensating evidence still exists.
```

A suppression with `requiresEvidence` is re-evaluated on every run. If the compensating control disappears, the finding reopens automatically:

```json
{
  "ruleId": "security.authorization.middleware_removed",
  "semanticTarget": {
    "routeMethod": "PUT",
    "routePathPattern": "/users/{id}/role"
  },
  "requiresEvidence": [
    { "type": "authorization_check", "name": "RolePolicy.update" }
  ],
  "reason": "Authorization moved from middleware to policy",
  "expiresAt": "2026-08-01"
}
```

Suppression files are treated as security-sensitive. If a PR modifies `tracegraph.suppressions.json`, TraceGraph emits a distinct `policy.suppressions_modified` finding that can be gated on a designated reviewer.

Batch operations for CI:

```bash
tracegraph finding approve --all --run-id <id>
tracegraph finding suppress --all --reason "known regression"
```


## Semantic Baselines

Baselines store compact semantic signatures, not raw traces. They record which events occurred, what resources were touched, and what authorization checks were present — without capturing volatile values like IDs or timestamps:

```json
{
  "schemaVersion": "tracegraph.baseline.v1",
  "entrypoint": "POST /invoices",
  "events": [
    {
      "signature": {
        "eventType": "method_call",
        "className": "InvoiceService",
        "methodName": "create",
        "role": "business_logic"
      },
      "count": 1
    },
    {
      "signature": {
        "eventType": "authorization_check",
        "className": "InvoicePolicy",
        "methodName": "create",
        "role": "authorization"
      },
      "count": 1,
      "critical": true
    }
  ],
  "resources": [
    { "type": "database_table", "key": "invoices", "operation": "write", "count": 1 }
  ]
}
```

Baselines are small enough to commit to git. Raw traces stay local and are pruned automatically.

The diff engine uses **multiset comparison** to distinguish "called once" from "called three times" — catching N+1 regressions and duplicate side effects that scalar presence checks miss.


## VS Code Extension

The TraceGraph VS Code extension provides:

- **Sidebar** with trace files, baselines, findings grouped by severity, and scenario files
- **Interactive graph panel** — clickable behavior graph with node detail and source navigation
- **Timeline view** — Gantt-style proportional event duration bars
- **Error path view** — causal chain from error events to trace root, with HTTP status intelligence
- **Source navigation** — clicking any node with a `file` + `line` opens the source file at the right line
- **Auto-refresh** — file watcher picks up new traces, baselines, and reports as they are written
- **`tracegraph.runLatest`** command — spawns the CLI and streams output to an Output Channel

Install from the VS Code Marketplace or build the `.vsix` from source.


## Server Mode

For long-running servers (development or staging), TraceGraph can capture a separate trace per HTTP request rather than one combined trace for the whole process lifetime:

```bash
tracegraph run --server-mode -- node server.js
```

In server mode, each incoming request gets its own `traceId` and its own `.events.jsonl.tmp` file. The finaliser writes a `.trace.json` for each request as it completes, without stopping the server.


## Scenario Runner

Define multi-step HTTP scenarios and capture cross-service traces linked into a single `TraceBundle`:

```json
{
  "name": "create-invoice-flow",
  "servers": [{ "name": "api", "command": "node server.js", "port": 3000 }],
  "steps": [
    { "name": "health", "request": { "method": "GET", "url": "http://localhost:3000/health" } },
    { "name": "create", "request": { "method": "POST", "url": "http://localhost:3000/invoices",
        "body": { "customerId": "C-001", "amount": 500 } } }
  ]
}
```

```bash
tracegraph scenario run .tracegraph/scenarios/create-invoice.scenario.json
tracegraph compare --bundle .tracegraph/bundles/create-invoice-flow.bundle.json
```

TraceBundle links `external_http_call` events in one trace to `http_request` events in another via `x-tracegraph-correlation-id` headers, enabling end-to-end behavioral diff across services.


## AI Coverage and Code Generation

### Runtime coverage of changed functions

```bash
# Show which changed functions were exercised by the test suite
tracegraph coverage --base main --head HEAD

# Export context packs for your AI coding tool
tracegraph pack --format cursor          # .cursor/tracegraph-context.md
tracegraph pack --format claude-code     # CLAUDE.md XML block
tracegraph pack --format copilot         # .github/copilot-instructions.md
tracegraph pack --format mcp             # .tracegraph/mcp-context.json
```

### Test generation from gaps

```bash
# Generate tests for uncovered changed functions
tracegraph testgen --framework vitest
tracegraph testgen --framework jest
tracegraph testgen --framework phpunit
tracegraph testgen --framework pytest
```

### AI-assisted baseline review

```bash
# Suggest which baselines are safe to auto-approve vs. need human review
tracegraph baseline suggest-update
```


## Auditing External Repositories

`tracegraph audit` clones a GitHub repository, scores its open pull requests for behavioral risk, runs the test suite on both the base branch and the PR branch, compares runtime behavior, and generates a findings report — all non-invasively without modifying any tracked source files:

```bash
tracegraph audit https://github.com/expressjs/express --skip-fork
tracegraph audit https://github.com/laravel/framework --pr 54321
```

**What it does:**

1. Fetches open PRs, scores them by keyword, activity, size, and labels
2. Clones the repo to `~/.tracegraph/audits/`
3. Detects the stack (Node.js, PHP, Python, Java, Go, .NET)
4. Installs dependencies non-interactively
5. Injects tracegraph instrumentation — non-invasively for most stacks; invasively for PHP (modifies `phpunit.xml`) and Vitest (wrapper config `vitest.config.tracegraph.ts`)
6. Runs tests on the base branch → creates baseline
7. Checks out the PR branch → runs tests again
8. Compares and generates a full behavioral diff report

**Invasive injection detail:**

For PHP repos (PHPUnit 10/11), injects `TraceGraphPhpUnitExtension` by patching `phpunit.xml` and writing a bootstrap chainer — re-injected after the PR branch checkout so the extension survives `git checkout -- .`.

For Vitest repos, writes `vitest.config.tracegraph.ts` (untracked, deleted after the audit) that uses `mergeConfig()` to add the reporter without touching any tracked file. Passes `-- --config vitest.config.tracegraph.ts` through the package manager script, bypassing Turbo/nx flag-swallowing.


## Team Server

A self-hosted Team Server provides shared baselines, findings, and suppressions across the team:

```bash
# Start with Docker Compose
docker compose up -d

# Upload artifacts after a CI run
tracegraph upload --server https://your-team-server.internal

# Pull shared baselines and suppressions
tracegraph pull --server https://your-team-server.internal
```

The Team Server exposes a REST API with token authentication, stores artifacts in SQLite, and handles multi-project routing. Docker Compose setup is provided out of the box.


## CI Integration

### Native GitHub Action

```yaml
- uses: tracegraph/action@v1
  with:
    command: npm test
    baseline-id: main
    fail-on: critical
    github-token: ${{ secrets.GITHUB_TOKEN }}
```

### Manual workflow

```yaml
name: TraceGraph Behaviour Analysis

on:
  pull_request:

jobs:
  tracegraph:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - run: npm ci

      - name: Run tests with TraceGraph
        run: npx tracegraph run -- npm test

      - name: Compare runtime behavior
        run: npx tracegraph compare --fail-on-critical

      - name: Publish step summary
        run: npx tracegraph ci-summary
        if: always()

      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: tracegraph-report
          path: .tracegraph/reports/
```

Exit codes from `tracegraph compare`:

| Code | Meaning |
|------|---------|
| 0 | No findings, or all findings approved |
| 1 | CLI error |
| 2 | No traces captured |
| 3 | Critical findings present (`--fail-on-critical`) |
| 4 | Suppressions file modified — policy review required |
| 5 | Schema version mismatch |
| 6 | Capture level too low |


## Async and Concurrent Execution

TraceGraph supports async branch metadata for JavaScript and TypeScript, letting it represent concurrent execution paths that normal call stacks miss:

```ts
const [user, orders] = await Promise.all([
  getUser(id),
  getOrders(id),
]);
```

```text
HTTP Request
└── Promise.all group
    ├── Branch A: getUser
    │   └── DB query: users
    └── Branch B: getOrders
        └── DB query: orders
```


## Cross-Trace Causality

Queue jobs, background tasks, and async downstream services are linked as causally related traces:

```text
POST /orders
 → dispatch SendOrderEmailJob [causedTraceId: trace_abc]

Later — SendOrderEmailJob.handle() [causalParentRef: trace_xyz → dispatch event]
 → send email via Mailgun
```

The `TraceBundle` format links these across language and service boundaries using `x-tracegraph-correlation-id` headers.


## Storage

```bash
# Check storage usage
tracegraph storage status

# Prune old runs
tracegraph clean
tracegraph clean --older-than 7d
tracegraph clean --keep-last 20
```

Recommended `.gitignore`:

```gitignore
.tracegraph/runs/
.tracegraph/traces/
.tracegraph/reports/
```

Recommended committed files:

```text
.tracegraph/baselines/
.tracegraph/scenarios/
tracegraph.config.json
tracegraph.suppressions.json
```


## Architecture

```text
TraceGraph
│
├── CLI (packages/cli)
│   ├── run / compare / baseline / report / open
│   ├── finding / scenario / coverage / pack / testgen
│   ├── audit / quick / adopt / init / diagnose
│   ├── server / upload / pull
│   └── schema / clean / replay / ci-summary
│
├── Language Adapters
│   ├── @tracegraph/trace-js      — Express, CJS hook, ESM hook, traceFunction
│   ├── @tracegraph/vitest        — Vitest 1–4 reporter (Level 5)
│   ├── @tracegraph/jest          — Jest reporter (Level 5)
│   └── tracegraph/laravel        — Laravel middleware, DB, Gate, Queue, PHPUnit extension
│
├── Trace Core (packages/trace-core)
│   ├── ID generation, JSONL writer, atomic finaliser
│   ├── Trace reader, storage manager
│   └── Xdebug .xt parser + Laravel merger
│
├── Graph Engine (packages/graph-engine)
│   ├── traceSessionToGraph — nodes, edges, colors
│   ├── buildCompactBaseline — semantic signature set
│   ├── diffBaseline — BehaviorDiff (multiset added/removed)
│   ├── diffToFindings — Finding[] with stable fingerprints
│   ├── analyseTraceFindings — N+1, duplicate side effects, missing tx
│   └── renderGraphSvg — pure SVG (no browser dependency)
│
├── Trace Sanitizer (packages/trace-sanitizer)
│   └── Redaction, depth limits, UUID/timestamp normalisation
│
├── Scenario Runner (packages/scenario-runner)
│   ├── ServerManager — spawn, health-check, graceful shutdown
│   ├── HTTP runner — step execution with correlation header injection
│   └── Bundle linker — cross-trace TraceBundle assembly
│
├── AI Coverage (packages/ai-coverage)
│   ├── Git diff → changed function extraction
│   ├── Trace scanner — runtime coverage mapping
│   ├── Prompt pack builder — Cursor / Claude Code / Copilot / MCP
│   └── Test generator — framework-specific test stubs
│
├── CI Reporter (packages/ci-reporter)
│   └── Markdown / JSON / GitHub step summary renderer
│
├── Team Server (packages/team-server)
│   └── REST API + SQLite + Docker Compose
│
└── Viewers
    ├── apps/webview        — React graph, timeline, error path (bundled into CLI)
    └── apps/vscode-extension — Sidebar, graph panel, source navigation
```


## Why TraceGraph?

Modern software teams move fast. AI coding tools make teams move even faster. A normal code diff shows what changed in files. A normal test result shows whether assertions passed. But faster code generation creates a new problem:

> How do you know what the generated or changed code actually did when it ran?

TraceGraph helps answer questions like:

- Did this PR remove a validation step?
- Did this endpoint still call authorization before writing to the database?
- Did a passing test hide a new side effect?
- Did this change add a new external API call?
- Did the response shape change?
- Did a database write increase from one write to three?
- Did AI-generated code introduce a risky behavior change?
- Did a critical flow still behave like the approved baseline?


## What TraceGraph Is Not

TraceGraph is not a replacement for unit tests, integration tests, static analysis, code review, formal verification, or observability tools. It complements all of these by adding runtime behavior evidence to the development and release process.


## Contributing

Contribution guidelines will be published as the project matures.

Expected contribution areas:

- Language adapters (Java, Python, .NET, Go)
- Framework integrations
- Trace schema design
- Graph visualization
- Runtime verification rules
- CI integrations
- Documentation
- Sample applications

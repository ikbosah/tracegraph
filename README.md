<p align="center">
  <img src="assets/tracegraph_logo_transparent.png" alt="TraceGraph Logo" width="420" />
</p>

# TraceGraph

TraceGraph is a runtime assurance tool for AI-generated and human-written code. It runs alongside your existing tests, captures what the application actually did, and compares that behavior against approved baselines so reviewers can see exactly what changed before a release reaches production.

> A test tells you whether an assertion passed.
> TraceGraph shows you what the code actually did.

It is designed for development workflows where code is written by humans, AI coding tools, or both, and where passing tests alone is not enough to know whether a release is safe.


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
npx tracegraph open --html .tracegraph/traces/*.trace.json
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
tracegraph open --html <file>         # Self-contained offline HTML report

# Onboarding
tracegraph quick                      # Zero-config demo — creates a sample project and opens the viewer
tracegraph adopt                      # Adopt current runtime behaviour as the initial baseline for an existing codebase
tracegraph init                       # Add tracegraph scripts to package.json
tracegraph diagnose                   # Show capture level and improvement recommendations

# Baselines and findings
tracegraph baseline list              # List all baselines
tracegraph baseline approve <id>      # Approve a specific baseline
tracegraph baseline suggest           # Suggest high-priority baselines from traces and static graph
tracegraph baseline suggest-update    # AI-assisted review: safe to auto-approve vs. needs human review
tracegraph finding list               # List all open findings
tracegraph finding approve <id>       # Accept a specific finding
tracegraph finding suppress <id>      # Suppress with optional evidence requirement
tracegraph finding explain <id>       # Human-readable finding detail + recommendation
tracegraph replay                     # Re-execute recorded HTTP requests against a live server

# Scenarios
tracegraph scenario run <file>        # Run an HTTP scenario and write a TraceBundle
tracegraph scenario validate <file>   # Validate scenario file without running
tracegraph scenario list              # List all .scenario.json files

# AI coverage and code generation
tracegraph coverage                   # Map git diff to runtime coverage
tracegraph pack                       # Export prompt packs for Cursor / Claude / Copilot / MCP
tracegraph testgen                    # Generate missing tests from uncovered changed functions

# Static architecture analysis
tracegraph scan                       # Risk scan without a baseline — uses static call graph
tracegraph graph build                # Build a static call graph from source
tracegraph graph status               # Show graph stats (nodes, edges, communities, god nodes)
tracegraph graph open                 # Open static graph in browser
tracegraph graph update               # Rebuild graph and refresh the index
tracegraph graph communities          # List detected communities and cross-community edges
tracegraph graph doctor               # Diagnose graph build quality
tracegraph architecture baseline create   # Snapshot current graph as architecture baseline
tracegraph architecture baseline status   # Show stored architecture baseline
tracegraph architecture compare           # Diff current graph vs baseline; --fail-on-critical

# Auditing external repositories
tracegraph audit <github-url>         # Clone a GitHub repo, audit an open PR, report findings

# Team server
tracegraph server start               # Start local Team Server
tracegraph upload                     # Upload trace artifacts to Team Server
tracegraph pull                       # Pull shared baselines and suppressions

# MCP server
tracegraph mcp start                  # Start MCP JSON-RPC 2.0 server for AI tool integration

# Utilities
tracegraph schema doctor              # Check artifact schema versions
tracegraph baseline migrate           # Upgrade baseline schema versions
tracegraph import xdebug <file>       # Import a PHP Xdebug .xt trace file
tracegraph ci-summary                 # Write GitHub Actions step summary
tracegraph clean                      # Remove old run directories
```

> See the [User Guide](GUIDE.md) for the full reference on every command, flag, and adapter.


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

## Assurance Levels

TraceGraph computes an **assurance level** (0–5) for every compare run and coverage report, combining capture quality and baseline coverage:

| Level | Label | What it means |
|-------|-------|---------------|
| 0 | No evidence | No traces captured or no baseline to compare against |
| 1 | Static only | Static graph available; no runtime trace coverage |
| 2 | Partial runtime | Runtime traces captured but no approved baselines |
| 3 | Baseline-lite | Baselines present; static-graph only, no runtime baseline match |
| 4 | Runtime baseline | Runtime baseline matched; captures below Level 5 |
| 5 | Full assurance | Per-test Level 5 traces + runtime baseline matched |

The assurance level is visible in the CI report and can gate CI via `tracegraph compare --min-assurance 4` (exits code 8 when level is too low).

**Capture Depth, Evidence Assurance, and Architecture Quality are separate scales.** A run can have Capture Level 5 (per-test traces via Vitest) but Evidence Assurance Level 4 if it has a runtime baseline match but no static graph. Architecture Quality is tracked independently via `tracegraph architecture compare`. You can combine all three for maximum confidence.


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

# Manual wrappers (Level 2) — two equivalent signatures:
import { traceFunction } from '@tracegraph/trace-js';
const traced = traceFunction('MyService.myMethod', myFunction);      // name-first
const traced = traceFunction(myFunction, { name: 'MyService.myMethod' }); // function-first
```

Supported test runners:

| Runner | Integration | Notes |
|--------|-------------|-------|
| **Vitest 1–4** | `@tracegraph/vitest` reporter | Per-test traces; Level 5; ESM and CJS builds |
| **Jest** | `@tracegraph/jest` reporter | Per-test traces; Level 5 |
| **Mocha** | Level 3 hook | HTTP and function events in one combined trace |

### PHP / Laravel

```bash
# Composer install (--dev is recommended; TraceGraph should not run in production)
composer require --dev tracegraph/laravel

# Laravel auto-discovery registers TraceServiceProvider automatically
# Adds: HTTP middleware, DB::listen, Gate hooks, Queue lifecycle
```

```xml
<!-- PHPUnit 10/11 — add to phpunit.xml for per-test traces (Level 5) -->
<extensions>
  <extension class="Tracegraph\Laravel\Testing\TraceGraphPhpUnitExtension"/>
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

TraceGraph separates three concepts that must not collapse into one:

- **Baseline approval** — updates expected behavior going forward for a route or test
- **Finding approval** — accepts one specific finding instance without changing the baseline
- **Suppression** — conditionally silences a recurring finding only while a compensating control (e.g. an auth check) is still present in the trace; reopens automatically if the control disappears

Suppression files are treated as security-sensitive: a PR that modifies `tracegraph.suppressions.json` triggers a `policy.suppressions_modified` finding that can require a designated reviewer to sign off.

See [User Guide §8](GUIDE.md) for the full approval and suppression workflow.


## Semantic Baselines

Baselines store compact semantic signatures of what the application did — which events occurred, what resources were touched, which authorization checks were present — without capturing volatile values like IDs or timestamps. The diff engine uses **multiset comparison** so it catches N+1 regressions and duplicate side effects that scalar presence checks miss.

Baselines are small enough to commit to git. Raw traces stay local and are pruned automatically. See [User Guide §8](GUIDE.md) for schema details and migration.


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


## Static Architecture Analysis

TraceGraph can build a static call graph from your source tree and use it to:

- **Scan for risk without a baseline** — identify god nodes, high blast-radius functions, and sensitive communities that lack test coverage
- **Enrich runtime traces** — link runtime events to their static graph node so findings carry confidence scores and evidence sources
- **Detect architecture drift** — compare the current graph against a committed architecture baseline and flag new cross-community edges

```bash
# Build the static call graph from source (optional — enriches all other commands)
tracegraph graph build

# Risk scan — no baseline required
tracegraph scan
# → Lists god nodes, untested high-risk nodes, and community coverage gaps

# Suggest which baselines to create next (scores by blast radius, coverage, and assurance)
tracegraph baseline suggest --top 10

# Commit the current architecture as a baseline
tracegraph architecture baseline create

# Detect drift on every PR
tracegraph architecture compare --fail-on-critical
# exits 3 when a new cross-community edge points into a sensitive community
```

**What the static graph provides:**

| Signal | Finding | Severity |
|--------|---------|----------|
| Node with high in-degree (god node) and no test trace | `architecture.god_node_untested` | High |
| High blast-radius node changed without trace coverage | `architecture.high_blast_radius` | High |
| Sensitive community (auth, payment) with no verified trace | `architecture.sensitive_community_unverified` | High |
| New cross-community runtime call not in architecture baseline | `architecture.surprise_edge` | Medium–High |
| New edge into a sensitive community | `architecture.sensitive_community_crossed` | High |

Static graph findings include a `confidence` score and `evidenceSources` list (e.g. `["static_graph", "runtime_trace"]`) so the report clearly distinguishes inferred from verified findings.


## MCP Server

TraceGraph exposes an **MCP (Model Context Protocol) server** so AI tools can query the static graph and runtime traces directly:

```bash
# Start the MCP server (JSON-RPC 2.0 over stdin/stdout)
tracegraph mcp start [--project-dir <path>] [--no-graph] [--no-traces] [--no-findings]
```

**Available MCP tools:**

| Tool | Description |
|------|-------------|
| `tracegraph.graph.get_node` | Fetch a node from the static graph by symbol name |
| `tracegraph.graph.get_neighbors` | Get direct callers and callees of a node |
| `tracegraph.graph.get_community` | Get all nodes in a community |
| `tracegraph.graph.get_god_nodes` | List god nodes by degree |
| `tracegraph.graph.find_path` | Find the shortest call path between two nodes |
| `tracegraph.trace.find_events_for_node` | Find runtime events matching a symbol name |
| `tracegraph.coverage.get_uncovered_changed_nodes` | Get changed functions with no runtime trace coverage |
| `tracegraph.findings.explain_with_architecture` | Explain a finding enriched with graph context |

Each tool degrades gracefully when data is unavailable — no crashes, helpful messages instead.


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

The **architecture dashboard** tracks graph snapshots over time, computes an architecture debt score `(godNodeRatio × 60 + crossEdgeDensity × 40) × 100`, and exposes a drift history API so teams can see how the static graph evolves across releases. Run `tracegraph compare --upload` to upload both traces and the current architecture snapshot automatically.


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
| 8 | Assurance level below minimum (`--min-assurance`) |


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
│   ├── scan / graph / architecture / mcp
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
├── Static Graph (packages/static-graph)
│   ├── Graph runner — builds static call graph from source
│   ├── Normaliser — community detection, god-node scoring, blast radius
│   ├── Indexer — symbol→node lookup, neighbour queries
│   ├── Findings — god_node_untested, high_blast_radius, surprise_edge, community drift
│   ├── Assurance — computeAssuranceLevel() (levels 0–5)
│   ├── Baseline suggest — priority-scored baseline recommendation engine
│   └── Architecture baseline — create / diff / compare cross-community edges
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
│   ├── REST API + SQLite + Docker Compose
│   └── Architecture dashboard — snapshot upload, drift history, debt score
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

TraceGraph is not a replacement for unit tests, integration tests, code review, formal verification, or observability tools. It is also not a traditional static analyser — runtime evidence is the source of truth, and static graph intelligence exists to enrich runtime findings, not replace them. TraceGraph complements all of the above by adding runtime behavior evidence to the development and release process.


## Documentation

| Document | What it covers |
|----------|---------------|
| [User Guide](GUIDE.md) | Every command, flag, adapter, CI workflow, configuration, troubleshooting |
| [GUIDE.md §7](GUIDE.md) | Full CLI command reference (all 26 commands) |
| [GUIDE.md §12](GUIDE.md) | Static architecture analysis and assurance levels |
| [GUIDE.md §13](GUIDE.md) | MCP server setup and tools |
| [GUIDE.md §15](GUIDE.md) | CI integration and GitHub Actions |
| [GUIDE.md §18](GUIDE.md) | Full configuration reference |


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

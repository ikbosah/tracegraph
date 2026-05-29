# TraceGraph — Complete User Guide

> **Version:** 0.1.4 · **Packages:** `@tracegraph/cli` and all adapters

---

## Table of Contents

1. [What is TraceGraph?](#1-what-is-tracegraph)
2. [How TraceGraph Works](#2-how-tracegraph-works)
3. [Installation](#3-installation)
4. [Quick Start](#4-quick-start)
5. [Capture Levels](#5-capture-levels)
6. [Language Adapters](#6-language-adapters)
   - [Express / Node.js](#61-express--nodejs)
   - [traceFunction & traceMethod](#62-tracefunction--tracemethod)
   - [Outbound HTTP Tracking](#63-outbound-http-tracking)
   - [Vitest Reporter](#64-vitest-reporter)
   - [Jest Reporter](#65-jest-reporter)
   - [Laravel (PHP)](#66-laravel-php)
   - [PHPUnit Extension](#67-phpunit-extension)
   - [Xdebug Integration](#68-xdebug-integration)
7. [CLI Command Reference](#7-cli-command-reference)
   - [tracegraph init](#71-tracegraph-init)
   - [tracegraph run](#72-tracegraph-run)
   - [tracegraph open](#73-tracegraph-open)
   - [tracegraph diagnose](#74-tracegraph-diagnose)
   - [tracegraph baseline](#75-tracegraph-baseline)
   - [tracegraph compare](#76-tracegraph-compare)
   - [tracegraph finding](#77-tracegraph-finding)
   - [tracegraph report](#78-tracegraph-report)
   - [tracegraph scenario](#79-tracegraph-scenario)
   - [tracegraph import xdebug](#710-tracegraph-import-xdebug)
   - [tracegraph coverage](#711-tracegraph-coverage)
   - [tracegraph pack](#712-tracegraph-pack)
   - [tracegraph schema](#713-tracegraph-schema)
   - [tracegraph clean & storage](#714-tracegraph-clean--storage-status)
8. [Baseline, Compare & Findings Workflow](#8-baseline-compare--findings-workflow)
9. [Security & Reliability Findings](#9-security--reliability-findings)
10. [Scenario Runner](#10-scenario-runner)
11. [AI Change Coverage & Prompt Packs](#11-ai-change-coverage--prompt-packs)
12. [VS Code Extension](#12-vs-code-extension)
13. [CI Integration](#13-ci-integration)
14. [Sample Projects](#14-sample-projects)
15. [File System Layout](#15-file-system-layout)
16. [Configuration Reference](#16-configuration-reference)
17. [Exit Codes](#17-exit-codes)
18. [Troubleshooting](#18-troubleshooting)

---

## 1. What is TraceGraph?

TraceGraph is a **CLI-first runtime assurance platform**. It wraps your existing test and
application commands, captures a complete structured execution trace of every HTTP request,
database query, authorisation check, function call, and test result — then gives you:

- A **visual call graph** of everything your application did at runtime
- A **behaviour diff engine** that compares traces across code changes and flags meaningful regressions
- **Security and reliability findings** — missing auth middleware, N+1 queries, sensitive data in responses, duplicate side-effects
- A **scenario runner** for multi-service declarative test scenarios with automatic cross-service trace linking
- **AI change coverage** — maps your git diff to runtime trace evidence so you know which changed functions were exercised
- **AI context packs** — exports runtime findings to Cursor, Claude Code, GitHub Copilot, and MCP tools
- A **VS Code extension** that brings the graph viewer, timeline, and source navigation directly into your editor
- **CI gate enforcement** with structured exit codes so findings block merges when required

### What TraceGraph is NOT

| It is NOT | Because |
|-----------|---------|
| A debugger | No breakpoints, no stepping; it observes what already runs |
| A static analyser | Every finding is derived from actual runtime behaviour |
| An APM / observability platform | No production metrics, no aggregation, no agents in prod |
| A test framework replacement | It wraps existing test runners; your tests stay unchanged |

### Three Core Concepts

Everything in TraceGraph revolves around three distinct approval mechanisms. Understanding their
differences is essential:

| Concept | What it means | Command | Effect |
|---------|---------------|---------|--------|
| **Baseline** | This is the *expected* runtime behaviour going forward | `tracegraph baseline create` | Sets new expected state; future runs are compared against it |
| **Finding approval** | This specific finding instance is acceptable right now | `tracegraph finding approve <fp>` | Acknowledges a single deviation; does not change expected behaviour |
| **Suppression** | Never report this rule while a compensating event is present | `finding suppress --requires-evidence` | Conditionally silences a rule; self-invalidates if evidence disappears |

These must never collapse into one mechanism. Approving a finding does not update the baseline.
Updating the baseline does not suppress future rule firings.

---

## 2. How TraceGraph Works

### 2.1 The Big Picture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          TraceGraph Data Flow                               │
│                                                                             │
│  Your code                TraceGraph                     You                │
│  ──────────               ───────────                    ───                │
│                                                                             │
│  npm test  ──────────►  tracegraph run  ──►  .trace.json                   │
│  php artisan test           │                     │                         │
│  node script.js             │                     ▼                         │
│                             │             tracegraph open ──► HTML report   │
│                             │             (call graph viewer)               │
│                             │                     │                         │
│                             │                     ▼                         │
│                             │          tracegraph baseline create           │
│                             │             .baseline.json  (commit to git)   │
│                             │                                               │
│  [later, after a change]    │                                               │
│                             │                                               │
│  npm test  ──────────►  tracegraph run  ──►  .trace.json (new)             │
│                             │                     │                         │
│                             │                     ▼                         │
│                             │          tracegraph compare ──► .report.json  │
│                             │                     │                         │
│                             │             ┌───────┴──────────┐             │
│                             │             │   Findings        │             │
│                             │             │  ● auth removed   │             │
│                             │             │  ● N+1 query      │             │
│                             │             │  ● sensitive data │             │
│                             │             └───────────────────┘             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Inside a Trace Run

When you run `tracegraph run -- npm test`, three things happen simultaneously:

```
┌──────────────────────────────────────────────────────────────────┐
│  tracegraph run -- npm test                                      │
│                                                                  │
│  1. Sets environment variables on the child process:             │
│     TRACEGRAPH_ENABLED=1                                         │
│     TRACEGRAPH_RUN_DIR=.tracegraph/runs/run_<id>/                │
│     TRACEGRAPH_TRACE_ID=trace_<id>                               │
│     NODE_OPTIONS=--import @tracegraph/trace-js/register          │
│                                                                  │
│  2. Child process runs (your test suite / script / server):      │
│     Language adapters detect TRACEGRAPH_ENABLED and start        │
│     writing events to:                                           │
│     .tracegraph/runs/<runId>/<traceId>.events.jsonl.tmp          │
│                                 ↑                                │
│                        Live event stream.                        │
│                   Never read by VS Code or CLI                   │
│                   until the run completes.                       │
│                                                                  │
│  3. On completion:                                               │
│     Post-processor reads events.jsonl.tmp                        │
│     Builds TraceSession object                                   │
│     Writes .tracegraph/traces/<traceId>.trace.json.tmp           │
│     Atomic rename → .trace.json (never a partial file)           │
│     Emits stdout: { "type": "trace.completed", "file": "..." }  │
└──────────────────────────────────────────────────────────────────┘
```

### 2.3 The Trace Event DAG

A TraceGraph trace is a **directed acyclic graph** (DAG), not a flat list. Events are connected
by parent references that capture the call hierarchy:

```
                     ┌─────────────────────┐
                     │  http_request        │  evt_001
                     │  POST /invoices      │
                     └──────────┬──────────┘
                                │  parentEventId
                    ┌───────────┴────────────┐
                    │                        │
          ┌─────────▼──────┐     ┌──────────▼──────────┐
          │ function_call   │     │  authorization_check │
          │ validateRequest │     │  InvoicePolicy.create│  evt_003
          └─────────┬───────┘     └──────────────────────┘
                    │
          ┌─────────▼──────┐
          │  db_query       │  evt_004
          │  INSERT invoices│
          └─────────┬───────┘
                    │
          ┌─────────▼──────┐
          │  queue_event    │  evt_005
          │  dispatch:      │
          │  SendEmailJob   │
          └────────────────┘

                    ┌──────────────────────┐
                    │  http_response        │  evt_006
                    │  201 Created         │
                    └──────────────────────┘


  In a separate queue-worker trace:

                    ┌──────────────────────┐
                    │  queue_event          │  evt_101
                    │  start: SendEmailJob  │  causalParentRef →
                    └─────────┬────────────┘    { traceId: trace_001,
                               │                  eventId: evt_005 }
                    ┌─────────▼──────────┐
                    │  external_http_call │
                    │  POST smtp.example  │
                    └────────────────────┘
```

### 2.4 Baseline and Diff

```
  Run 1 (before PR)                Run 2 (after code change)
  ─────────────────                ──────────────────────────

  trace.json                       trace.json
       │                                │
  baseline create                  compare
       │                                │
  .baseline.json ─────────────────►  BehaviorDiff
                                        │
                    ┌───────────────────┼───────────────────┐
                    │                   │                   │
              addedEvents         removedEvents      changedResources
                    │                   │
              ┌─────▼──────┐   ┌───────▼──────────────────┐
              │ new event   │   │  authorization_check      │
              │ detected    │   │  InvoicePolicy.create     │
              │ (informational)│  was in baseline — GONE    │
              └─────────────┘   │  Severity: CRITICAL       │
                                └──────────────────────────┘

  Identity hashing: file paths are NEVER part of the hash.
  Moving InvoiceService.php → Services/InvoiceService.php
  produces zero diff findings.
```

### 2.5 Non-Determinism Handling

TraceGraph normalises volatile values before diffing so that dynamic IDs never create noise:

```
Before diff normalisation          After normalisation
─────────────────────────          ──────────────────
invoiceId: "INV-001"          →    invoiceId: "<id>"
invoiceId: "INV-523"          →    invoiceId: "<id>"
                                   (no diff — both normalise to <id>)

createdAt: "2026-05-01T09:00" →    createdAt: "<timestamp>"
token: "eyJhbGciOiJIUzI1..."  →    token: "<token>"
id: "550e8400-e29b-41d4..."   →    id: "<uuid>"

status: "active"              →    status: "active"   ← NOT normalised
status: "suspended"           →    status: "suspended" (diff fires!)
```

Value-sensitive fields (like `status`, `role`, `currency`) are compared as-is when configured
in `tracegraph.config.json`. Everything else is structure-only.

---

## 3. Installation

### 3.1 CLI (required)

```bash
# Global install (recommended for local development)
npm install -g @tracegraph/cli

# Or project-local (recommended for CI)
npm install -D @tracegraph/cli

# Verify
tracegraph --version
```

### 3.2 JavaScript / TypeScript adapter

```bash
npm install -D @tracegraph/trace-js
```

### 3.3 Vitest reporter

```bash
npm install -D @tracegraph/vitest
```

### 3.4 Jest reporter

```bash
npm install -D @tracegraph/jest
```

### 3.5 Laravel adapter (PHP)

```bash
composer require --dev tracegraph/laravel
```

Auto-discovered by Laravel — no manual registration in `config/app.php`.

### 3.6 Packages published to npm

| Package | Description |
|---------|-------------|
| `@tracegraph/cli` | CLI binary (`tracegraph` command) |
| `@tracegraph/trace-js` | JavaScript/TypeScript instrumentation adapters |
| `@tracegraph/vitest` | Vitest reporter (Level 5 per-test tracing) |
| `@tracegraph/jest` | Jest reporter (Level 5 per-test tracing) |
| `@tracegraph/shared-types` | TypeScript type definitions |
| `@tracegraph/trace-core` | Trace writer, reader, atomic finaliser |
| `@tracegraph/trace-sanitizer` | Redaction, normalisation, size limits |
| `@tracegraph/graph-engine` | Trace→graph, diff engine, finding generator |
| `@tracegraph/scenario-runner` | Scenario executor and TraceBundle linker |
| `@tracegraph/ci-reporter` | Report generators (markdown, JSON, GitHub step summary) |
| `@tracegraph/ai-coverage` | AI change coverage + prompt pack builder |
| `@tracegraph/trace-xdebug` | Xdebug `.xt` file parser and Laravel merger |

---

## 4. Quick Start

### 4.1 JavaScript / TypeScript (5 minutes)

```bash
# 1. Install
npm install -D @tracegraph/cli @tracegraph/trace-js @tracegraph/vitest

# 2. One-time project setup
npx tracegraph init
# → Adds 4 npm scripts to package.json
# → Creates tracegraph.config.json
# → Adds .tracegraph/ entries to .gitignore

# 3. Add the Express middleware (one line, before your routes)
```

```typescript
// src/app.ts
import { traceExpress } from '@tracegraph/trace-js';

const app = express();
app.use(express.json());
app.use(traceExpress());  // ← add this line
// ... your routes ...
```

```bash
# 4. Run your tests under tracing
npm run trace:test
# → .tracegraph/traces/<traceId>.trace.json written

# 5. Open the graph viewer
npx tracegraph open --html .tracegraph/traces/<traceId>.trace.json
# → Browser opens with the call graph

# 6. Approve the first run as a baseline
npx tracegraph baseline create --reason "Initial baseline"
# → .tracegraph/baselines/*.baseline.json written (commit these!)

# 7. After making a code change, compare
npm run trace:test
npm run trace:compare
# → Report shows any behaviour regressions
```

### 4.2 PHP / Laravel (5 minutes)

```bash
# 1. Install
composer require --dev tracegraph/laravel

# 2. Install CLI (if not installed globally)
npm install -g @tracegraph/cli

# 3. One-time setup
php artisan tracegraph:install
# → Publishes config/tracegraph.php
# → Adds .tracegraph/ to .gitignore
# → Adds .env.example entries

# 4. Run tests with tracing
php artisan tracegraph:test
# → Traces written to .tracegraph/

# 5. Create baseline
php artisan tracegraph:baseline

# 6. Compare on future runs
php artisan tracegraph:compare

# 7. Open the graph
php artisan tracegraph:open
```

---

## 5. Capture Levels

TraceGraph assigns every trace a **capture level from 0 to 5** indicating how much detail was
collected. This is always reported — TraceGraph never silently provides a weak trace.

```
Level 0 ──────────────────────────────────────────────────────────────────── Level 5
  │                                                                              │
  │  Runner         Framework       Manual        CJS Hook    ESM Hook   Reporter
  │  metadata       adapters        wrappers      auto        auto       per-test
  │  only           (HTTP, DB,      (traceFunc    instrumt.   instrumt.  isolation
  │                 auth)           traceMethod)
  │
  ▼
Zero config                                                           Full coverage
```

| Level | Label | What is captured | How to achieve |
|-------|-------|-----------------|----------------|
| **0** | Runner metadata only | `trace_start` + `trace_end` + exit code | Default; zero config |
| **1** | Framework adapter | HTTP req/res, DB queries, auth checks, queue events | Add `traceExpress()` or `TraceServiceProvider` |
| **2** | Manual wrappers | Level 1 + explicitly wrapped functions/methods | Use `traceFunction()` / `traceMethod()` |
| **3** | CJS require hook | Level 2 + auto-instrumented CJS modules | `--require @tracegraph/trace-js/register-cjs` |
| **4** | ESM import hook | Level 3 + globals, fetch, diagnostics_channel | `--import @tracegraph/trace-js/register` |
| **5** | Test reporter | Per-test isolation, full test lifecycle | Add `@tracegraph/vitest` or `@tracegraph/jest` |

The capture level banner in the HTML viewer and stdout changes colour by level:

```
  ✅  Level 5 — Vitest reporter (green)   → full per-test coverage
  🟡  Level 2 — Manual wrappers (amber)   → some functions covered
  🔴  Level 0 — Runner metadata (red)     → nothing meaningful captured
```

Run `tracegraph diagnose` after any trace for a ranked list of recommendations.

---

## 6. Language Adapters

### 6.1 Express / Node.js

The `traceExpress()` middleware wraps every HTTP request with a trace context. It uses
`AsyncLocalStorage` so every function called within a request handler automatically has access
to the trace context — no manual context passing needed.

```typescript
import express from 'express';
import { traceExpress } from '@tracegraph/trace-js';

const app = express();
app.use(express.json());

// Must be registered BEFORE route handlers
app.use(traceExpress({
  sanitizerConfig: {
    redactKeys:      ['password', 'authorization', 'token', 'cardNumber', 'cvv'],
    maxDepth:        4,
    maxStringLength: 500,
    maxArrayLength:  50,
  },
}));

app.post('/invoices', async (req, res) => {
  // Everything called here is automatically within the trace context
  const invoice = await invoiceService.create(req.body);
  res.status(201).json(invoice);
});
```

**Events captured by `traceExpress()`:**

| Event type | When emitted | Payload |
|-----------|--------------|---------|
| `http_request` | Request enters middleware | Method, path, params, query, sanitised body, sanitised headers |
| `http_response` | `res.on('finish')` fires | Status code, duration ms |
| `error` | `next(err)` or unhandled error | Error type, message, sanitised stack |

**Correlation header extraction:** TraceGraph automatically reads and propagates:
- `x-tracegraph-scenario-id` — links traces to a scenario run
- `x-tracegraph-correlation-id` — links outbound calls to inbound requests across services
- `traceparent` — W3C trace context (for interop with OpenTelemetry)

**Late registration warning:** If routes are registered before `traceExpress()`, TraceGraph emits
a `console.warn` and a `captureLevel.recommendation` explaining why some events may be missed.

---

### 6.2 `traceFunction` & `traceMethod`

Manually wrap any function or class method to emit `function_call` events. This is Level 2
instrumentation — it adds your critical business logic to the trace without requiring any
code transformation tooling.

```typescript
import { traceFunction, traceMethod } from '@tracegraph/trace-js';

// ── Function wrapper ──────────────────────────────────────────────
// Before:
async function createInvoice(data: CreateInvoiceDto) { ... }

// After:
const createInvoice = traceFunction('InvoiceService.create', async function(data) {
  return { id: 'inv_001', ...data };
});
// Emits: function_call { name: 'InvoiceService.create', input: data, output: result }


// ── Class method decorator ────────────────────────────────────────
class InvoiceService {
  @traceMethod()
  async create(data: CreateInvoiceDto) {
    return this.repo.save(data);
  }

  @traceMethod({ name: 'InvoiceService.calculateTax' })
  async calculateTax(amount: number, region: string) {
    return amount * TAX_RATES[region];
  }
}


// ── Async nesting ─────────────────────────────────────────────────
// traceFunction is fully async-aware. Nested calls build the parent chain:
//
//  http_request
//    └── function_call: InvoiceService.create
//          ├── function_call: TaxService.calculate
//          └── db_query: INSERT invoices
```

**What gets captured per call:**
- `parentEventId` — automatically derived from the current `AsyncLocalStorage` context
- `input` — sanitised function arguments
- `output` — sanitised return value
- `durationMs` — wall-clock time from enter to return
- `file` + `line` — source location (populated at instrumentation time)
- On throw: `error` event is emitted and the exception is re-thrown

---

### 6.3 Outbound HTTP Tracking

TraceGraph provides three mechanisms for capturing outbound HTTP calls, depending on how your
application makes them:

```
Mechanism                 Captures                    Injects correlation header?
─────────────────────────────────────────────────────────────────────────────────
undici diagnostics_channel method, URL, status, dur   No  (observation only)
globalThis.fetch patch     same + correlation         Yes (propagation fallback)
tracedFetch wrapper        same + correlation         Yes (recommended)
axios interceptors         same + correlation         Yes (for axios users)
```

**Using `tracedFetch`** (recommended for fetch-based code):

```typescript
import { tracedFetch } from '@tracegraph/trace-js';

// Replace fetch() calls with tracedFetch()
const response = await tracedFetch('https://inventory.internal/items', {
  method: 'GET',
  headers: { 'Authorization': `Bearer ${token}` },
});
// Emits: external_http_call event with URL, method, status, duration
// Automatically injects x-tracegraph-correlation-id for cross-service linking
```

**Axios interceptors:**

```typescript
import { traceAxios } from '@tracegraph/trace-js';
import axios from 'axios';

const client = axios.create({ baseURL: 'https://api.example.com' });
traceAxios(client);  // attaches request + response interceptors
```

**Emitted event (`external_http_call`):**

```json
{
  "type": "external_http_call",
  "name": "GET https://inventory.internal/items",
  "input":  { "method": "GET", "url": "...", "headers": { "authorization": "[REDACTED]" } },
  "output": { "status": 200, "durationMs": 45 }
}
```

---

### 6.4 Vitest Reporter

The Vitest reporter gives you **Level 5 tracing**: one isolated `.trace.json` file per test case,
with the full test lifecycle captured.

**Option A — Auto-inject via `tracegraph run` (zero config):**

```bash
tracegraph run -- npx vitest run
# → "TraceGraph: detected Vitest — injecting @tracegraph/vitest reporter (Level 5)"
# → One .trace.json per test case written to .tracegraph/traces/
```

**Option B — Explicit `vitest.config.ts`:**

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';
import { TraceGraphReporter } from '@tracegraph/vitest';

export default defineConfig({
  test: {
    reporters: ['verbose', new TraceGraphReporter()],
  },
});
```

**`traceTest` — behavioural assertions inside tests:**

```typescript
import { describe, test } from 'vitest';
import { traceTest } from '@tracegraph/vitest';
import { app } from '../src/app';
import request from 'supertest';

describe('InvoiceService', () => {
  test('create invoice calls validation and saves to DB', traceTest({
    mustCall:    ['InvoiceService.create', 'TaxService.calculate'],
    mustNotCall: ['InvoiceService.sendDuplicateEmail'],
    maxDbQueries: 3,
    async expectBehavior() {
      const res = await request(app)
        .post('/invoices')
        .send({ customerId: 'c1', amount: 100 });

      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();
    },
  }));
});
```

The test **fails** if:
- Any function in `mustCall` does not appear in the trace
- Any function in `mustNotCall` appears in the trace
- The number of `db_query` events exceeds `maxDbQueries`

This gives you runtime-level regression tests that go beyond what static assertions can catch.

---

### 6.5 Jest Reporter

The Jest reporter works identically to the Vitest reporter — one trace file per test case.

**Option A — Auto-inject via `tracegraph run`:**

```bash
tracegraph run -- npx jest
# → "@tracegraph/jest reporter auto-injected"
```

**Option B — `jest.config.js`:**

```javascript
// jest.config.js
module.exports = {
  reporters: ['default', '@tracegraph/jest'],
};
```

**Option C — `package.json`:**

```json
{
  "jest": {
    "reporters": ["default", "@tracegraph/jest"]
  }
}
```

---

### 6.6 Laravel (PHP)

The Laravel adapter auto-discovers via Composer's package discovery mechanism and hooks into
every layer of the framework.

**Activation:** Set `TRACEGRAPH_ENABLED=1`. The adapter does nothing in production unless
this variable is set.

```bash
# .env (local development)
TRACEGRAPH_ENABLED=1
TRACEGRAPH_RUN_DIR=.tracegraph/runs/run_local
```

**What gets captured automatically at Level 1:**

```
HTTP Request arrives
      │
      ▼
TraceMiddleware.handle()          → http_request event
      │
      ▼
Auth::Attempting / Authenticated  → auth_check event
      │
      ▼
Gate::after()                     → authorization_check event
  (with policy inference)           "OrderPolicy::update" inferred from
                                    Gate::allows('update', $order)
      │
      ▼
Route handler (Controller)
      │
      ├──► DB::listen() callback  → db_query event (SQL, duration,
      │                             table, operation, sanitised bindings)
      │
      ├──► Bus::dispatch()        → queue_event (type: dispatch,
      │                             causedTraceId: <job_trace_id>)
      │
      └──► Exception::report()    → error event (type, message,
                                    sanitised stack, vendor frames stripped)
      │
      ▼
TraceMiddleware.terminate()       → http_response event
```

**Policy inference:** Gate events automatically resolve the likely Policy class and method:

```php
Gate::allows('update', $order)
// → authorization_check event:
//   { ability: "update", displayName: "OrderPolicy::update", result: true }
```

**Queue lifecycle:** Full job tracing with cross-trace causal links:

```php
// In HTTP trace:
dispatch(new SendInvoiceEmailJob($invoice));
// → queue_event { type: "dispatch", causedTraceId: "trace_job_001" }

// In separate job trace (trace_job_001):
// → queue_event { type: "start", causalParentRef: { traceId: "trace_http_001", eventId: "evt_dispatch" } }
// → external_http_call (SMTP call)
// → queue_event { type: "succeeded", durationMs: 234 }
```

**Artisan commands:**

```bash
php artisan tracegraph:install         # Publish config, add .env entries
php artisan tracegraph:test            # Run tests with tracing enabled
php artisan tracegraph:baseline        # Create baselines from latest run
php artisan tracegraph:compare         # Compare and produce report
php artisan tracegraph:report          # Render report as markdown/HTML
php artisan tracegraph:open            # Open latest trace in browser
php artisan tracegraph:open --file <f> # Open a specific trace file
```

---

### 6.7 PHPUnit Extension

For per-test trace files in PHPUnit (10/11), register the extension in `phpunit.xml`:

```xml
<!-- phpunit.xml -->
<phpunit>
  <extensions>
    <extension class="Tracegraph\Laravel\Testing\TraceGraphPhpUnitExtension"/>
  </extensions>
</phpunit>
```

Requires `TRACEGRAPH_ENABLED=1` and `TRACEGRAPH_RUN_DIR` to be set when running tests.

**What it captures:**

```
PHPUnit Test Suite starts
      │
      ├── BeforeTestExtension: startTrace({ type: 'test_case', name: $test })
      │
      │   [test body runs, capturing all Laravel hooks]
      │
      └── AfterTestExtension: endTrace()
            → writes <testTraceId>.trace.json
            → captureLevel: 1 (test lifecycle + all Laravel hooks)
```

One `.trace.json` file is written per test case, named by trace ID. Each file is independent
and can be opened, compared, and baselined individually.

---

### 6.8 Xdebug Integration

Xdebug enrichment adds deep PHP function-call detail to Laravel semantic traces. It is entirely
optional — the semantic trace is fully useful without it.

**How it works:**

```
  Run with Xdebug enabled:

  XDEBUG_MODE=trace php artisan test

  Produces two parallel streams:
  ──────────────────────────────────────────────────────────────────
  Laravel adapter stream          Xdebug stream
  ────────────────────            ─────────────
  http_request                    ENTRY  InvoiceController->store
  authorization_check             ENTRY  InvoiceService->create
  db_query (INSERT)               ENTRY  Illuminate\DB\Connection->insert
  http_response                   EXIT   ...
  ...                             EXIT   ...

  Correlation anchors:
  tracegraph_xdebug_marker('request_start')  ← PHP stub, no-op at runtime
                                               Xdebug records it as a named call
  Merger algorithm:
  1. Finds marker pairs (request_start / request_end) → defines time window
  2. For each Laravel event, finds Xdebug calls within ±50ms + matching file
  3. Confidence scoring: timestamp(0.6) + file(0.3) + name(0.1)
  4. High confidence: attached as detailStreams.xdebug.attachedTo[eventId]
  5. Low confidence: kept as separate expandable lane

  Result: trace.json with both semantic and Xdebug detail
```

**Import command:**

```bash
# Import standalone Xdebug trace
tracegraph import xdebug /tmp/trace.*.xt --include "app/"

# Import and merge with Laravel semantic trace
tracegraph import xdebug /tmp/trace.*.xt \
  --semantic .tracegraph/runs/run_001/trace_xyz.events.jsonl \
  --include "app/" \
  --max-events 5000
```

**In the HTML viewer:** Click any semantic node (e.g., `authorization_check`). If correlated
Xdebug calls exist, a collapsible **"Xdebug Call Stack"** section appears in the detail panel
showing depth-indented function names with `file:line` and confidence badges.

---

## 7. CLI Command Reference

### 7.1 `tracegraph init`

One-command project setup. Run once per project.

```bash
tracegraph init
```

**What it does:**

1. Detects your package manager (`pnpm` / `yarn` / `bun` / `npm`)
2. Detects your test runner (`vitest` / `jest` / `mocha`)
3. Adds four scripts to `package.json`:

   | Script | Command |
   |--------|---------|
   | `trace:test` | `tracegraph run -- <pm> test` |
   | `trace:baseline` | `tracegraph baseline create` |
   | `trace:compare` | `tracegraph compare` |
   | `trace:report` | `tracegraph open --html .tracegraph/reports/latest.report.json` |

4. Creates `tracegraph.config.json` with detected language/framework
5. Appends to `.gitignore`:
   ```
   .tracegraph/runs/
   .tracegraph/traces/
   .tracegraph/reports/
   .tracegraph/index.json
   ```

---

### 7.2 `tracegraph run`

Wraps any shell command with tracing. The most frequently used command.

```
tracegraph run -- <command> [args...]
```

**Environment variables injected into the child process:**

| Variable | Value | Purpose |
|----------|-------|---------|
| `TRACEGRAPH_ENABLED` | `1` | Activates all language adapters |
| `TRACEGRAPH_RUN_DIR` | `.tracegraph/runs/<runId>/` | Directory for live event streams |
| `TRACEGRAPH_TRACE_ID` | `trace_<hex16>` | Trace ID for the current run |
| `NODE_OPTIONS` | `--import .../register` or `--require .../register-cjs` | Auto-instrumentation hook (JS only) |

**Examples:**

```bash
# Wrap npm test (most common)
tracegraph run -- npm test

# Wrap Vitest directly
tracegraph run -- npx vitest run

# Wrap Jest directly
tracegraph run -- npx jest --testPathPattern tests/

# Wrap a Node.js script
tracegraph run -- node src/batch-processor.js

# Wrap PHP (TRACEGRAPH_ENABLED must be in the env or set separately)
TRACEGRAPH_ENABLED=1 tracegraph run -- php artisan test

# Pass extra flags to the wrapped command
tracegraph run -- npx vitest run --reporter=verbose
```

**stdout protocol** (JSONL lines, consumed by VS Code extension and CI tools):

```jsonl
{"protocol":"tracegraph.cli.v1","type":"run.started","runId":"run_abc"}
{"protocol":"tracegraph.cli.v1","type":"trace.started","runId":"run_abc","traceId":"trace_xyz"}
{"protocol":"tracegraph.cli.v1","type":"trace.completed","runId":"run_abc","traceId":"trace_xyz","captureLevel":{"overall":5,"label":"Vitest reporter"}}
{"protocol":"tracegraph.cli.v1","type":"run.completed","runId":"run_abc","captureLevel":{"overall":5}}
```

**Reporter auto-injection:** When the command contains `vitest`, TraceGraph appends
`--reporter=default --reporter=@tracegraph/vitest`. For `jest`, it appends
`--reporters=default --reporters=@tracegraph/jest`. Auto-injection is skipped if the reporter
is already present in a detected config file.

---

### 7.3 `tracegraph open`

Produces a **self-contained offline HTML file** from a `.trace.json` or `.report.json` and
optionally opens it in your default browser.

```
tracegraph open --html <file> [--out <output.html>] [--no-open]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--html <file>` | required | Path to `.trace.json` or `.report.json` |
| `--out <path>` | `.tracegraph/reports/<id>.html` | Where to write the HTML |
| `--no-open` | `false` | Write HTML but do not launch browser (useful in CI) |

```bash
# Open most recent trace
tracegraph open --html .tracegraph/traces/trace_abc123.trace.json

# Open a report (shows diff view + findings panel)
tracegraph open --html .tracegraph/reports/report_abc.report.json

# CI: generate HTML artifact without opening browser
tracegraph open --html .tracegraph/traces/*.trace.json --no-open --out artifact.html
```

**HTML viewer features:**

```
┌──────────────────────────────────────────────────────────────────────┐
│  TraceGraph Viewer                                                   │
│  ─────────────────────────────────────────────────────────────────  │
│  [Graph] [Timeline] [Error Path]          Capture Level: ✅ Level 5 │
│                                                                      │
│   ┌─────────┐                         ┌────────────────────────────┐│
│   │http_req  │                         │  Event Detail              ││
│   │POST /inv │                         │  ──────────────────────    ││
│   └────┬─────┘                         │  Type:  authorization_check││
│        │                               │  Name:  InvoicePolicy.create│
│   ┌────┴─────┐    ┌──────────────┐    │  File:  app/Policies/...  ││
│   │auth_check│    │db_query       │    │  Line:  42                 ││
│   │Invoice   │    │INSERT invoices│    │  Duration: 2ms             ││
│   │Policy    │    │              │    │                            ││
│   └──────────┘    └──────────────┘    │  ↗ Open in editor          ││
│                                       │                            ││
│   ┌──────────┐                        │  Input: { ability: "create"││
│   │http_resp │                        │  Output: { result: true }  ││
│   │201 Created│                       └────────────────────────────┘│
│   └──────────┘                                                       │
└──────────────────────────────────────────────────────────────────────┘
```

**Node colour key:**

| Colour | Event types |
|--------|-------------|
| 🔵 Blue | `http_request`, `http_response` |
| 🟠 Orange | `db_query` |
| 🔴 Red | `authorization_check`, `auth_check`, `error` |
| 🟣 Purple | `external_http_call` |
| 🟢 Teal | `queue_event` |
| ⚫ Grey | `function_call`, `method_call`, `trace_start`, `trace_end` |

**Timeline view** — horizontal Gantt-style bars proportional to each event's `durationMs`,
showing parallel async branches in separate lanes side-by-side.

**Error Path view** — walks `causalParentEventId → parentEventId` chains from every `error`
event back to the trace root, highlighting only the causal chain and dimming unrelated branches.

---

### 7.4 `tracegraph diagnose`

Reads the latest (or specified) trace and prints a human-readable capture report with ranked
recommendations for reaching a higher capture level.

```
tracegraph diagnose [--trace <traceId|path>] [--json]
```

```bash
tracegraph diagnose
```

**Example output:**

```
TraceGraph Capture Report
────────────────────────────────────────────────────────
Trace ID:      trace_a1b2c3d4
Capture level: 1 — Framework adapter
Language:      typescript
Framework:     express

Captured:
  ✓ HTTP requests and responses
  ✓ Database queries (SQL, duration, table, operation)
  ✓ Outbound HTTP calls (undici diagnostics_channel)

Not captured:
  ✗ Internal function calls
  ✗ Per-test isolation (one trace per test case)

Recommendations:
  1. Add @tracegraph/vitest reporter → Level 5
     npm install -D @tracegraph/vitest
     tracegraph run -- npx vitest run  (auto-injected)

  2. Wrap critical business logic with traceFunction() → Level 2
     import { traceFunction } from '@tracegraph/trace-js'
────────────────────────────────────────────────────────
```

---

### 7.5 `tracegraph baseline`

Manages baselines — the stored "known-good" behaviour snapshots that define expected behaviour.

#### `baseline create`

```
tracegraph baseline create [options]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--reason "..."` | `"Baseline created by tracegraph CLI"` | Human-readable reason |
| `--approved-by "name"` | `$USER` / `$USERNAME` | Approver name stored in the file |
| `--all` | `false` | Overwrite existing baselines without prompting |
| `--latest-run` | *(default)* | Scope to traces from the most recent `tracegraph run` |
| `--run-id <id>` | — | Scope to a specific run ID |
| `--all-traces` | `false` | Scope to ALL `.trace.json` files |
| `--only-passed` | `false` | Skip traces whose status is `failed` |

```bash
# Most common — baseline the latest run
tracegraph baseline create --reason "Post-refactor baseline" --approved-by alice

# Only baseline passing tests
tracegraph baseline create --only-passed --reason "All green"

# Force re-baseline everything after a major change
tracegraph baseline create --all-traces --all --reason "v2.0 API rewrite"

# Baseline a specific run
tracegraph baseline create --run-id run_abc123 --reason "Staging environment run"
```

**Default scope behaviour:** reads `.tracegraph/latest.json` (written by the most recent
`tracegraph run`) to find trace IDs from that run. Falls back to all traces with a warning
when `latest.json` does not exist.

#### `baseline list`

```bash
tracegraph baseline list
```

```
testId                | events | captureLevel | approvedBy | approvedAt
─────────────────────────────────────────────────────────────────────────
POST /invoices        |  14    | 5            | alice      | 2026-05-29
GET /invoices/:id     |   9    | 5            | alice      | 2026-05-29
DELETE /invoices/:id  |   7    | 5            | alice      | 2026-05-29
```

#### `baseline approve`

Re-approves an existing baseline with a new reason (use when intentional behaviour changes):

```bash
tracegraph baseline approve "POST /invoices" \
  --reason "Added coupon validation step — now expected" \
  --approved-by alice
```

---

### 7.6 `tracegraph compare`

Compares candidate traces against stored baselines and produces a `TraceReport` JSON file.

```
tracegraph compare [options]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--baseline <dir>` | `.tracegraph/baselines/` | Directory of `.baseline.json` files |
| `--candidate <file\|dir>` | Latest run (from `latest.json`) | `.trace.json` or directory |
| `--bundle <file>` | — | TraceBundle JSON — compare all traces in the bundle |
| `--out <file>` | `.tracegraph/reports/<id>.report.json` | Report output path |
| `--latest` | — | Explicitly use the most recent run (same as default) |
| `--fail-on-critical` | `false` | Exit **3** if any critical findings are open |

```bash
# Compare latest run against all baselines (most common)
tracegraph compare

# Gate CI build on critical findings
tracegraph compare --fail-on-critical

# Compare a scenario bundle
tracegraph compare --bundle .tracegraph/bundles/create_invoice_run_abc.bundle.json

# Compare a specific trace
tracegraph compare --candidate .tracegraph/traces/trace_abc.trace.json

# Custom paths (CI with separate artifact directories)
tracegraph compare \
  --baseline baselines/ \
  --candidate artifacts/traces/ \
  --out artifacts/report.json \
  --fail-on-critical
```

**What `compare` checks:**

```
For each (baseline, candidate) pair matched by testId:

  1. Structural diff
     ├── Events in baseline but not candidate → "removed" findings
     ├── Events in candidate but not baseline → "added" (informational)
     ├── Changed resource operations (new/removed table+op pairs)
     └── Changed response shape (field added/removed/type changed)

  2. Security rules (always run, single-trace)
     ├── auth middleware removed from baseline route → Critical
     ├── authorization_check removed → Critical
     └── sensitive data in http_response output → High

  3. Reliability rules (always run, single-trace)
     ├── N+1 query pattern (≥5 identical table+op pairs) → Medium
     ├── Duplicate side effects (same queue dispatch ≥2x) → High
     └── Writes to 2+ tables without transaction events → Medium

  4. Policy check
     └── suppressions file has uncommitted git changes → High

  5. Suppression evaluation
     └── Any finding with matching suppression:
           - Check expiry date
           - Check requiresEvidence still present in trace
           - If both pass → status: "suppressed"
```

---

### 7.7 `tracegraph finding`

Manages findings from the latest report.

#### `finding list`

```bash
tracegraph finding list [--report <path>]
```

```
Findings — 2026-05-29T14:30

  🔴 CRITICAL  security.authorization.middleware_removed
               Missing auth middleware on POST /orders
               fingerprint: a1b2c3d4  status: open

  🟠 HIGH      behavior.validation.removed
               validateCouponExpiry() removed from POST /invoices
               fingerprint: e5f6a7b8  status: open

  🟡 MEDIUM    reliability.n_plus_one_query
               5 identical SELECT FROM products within single request
               fingerprint: c9d0e1f2  status: open
```

#### `finding approve`

Accepts one finding instance. Recorded in `.tracegraph/approvals/findings.json`.

```bash
tracegraph finding approve a1b2c3d4 \
  --reason "Auth handled by API gateway upstream — confirmed with infra team" \
  --approved-by alice \
  --expires 2027-01-01
```

| Flag | Default | Description |
|------|---------|-------------|
| `--reason` | required | Human-readable approval reason |
| `--approved-by` | `$USER` | Approver name |
| `--expires` | 1 year | ISO date after which approval expires |

#### `finding suppress`

Conditionally silences a rule while compensating evidence is present in the trace.

```bash
tracegraph finding suppress a1b2c3d4 \
  --reason "Auth is handled upstream by API gateway (GatewayPolicy.validate)" \
  --requires-evidence "authorization_check:GatewayPolicy.validate" \
  --expires 2027-06-01
```

**`requiresEvidence` self-invalidation:** If `GatewayPolicy.validate` stops appearing in traces
(e.g., someone removes the gateway), the suppression automatically expires and the finding
re-opens at Critical severity. This prevents suppressions from silently masking real regressions.

#### `finding explain`

Full human-readable explanation of a finding including description, recommendation, and evidence.

```bash
tracegraph finding explain a1b2c3d4 [--json]
```

```
🔴 CRITICAL — security.authorization.middleware_removed
Fingerprint: a1b2c3d4e5f60000

Description:
  Route-level authorization middleware that was present in the baseline
  has been removed from POST /orders. Any request to this endpoint now
  bypasses the authentication layer entirely.

Recommendation:
  Restore the middleware. If this route is intentionally public, add it
  to tracegraph.config.json under security.publicRoutes and re-baseline.

Evidence:
  Trace: trace_abc123   Event: evt_001

Actions:
  tracegraph finding approve a1b2c3d4 --reason "..."
  tracegraph finding suppress a1b2c3d4 --reason "..." --requires-evidence "..."
```

---

### 7.8 `tracegraph report`

Renders the latest `.report.json` in human-readable or machine-readable formats.

```
tracegraph report [--format <fmt>] [--input <file>] [--out <file>]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--format` | `markdown` | `markdown` / `json` / `github-step-summary` |
| `--input` | Latest report | Path to `.report.json` |
| `--out` | stdout | Write to file instead of stdout |

```bash
# Print markdown summary to stdout
tracegraph report

# Write GitHub Actions step summary
tracegraph report --format github-step-summary --out "$GITHUB_STEP_SUMMARY"

# Machine-readable JSON for downstream tooling
tracegraph report --format json --out report-export.json

# Write markdown report file
tracegraph report --out docs/security-report.md
```

**Markdown report sections:**

1. **Summary** — traces collected, findings by severity, capture level
2. **🔐 Security** — Critical/High security findings with route and recommendation
3. **⚙️ Reliability** — N+1, duplicate side-effects, missing transaction findings
4. **📋 Policy** — Suppression file modification alerts
5. **Behaviour changes** — Added/removed events by route
6. **Capture level** — Current level + upgrade recommendation

---

### 7.9 `tracegraph scenario`

Run declarative multi-service scenarios. The runner starts servers, executes HTTP steps in
sequence, injects correlation headers on every request, and writes a `TraceBundle` linking
cross-service calls.

#### `scenario run`

```bash
tracegraph scenario run <scenario.json> [--server-url <url>]
```

```bash
tracegraph scenario run .tracegraph/scenarios/create-invoice.scenario.json
```

```
[tracegraph] Running scenario: create-invoice.scenario.json
  Starting express-api on port 3001...
  ✓ Health check passed (200)
  ✓ Step 1: Health check (200)  12ms
  ✓ Step 2: Create invoice (201)  87ms
  ✓ Step 3: List invoices (200)  23ms
[tracegraph] Scenario "create_invoice" ✓ passed (3 steps, 412ms)
[tracegraph] Bundle: .tracegraph/bundles/create_invoice_run_abc123.bundle.json
```

#### `scenario validate`

```bash
tracegraph scenario validate .tracegraph/scenarios/create-invoice.scenario.json
```

Validates the scenario file structure without starting any server or making any requests.

#### `scenario list`

```bash
tracegraph scenario list
```

**Scenario file format:**

```json
{
  "schemaVersion": "tracegraph.scenario.v1",
  "scenarioId": "create_invoice",
  "name": "Create Invoice — end-to-end",
  "servers": [
    {
      "name": "invoice-api",
      "command": "node -r ts-node/register src/app.ts",
      "port": 3001,
      "env": { "PORT": "3001", "NODE_ENV": "test" },
      "healthCheck": {
        "path": "/health",
        "expectedStatus": 200,
        "intervalMs": 300,
        "timeoutMs": 10000
      }
    }
  ],
  "steps": [
    {
      "name": "Create invoice",
      "http": {
        "method": "POST",
        "url": "http://localhost:3001/invoices",
        "headers": { "Content-Type": "application/json" },
        "body": { "customerId": "c1", "amount": 99.99 }
      },
      "assert": { "status": 201 }
    },
    {
      "name": "List invoices — verify it appears",
      "http": { "method": "GET", "url": "http://localhost:3001/invoices" },
      "assert": { "status": 200, "bodyContains": "c1" }
    }
  ],
  "tags": ["smoke", "invoice"]
}
```

**Correlation headers injected automatically on every step:**

| Header | Value | Purpose |
|--------|-------|---------|
| `x-tracegraph-scenario-id` | `create_invoice` | Tags all requests to the same scenario |
| `x-tracegraph-correlation-id` | `create_invoice_step1` | Links outbound HTTP calls across services |

**Comparing a bundle against baselines:**

```bash
tracegraph compare --bundle .tracegraph/bundles/create_invoice_run_abc.bundle.json
```

---

### 7.10 `tracegraph import xdebug`

Parses an Xdebug `.xt` file and converts it to a TraceGraph `.trace.json`. Optionally merges
with a Laravel semantic trace for full detail.

```
tracegraph import xdebug <trace.xt> [options]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--semantic <file>` | none | Path to `.events.jsonl` from the Laravel adapter to merge with |
| `--include <pattern>` | none | Only include Xdebug calls where file path contains this string |
| `--max-events <n>` | `10000` | Cap Xdebug event count (large traces can be huge) |
| `--out-dir <dir>` | `.tracegraph/traces/` | Output directory |

```bash
# Standalone — Xdebug only
tracegraph import xdebug /tmp/trace.1234.xt --include "app/"

# Merged with Laravel semantic trace
tracegraph import xdebug /tmp/trace.1234.xt \
  --semantic .tracegraph/runs/run_001/trace_abc.events.jsonl \
  --include "app/" \
  --max-events 3000
```

**Generating Xdebug traces with correlation markers:**

```php
// In TraceServiceProvider (auto-loaded)
function tracegraph_xdebug_marker(string $traceId, string $phase): void
{
    // intentionally empty — Xdebug records this call as a correlation anchor
}

// Called automatically by TraceMiddleware:
tracegraph_xdebug_marker($traceId, 'request_start');
// ... request handling ...
tracegraph_xdebug_marker($traceId, 'request_end');
```

```bash
# Full Xdebug workflow
XDEBUG_MODE=trace \
XDEBUG_CONFIG="trace_output_dir=/tmp trace_format=0" \
TRACEGRAPH_ENABLED=1 \
TRACEGRAPH_RUN_DIR=.tracegraph/runs/run_001 \
./vendor/bin/phpunit

tracegraph import xdebug /tmp/trace.*.xt \
  --semantic .tracegraph/runs/run_001/*.events.jsonl \
  --include "app/" \
  --max-events 5000

tracegraph open --html .tracegraph/traces/<traceId>.trace.json
```

---

### 7.11 `tracegraph coverage`

Maps functions changed in a git diff to runtime trace events. Produces a gap report showing
which changed functions were exercised at runtime and which were not.

```
tracegraph coverage [options]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--base <ref>` | `HEAD~1` | Git ref for the diff base |
| `--head <ref>` | `HEAD` | Git ref for the diff head |
| `--traces <dir>` | `.tracegraph/traces/` | Directory of trace files to scan |
| `--out <file>` | `.tracegraph/reports/<id>.coverage.json` | Report output path |
| `--json` | — | Print full JSON to stdout in addition to writing the file |
| `--fail-uncovered` | — | Exit 1 if any changed function has no trace coverage |

```bash
# Check coverage between your branch and main
tracegraph coverage --base origin/main --head HEAD

# Run tests first, then check what changed functions were exercised
tracegraph run -- npm test
tracegraph coverage

# CI gate: fail if changed code was not tested at runtime
tracegraph coverage --base origin/main --fail-uncovered
```

**How coverage matching works:**

```
git diff origin/main..HEAD
  └── parses .ts, .js, .tsx, .jsx, .php files
  └── extracts changed function/method declarations

.tracegraph/traces/*.trace.json
  └── scans function_call and method_call events
  └── matches by three strategies:
       1. event.functionName === changed.functionName (exact)
       2. event.name === "ClassName.methodName" (dot notation)
       3. event.displayName === "ClassName.methodName"

Output: ChangeCoverageReport
  ├── covered:   functions with at least one matching trace event
  ├── uncovered: functions with no trace evidence
  └── summary:   { changedFunctions: 3, coveredCount: 2, coveragePercent: 67 }
```

**Example output:**

```
  tracegraph coverage
  diff: origin/main..HEAD
  ─────────────────────────────────────────────────
  Changed functions: 3
  Covered:           2  (67%)
  Uncovered:         1

  Uncovered changed functions:
    ✗  validateCouponExpiry()   src/invoice.ts:45

  Covered changed functions:
    ✓  InvoiceService.create()  — 3 trace(s)
    ✓  formatLineItems()        — 1 trace(s)
```

---

### 7.12 `tracegraph pack`

Generates AI context packs from a `TraceReport` and recent traces, writing them to the
conventional locations where AI tools automatically pick them up.

```
tracegraph pack [options]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--format <fmt>` | `all` | `cursor` / `claude-code` / `copilot` / `mcp` / `all` |
| `--report <file>` | Latest report | Path to `.report.json` |
| `--traces <dir>` | `.tracegraph/traces/` | Trace files to include as context |
| `--out-dir <dir>` | Project root | Base directory for output files |
| `--project <name>` | From `package.json` | Project name in pack headers |
| `--max-chars <n>` | `40000` | Max trace context characters per pack |
| `--dry-run` | — | Show what would be written without writing |

```bash
# Generate all AI context packs from the latest report
tracegraph pack

# Preview what would be generated
tracegraph pack --dry-run

# Generate only for Cursor and Claude Code
tracegraph pack --format cursor
tracegraph pack --format claude-code

# Use a specific report
tracegraph pack --report .tracegraph/reports/rep_abc123.report.json
```

**Output files:**

| Format | Output file | Read by |
|--------|-------------|---------|
| `cursor` | `.cursor/tracegraph-context.md` | Cursor IDE |
| `claude-code` | `CLAUDE.md` | Claude Code CLI / claude.ai |
| `copilot` | `.github/copilot-instructions.md` | GitHub Copilot |
| `mcp` | `.tracegraph/mcp-context.json` | Any MCP-compatible tool |

Each pack contains:
- Open findings (severity, rule, description, recommendation)
- Summarised recent runtime traces (what the application actually did)
- Coverage gaps from the latest `tracegraph coverage` report (if available)
- Suppressed and approved findings are excluded

```
  tracegraph pack
  report: .tracegraph/reports/rep_abc123.report.json
  ─────────────────────────────────────────────────────────────────
  ✓ wrote  .cursor/tracegraph-context.md               (12.3 KB)
  ✓ wrote  CLAUDE.md                                   (11.8 KB)
  ✓ wrote  .github/copilot-instructions.md             (11.8 KB)
  ✓ wrote  .tracegraph/mcp-context.json                (15.1 KB)
```

---

### 7.13 `tracegraph schema`

Inspects and migrates TraceGraph artifact schemas to keep old traces and baselines compatible
across CLI upgrades.

#### `schema doctor`

```bash
tracegraph schema doctor [--json]
```

Scans `.tracegraph/` for artifacts whose `schemaVersion` does not match the current CLI.

```
TraceGraph Schema Doctor
────────────────────────────────────────────────────
  Checked:   18 artifacts
  OK:        16
  Mismatch:  2

  ⚠  .tracegraph/baselines/invoices.baseline.json   (v1.0 → expected v1.1)
  ⚠  .tracegraph/baselines/orders.baseline.json     (v1.0 → expected v1.1)

Run `tracegraph baseline migrate` to upgrade.
```

Exits `5` (`SCHEMA_MIGRATION`) when any mismatch is found.

#### `baseline migrate`

```bash
tracegraph baseline migrate [--dry-run]
```

```bash
# Preview first
tracegraph baseline migrate --dry-run
# → Would migrate: .tracegraph/baselines/invoices.baseline.json (v1.0 → v1.1)
# → Would migrate: .tracegraph/baselines/orders.baseline.json   (v1.0 → v1.1)

# Apply
tracegraph baseline migrate
# → Migrated: invoices.baseline.json ✓
# → Migrated: orders.baseline.json   ✓
```

---

### 7.14 `tracegraph clean` & `storage status`

#### `clean`

Removes run directories from `.tracegraph/runs/`. Never removes baselines, approvals,
suppressions, or scenarios.

```bash
tracegraph clean --older-than 3d     # remove runs older than 3 days
tracegraph clean --keep-last 5       # keep 5 most recent, remove the rest
tracegraph clean --all-runs          # remove everything (be careful)
```

Auto-pruning also runs on every `tracegraph run` according to the `storage` config.

#### `storage status`

```bash
tracegraph storage status
```

```
TraceGraph Storage
────────────────────────────────────────────
  Runs:        3    (in .tracegraph/runs/)
  Traces:      12   (in .tracegraph/traces/)
  Baselines:   4    (in .tracegraph/baselines/)
  Total size:  1.4 MB
  Location:    /home/alice/invoice-api/.tracegraph
```

---

## 8. Baseline, Compare & Findings Workflow

This is the core TraceGraph workflow. Run it on every pull request.

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        TraceGraph PR Workflow                            │
│                                                                          │
│  main branch                          feature/coupon-fix branch          │
│  ───────────                          ────────────────────────           │
│                                                                          │
│  tracegraph run -- npm test           tracegraph run -- npm test         │
│         │                                     │                          │
│         ▼                                     ▼                          │
│   .trace.json                          .trace.json (new)                 │
│         │                                     │                          │
│  baseline create                      compare --fail-on-critical         │
│         │                                     │                          │
│  .baseline.json ─────────────────────►  BehaviorDiff + Findings          │
│  (commit to git)                              │                          │
│                                              ┌┴──────────────────────┐  │
│                                              │                       │  │
│                                        open finding            real bug  │
│                                              │                    │      │
│                                     finding approve          fix code    │
│                                     (--reason "...")               │      │
│                                        or                     re-run    │
│                                     finding suppress          compare    │
│                                     (--requires-evidence)               │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

**Step-by-step for a typical PR cycle:**

```bash
# ── On main, after merging ──────────────────────────────────────────────
tracegraph run -- npm test
tracegraph baseline create --reason "Post-merge baseline" --approved-by alice
git add .tracegraph/baselines/
git commit -m "chore: update tracegraph baselines"

# ── On feature branch ───────────────────────────────────────────────────
tracegraph run -- npm test
tracegraph compare --fail-on-critical    # exits 3 if critical findings

tracegraph finding list                  # review what was found

# If it's a real regression → fix the code, re-run, re-compare

# If behaviour changed intentionally → update the baseline
tracegraph baseline create --all --reason "Added coupon validation step"
git add .tracegraph/baselines/

# If it's a known false positive → approve this specific finding instance
tracegraph finding approve e5f6a7b8 \
  --reason "Auth is handled by the outer gateway, not this service"

# View full report in browser
tracegraph open --html .tracegraph/reports/*.report.json
```

---

## 9. Security & Reliability Findings

TraceGraph fires the following finding rules automatically on every `compare` run.

### 9.1 Security Findings

#### `security.authorization.middleware_removed` — CRITICAL

```
Trigger: Route-level auth middleware present in baseline trace,
         absent in candidate trace for the same route.

Example:
  Baseline: POST /orders → [checkAuth middleware] → handler → db_write
  Candidate: POST /orders → handler → db_write  ← auth gone

Severity: Critical
```

#### `security.authorization.check_removed` — CRITICAL

```
Trigger: An authorization_check or auth_check event with
         role="authorization" present in baseline, absent in candidate.

Example:
  Baseline: ...→ Gate::allows('update', $order) [InvoicePolicy.update] → ...
  Candidate: same route, no Gate call found

Severity: Critical
```

#### `security.sensitive_data.in_response` — HIGH

```
Trigger: Any of the following keys found in http_response output:
         password, passwordHash, api_key, apiKey, accessToken,
         refreshToken, secret, token, remember_token, cvv, pin

Example:
  { "user": { "email": "alice@example.com", "password": "abc123" } }
                                              ↑ triggers finding

Severity: High
```

### 9.2 Reliability Findings

#### `reliability.n_plus_one_query` — MEDIUM

```
Trigger: The same (table, operation) db_query pair appears ≥ 5 times
         within a single request trace.

Example:
  GET /orders
    → SELECT FROM products WHERE id = 1
    → SELECT FROM products WHERE id = 2
    → SELECT FROM products WHERE id = 3
    → SELECT FROM products WHERE id = 4
    → SELECT FROM products WHERE id = 5  ← 5th identical (products, SELECT)

Severity: Medium
Evidence: Lists all matching event IDs
```

#### `reliability.duplicate_side_effects` — HIGH

```
Trigger: The same queue job name dispatched ≥ 2 times, OR the same
         non-GET outbound HTTP URL called ≥ 2 times within one trace.

Example:
  dispatch(SendInvoiceEmail, invoice_id=1)  ← first dispatch
  dispatch(SendInvoiceEmail, invoice_id=1)  ← duplicate!

Severity: High
```

#### `reliability.missing_transaction` — MEDIUM

```
Trigger: db_query write events targeting ≥ 2 distinct tables with no
         transaction_start / transaction_commit events wrapping them.

Example:
  UPDATE orders SET status = 'paid'
  INSERT INTO payments ...
  ← no BEGIN/COMMIT → partial write risk

Severity: Medium
```

### 9.3 Policy Findings

#### `policy.suppressions_modified` — HIGH

```
Trigger: .tracegraph/suppressions/tracegraph.suppressions.json has
         uncommitted changes in git (detected via git status --porcelain).

This finding fires in CI on any PR that modifies the suppressions file.
Exit code 4 (POLICY_REVIEW) is returned, blocking the merge until a
designated reviewer approves the suppression change.

Severity: High
```

---

## 10. Scenario Runner

The scenario runner lets you write declarative multi-service test scenarios that automatically
link cross-service traces via correlation headers.

### 10.1 How Scenarios Work

```
┌──────────────────────────────────────────────────────────────────────┐
│  Scenario Run Flow                                                   │
│                                                                      │
│  scenario.json                                                       │
│       │                                                              │
│       ▼                                                              │
│  1. Start all servers listed in "servers"                            │
│     → spawn child process (SIGTERM + SIGKILL on exit)               │
│     → poll health check URL until ready                             │
│     → or watch stdout for readyPattern match                        │
│                                                                      │
│  2. Execute steps in sequence                                        │
│     For each step:                                                   │
│     → Inject x-tracegraph-scenario-id + x-tracegraph-correlation-id │
│     → Make HTTP request                                              │
│     → Assert status code / body content                             │
│     → Each server writes its own .trace.json (via adapter)          │
│                                                                      │
│  3. Stop all servers (SIGTERM → 5s drain → SIGKILL)                 │
│                                                                      │
│  4. Bundle linking                                                   │
│     → Scan all trace files for x-tracegraph-correlation-id values   │
│     → Match external_http_call events to http_request events        │
│     → Write .tracegraph/bundles/<scenarioId>_<runId>.bundle.json    │
│       {                                                              │
│         "traces": [{ traceId, file, language }, ...],               │
│         "links": [{ source, target, type: "causes", correlationId}] │
│       }                                                              │
└──────────────────────────────────────────────────────────────────────┘
```

### 10.2 Multi-Service Scenario Example

```json
{
  "schemaVersion": "tracegraph.scenario.v1",
  "scenarioId": "order_with_inventory_check",
  "name": "Order creation — cross-service",
  "servers": [
    {
      "name": "order-api",
      "command": "node src/order-api.js",
      "port": 3001,
      "env": { "PORT": "3001" },
      "healthCheck": { "path": "/health", "expectedStatus": 200, "intervalMs": 500 }
    },
    {
      "name": "inventory-api",
      "command": "node src/inventory-api.js",
      "port": 3002,
      "env": { "PORT": "3002" },
      "healthCheck": { "path": "/health", "expectedStatus": 200, "intervalMs": 500 }
    }
  ],
  "steps": [
    {
      "name": "Create order (triggers inventory check)",
      "http": {
        "method": "POST",
        "url": "http://localhost:3001/orders",
        "body": { "productId": "p1", "quantity": 2 }
      },
      "assert": { "status": 201 }
    }
  ]
}
```

The order service makes a fetch call to the inventory service. Because TraceGraph injects
`x-tracegraph-correlation-id`, the bundle linker connects:

```
order-api trace:
  http_request POST /orders
    └── external_http_call GET http://localhost:3002/items/p1
          correlation-id: order_with_inventory_check_step1

inventory-api trace:
  http_request GET /items/p1
    x-tracegraph-correlation-id: order_with_inventory_check_step1

Bundle links:
  order-api:evt_external_call ──causes──► inventory-api:evt_http_request
```

---

## 11. AI Change Coverage & Prompt Packs

### 11.1 `tracegraph coverage` — What changed, what was tested

After running tests with tracing active, `tracegraph coverage` tells you which functions
that changed in your PR were exercised at runtime versus which were not:

```bash
# Typical CI workflow
tracegraph run -- npm test          # capture runtime traces
tracegraph coverage \               # compare to git diff
  --base origin/main \
  --head HEAD \
  --fail-uncovered                  # exit 1 if any gap found
```

This answers the question: *"Does my test suite actually exercise the code I just changed?"*
It does not replace code coverage tools — it adds a runtime-level check that proves the new
code path was actually reached during the test run.

### 11.2 `tracegraph pack` — Feed findings to AI tools

After a `tracegraph compare`, run `tracegraph pack` to write AI context files that tell your
AI coding assistant exactly what TraceGraph found:

```bash
tracegraph compare
tracegraph pack
```

What each AI tool sees (example content for a security finding):

```markdown
<!-- .cursor/tracegraph-context.md -->

## TraceGraph Runtime Findings — invoice-api

### 🔴 CRITICAL — security.authorization.middleware_removed
Route POST /orders is missing authorization middleware.
The baseline trace shows checkAuth was present; the current trace does not.

Recommendation:
  Restore the middleware or add this route to security.publicRoutes.

Evidence:
  trace_abc123 — evt_001 (http_request, POST /orders, no auth event before db_write)
```

This gives AI tools grounded, runtime-derived context rather than static guesses.

---

## 12. VS Code Extension

The TraceGraph VS Code extension brings the full trace graph, timeline, error path views, and
source navigation directly into the editor — without leaving VS Code.

### 12.1 Architecture

```
VS Code Extension
       │
       │ spawns CLI as child process
       ▼
tracegraph run -- npm test
       │
       │ writes (atomic rename)
       ▼
.tracegraph/traces/<id>.trace.json
       │
       │ on trace.completed stdout event
       ▼
Extension reads file → renders in Webview panel
```

The extension **never reads `.tmp` files**. It waits for the `trace.completed` JSONL event on
stdout, then reads the finalised `.trace.json`. This guarantees it never sees a partial file.

### 12.2 Sidebar Trees

The TraceGraph activity bar icon opens four auto-refreshing trees:

```
TraceGraph (sidebar)
├── 📋 Traces
│   ├── run_abc123 (2026-05-29 14:30)
│   │   ├── POST /invoices   trace_001.trace.json
│   │   ├── GET /invoices    trace_002.trace.json
│   │   └── DELETE /inv/:id  trace_003.trace.json
│   └── run_abc122 (2026-05-29 09:15)
│       └── ...
│
├── 🔴 Findings (from latest report)
│   ├── CRITICAL
│   │   └── auth middleware removed — POST /orders
│   └── HIGH
│       └── validateCoupon removed — POST /invoices
│
├── 📦 Baselines
│   ├── POST /invoices   ✓ alice · 2026-05-29
│   └── GET /invoices    ✓ alice · 2026-05-29
│
└── 🔀 Scenarios
    └── create-invoice.scenario.json
```

Trees auto-refresh when files change in `.tracegraph/`.

### 12.3 Graph Panel Views

Clicking any trace item opens it in a Webview panel with three view modes:

**Graph view** (default)

The full SVG call graph with colour-coded nodes. Click any node to inspect its event details.
When a node has `file` + `line` data, an **↗ Open in editor** button appears — clicking it
navigates directly to that source line using `showTextDocument`.

**Timeline view**

Horizontal Gantt-style bars where each bar's width is proportional to the event's `durationMs`.
Parallel async branches (`asyncGroupId`) are rendered in separate lanes side-by-side so
concurrent operations are visually obvious.

```
Timeline View
─────────────────────────────────────────────────────────── time →
http_request    ████████████████████████████████████████████ 234ms
  auth_check    ██  3ms
  db_query 1    ████  12ms
  db_query 2          ████  11ms    (parallel branch)
  fn: create    ████████  45ms
http_response                                           ██  2ms
```

**Error Path view**

Walks `causalParentEventId → parentEventId` chains backward from every `error` event to the
trace root. Only the causal ancestors are shown; unrelated branches are dimmed. Useful for
quickly finding "what led to this exception."

### 12.4 Commands (Command Palette)

| Command | Description |
|---------|-------------|
| `TraceGraph: Run with Tracing` | Prompts for a command, runs `tracegraph run -- <cmd>`, streams output to Output Channel |
| `TraceGraph: Compare Latest Run` | Runs `tracegraph compare --latest`, refreshes Findings tree |
| `TraceGraph: Open Trace` | Quick-picks a trace file, opens in graph panel |
| `TraceGraph: View Latest Report` | Opens latest `.report.json` in report mode |
| `TraceGraph: Create Baseline` | Prompts for reason, runs `tracegraph baseline create` |
| `TraceGraph: Generate AI Context Packs` | Runs `tracegraph pack --format all` |
| `TraceGraph: Refresh` | Forces a tree refresh |

### 12.5 VS Code Settings

```jsonc
// settings.json
{
  "tracegraph.cliPath":     "",     // path to tracegraph binary; empty = auto-detect
  "tracegraph.runCommand":  "",     // command for "Run with Tracing"; prompted if empty
  "tracegraph.autoRefresh": true    // auto-refresh trees on file changes
}
```

---

## 13. CI Integration

### 13.1 GitHub Actions — JavaScript/TypeScript

```yaml
name: TraceGraph Assurance
on: [push, pull_request]

jobs:
  trace:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0  # needed for git diff in tracegraph coverage

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install dependencies
        run: npm ci

      - name: Run tests with tracing
        run: npx tracegraph run -- npm test

      - name: Compare against baseline
        run: npx tracegraph compare --fail-on-critical
        # exits 3 on critical findings (distinguishable from exit 1 test failures)

      - name: Check AI change coverage
        run: npx tracegraph coverage --base origin/main --head HEAD

      - name: Write GitHub step summary
        if: always()
        run: npx tracegraph report --format github-step-summary --out "$GITHUB_STEP_SUMMARY"

      - name: Upload trace artifacts
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: tracegraph-traces
          path: .tracegraph/reports/
          retention-days: 14
```

### 13.2 GitHub Actions — Laravel / PHP

```yaml
name: TraceGraph Assurance (Laravel)
on: [push, pull_request]

jobs:
  trace:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: shivammathur/setup-php@v2
        with:
          php-version: '8.2'
          extensions: pdo_sqlite, xdebug

      - name: Install PHP dependencies
        run: composer install --no-interaction

      - name: Run tests with tracing
        env:
          TRACEGRAPH_ENABLED: '1'
          TRACEGRAPH_RUN_DIR: ${{ github.workspace }}/.tracegraph/runs/run_ci
        run: ./vendor/bin/phpunit

      # Node CLI for compare/report
      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install TraceGraph CLI
        run: npm install -g @tracegraph/cli

      - name: Compare against baseline
        run: tracegraph compare --fail-on-critical

      - name: Write GitHub step summary
        if: always()
        run: tracegraph report --format github-step-summary --out "$GITHUB_STEP_SUMMARY"
```

### 13.3 Suppression File Policy

Any PR that modifies `.tracegraph/suppressions/tracegraph.suppressions.json` automatically
triggers a `policy.suppressions_modified` finding and exits with code 4:

```yaml
- name: Compare (with policy enforcement)
  run: tracegraph compare --fail-on-critical
  # exits 3 for critical findings
  # exits 4 if suppressions file was modified in this PR
  # → requires explicit reviewer approval before merge
```

### 13.4 What to Commit vs. Gitignore

```
.tracegraph/
  baselines/    ← COMMIT (your source of truth for expected behaviour)
  approvals/    ← COMMIT (finding approvals with reasons and expiry dates)
  suppressions/ ← COMMIT (suppression rules — security-sensitive, requires review)
  scenarios/    ← COMMIT (declarative scenario definitions)
  runs/         ← GITIGNORE (temporary, large)
  traces/       ← GITIGNORE (large, regenerated every run)
  reports/      ← GITIGNORE (generated output)
  index.json    ← GITIGNORE
```

---

## 14. Sample Projects

All sample projects live under `sample-projects/` in the repository. Each is a standalone,
self-contained project you can `cd` into and run immediately.

### 14.1 Express TypeScript API

**Location:** `sample-projects/express-typescript`

A minimal Express 4 + TypeScript invoice API demonstrating the complete JS/TS tracing stack.

**Services:**
- `InvoiceService` — creates, updates, and lists invoices
- `TaxService` — calculates tax rates by region
- `InvoiceRepository` — in-memory store

```bash
cd sample-projects/express-typescript
pnpm install

# Run tests with tracing (Vitest reporter auto-injected → Level 5)
pnpm run trace:test

# Open the graph viewer in browser
npx tracegraph open --html .tracegraph/traces/*.trace.json

# Approve as baseline
npx tracegraph baseline create --reason "Initial baseline"

# Simulate a regression: comment out a validation call in src/invoice.ts
# Then re-run and compare:
pnpm run trace:test
npx tracegraph compare
# → High: validation-like event removed from POST /invoices
```

**Key tracing code (`src/app.ts`):**

```typescript
import express from 'express';
import { traceExpress } from '@tracegraph/trace-js';

const app = express();
app.use(express.json());
app.use(traceExpress({
  sanitizerConfig: { redactKeys: ['cardNumber', 'cvv', 'authorization'] },
}));
```

---

### 14.2 Node Script / Batch Processor

**Location:** `sample-projects/node-script`

A Node.js batch data-processing script demonstrating zero-config (Level 0) and manual
`traceFunction` wrappers (Level 2).

```bash
cd sample-projects/node-script
pnpm install

# Level 0 — zero config
tracegraph run -- node src/index.js

# Level 5 — run tests with Vitest reporter
tracegraph run -- npx vitest run
npx tracegraph open --html .tracegraph/traces/*.trace.json
```

---

### 14.3 Inventory Service (Vitest)

**Location:** `sample-projects/inventory-service`

An Express service with a full Vitest test suite demonstrating per-test trace isolation
and `traceTest` behavioural assertions.

```bash
cd sample-projects/inventory-service
pnpm install
tracegraph run -- npx vitest run
# → One .trace.json per test case
ls .tracegraph/traces/
```

---

### 14.4 Order Service (Vitest)

**Location:** `sample-projects/order-service`

A multi-service scenario: the Order Service makes outbound HTTP calls to the Inventory Service.
Demonstrates `external_http_call` tracing and cross-service causal link tracking.

```bash
cd sample-projects/order-service
pnpm install
tracegraph run -- npx vitest run
npx tracegraph open --html .tracegraph/traces/*.trace.json
# → Graph shows: http_request → fn call → external_http_call → http_response
```

---

### 14.5 Laravel API (PHP)

**Location:** `sample-projects/laravel-api`

A Laravel 11 REST API for product catalogue management demonstrating the full PHP/Laravel
tracing stack: HTTP middleware, DB queries, Gate/Policy hooks, queue events, and PHPUnit.

```bash
cd sample-projects/laravel-api
composer install

# 1. Install and configure
php artisan tracegraph:install

# 2. Run tests with tracing
php artisan tracegraph:test
# → .tracegraph/traces/ populated with per-test trace files

# 3. Open a trace
php artisan tracegraph:open
# → Browser opens with call graph showing:
#   http_request → auth_check → authorization_check (OrderPolicy::update)
#   → db_query (SELECT + INSERT) → queue_event (dispatch) → http_response

# 4. Create baseline
php artisan tracegraph:baseline

# 5. Compare on subsequent runs
php artisan tracegraph:compare

# Optional: deep Xdebug enrichment
XDEBUG_MODE=trace XDEBUG_CONFIG="trace_output_dir=/tmp" \
TRACEGRAPH_ENABLED=1 TRACEGRAPH_RUN_DIR=.tracegraph/runs/run_001 \
./vendor/bin/phpunit

tracegraph import xdebug /tmp/trace.*.xt \
  --semantic .tracegraph/runs/run_001/*.events.jsonl \
  --include "app/" \
  --max-events 3000

tracegraph open --html .tracegraph/traces/<traceId>.trace.json
# → Click any controller node → collapsible Xdebug Call Stack appears in detail panel
```

**What the Laravel trace captures:**

| Event type | Source |
|-----------|--------|
| `http_request` / `http_response` | `TraceMiddleware` (auto-registered) |
| `db_query` | `DB::listen()` in `TraceServiceProvider` |
| `authorization_check` | `Gate::after()` with `OrderPolicy::update` inference |
| `auth_check` | `Auth::Attempting` / `Auth::Authenticated` events |
| `queue_event` | `QueueEventListener` — dispatch, start, complete |
| `error` | `Tracegraph::captureException($e)` |

**PHPUnit extension** (adds per-test trace isolation):

```xml
<!-- phpunit.xml -->
<extensions>
  <extension class="Tracegraph\Laravel\Testing\TraceGraphPhpUnitExtension"/>
</extensions>
```

---

## 15. File System Layout

```
<project-root>/
├── tracegraph.config.json        ← project configuration (commit this)
│
└── .tracegraph/
    │
    ├── index.json                ← trace index — last N runs (do NOT commit)
    │
    ├── runs/                     ← temporary, per-run working directories (do NOT commit)
    │   └── run_<id>/
    │       ├── <traceId>.events.jsonl.tmp   ← live event stream (deleted after finalise)
    │       ├── capture-level.json           ← written by language adapter
    │       ├── meta.json                    ← language/framework detected
    │       └── tests/                       ← per-test JSONL streams (Vitest/Jest/PHPUnit)
    │           └── <testTraceId>.events.jsonl.tmp
    │
    ├── traces/                   ← finalised trace files (do NOT commit; regenerate)
    │   └── <traceId>.trace.json  ← atomic-renamed from .tmp; safe to read
    │
    ├── baselines/                ← COMMIT THESE ← source of truth for expected behaviour
    │   └── <testId>.baseline.json
    │
    ├── reports/                  ← compare output (do NOT commit; regenerated)
    │   └── <reportId>.report.json
    │
    ├── bundles/                  ← scenario run bundles (do NOT commit)
    │   └── <scenarioId>_<runId>.bundle.json
    │
    ├── approvals/                ← COMMIT THESE ← finding approvals
    │   └── findings.json
    │
    ├── suppressions/             ← COMMIT THESE ← security-sensitive; triggers policy finding on change
    │   └── tracegraph.suppressions.json
    │
    └── scenarios/                ← COMMIT THESE ← declarative scenario definitions
        └── *.scenario.json
```

**Atomic write protocol** — no file is ever written in-place:

```
1. Adapter streams events → .events.jsonl.tmp  (live, never read externally)
2. Run completes
3. Post-processor builds TraceSession
4. Writes → <traceId>.trace.json.tmp
5. fsync
6. Atomic rename → <traceId>.trace.json  (always a complete file)
7. CLI emits stdout: { "type": "trace.completed", "file": "..." }
```

---

## 16. Configuration Reference

`tracegraph.config.json` (created by `tracegraph init`):

```json
{
  "language":  "typescript",
  "framework": "express",

  "sanitize": {
    "redactKeys": [
      "password", "passwd", "token", "accessToken", "refreshToken",
      "authorization", "cookie", "set-cookie", "session", "secret",
      "apiKey", "clientSecret", "privateKey", "cardNumber", "cvv", "pin"
    ],
    "maxDepth":        4,
    "maxStringLength": 500,
    "maxArrayLength":  50,
    "maxObjectKeys":   100
  },

  "diff": {
    "mode": "structure",
    "valueSensitiveFields": ["status", "role", "currency", "amount"]
  },

  "security": {
    "protectedRoutes":  ["/admin/**", "/payments/**", "/users/*/role"],
    "sensitiveFields":  ["passwordHash", "password", "accessToken", "cvv"]
  },

  "behavior": {
    "failOnCritical": true,
    "failOnHigh":     false
  },

  "storage": {
    "maxRuns":        20,
    "maxAgeDays":     7,
    "maxSizeMB":      500,
    "keepFailedRuns": 50,
    "pruneOnRun":     true
  }
}
```

**Field reference:**

| Field | Default | Description |
|-------|---------|-------------|
| `language` | `"typescript"` | `"typescript"` / `"javascript"` / `"php"` |
| `framework` | `"plain"` | `"express"` / `"fastify"` / `"nextjs"` / `"nestjs"` / `"laravel"` / `"plain"` |
| `sanitize.redactKeys` | *(see above)* | Keys whose values are replaced with `"[REDACTED]"` |
| `sanitize.maxDepth` | `4` | Maximum object nesting depth |
| `sanitize.maxStringLength` | `500` | String truncation length |
| `sanitize.maxArrayLength` | `50` | Array truncation length |
| `diff.mode` | `"structure"` | `"structure"` / `"input-shape"` / `"value-sensitive"` |
| `diff.valueSensitiveFields` | `[]` | Fields compared by value (not normalised to `<id>`) |
| `security.protectedRoutes` | `[]` | Routes that must have auth events (glob patterns) |
| `security.sensitiveFields` | *(see above)* | Response fields that trigger `sensitive_data.in_response` |
| `behavior.failOnCritical` | `false` | Equivalent to always passing `--fail-on-critical` |
| `storage.maxRuns` | `20` | Maximum run directories to keep |
| `storage.maxAgeDays` | `7` | Auto-prune runs older than this |
| `storage.maxSizeMB` | `500` | Total `.tracegraph/` size limit |
| `storage.keepFailedRuns` | `50` | Retain this many failed runs regardless of age |
| `storage.pruneOnRun` | `true` | Auto-prune on every `tracegraph run` |

**Environment variable overrides** (take precedence over config file):

| Variable | Description |
|----------|-------------|
| `TRACEGRAPH_ENABLED` | Set to `1` to activate language adapters |
| `TRACEGRAPH_RUN_DIR` | Override run directory path |
| `TRACEGRAPH_TRACE_ID` | Override trace ID |
| `TRACEGRAPH_WEBVIEW_BUNDLE` | Override webview JS bundle path |

---

## 17. Exit Codes

TraceGraph uses distinct exit codes so CI pipelines can act differently on each outcome:

| Code | Constant | When it happens |
|------|----------|----------------|
| `0` | `SUCCESS` | No open findings above threshold; everything passed |
| `1` | `COMMAND_FAILURE` | The wrapped command (npm test, phpunit, etc.) exited non-zero |
| `2` | `CLI_ERROR` | Bad arguments, missing file, or internal CLI error |
| `3` | `FINDINGS_THRESHOLD` | One or more critical findings are open (`--fail-on-critical`) |
| `4` | `POLICY_REVIEW` | Suppressions file has uncommitted changes in git |
| `5` | `SCHEMA_MIGRATION` | A trace or baseline has a mismatched schema version |
| `6` | `CAPTURE_LEVEL_INSUFFICIENT` | Capture level is below the configured minimum |

**Why `--fail-on-critical` exits 3, not 1:**

Exit code 1 already means "tests failed". Exit code 3 means "tests passed but TraceGraph found
a security/behaviour regression". CI can treat these differently:

```yaml
- name: Run tests with tracing
  run: tracegraph run -- npm test
  # exits 1 → test failure → always blocks merge

- name: Compare behaviour
  run: tracegraph compare --fail-on-critical
  # exits 0 → all good
  # exits 3 → critical finding → block merge
  # exits 4 → suppression policy → requires security reviewer
```

---

## 18. Troubleshooting

### "No traces found" after `tracegraph run`

1. Check the wrapped command actually ran — its stdout/stderr passes through to your terminal
2. Look for `.tracegraph/runs/<runId>/*.events.jsonl.tmp` — if it exists but no `.trace.json`
   was produced, finalisation failed; check for write permission errors on `.tracegraph/traces/`
3. On Windows, invoke via `npx` or the full binary path to avoid `ENOENT` shell differences

### Vitest / Jest reporter not auto-injecting

- Run `tracegraph diagnose` to see what the CLI detected
- If you already have the reporter in `vitest.config.ts`, auto-injection is intentionally skipped
- Pass it manually: `tracegraph run -- npx vitest run --reporter=default --reporter=@tracegraph/vitest`

### `tracegraph compare` shows false-positive diffs (UUIDs, timestamps)

TraceGraph normalises UUIDs, timestamps, and ID-like strings in `structure` mode (the default).
If you're still seeing noise, check that:
- The diff mode is `"structure"` in `tracegraph.config.json` (not `"value-sensitive"`)
- The fields are not listed in `diff.valueSensitiveFields`

### "Schema mismatch" error (exit code 5)

```bash
# Identify affected artifacts
tracegraph schema doctor

# Preview migration
tracegraph baseline migrate --dry-run

# Apply migration
tracegraph baseline migrate
```

If `baseline migrate` exits 5 (incompatible schema), re-capture traces from scratch:

```bash
tracegraph clean --all-runs
tracegraph run -- npm test
tracegraph baseline create --all --reason "Post-upgrade baseline"
```

### Xdebug trace is empty or captures wrong functions

- Ensure `XDEBUG_MODE=trace` is set (not `debug` or `profile`)
- Check `xdebug.trace_output_dir` in `php.ini` points to a writable directory
- Filter to application code: `tracegraph import xdebug ./trace.xt --include "app/"`
- Cap event count for large traces: `--max-events 3000`

### Laravel: no events captured

- Ensure `TRACEGRAPH_ENABLED=1` is set in your `.env` or CI environment
- Do **not** set this variable in production
- Run `php artisan tracegraph:install` to verify the `TraceServiceProvider` is registered
  and the `tracegraph.php` config is published

### HTML viewer is blank or shows loading indefinitely

1. Build the webview bundle: `pnpm --filter @tracegraph/webview build`
2. Or override the bundle path: `TRACEGRAPH_WEBVIEW_BUNDLE=/path/to/tracegraph-viewer.iife.js`
3. Check that the `.trace.json` file is valid JSON and has `schemaVersion: "tracegraph.trace.v1"`

### `finding suppress --requires-evidence` not working

Verify that the evidence event type and name exactly match an event in the trace:

```bash
# List events in the trace to find the correct type and displayName
tracegraph diagnose --trace .tracegraph/traces/<id>.trace.json --json \
  | jq '[.events[] | {type, name, displayName}]'

# Use the exact values in the suppress command:
tracegraph finding suppress <fp> \
  --requires-evidence "authorization_check:GatewayPolicy.validate"
```

---

*TraceGraph is open-source under the MIT licence. The `ee/` directory contains Enterprise Edition
stubs. All packages in `packages/` are MIT-licensed.*

````markdown
# TraceGraph

**Runtime assurance for AI-generated and human-written code.**

TraceGraph captures what your code actually does at runtime, turns execution into an interactive behavior graph, and helps teams detect risky changes before software reaches production.

It is designed for modern development workflows where code is written by humans, AI coding tools, or both — and where passing tests alone may not be enough to know whether a release is safe.

---

## Why TraceGraph?

Modern software teams move fast.

AI coding tools make teams move even faster.

But faster code generation creates a new problem:

> How do you know what the generated or changed code actually did when it ran?

A normal code diff shows what changed in files.

A normal test result shows whether assertions passed.

TraceGraph shows the missing layer:

> **What changed in runtime behavior?**

TraceGraph helps answer questions like:

- Did this PR remove a validation step?
- Did this endpoint still call authorization before writing to the database?
- Did a passing test hide a new side effect?
- Did this change add a new external API call?
- Did the response shape change?
- Did a database write increase from one write to three?
- Did AI-generated code introduce a risky behavior change?
- Did a critical flow still behave like the approved baseline?

---

## What TraceGraph Does

TraceGraph captures runtime events such as:

- HTTP requests
- Function and method calls
- Database queries
- External API calls
- Authorization checks
- Validation steps
- Queue events
- Errors and exceptions
- Resource reads and writes
- Data-flow and response-shape changes
- Concurrent execution paths

It then builds a **runtime behavior graph** that can be inspected, compared, and used as evidence during code review and release assurance.

---

## Core Idea

TraceGraph turns this:

```text
Tests passed.
````

Into this:

```text
Tests passed, but runtime behavior changed:

- validateCouponExpiry() was removed from POST /invoices
- invoices table write still occurred
- authorization check remained present
- response shape added discountOverride
- external call count unchanged
```

TraceGraph helps teams move from simple pass/fail testing to **runtime evidence-based review**.

---

## Product Positioning

TraceGraph is a:

```text
CLI-first runtime assurance platform
with a standalone HTML viewer,
VS Code visual review experience,
language adapters,
behavior diff engine,
and CI-ready reports.
```

The core execution model is CLI-first.

The visual review experience can happen through:

* Self-contained HTML reports
* VS Code extension
* CI reports
* PR summaries
* Future team dashboards

---

## How TraceGraph Fits with ProdReady

TraceGraph can be used independently as a developer tool.

It is also designed to power **ProdReady**, a broader release assurance service.

```text
ProdReady = release assurance platform/service
TraceGraph = runtime behavior evidence engine
```

ProdReady asks:

> Should this release go to production?

TraceGraph answers:

> What actually changed at runtime?

Together, they provide release assurance for modern software teams, especially teams using AI-assisted development.

---

## Theoretical Foundation

TraceGraph is grounded in established computer science ideas:

* Runtime verification
* Dynamic program analysis
* Trace-based regression testing
* Directed acyclic graphs
* Partial-order event semantics
* Dynamic slicing and data-flow reasoning
* Software verification and validation
* Observability and distributed tracing

TraceGraph does not claim to formally prove that software is correct for all possible inputs.

Instead, it verifies important properties over the executions that were actually observed.

In precise terms:

> TraceGraph constructs a runtime behavior graph from observed execution events and checks graph, temporal, and differential properties against approved semantic baselines.

---

## What TraceGraph Can Verify

TraceGraph can verify properties over captured traces, such as:

* A protected route called authorization before a sensitive database write.
* A candidate release preserved an approved validation path.
* A critical flow did not add new database side effects.
* A response did not expose a new sensitive field.
* A concurrent scenario did not produce duplicate writes.
* A PR changed runtime behavior compared with the approved baseline.

TraceGraph does **not** prove universal correctness.

It increases confidence by turning executed tests and scenarios into runtime evidence.

---

## Architecture Overview

```text
TraceGraph
│
├── CLI
│   ├── tracegraph run
│   ├── tracegraph compare
│   ├── tracegraph baseline
│   ├── tracegraph report
│   ├── tracegraph open --html
│   └── tracegraph clean
│
├── Language Adapters
│   ├── JavaScript / TypeScript
│   ├── Express / Fastify / Node
│   ├── Vitest / Jest / Playwright
│   ├── PHP
│   ├── Laravel
│   ├── PHPUnit / Pest
│   └── Xdebug import
│
├── Trace Core
│   ├── Trace schema
│   ├── Event writer
│   ├── Sanitizer
│   ├── Atomic file finalization
│   ├── Storage pruning
│   └── Capture-level reporting
│
├── Graph Engine
│   ├── TraceSession to graph
│   ├── TraceBundle to graph
│   ├── Behavior DAG
│   ├── Resource edges
│   ├── Data-flow edges
│   └── Cross-trace links
│
├── Diff Engine
│   ├── Semantic baselines
│   ├── Behavior diff
│   ├── Response-shape diff
│   ├── Security path diff
│   └── Finding fingerprints
│
├── Viewers
│   ├── Self-contained HTML report
│   └── VS Code extension
│
└── CI / Release Assurance
    ├── GitHub Actions
    ├── PR summaries
    ├── Finding approvals
    ├── Suppressions with evidence
    └── ProdReady evidence packs
```

---

## CLI-First Design

TraceGraph is designed to work anywhere developers already run code:

```bash
tracegraph run -- npm test
tracegraph run -- php artisan test
tracegraph run -- npx vitest
tracegraph run -- npx playwright test
tracegraph compare
tracegraph open --html
```

The CLI is the canonical execution interface.

The VS Code extension is a viewer, launcher, and source-navigation layer on top of the CLI.

---

## Quick Start: Express TypeScript

Install TraceGraph:

```bash
npm install -D tracegraph @tracegraph/js
```

Add TraceGraph middleware:

```ts
import { traceExpress } from "@tracegraph/js/express";

app.use(traceExpress());
```

Run your tests with TraceGraph:

```bash
npx tracegraph run -- npm test
```

Create a baseline:

```bash
npx tracegraph baseline create
```

After changing code, run again:

```bash
npx tracegraph run -- npm test
npx tracegraph compare
```

Generate a self-contained HTML report:

```bash
npx tracegraph open --html .tracegraph/reports/latest.report.json
```

Open the generated HTML file in your browser.

---

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

---

## Runtime Behavior Graph

TraceGraph models runtime behavior as a **directed acyclic graph**.

A simple call tree only shows:

```text
A called B
B called C
```

TraceGraph needs to show more:

```text
A called B
A caused C
B and C ran concurrently
B read resource R
C wrote resource R
input.amount flowed into invoice.total
authorization happened before database write
```

That is why TraceGraph uses a DAG.

---

## Trace Events

A TraceGraph event may represent:

* HTTP request
* Function call
* Method call
* Database query
* External HTTP call
* Authorization check
* Validation check
* Queue dispatch
* Queue job execution
* Cache operation
* File operation
* Error
* Response
* Resource read/write

Example event:

```json
{
  "eventId": "evt_db_write_invoice",
  "traceId": "trace_001",
  "type": "db_query",
  "name": "INSERT INTO invoices",
  "parentEventId": "evt_invoice_service_create",
  "resource": {
    "type": "database_table",
    "key": "invoices",
    "operation": "write"
  },
  "startTime": 1779703921000,
  "endTime": 1779703921012
}
```

---

## Async and Concurrent Execution

TraceGraph supports async branch metadata for JavaScript and TypeScript.

Example:

```ts
const [user, orders] = await Promise.all([
  getUser(id),
  getOrders(id)
]);
```

TraceGraph represents this as:

```text
HTTP Request
└── Promise.all group
    ├── Branch A: getUser
    │   └── DB query: users
    └── Branch B: getOrders
        └── DB query: orders
```

This helps detect behavior that normal call stacks miss.

---

## Cross-Trace Causality

Some runtime behavior happens after the original request ends.

Example:

```text
POST /orders
 → dispatch SendOrderEmailJob

Later:
SendOrderEmailJob.handle()
 → send email
```

TraceGraph links these as causally related traces.

```text
dispatch SendOrderEmailJob
  causes
SendOrderEmailJob.handle
```

This is important for queues, background jobs, retries, and distributed flows.

---

## Semantic Baselines

TraceGraph does not store full raw traces as baselines by default.

Instead, it stores compact semantic baselines.

A baseline records expected behavior such as:

* Which semantic events occurred
* Which resources were read or written
* Which authorization or validation events were present
* Which external calls happened
* What response shape was returned
* Which critical relationships existed

Example:

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
    {
      "type": "database_table",
      "key": "invoices",
      "operation": "write",
      "count": 1
    }
  ]
}
```

Baselines are small enough to commit to git.

Raw traces are local artifacts and are pruned automatically.

---

## Diffing Runtime Behavior

TraceGraph compares candidate behavior against approved baselines.

It can detect:

* Removed validation
* Removed authorization
* Added database writes
* Removed database writes
* Added external calls
* Response shape changes
* Sensitive field exposure
* Changed resource side effects
* Changed queue behavior
* Changed concurrency behavior

Default diff mode avoids noisy value comparisons.

For example:

```json
{
  "invoiceId": "INV-001"
}
```

and:

```json
{
  "invoiceId": "INV-523"
}
```

are not flagged as a behavior change by default because the response shape is still:

```text
invoiceId: string
```

TraceGraph focuses on meaningful behavior, not volatile values.

---

## Capture Level

TraceGraph must never silently provide weak traces.

Every trace includes a capture-level summary.

Example:

```json
{
  "captureLevel": {
    "overall": 2,
    "label": "Framework-level tracing",
    "adapters": {
      "express": {
        "level": 2,
        "mode": "middleware",
        "captured": [
          "http_request",
          "http_response",
          "errors"
        ],
        "notCaptured": [
          "automatic internal function calls"
        ],
        "recommendation": "Use traceFunction or transform plugin for deeper function tracing."
      }
    }
  }
}
```

Capture level appears in:

* Trace artifacts
* CLI output
* HTML reports
* CI summaries
* Future PR comments

---

## Approvals and Suppressions

TraceGraph separates three concepts:

```text
Baseline approval = updates expected behavior.
Finding approval = accepts one specific finding instance.
Suppression = conditionally hides a recurring finding only when compensating evidence still exists.
```

This distinction is important.

A baseline approval says:

> This is now the expected runtime behavior.

A finding approval says:

> This specific finding is accepted for now.

A suppression says:

> Do not report this rule for this target, but only while required evidence remains present.

Example suppression:

```json
{
  "ruleId": "security.authorization.middleware_removed",
  "semanticTarget": {
    "routeMethod": "PUT",
    "routePathPattern": "/users/{id}/role"
  },
  "requiresEvidence": [
    {
      "type": "authorization_check",
      "name": "RolePolicy.update"
    }
  ],
  "reason": "Authorization moved from middleware to policy",
  "expiresAt": "2026-08-01"
}
```

`requiresEvidence` is evaluated on every run.

If the compensating control disappears, the finding reopens.

---

## Security-Sensitive Suppression Files

TraceGraph treats suppression files as security-sensitive.

If a PR modifies:

```text
tracegraph.suppressions.json
```

TraceGraph emits a distinct finding.

In team mode, this can require approval from a designated reviewer.

This prevents a developer from introducing a security issue and hiding it in the same PR.

---

## Storage Management

TraceGraph manages local storage automatically.

Default behavior:

* Compress completed trace files
* Keep recent runs
* Prune old traces
* Preserve baselines
* Preserve approved artifacts
* Ignore raw traces in git

Recommended `.gitignore`:

```gitignore
.tracegraph/runs/
.tracegraph/traces/
.tracegraph/reports/
```

Recommended committed files:

```text
.tracegraph/baselines/
tracegraph.config.json
tracegraph.suppressions.json
tracegraph/scenarios/
```

Useful commands:

```bash
tracegraph storage status
tracegraph clean
tracegraph clean --older-than 7d
tracegraph clean --keep-last 20
```

---

## Self-Contained HTML Reports

TraceGraph can generate a self-contained HTML report:

```bash
tracegraph open --html .tracegraph/reports/latest.report.json
```

The HTML file can be:

* Opened locally
* Shared with teammates
* Uploaded as a CI artifact
* Attached to a PR
* Used in release evidence packs

No server is required for the MVP HTML viewer.

---

## VS Code Extension

The VS Code extension is planned as a visual review layer.

It will:

* Launch TraceGraph CLI commands
* Open completed trace artifacts
* Show behavior graphs
* Show timeline and data-flow views
* Navigate from graph nodes to source code
* Display findings
* Help review baselines and approvals

The extension will not own the runtime engine.

It will spawn the CLI and read completed artifacts.

---

## Multi-Language Trace Bundles

TraceGraph supports the idea of linked traces from multiple languages or runtimes.

Example:

```text
Playwright browser action
 → TypeScript frontend request
 → PHP Laravel backend
 → database write
```

Each runtime writes its own trace.

TraceGraph links them using:

* `scenarioId`
* `correlationId`
* `traceparent`
* `x-tracegraph-scenario-id`
* `x-tracegraph-correlation-id`

The result is a `TraceBundle`.

```json
{
  "schemaVersion": "tracegraph.bundle.v1",
  "scenarioId": "checkout-flow-001",
  "traces": [
    {
      "language": "typescript",
      "traceId": "trace_frontend_001",
      "file": "traces/trace_frontend_001.trace.json"
    },
    {
      "language": "php",
      "traceId": "trace_backend_001",
      "file": "traces/trace_backend_001.trace.json"
    }
  ],
  "links": [
    {
      "source": {
        "traceId": "trace_frontend_001",
        "eventId": "evt_browser_click"
      },
      "target": {
        "traceId": "trace_backend_001",
        "eventId": "evt_http_request"
      },
      "type": "causes",
      "correlationId": "corr_123"
    }
  ]
}
```

---

## CI Example

Basic GitHub Actions example:

```yaml
name: TraceGraph

on:
  pull_request:

jobs:
  tracegraph:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Run tests with TraceGraph
        run: npx tracegraph run -- npm test

      - name: Compare runtime behavior
        run: npx tracegraph compare

      - name: Publish TraceGraph summary
        run: npx tracegraph report --github-step-summary

      - name: Upload TraceGraph artifacts
        uses: actions/upload-artifact@v4
        with:
          name: tracegraph-report
          path: |
            .tracegraph/reports/
            .tracegraph/traces/
```

---

## Scenario Runner

TraceGraph is designed to support scenario-based runtime assurance.

Example scenario:

```json
{
  "name": "non-admin user cannot update role",
  "type": "security",
  "request": {
    "method": "PUT",
    "url": "/users/USER_200/role",
    "headers": {
      "Authorization": "Bearer {{nonAdminToken}}"
    },
    "body": {
      "role": "admin"
    }
  },
  "expect": {
    "status": [401, 403],
    "mustNotWrite": ["users.role"],
    "mustCallAny": [
      "RolePolicy.update",
      "Gate::authorize",
      "AuthorizationGuard"
    ]
  }
}
```

Future versions may generate scenarios automatically from TraceGraph findings.

---

## AI Code Assurance

TraceGraph is especially useful when reviewing AI-generated code.

AI coding tools can produce correct-looking changes that pass tests but still alter important runtime behavior.

TraceGraph helps reviewers see:

* What runtime path changed
* What validation was removed
* What authorization was skipped
* What database writes were added
* What external calls were introduced
* What scenarios are missing
* What should be reviewed before merge

Future AI Code Assurance features may include:

* Runtime risk explanations
* Suggested missing tests
* Scenario generation from findings
* PR summaries
* Release risk classification

---

## Roadmap

### Milestone 0: Trace File Protocol

* Schema versioning
* JSONL event writing
* Atomic file finalization
* Low-volume CLI stdout protocol
* Storage configuration
* `tracegraph clean`

### Milestone 1: Express Vertical Slice

* `tracegraph run`
* Express adapter
* One real request trace
* Trace JSON output
* Self-contained HTML viewer

### Milestone 2: Diff and Baseline

* Structured semantic signatures
* Compact baselines
* Behavior diff
* Finding fingerprints
* Finding approvals
* Suppressions with evidence

### Milestone 3: Test Runner Adapters

* Vitest adapter
* Jest adapter
* Capture-level reporting
* No silent weak traces

### Milestone 4: Laravel Adapter

* Laravel middleware
* DB listener
* Gate hooks
* Policy inference
* Optional Xdebug enrichment

### Milestone 5: VS Code Viewer

* CLI launcher
* Trace viewer
* Graph navigation
* Timeline view
* Source-code navigation

### Milestone 6: Scenario Runner

* HTTP/API scenarios
* Concurrency scenarios
* Security scenarios
* Reliability scenarios

### Milestone 7: CI and Team Workflows

* GitHub Actions
* PR summaries
* Team baselines
* Approval workflow
* Policy enforcement

### Milestone 8: AI Code Assurance

* AI-generated risk summaries
* Missing scenario suggestions
* Scenario generation from findings
* Runtime evidence for AI code review

---

## Open Source and Commercial Model

TraceGraph is planned as an open-core project.

### Community Edition

The community edition should include:

* CLI
* Local tracing
* Basic JavaScript/TypeScript support
* Basic PHP/Laravel support
* Self-contained HTML viewer
* Local behavior diff
* Compact baselines
* Basic GitHub Actions support

### Commercial / Team Edition

Commercial features may include:

* Hosted PR intelligence
* Team baselines
* Approval workflows
* Suppression governance
* AI Code Assurance
* Security Lab
* Reliability Lab
* Team dashboard
* Policy-as-code
* Audit history
* ProdReady release evidence packs

---

## License

TraceGraph Community Edition is intended to be released under the Apache License 2.0.

Enterprise and commercial modules may be licensed separately.

```text
Community core: Apache-2.0
Enterprise modules: Commercial License
```

---

## What TraceGraph Is Not

TraceGraph is not a replacement for:

* Unit tests
* Integration tests
* Static analysis
* Code review
* Formal verification
* Observability tools
* Security testing

TraceGraph complements these tools.

It adds runtime behavior evidence to the development and release process.

---

## What TraceGraph Is

TraceGraph is:

* A runtime assurance engine
* A behavior graph generator
* A trace-based regression analysis tool
* A CI evidence tool
* A PR review assistant
* A runtime verification layer for AI-assisted software development
* A release assurance evidence engine for ProdReady

---

## Status

TraceGraph is currently in early product and architecture design.

The initial engineering focus is:

```text
1. CLI file protocol
2. Express TypeScript vertical slice
3. Self-contained HTML viewer
4. Behavior diff
5. Compact baselines
6. Basic CI reporting
```

---

## Contributing

Contribution guidelines will be published as the project matures.

Expected contribution areas:

* Language adapters
* Framework integrations
* Trace schema design
* Graph visualization
* Runtime verification rules
* CI integrations
* Documentation
* Sample applications

---

## Guiding Principle

> A test tells you whether an assertion passed.
> TraceGraph shows you what the code actually did.

TraceGraph exists to help teams ship software with stronger runtime evidence, better code review, and more confidence in the AI-assisted software development era.

```
```

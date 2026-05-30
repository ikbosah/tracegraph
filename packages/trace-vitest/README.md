# @tracegraph/vitest

TraceGraph reporter and test utilities for Vitest. Produces per-test `.trace.json` files (capture level 5), giving full test-lifecycle isolation so every test case has its own trace. Also exports `traceTest()` for asserting on runtime behaviour directly inside Vitest tests.

## What's in this package

| Export | Description |
|--------|-------------|
| `TraceGraphReporter` | Vitest reporter class — attaches to Vitest's lifecycle hooks to write one trace per test |
| `traceTest(name, fn)` | Wraps a Vitest test with a trace context and exposes `trace.expectBehavior()` for behavioural assertions |
| `makeTraceAssertions(traceId)` | Returns a `TraceAssertions` object for a specific trace ID — useful for custom test helpers |
| `TraceAssertions` | Interface exposing `mustCall`, `mustNotCall`, and `expectBehavior` |
| `ExpectBehaviorOptions` | `{ mustCall?, mustNotCall? }` |

## Installation

```bash
npm install -D @tracegraph/vitest vitest
```

## Usage

### 1. Add the reporter to `vitest.config.ts`

```typescript
import { defineConfig } from 'vitest/config';
import { TraceGraphReporter } from '@tracegraph/vitest';

export default defineConfig({
  test: {
    reporters: ['verbose', new TraceGraphReporter()],
  },
});
```

Or let `tracegraph run` inject it automatically:

```bash
tracegraph run -- npx vitest run
# → "@tracegraph/vitest reporter auto-injected"
```

Each test run produces one `.trace.json` per test case in `.tracegraph/traces/`.

### 2. Behavioural assertions with `traceTest`

`traceTest` wraps a standard Vitest test. Inside the callback you get a `trace` object that lets you assert which functions were called at runtime.

```typescript
import { describe, expect } from 'vitest';
import { traceTest } from '@tracegraph/vitest';
import { app } from '../src/app';
import request from 'supertest';

describe('InvoiceService', () => {
  traceTest('creates an invoice and validates tax', async (trace) => {
    const res = await request(app).post('/invoices').send({ amount: 100, region: 'US' });
    expect(res.status).toBe(201);

    trace.expectBehavior({
      mustCall:    ['InvoiceService.create', 'TaxService.calculate'],
      mustNotCall: ['InvoiceService.sendEmailDirect'],
    });
  });
});
```

The test fails if any `mustCall` function is absent from the trace, or if any `mustNotCall` function appears.

### 3. Via the reporter entry point

The default export allows Vitest to load the reporter via the short string form:

```bash
npx vitest --reporter=verbose --reporter=@tracegraph/vitest
```

## What the reporter captures

Each test trace includes:

- `test_suite` event — the `describe` block name and file
- `test_run` event — the individual test name, pass/fail status, and duration
- All events emitted by `traceFunction` / `traceMethod` / `traceExpress` during the test body
- Error events on test failure, including the error type and message

## Trace isolation

The reporter creates a fresh trace context for each test case. Events from concurrent tests (when using Vitest's parallel workers) are written to separate `.tmp` files and finalised independently, so traces never mix between tests.

## Requirements

- Vitest ≥ 1.0.0
- `@tracegraph/trace-js` (optional peer — needed if using `traceFunction` / `traceExpress` within tests)
- `TRACEGRAPH_ENABLED=1` and `TRACEGRAPH_RUN_DIR` set in the environment (set automatically by `tracegraph run`)

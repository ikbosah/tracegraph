# @tracegraph/trace-js

JavaScript and TypeScript instrumentation adapters for TraceGraph. Provides everything needed to capture runtime events from Node.js applications and tests: Express middleware, manual function/method wrappers, automatic HTTP client patching, and CJS/ESM register hooks for zero-config auto-instrumentation.

## What's in this package

| Export | Description |
|--------|-------------|
| `traceExpress(options?)` | Express middleware — captures `http_request` and `http_response` events, including method, path, status, sanitized headers and body |
| `traceFunction(name, fn)` | Wraps any function to emit `function_call` events with timing and sanitized input/output |
| `traceMethod()` | TypeScript decorator equivalent of `traceFunction` for class methods |
| `patchGlobalFetch()` | Patches the global `fetch` to capture `external_http_call` events |
| `subscribeUndiciChannel()` | Subscribes to the Node.js diagnostics channel for undici (the native fetch implementation) |
| `tracedAxios(instance?)` | Wraps an axios instance to capture `external_http_call` events |
| `ChildEventWriter` | Low-level JSONL event emitter used by adapters |
| `traceStorage` / `getContext` / `writeEvent` / `currentParentEventId` | `AsyncLocalStorage`-based context used to correctly nest parent/child event IDs |
| `TRACEGRAPH_ENV` | Helper to read `TRACEGRAPH_ENABLED`, `TRACEGRAPH_RUN_DIR`, `TRACEGRAPH_TRACE_ID` |

### Register hooks (separate entry points)

| Entry point | Use case |
|-------------|----------|
| `@tracegraph/trace-js/register` | ESM `--import` hook — auto-instruments CJS modules loaded after registration |
| `@tracegraph/trace-js/register-cjs` | CJS `--require` hook — same, for CommonJS contexts |

## Installation

```bash
npm install -D @tracegraph/trace-js
```

Express is a peer dependency (optional — only needed if you use `traceExpress`):

```bash
npm install express
```

## Usage

### Express middleware

Add **before** your route handlers. The middleware captures the full request/response lifecycle as a pair of trace events.

```typescript
import express from 'express';
import { traceExpress } from '@tracegraph/trace-js';

const app = express();
app.use(express.json());
app.use(traceExpress({
  sanitizerConfig: {
    redactKeys:      ['authorization', 'cardNumber'],
    maxStringLength: 500,
  },
}));

app.post('/invoices', invoiceHandler);
```

Events emitted per request:
- `http_request` — on entry (method, path, sanitized headers + body)
- `http_response` — on exit (status code, sanitized response body, duration)

### Manual function wrappers (Level 2 capture)

```typescript
import { traceFunction, traceMethod } from '@tracegraph/trace-js';

// Wrap any function
const tracedCreate = traceFunction('InvoiceService.create', originalCreate);
const result = await tracedCreate(invoiceData);

// Class method decorator
class InvoiceService {
  @traceMethod()
  async create(data: CreateInvoiceDto) {
    // ...
  }
}
```

Each call emits a `function_call` event with the function name, sanitized arguments, return value, timing, and `parentEventId` correctly set from the `AsyncLocalStorage` call context.

### Outbound HTTP patching

```typescript
import { patchGlobalFetch, tracedAxios } from '@tracegraph/trace-js';

// Patch global fetch (or undici)
patchGlobalFetch();

// Or wrap an axios instance
import axios from 'axios';
const client = tracedAxios(axios.create({ baseURL: 'https://api.example.com' }));
```

Outbound calls emit `external_http_call` events with the URL, method, status, and duration.

### Auto-instrumentation via register hooks

For CJS modules, pass `--require` to Node.js:

```bash
node --require @tracegraph/trace-js/register-cjs src/app.js
# or via tracegraph run:
tracegraph run -- node --require @tracegraph/trace-js/register-cjs src/app.js
```

For ESM:

```bash
node --import @tracegraph/trace-js/register src/app.mjs
```

The register hooks patch `require`/`import` to automatically wrap exported functions from application modules (non-`node_modules`) with `traceFunction`.

## Capture levels

This package contributes to the following [capture levels](../shared-types):

| Level | How |
|-------|-----|
| **1** | `traceExpress()` middleware |
| **2** | `traceFunction()` / `traceMethod()` / `patchGlobalFetch()` |
| **3** | `@tracegraph/trace-js/register-cjs` register hook |
| **4** | `@tracegraph/trace-js/register` ESM hook |

Level 5 (per-test isolation) is provided by `@tracegraph/vitest` and `@tracegraph/jest`.

## How parent/child nesting works

All adapters use a shared `AsyncLocalStorage` context (`traceStorage`). When `traceExpress` receives a request, it creates a new context containing the current `traceId` and `parentEventId`. Every `traceFunction` call inside that request reads from the context to set `parentEventId` on its own event — even across `await` boundaries and `Promise.all` concurrency.

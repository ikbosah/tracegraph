# Sample: Node.js Batch Script

A standalone Node.js + TypeScript batch processing script that demonstrates TraceGraph on a **non-HTTP** workload. There is no web server — TraceGraph wraps the script as a `cli_command` entrypoint and captures function-level traces using manual `traceFunction()` wrappers.

## What this project demonstrates

| Concept | Where to look |
|---------|---------------|
| `cli_command` trace entrypoint (no HTTP required) | `src/index.ts` — wrapped via `tracegraph run` |
| `traceFunction()` producing a nested call graph | `src/batch-processor.ts` |
| Error events when processing fails | `src/batch-processor.ts` — `processInvoice` throws on validation failure |
| Capture level 0 vs level 2 | run the script directly vs with `traceFunction` wrappers |
| Per-test traces with Vitest | `pnpm trace:test` |

## Tech stack

- **Node.js** with TypeScript (no framework)
- **Vitest** for unit tests
- **@tracegraph/trace-js** for instrumentation

## Domain model

A batch invoice processor that reads a list of raw invoices, validates each one, applies a tax calculation, and produces a summary report. Intentionally simple so the call graph is easy to follow.

```
index.ts          ← CLI entry point; calls processBatch()
  └─ processBatch()         ← top-level traced function
       ├─ processInvoice()  ← traced; calls validate + calculateTax per invoice
       │    ├─ validateInvoice()   ← checks required fields, positive amounts
       │    └─ calculateTax()      ← rate lookup by currency code
       └─ generateSummary()  ← tallies succeeded / failed / totalValue
```

## Setup

```bash
cd sample-projects/node-script
pnpm install
```

## Running

### Direct execution (no tracing — level 0)

```bash
pnpm start
# Processing 5 pending invoices...
# Batch complete:
#   4 succeeded  (total billed: 1234.56)
#   1 failed
```

### With tracing (level 2 — function calls captured)

```bash
pnpm trace
# equivalent to: tracegraph run -- tsx src/index.ts
```

TraceGraph wraps the script and records every `traceFunction`-wrapped call as a `function_call` event, including timing, inputs, and any errors.

### Tests with tracing

```bash
pnpm trace:test
# equivalent to: tracegraph run -- pnpm test
```

Vitest runs the unit tests and each test gets its own trace file in `.tracegraph/traces/`.

## Exploring the trace

After `pnpm trace` or `pnpm trace:test`:

```bash
npx tracegraph open --html .tracegraph/traces/*.trace.json
```

The call graph for a successful batch run looks like:

```
function_call  processBatch          (total duration)
  ├─ function_call  processInvoice   (invoice 1)
  ├─ function_call  processInvoice   (invoice 2)
  │    └─ error  processInvoice → error  (validation failed)
  ├─ function_call  processInvoice   (invoice 3)
  └─ function_call  generateSummary
```

The **Error Path** view shows the causal chain from each failed invoice back to the `processBatch` root — useful for understanding which validation rule fired and why.

## The `cli_command` entrypoint

Unlike HTTP services where TraceGraph records `http_request` as the root event, a script wrapped with `tracegraph run` records a `cli_command` entrypoint:

```json
{
  "entrypoint": {
    "type": "cli_command",
    "command": "tsx src/index.ts"
  }
}
```

This is reflected in the title bar of the HTML viewer and in the trace index.

## Full workflow

```bash
# 1. Run the script with tracing
pnpm trace

# 2. Open the trace
npx tracegraph open --html .tracegraph/traces/*.trace.json

# 3. Approve as baseline
npx tracegraph baseline create --reason "Initial batch baseline"

# 4. Modify the script (e.g. remove the validateInvoice call)
# 5. Run again
pnpm trace

# 6. Compare — TraceGraph detects the removed validation step
npx tracegraph compare
```

## Key files

```
src/
  index.ts             ← entry point; calls processBatch(), exits non-zero on failures
  batch-processor.ts   ← traceFunction-wrapped: processBatch, processInvoice, generateSummary
  validators.ts        ← validateInvoice — checks required fields and positive amounts
  tax-calculator.ts    ← calculateTax — rate table by currency code
  data.ts              ← PENDING_INVOICES fixture (mix of valid and invalid records)
tests/
  batch-processor.test.ts  ← unit tests for processBatch and processInvoice
```

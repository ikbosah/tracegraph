# Sample: Express TypeScript API

A minimal Express 4 + TypeScript invoice API that demonstrates the complete TraceGraph onboarding workflow for a Node.js web service. Start here if you are adding TraceGraph to an Express application.

## What this project demonstrates

| Concept | Where to look |
|---------|---------------|
| `traceExpress()` middleware (capture level 1) | `src/app.ts` |
| `traceFunction()` wrappers on service methods (capture level 2) | `src/services/invoice-service.ts` |
| Nested call graph: request → service → repository | any trace in the viewer |
| Tax calculation as a named child event | `src/services/tax-service.ts` |
| Redacting sensitive fields (`cardNumber`, `cvv`) | `src/app.ts` — `sanitizerConfig` |
| Baseline creation and regression detection | full workflow below |

## Tech stack

- **Express 4** with TypeScript
- **Vitest** for tests
- **@tracegraph/trace-js** for instrumentation

## Domain model

A simple invoicing service with three layers:

```
InvoiceRepository   ← in-memory store (no database)
     ↑
  TaxService        ← calculates tax by currency (USD 8%, GBP 20%, EUR 15%)
     ↑
InvoiceService      ← business logic, traceFunction-wrapped
     ↑
  /invoices routes  ← Express router
```

## API routes

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/invoices` | Create an invoice (returns `201` with tax breakdown) |
| `GET` | `/invoices` | List all invoices |
| `GET` | `/invoices/:id` | Get a single invoice |
| `PUT` | `/invoices/:id` | Update invoice status or amount |
| `DELETE` | `/invoices/:id` | Delete an invoice |
| `GET` | `/health` | Health check |

## Setup

```bash
cd sample-projects/express-typescript
pnpm install
```

## Running

### Development server

```bash
pnpm dev
# Express listening on http://localhost:3000
```

Try it:

```bash
curl -X POST http://localhost:3000/invoices \
  -H 'Content-Type: application/json' \
  -d '{"customerId":"cust_001","amount":500,"currency":"USD","description":"Consulting"}'
# {"id":1,"amount":500,"currency":"USD","taxAmount":40,"totalAmount":540,"status":"draft"}
```

### Tests (without tracing)

```bash
pnpm test
```

### Tests with tracing

```bash
pnpm trace:test
# equivalent to: tracegraph run -- pnpm test
```

This runs all Vitest tests and produces a `.trace.json` for each test case in `.tracegraph/traces/`.

## Exploring the trace

After `pnpm trace:test`:

```bash
# Open the most recent trace in your browser
npx tracegraph open --html .tracegraph/traces/*.trace.json
```

In the call graph you will see:

```
http_request  POST /invoices
  └─ function_call  InvoiceService.createInvoice
       ├─ function_call  TaxService.calculate
       └─ function_call  InvoiceRepository.create
http_response  POST /invoices → 201
```

Each node is colour-coded (blue = HTTP, grey = function calls). Click any node to see its timing, inputs, and outputs in the detail panel on the right.

## Full baseline → compare workflow

```bash
# 1. Run tests with tracing and approve as baseline
pnpm trace:test
npx tracegraph baseline create --reason "Initial baseline"

# 2. Make a change (e.g. simulate removing the tax calculation)
#    Edit src/services/invoice-service.ts and comment out the TaxService call

# 3. Run again and compare
pnpm trace:test
npx tracegraph compare

# Output:
# [tracegraph] 1 open finding(s): 1 high
# High: function_call TaxService.calculate removed from baseline
```

## Key files

```
src/
  app.ts                       ← traceExpress() registered here
  services/
    invoice-service.ts         ← traceFunction() on every public method
    tax-service.ts             ← calculates tax by currency code
  repositories/
    invoice-repository.ts      ← in-memory CRUD store
  routes/
    invoices.ts                ← Express router — maps HTTP verbs to service calls
tests/
  invoices.test.ts             ← integration tests against a live server on a random port
```

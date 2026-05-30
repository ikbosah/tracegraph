# Sample: Inventory Service

A TypeScript Express service that manages product stock. This is one half of the two-service microservices sample — the **Order Service** calls this service to check and reserve stock. Run it standalone or together with the Order Service to see cross-service `external_http_call` events in the Order Service's trace.

## What this project demonstrates

| Concept | Where to look |
|---------|---------------|
| `traceExpress()` capturing HTTP lifecycle (level 1) | `src/app.ts` |
| `traceFunction()` on service methods (level 2) | `src/services/inventory-service.ts` |
| 404 errors captured as `error` events in the trace | `getStock` — throws when product not found |
| Conflict errors (insufficient stock) in the trace | `reserveStock` — returns `reserved: false` |
| Per-test trace isolation with Vitest | `pnpm trace:test` |

## Tech stack

- **Express 4** with TypeScript
- **Vitest** for integration tests
- **@tracegraph/trace-js** for instrumentation

## Domain model

An in-memory product inventory with three operations:

| Operation | Service method | Description |
|-----------|---------------|-------------|
| Check stock | `InventoryService.getStock` | Returns current and available units for a product |
| Reserve stock | `InventoryService.reserveStock` | Atomically reserves N units; returns `reserved: false` if insufficient |
| Release stock | `InventoryService.releaseStock` | Returns previously-reserved units |

## API routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/inventory/:productId` | Get stock level for a product |
| `POST` | `/inventory/:productId/reserve` | Reserve `{ units: number }` units |
| `POST` | `/inventory/:productId/release` | Release `{ units: number }` units |
| `GET` | `/health` | Health check |

## Setup

```bash
cd sample-projects/inventory-service
pnpm install
```

## Running

### Development server

```bash
pnpm dev
# Inventory service listening on http://localhost:3001
```

Try it:

```bash
# Check stock for product prod_001
curl http://localhost:3001/inventory/prod_001
# {"productId":"prod_001","name":"Widget A","stock":100,"reserved":0,"available":100}

# Reserve 5 units
curl -X POST http://localhost:3001/inventory/prod_001/reserve \
  -H 'Content-Type: application/json' \
  -d '{"units":5}'
# {"reserved":true,"available":95}
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

## Exploring the trace

```bash
npx tracegraph open --html .tracegraph/traces/*.trace.json
```

A successful `POST /inventory/:id/reserve` trace looks like:

```
http_request  POST /inventory/prod_001/reserve
  └─ function_call  InventoryService.reserveStock
http_response  POST /inventory/prod_001/reserve → 200
```

A failed request (product not found) shows the `error` event in the Error Path view:

```
http_request  GET /inventory/unknown_product
  └─ function_call  InventoryService.getStock
       └─ error  Product not found: unknown_product
http_response  GET /inventory/unknown_product → 404
```

## Running alongside the Order Service

The Order Service calls this service's `/inventory` endpoints. To see `external_http_call` events in the Order Service's trace, start this service first:

```bash
# Terminal 1 — start inventory service
cd sample-projects/inventory-service
pnpm dev   # port 3001

# Terminal 2 — run order service tests with tracing
cd sample-projects/order-service
pnpm trace:test
```

The Order Service's trace will show `external_http_call` events pointing to `http://localhost:3001/inventory/...`.

## Full workflow

```bash
# 1. Run with tracing
pnpm trace:test

# 2. Open a trace
npx tracegraph open --html .tracegraph/traces/*.trace.json

# 3. Baseline
npx tracegraph baseline create --reason "Initial baseline"

# 4. Simulate a change — comment out the reserveStock call in the route
# 5. Re-run and compare
pnpm trace:test
npx tracegraph compare
# High finding: InventoryService.reserveStock removed from baseline
```

## Key files

```
src/
  app.ts                          ← traceExpress() registered here
  server.ts                       ← starts Express on port 3001
  services/
    inventory-service.ts          ← traceFunction-wrapped: getStock, reserveStock, releaseStock
  routes/
    inventory.ts                  ← Express router
  data/
    inventory.ts                  ← in-memory stock store with initial product fixtures
tests/
  inventory.test.ts               ← integration tests covering happy path and error cases
```

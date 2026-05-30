# Sample: Order Service

A TypeScript Express service that places and manages orders. It calls the **Inventory Service** to check and reserve stock before confirming an order. This is one half of the two-service microservices sample and is the primary project for learning how TraceGraph captures cross-service `external_http_call` events and detects removed authorization checks.

## What this project demonstrates

| Concept | Where to look |
|---------|---------------|
| `auth_check` event — Critical finding if removed | `src/auth.ts` — `assertCanPlaceOrder()` |
| `external_http_call` events from outbound fetch | `src/services/inventory-client.ts` |
| `traceExpress()` HTTP lifecycle capture (level 1) | `src/app.ts` |
| `traceFunction()` on service methods (level 2) | `src/services/order-service.ts` |
| Cross-service call chain in one trace | `createOrder` flow |
| Critical finding when auth check is removed | full workflow below |

## Tech stack

- **Express 4** with TypeScript
- **Vitest** for integration tests
- **@tracegraph/trace-js** for instrumentation and auth event emission

## Domain model

```
POST /orders
  └─ OrderService.createOrder
       ├─ assertCanPlaceOrder()      ← emits auth_check (Critical if removed)
       ├─ InventoryClient.checkStock  ← external_http_call → inventory-service
       ├─ InventoryClient.reserveStock ← external_http_call → inventory-service
       └─ orderStore.create           ← persists the confirmed order
```

## API routes

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/orders` | Place an order — checks and reserves stock, then confirms |
| `GET` | `/orders` | List all orders |
| `GET` | `/orders/:id` | Get a single order |
| `DELETE` | `/orders/:id` | Cancel an order |
| `GET` | `/health` | Health check |

**Request body for `POST /orders`:**

```json
{
  "customerId": "cust_001",
  "productId":  "prod_001",
  "quantity":   3
}
```

## Setup

```bash
cd sample-projects/order-service
pnpm install
```

The Inventory Service is mocked in tests — you do not need it running to run `pnpm test` or `pnpm trace:test`.

## Running

### Development server (requires inventory-service)

```bash
# Terminal 1
cd sample-projects/inventory-service && pnpm dev   # port 3001

# Terminal 2
cd sample-projects/order-service && pnpm dev       # port 3002
```

```bash
# Place an order
curl -X POST http://localhost:3002/orders \
  -H 'Content-Type: application/json' \
  -d '{"customerId":"cust_001","productId":"prod_001","quantity":2}'
# {"id":1,"customerId":"cust_001","productId":"prod_001","quantity":2,"status":"confirmed"}
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

The call graph for a successful `POST /orders` looks like:

```
http_request  POST /orders
  └─ function_call  OrderService.createOrder
       ├─ auth_check  OrderPolicy.canPlace       ← red node (Critical anchor)
       ├─ external_http_call  GET /inventory/prod_001
       ├─ external_http_call  POST /inventory/prod_001/reserve
       └─ function_call  orderStore.create
http_response  POST /orders → 201
```

The `auth_check` node appears in red. Click it to see the event details — `eventName: "OrderPolicy.canPlace"`.

## The Critical finding demo

This project is designed to show how TraceGraph detects a removed authorization check. The `assertCanPlaceOrder()` function in `src/auth.ts` emits an `auth_check` event every time it is called. TraceGraph treats `auth_check` events as **Critical** baseline anchors.

**To trigger a Critical finding:**

1. Run tests with tracing and baseline:

   ```bash
   pnpm trace:test
   npx tracegraph baseline create --reason "Secure baseline with auth check"
   ```

2. Open `src/services/order-service.ts` and comment out the `assertCanPlaceOrder` call:

   ```typescript
   // assertCanPlaceOrder(input.customerId);  ← comment this out
   ```

3. Run tests and compare:

   ```bash
   pnpm trace:test
   npx tracegraph compare
   ```

4. Output:

   ```
   [tracegraph] 1 open finding(s): 1 critical
   🔴 Critical: Authorization check removed
      rule: security.authorization.middleware_removed
      The auth_check event "OrderPolicy.canPlace" was present in the baseline
      but is absent from the candidate trace.
   ```

The build will exit with code **3** if you add `--fail-on-critical`:

```bash
npx tracegraph compare --fail-on-critical
echo $?   # 3
```

## Full workflow

```bash
# 1. Run with tracing
pnpm trace:test

# 2. Explore the trace
npx tracegraph open --html .tracegraph/traces/*.trace.json

# 3. Baseline
npx tracegraph baseline create --reason "Secure baseline"

# 4. List findings (should be none)
npx tracegraph compare
npx tracegraph finding list

# 5. Remove the auth check (see above) and re-run
pnpm trace:test
npx tracegraph compare --fail-on-critical
# exit 3 — Critical finding open
```

## Key files

```
src/
  app.ts                           ← traceExpress() registered here
  server.ts                        ← starts Express on port 3002
  auth.ts                          ← assertCanPlaceOrder() — emits auth_check event
  services/
    order-service.ts               ← traceFunction-wrapped: createOrder, getOrder, cancelOrder
    inventory-client.ts            ← calls inventory-service via fetch (external_http_call)
  routes/
    orders.ts                      ← Express router
  data/
    orders.ts                      ← in-memory order store
tests/
  orders.test.ts                   ← integration tests — mocks inventory-service responses
```

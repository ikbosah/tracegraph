# Sample: Laravel API

A Laravel 11 REST API for a product catalogue with stock reservation. This project demonstrates the complete TraceGraph PHP stack: automatic HTTP, database, authentication, Gate/policy, and queue event capture via the `tracegraph/laravel` adapter, plus manual `Tracegraph::trace()` and `Tracegraph::authCheck()` wrappers for level-2 capture.

## What this project demonstrates

| Concept | Where to look |
|---------|---------------|
| Auto-capture: `http_request` / `http_response` | `TraceMiddleware` (registered by `TraceServiceProvider`) |
| Auto-capture: `db_query` events with SQL, table, duration | `DatabaseQueryListener` via `DB::listen()` |
| Auto-capture: `authorization_check` from Laravel Gate | `GateEventListener` via `Gate::after()` |
| Manual `Tracegraph::trace()` — level 2 function_call events | `app/Services/ProductService.php` |
| Manual `Tracegraph::authCheck()` — Critical baseline anchor | `ProductService::reserveStock()` and `ProductService::create()` |
| PHPUnit extension for per-test trace isolation | `phpunit.xml` |
| Artisan commands for the full TraceGraph workflow | `php artisan tracegraph:*` |
| Critical finding when auth check is removed | full workflow below |

## Tech stack

- **PHP 8.2** / **Laravel 11**
- **PHPUnit 11** with Orchestra Testbench
- **tracegraph/laravel** for instrumentation

## Domain model

A product catalogue API with stock management:

```
ProductController       ← REST controller, delegates to ProductService
  └─ ProductService     ← Tracegraph::trace() + authCheck() on every method
       └─ Product       ← Eloquent model (id, name, sku, stock, price)
```

## API routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/products` | List products with stock > 0 |
| `GET` | `/api/products/{id}` | Get a single product |
| `POST` | `/api/products` | Create a product (requires auth — `ProductPolicy.create`) |
| `POST` | `/api/products/{id}/reserve` | Reserve stock (requires auth — `ProductPolicy.reserveStock`) |

**Reserve request body:**

```json
{
  "quantity":    3,
  "customer_id": "cust_001"
}
```

## Setup

```bash
cd sample-projects/laravel-api
composer install
```

The project uses Orchestra Testbench, so no database setup is required — tests run against an in-memory SQLite database.

## Running

### Tests (without tracing)

```bash
./vendor/bin/phpunit --testdox
```

### Tests with tracing

```bash
TRACEGRAPH_ENABLED=1 \
TRACEGRAPH_RUN_DIR=.tracegraph/runs/run_$(date +%s) \
./vendor/bin/phpunit --testdox
```

Or use the Artisan command (delegates to the Node CLI when available):

```bash
php artisan tracegraph:test
```

After the run, traces are in `.tracegraph/traces/`.

## Exploring the trace

```bash
# With Node CLI installed globally
tracegraph open --html .tracegraph/traces/*.trace.json

# Or via Artisan
php artisan tracegraph:open
```

A `POST /api/products/{id}/reserve` trace looks like:

```
http_request  POST /api/products/1/reserve
  ├─ function_call  ProductService.reserveStock
  │    ├─ auth_check  ProductPolicy.reserveStock    ← red node (Critical anchor)
  │    └─ db_query  DB::read products               ← SELECT ...
  │    └─ db_query  DB::update products             ← UPDATE stock
  └─ authorization_check  reserve (Gate::after)
http_response  POST /api/products/1/reserve → 200
```

All four event types are visible in the same call graph:
- **Blue** — HTTP request/response
- **Red** — auth check and authorization check
- **Orange** — DB queries with table, operation, and duration

## PHPUnit extension (per-test traces)

`phpunit.xml` includes the extension that gives each test its own trace file:

```xml
<extensions>
    <bootstrap class="Tracegraph\Laravel\Testing\TraceGraphPhpUnitExtension"/>
</extensions>
```

Each PHPUnit test produces a `test_file` + `test_run` event pair around all the events emitted during the test body, enabling per-test exploration in the VS Code extension and HTML viewer.

## The Critical finding demo

`ProductService::reserveStock()` calls `Tracegraph::authCheck('ProductPolicy.reserveStock')` before touching the database. This is the semantic anchor TraceGraph uses to detect removed authorization.

**To trigger a Critical finding:**

1. Run tests with tracing and baseline:

   ```bash
   TRACEGRAPH_ENABLED=1 TRACEGRAPH_RUN_DIR=.tracegraph/runs/run_001 \
     ./vendor/bin/phpunit --testdox
   tracegraph baseline create --reason "Secure baseline"
   ```

2. Open `app/Services/ProductService.php` and comment out the `authCheck` call in `reserveStock()`:

   ```php
   // Tracegraph::authCheck('ProductPolicy.reserveStock');
   ```

3. Re-run and compare:

   ```bash
   TRACEGRAPH_ENABLED=1 TRACEGRAPH_RUN_DIR=.tracegraph/runs/run_002 \
     ./vendor/bin/phpunit --testdox
   tracegraph compare --fail-on-critical
   # exit 3 — Critical: auth_check removed
   ```

## Full workflow (Artisan commands)

```bash
# 1. Install (sets up .env, confirms config)
php artisan tracegraph:install

# 2. Run tests with tracing
php artisan tracegraph:test

# 3. Open latest trace in browser
php artisan tracegraph:open

# 4. Baseline the current behaviour
php artisan tracegraph:baseline

# 5. Make a code change, then re-run
php artisan tracegraph:test

# 6. Compare and see findings
php artisan tracegraph:compare

# 7. View the report as markdown
php artisan tracegraph:report
```

## Full workflow (Node CLI directly)

```bash
TRACEGRAPH_ENABLED=1 TRACEGRAPH_RUN_DIR=.tracegraph/runs/run_001 \
  ./vendor/bin/phpunit

tracegraph open --html .tracegraph/traces/*.trace.json
tracegraph baseline create --reason "Initial baseline"

TRACEGRAPH_ENABLED=1 TRACEGRAPH_RUN_DIR=.tracegraph/runs/run_002 \
  ./vendor/bin/phpunit

tracegraph compare
tracegraph finding list
```

## Xdebug integration (optional)

For deep function-call detail down to individual PHP method calls, run PHPUnit with Xdebug in trace mode and import the output:

```bash
XDEBUG_MODE=trace \
XDEBUG_CONFIG="trace_output_dir=/tmp" \
TRACEGRAPH_ENABLED=1 \
TRACEGRAPH_RUN_DIR=.tracegraph/runs/run_xdebug \
./vendor/bin/phpunit

tracegraph import xdebug /tmp/trace.*.xt \
  --semantic .tracegraph/runs/run_xdebug/*.events.jsonl \
  --include "app/"

tracegraph open --html .tracegraph/traces/*.trace.json
```

Click any semantic node (e.g. `ProductService.reserveStock`) in the viewer to expand its Xdebug call stack showing every PHP function call that occurred inside it.

## Key files

```
app/
  Http/Controllers/
    ProductController.php     ← REST controller (index, show, store, reserve)
  Services/
    ProductService.php        ← Tracegraph::trace() + authCheck() on every method
  Models/
    Product.php               ← Eloquent model (id, name, sku, stock, price)
tests/
  Feature/
    ProductApiTest.php        ← feature tests using Orchestra Testbench HTTP client
    TestCase.php              ← base test case: sets up in-memory SQLite + seeds products
phpunit.xml                   ← TraceGraphPhpUnitExtension registered here
```

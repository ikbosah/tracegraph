# tracegraph/laravel

TraceGraph instrumentation for Laravel. Auto-discovers via Composer and hooks into Laravel's existing event system to capture HTTP requests, database queries, authentication events, Gate/policy checks, and queue job lifecycle — all as structured trace events written to disk for offline analysis, baseline comparison, and security/reliability finding detection.

**Zero overhead when disabled.** Every hook in this package is gated on `TRACEGRAPH_ENABLED=1`. When the environment variable is absent or not `'1'`, no listeners are registered and every method is a true no-op.

## Requirements

- PHP 8.1 or later
- Laravel 10, 11, or 12

## Installation

```bash
composer require --dev tracegraph/laravel
```

The service provider auto-discovers via Composer's `extra.laravel.providers` — no changes to `config/app.php` or `bootstrap/providers.php` are needed.

## Quick start

### 1. Run your tests with tracing

```bash
TRACEGRAPH_ENABLED=1 TRACEGRAPH_RUN_DIR=.tracegraph/runs/run_001 ./vendor/bin/phpunit
```

Or use the Artisan command (delegates to the Node CLI when available):

```bash
php artisan tracegraph:test
```

### 2. Open the trace in your browser

```bash
php artisan tracegraph:open
# or with the Node CLI:
tracegraph open --html .tracegraph/traces/<traceId>.trace.json
```

### 3. Approve the current behaviour as a baseline

```bash
php artisan tracegraph:baseline
```

### 4. On subsequent runs, compare for regressions

```bash
php artisan tracegraph:compare
```

---

## What is captured automatically

When `TRACEGRAPH_ENABLED=1`, the service provider registers the following hooks at boot time. No code changes to your application are required.

| Hook | Event type emitted | Source |
|------|--------------------|--------|
| `TraceMiddleware` (prepended to global middleware stack) | `http_request` + `http_response` + `error` on 5xx | `src/TraceMiddleware.php` |
| `DB::listen()` | `db_query` with SQL, table, operation, duration | `src/Listeners/DatabaseQueryListener.php` |
| `Auth::Attempting` | `auth_check` (attempt started) | `src/Listeners/AuthEventListener.php` |
| `Auth::Authenticated` | `auth_check` (authentication succeeded) | `src/Listeners/AuthEventListener.php` |
| `Gate::after()` | `authorization_check` with ability name, user, and result | `src/Listeners/GateEventListener.php` |
| `Queue::JobProcessing` | `queue_event` (type: start) | `src/Listeners/QueueEventListener.php` |
| `Queue::JobProcessed` | `queue_event` (type: succeeded) | `src/Listeners/QueueEventListener.php` |
| `Queue::JobFailed` | `queue_event` (type: failed) with error info | `src/Listeners/QueueEventListener.php` |
| `Bus::dispatchingCallback` | `queue_event` (type: dispatch) with `causedTraceId` | `src/Listeners/QueueEventListener.php` |

All events include `language: 'php'`, `framework: 'laravel'`, and `schemaVersion: 'tracegraph.event.v1'`.

---

## Manual instrumentation

### `Tracegraph::trace()` — wrap a callable

Emits a `function_call` event with timing, and an `error` event if the callable throws.

```php
use Tracegraph\Laravel\Tracegraph;

class ProductService
{
    public function create(array $data): Product
    {
        return Tracegraph::trace('ProductService.create', function () use ($data) {
            return Product::create($data);
        });
    }

    public function reserveStock(int $productId, int $qty): void
    {
        Tracegraph::trace('ProductService.reserveStock', function () use ($productId, $qty) {
            // your logic here
        });
    }
}
```

Nested `trace()` calls produce nested events. The call stack is managed via a static context (`src/Context.php`) — PHP is synchronous, so no `AsyncLocalStorage` is needed.

Adding `Tracegraph::trace()` to key service methods upgrades the trace from capture level 1 (framework adapters only) to capture level 2 (manual wrappers).

### `Tracegraph::authCheck()` — explicit auth gate

Emits an `auth_check` event. TraceGraph treats `auth_check` events as **Critical** baseline anchors — if one disappears between runs, a Critical finding is raised.

```php
use Tracegraph\Laravel\Tracegraph;

public function placeOrder(Request $request): JsonResponse
{
    Tracegraph::authCheck('OrderPolicy.canPlace');
    $this->authorize('place', Order::class);

    // ...
}
```

The Gate listener captures Laravel's built-in policy checks automatically, but `authCheck()` lets you mark custom authorisation logic that isn't routed through the Gate facade.

### `Tracegraph::captureException()` — record an exception

Records a `Throwable` as an `error` event without interrupting the normal exception-handling pipeline. Vendor framework frames are stripped from the stack trace to reduce noise.

```php
// app/Exceptions/Handler.php

use Tracegraph\Laravel\Tracegraph;

public function register(): void
{
    $this->reportable(function (\Throwable $e): void {
        Tracegraph::captureException($e);
    });
}
```

### Helper functions (procedural aliases)

`helpers.php` is auto-loaded by Composer and provides procedural aliases for all three methods — useful in non-OOP contexts, scripts, and closures where importing a class is verbose.

```php
// Equivalent to Tracegraph::trace()
$result = tracegraph_trace('BatchProcessor.run', fn() => $processor->run($batch));

// Equivalent to Tracegraph::authCheck()
tracegraph_auth_check('can:manage-orders');

// Xdebug correlation anchor (see Xdebug section below)
tracegraph_xdebug_marker('before_payment_gateway');
```

---

## PHPUnit extension (per-test trace isolation)

Add the extension to `phpunit.xml` to give every test case its own isolated trace file (capture level 5):

```xml
<!-- phpunit.xml -->
<extensions>
    <bootstrap class="Tracegraph\Laravel\Testing\TraceGraphPhpUnitExtension"/>
</extensions>
```

The extension is a no-op unless `TRACEGRAPH_ENABLED=1` and `TRACEGRAPH_RUN_DIR` are set.

Each test produces:
- A `test_file` event for the test class/file
- A `test_run` event with the test name, pass/fail/skip status, and duration
- All `function_call`, `db_query`, `http_request`, and other events emitted during the test body

Trace files are written to `{TRACEGRAPH_RUN_DIR}/tests/{traceId}.events.jsonl.tmp` and finalised to `.tracegraph/traces/{traceId}.trace.json` by the TraceGraph CLI after the test run completes.

---

## Artisan commands

All commands are registered regardless of `TRACEGRAPH_ENABLED` so you can run them in any environment.

| Command | Description |
|---------|-------------|
| `php artisan tracegraph:install` | Publishes config, checks `.env`, sets up `TRACEGRAPH_ENABLED` |
| `php artisan tracegraph:test` | Runs the test suite with tracing enabled (delegates to Node CLI or PHP fallback) |
| `php artisan tracegraph:baseline` | Creates baselines from the latest run (delegates to Node CLI or PHP fallback) |
| `php artisan tracegraph:compare` | Compares latest traces against baselines and reports findings |
| `php artisan tracegraph:report` | Renders the latest report as Markdown or JSON |
| `php artisan tracegraph:open` | Opens the latest trace or report in your browser (requires the Node CLI) |

```bash
# Full workflow via Artisan
php artisan tracegraph:install
php artisan tracegraph:test
php artisan tracegraph:baseline --reason "Initial baseline"
php artisan tracegraph:compare
php artisan tracegraph:open

# With extra PHPUnit arguments
php artisan tracegraph:test --phpunit-args "--filter ProductServiceTest"

# Open a specific file
php artisan tracegraph:open --file .tracegraph/traces/trace_abc123.trace.json

# Generate without opening browser
php artisan tracegraph:open --no-open
```

---

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TRACEGRAPH_ENABLED` | Yes (to activate) | Set to `1` to enable all instrumentation. All hooks are no-ops when absent. |
| `TRACEGRAPH_RUN_DIR` | Yes (when enabled) | Absolute path to the run directory where event JSONL files are written. Set automatically by `tracegraph run` or `php artisan tracegraph:test`. |
| `TRACEGRAPH_TRACE_ID` | No | Override the generated trace ID. Useful in CI when you want a predictable ID. |

Set these in your `.env` for local development:

```env
TRACEGRAPH_ENABLED=1
TRACEGRAPH_RUN_DIR=/absolute/path/to/project/.tracegraph/runs/run_local
```

**Do not set `TRACEGRAPH_ENABLED=1` in production.** The adapters are safe but unnecessary overhead in a production environment.

---

## CI integration

### GitHub Actions

```yaml
jobs:
  trace:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: shivammathur/setup-php@v2
        with:
          php-version: '8.2'

      - run: composer install

      - name: Run tests with tracing
        env:
          TRACEGRAPH_ENABLED: '1'
          TRACEGRAPH_RUN_DIR: ${{ github.workspace }}/.tracegraph/runs/run_ci
        run: ./vendor/bin/phpunit

      # Install Node CLI for compare / report
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm install -g @tracegraph/cli

      - name: Compare against baseline
        run: tracegraph compare --fail-on-critical

      - name: Write step summary
        if: always()
        run: tracegraph report --format github-step-summary --out $GITHUB_STEP_SUMMARY
```

---

## Xdebug integration

For deep function-call detail beyond what the Laravel hooks capture, run PHP with Xdebug in trace mode and import the resulting `.xt` file using the Node CLI.

### 1. Add correlation markers to your PHP code

Place `tracegraph_xdebug_marker()` calls just before key semantic events. This is a genuine no-op function (never add logic to it). Its presence in the Xdebug log gives the merger a confidence-1.0 correlation anchor.

```php
public function handle(Request $request, Closure $next): Response
{
    tracegraph_xdebug_marker('request_start');
    return $next($request);
}
```

### 2. Run PHP with Xdebug enabled

```bash
XDEBUG_MODE=trace \
XDEBUG_CONFIG="trace_output_dir=/tmp" \
TRACEGRAPH_ENABLED=1 \
TRACEGRAPH_RUN_DIR=.tracegraph/runs/run_001 \
./vendor/bin/phpunit
```

### 3. Import and merge with the Node CLI

```bash
tracegraph import xdebug /tmp/trace.*.xt \
  --semantic .tracegraph/runs/run_001/*.events.jsonl \
  --include "app/"
```

The `--include "app/"` flag filters out vendor calls, keeping only application-level function calls. Use `--max-events 2000` for large test suites.

### 4. Open the enriched trace

```bash
tracegraph open --html .tracegraph/traces/<traceId>.trace.json
```

In the viewer, click any semantic node (e.g. an `authorization_check`). If correlated Xdebug calls exist, a **Xdebug Call Stack** section appears showing depth-indented function names with `file:line` and confidence badges.

---

## What each event looks like

All events written by this package follow the `tracegraph.event.v1` schema:

```json
{
    "schemaVersion": "tracegraph.event.v1",
    "eventId":       "evt_a1b2c3d4e5f6g7h8",
    "traceId":       "trace_abc123def456",
    "parentEventId": "evt_root000000000000",
    "type":          "db_query",
    "language":      "php",
    "framework":     "laravel",
    "name":          "DB::read products",
    "startTime":     1748606400123,
    "endTime":       1748606400145,
    "durationMs":    22,
    "resource": {
        "type":      "database",
        "key":       "products",
        "operation": "read"
    },
    "metadata": {
        "sql":           "select * from `products` where `id` = ?",
        "bindingCount":  1,
        "connection":    "mysql"
    }
}
```

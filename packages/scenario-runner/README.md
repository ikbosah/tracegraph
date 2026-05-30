# @tracegraph/scenario-runner

Multi-service scenario orchestrator for TraceGraph. Reads a declarative scenario definition file, starts the required servers, executes HTTP steps in order (injecting correlation headers on every request), collects the resulting traces, and links them into a `TraceBundle` — a single artifact that ties together all cross-service calls from one scenario run.

Used internally by the `tracegraph scenario run` CLI command.

## What's in this package

| Export | Description |
|--------|-------------|
| `runScenario(definition, options)` | Main entry point — orchestrates the full scenario: start servers → execute steps → stop servers → create bundle |
| `loadScenarioDefinition(filePath)` | Reads and validates a `.scenario.json` file |
| `ServerManager` | Manages server process lifecycle (spawn, health check, shutdown) |
| `executeStep(step, context)` | Executes a single HTTP step and returns the response + trace correlation data |
| `createBundle(traces, scenario)` | Links a set of `TraceSession` objects into a `TraceBundle` via correlation IDs |
| `ScenarioRunOptions` | Options for `runScenario` (output directory, timeout, dry-run) |
| `ServerHandle` | Handle returned by `ServerManager.start()` — used to await health checks and stop the server |
| `StepContext` | Context passed to `executeStep` containing the correlation ID, headers, and base URLs |

## Installation

```bash
npm install @tracegraph/scenario-runner
```

## Usage

### Running a scenario programmatically

```typescript
import { runScenario, loadScenarioDefinition } from '@tracegraph/scenario-runner';

const definition = loadScenarioDefinition('.tracegraph/scenarios/create-invoice.scenario.json');

const bundle = await runScenario(definition, {
  outputDir: '.tracegraph/bundles',
  timeoutMs: 30_000,
});

console.log(`Bundle: ${bundle.bundleId}`);
console.log(`Traces: ${bundle.traceIds.join(', ')}`);
```

### Scenario definition format

Scenario files are JSON (`.tracegraph/scenarios/*.scenario.json`):

```json
{
  "schemaVersion": "tracegraph.scenario.v1",
  "scenarioId":   "create_invoice",
  "name":         "Create Invoice — end-to-end",
  "servers": [
    {
      "name":    "express-api",
      "command": "node -r ts-node/register src/app.ts",
      "port":    3001,
      "env":     { "PORT": "3001" },
      "healthCheck": {
        "path":           "/health",
        "expectedStatus": 200,
        "intervalMs":     300
      }
    }
  ],
  "steps": [
    {
      "name": "Create invoice",
      "http": {
        "method": "POST",
        "url":    "http://localhost:3001/invoices",
        "body":   { "customerId": "c1", "amount": 150 }
      },
      "assert": { "status": 201 }
    },
    {
      "name": "List invoices",
      "http": {
        "method": "GET",
        "url":    "http://localhost:3001/invoices"
      },
      "assert": { "status": 200, "bodyContains": "c1" }
    }
  ],
  "tags": ["smoke"]
}
```

### Correlation headers

The runner automatically injects two headers on every HTTP step:

| Header | Value | Purpose |
|--------|-------|---------|
| `x-tracegraph-scenario-id` | `<scenarioId>` | Tags all requests to the same scenario run |
| `x-tracegraph-correlation-id` | `<scenarioId>_step<N>` | Links outbound calls across service boundaries |

The receiving service's TraceGraph adapter reads `x-tracegraph-correlation-id` and stores it on the `http_request` event as `causalParentRef`, allowing `createBundle` to stitch cross-service traces together.

### Using bundles with `tracegraph compare`

```bash
tracegraph compare --bundle .tracegraph/bundles/create_invoice_run_abc.bundle.json
```

The compare command reads every `traceId` referenced in the bundle and compares each against its corresponding baseline.

## CLI equivalent

Everything in this package is also accessible via the CLI:

```bash
# Run a scenario
tracegraph scenario run .tracegraph/scenarios/create-invoice.scenario.json

# Validate without running
tracegraph scenario validate .tracegraph/scenarios/create-invoice.scenario.json

# List all scenario files
tracegraph scenario list
```

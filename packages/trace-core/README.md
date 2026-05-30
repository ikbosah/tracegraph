# @tracegraph/trace-core

Low-level runtime primitives for the TraceGraph pipeline: event writing, atomic trace finalisation, trace reading, storage management, index maintenance, and ID generation. Every language adapter and the CLI depend on this package — it is the plumbing that moves events from capture to disk.

## What's in this package

| Export | Description |
|--------|-------------|
| `TraceEventWriter` | Appends `TraceEvent` objects to a `.events.jsonl.tmp` file; thread/process safe via sequential writes |
| `finaliseTrace(options)` | Atomically renames the `.tmp` event stream to a finished `.trace.json`; reads `capture-level.json` and `meta.json` from the run directory to populate the trace header |
| `readTrace(path)` | Reads and parses a `.trace.json` file; throws `SchemaVersionError` on schema mismatch |
| `readTraceIndex(dir)` | Reads `.tracegraph/index.json` |
| `updateTraceIndex(dir, entry)` | Appends a new entry to the index, pruning old entries |
| `StorageManager` | Enforces storage limits (max runs, max age, max size) by pruning old run directories |
| `createRunId()` | Generates `run_<16-hex>` IDs |
| `createTraceId()` | Generates `trace_<16-hex>` IDs |
| `createEventId()` | Generates `evt_<16-hex>` IDs |
| `createSessionId()` | Generates `session_<16-hex>` IDs |
| `createBundleId()` | Generates `bundle_<16-hex>` IDs |
| `SchemaVersionError` | Thrown by `readTrace` when `schemaVersion` does not match the expected value |

## Installation

```bash
npm install @tracegraph/trace-core
```

## Usage

### Writing events from an adapter

```typescript
import { TraceEventWriter, createEventId } from '@tracegraph/trace-core';
import type { TraceEvent } from '@tracegraph/shared-types';

const writer = new TraceEventWriter(process.env.TRACEGRAPH_RUN_DIR!);

const event: TraceEvent = {
  eventId:   createEventId(),
  type:      'function_call',
  name:      'InvoiceService.create',
  startTime: Date.now(),
  durationMs: 12.4,
};

await writer.write(event);
```

### Finalising a trace (done by `tracegraph run`)

```typescript
import { finaliseTrace } from '@tracegraph/trace-core';

await finaliseTrace({
  runDir:      '/path/to/.tracegraph/runs/run_abc',
  tracesDir:   '/path/to/.tracegraph/traces',
  traceId:     'trace_abc123',
  entrypoint:  { type: 'cli_command', command: 'npm test' },
});
// Writes .tracegraph/traces/trace_abc123.trace.json
```

### Reading a trace

```typescript
import { readTrace, SchemaVersionError } from '@tracegraph/trace-core';

try {
  const trace = readTrace('/path/to/trace_abc123.trace.json');
  console.log(trace.events.length, 'events');
} catch (e) {
  if (e instanceof SchemaVersionError) {
    console.error('Run: tracegraph schema doctor');
  }
}
```

### Storage pruning

```typescript
import { StorageManager, DEFAULT_STORAGE_CONFIG } from '@tracegraph/trace-core';

const mgr = new StorageManager('/path/to/.tracegraph', DEFAULT_STORAGE_CONFIG);
await mgr.prune(); // removes runs older than maxAgeDays, beyond maxRuns, etc.
```

## File protocol

The write path for a single trace run:

```
.tracegraph/runs/<runId>/
  <traceId>.events.jsonl.tmp    ← TraceEventWriter appends here
  capture-level.json            ← written by the language adapter on shutdown
  meta.json                     ← language/framework metadata

→ finaliseTrace() atomically renames to:

.tracegraph/traces/<traceId>.trace.json
```

The VS Code extension only reads finalised `.trace.json` files — never `.tmp` files.

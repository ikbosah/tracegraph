# @tracegraph/trace-xdebug

Streaming Xdebug `.xt` trace file parser and Laravel semantic merger for TraceGraph. Converts Xdebug's tab-separated function call logs into `TraceEvent` streams, and optionally correlates them with semantic events from the Laravel adapter to produce a merged trace with both deep call-stack detail and high-level semantic structure.

Used internally by `tracegraph import xdebug`.

## What's in this package

| Export | Description |
|--------|-------------|
| `parseXdebugString(content)` | Parses the full text of an Xdebug `.xt` file and returns an `XdebugParseResult` |
| `parseXdebugStream(readable)` | Streaming variant — reads an `.xt` file line-by-line from a `Readable` stream; useful for large files |
| `mergeXdebugTrace(semanticEvents, parsed, startTime)` | Correlates Xdebug entries with Laravel semantic events using marker-based and timestamp-heuristic matching |
| `mergedTraceToEvents(merged, options)` | Converts a `MergedTrace` to a flat `TraceEvent[]` ready to write into a `.trace.json` |
| `XdebugEntry` | Parsed representation of one Xdebug trace line (function name, file, line, depth, timing) |
| `XdebugEntryKind` | `'entry' \| 'exit' \| 'return'` |
| `XdebugParseResult` | `{ entries: XdebugEntry[]; parseErrors: string[] }` |
| `XdebugDetailEvent` | A single correlated Xdebug call attached to a semantic event |
| `XdebugDetailStream` | The full set of Xdebug calls correlated to one semantic event |
| `MergedTrace` | Combined semantic + Xdebug trace ready for rendering |

## Installation

```bash
npm install @tracegraph/trace-xdebug
```

## Usage

### Parse an Xdebug file (standalone)

```typescript
import { parseXdebugString, mergedTraceToEvents } from '@tracegraph/trace-xdebug';
import { readFileSync } from 'fs';

const content = readFileSync('/tmp/trace.1234567890.xt', 'utf8');
const parsed  = parseXdebugString(content);

console.log(`${parsed.entries.length} Xdebug entries`);
if (parsed.parseErrors.length > 0) {
  console.warn('Parse errors:', parsed.parseErrors);
}
```

### Merge with Laravel semantic events

```typescript
import { parseXdebugString, mergeXdebugTrace, mergedTraceToEvents } from '@tracegraph/trace-xdebug';
import { readFileSync } from 'fs';

// Xdebug .xt file
const parsed = parseXdebugString(readFileSync('trace.xt', 'utf8'));

// Semantic events from the Laravel adapter (JSONL)
const semanticRaw    = readFileSync('trace.events.jsonl', 'utf8');
const semanticEvents = semanticRaw.trim().split('\n').map(l => JSON.parse(l));

const merged = mergeXdebugTrace(semanticEvents, parsed, Date.now() - 5000);

// Convert to TraceEvent[] for writing to .trace.json
const events = mergedTraceToEvents(merged, {
  include:   'app/',   // filter to application code only
  maxEvents: 2000,
});
```

### Streaming large files

```typescript
import { parseXdebugStream } from '@tracegraph/trace-xdebug';
import { createReadStream } from 'fs';

const stream = createReadStream('/tmp/trace.xt', { encoding: 'utf8' });
const parsed = await parseXdebugStream(stream);
```

### CLI equivalent

```bash
# Standalone (Xdebug only)
tracegraph import xdebug ./trace.xt

# Merged with Laravel semantic trace
tracegraph import xdebug ./trace.xt \
  --semantic .tracegraph/runs/run_abc/trace_xyz.events.jsonl

# Filter to app code, cap at 2000 events
tracegraph import xdebug ./trace.xt \
  --include "app/" \
  --max-events 2000
```

## Generating an Xdebug trace

Run PHP with Xdebug in trace mode:

```bash
XDEBUG_MODE=trace XDEBUG_CONFIG="trace_output_dir=/tmp" php artisan test
```

For better correlation, place `tracegraph_xdebug_marker()` calls at semantic anchor points in your PHP code (provided as a no-op stub by `tracegraph/laravel`):

```php
// In your service or middleware — called just before the event you want to correlate
tracegraph_xdebug_marker('request_start');
```

The merger matches the `tracegraph_xdebug_marker` call in the Xdebug log to the nearest semantic event, giving a confidence of 1.0 for those correlations.

## Correlation confidence

Xdebug calls are correlated to semantic events using two passes:

| Method | Confidence | Trigger |
|--------|------------|---------|
| Marker-based | 1.0 | `tracegraph_xdebug_marker()` stub is present in the Xdebug log |
| Timestamp heuristic | 0.7–0.99 | Xdebug entry is within 50ms of a semantic event's start time |

Matches below confidence 1.0 are shown with a badge in the VS Code and HTML webview viewers.

## Xdebug `.xt` format

Xdebug trace files are tab-separated text files with one line per function entry/exit/return:

```
TRACE START [2026-05-30 12:00:00.123456]
1	1	0	0.000123	1234567	{main}	1		/app/public/index.php	0	0
1	2	0	0.001234	1234890	App\Http\Controllers\InvoiceController->store	1		/app/Http/Controllers/InvoiceController.php	0	0
...
TRACE END   [2026-05-30 12:00:01.456789]
```

The parser handles both Xdebug 2 and Xdebug 3 output formats.

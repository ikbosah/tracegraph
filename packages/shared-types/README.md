# @tracegraph/shared-types

Canonical TypeScript types and schema-version constants shared by every package in the TraceGraph monorepo. This is the single source of truth for the TraceGraph data model — if it lives in a `.trace.json`, a `.baseline.json`, a `.report.json`, or any other artifact file, its TypeScript shape is defined here.

## What's in this package

| Export | Description |
|--------|-------------|
| `SCHEMA_VERSIONS` | String constants for every artifact schema (`tracegraph.trace.v1`, `tracegraph.baseline.v1`, …) |
| `TraceEvent` | A single captured runtime event (HTTP request, DB query, function call, error, …) |
| `TraceSession` | A complete trace: entrypoint, events array, capture level, timing |
| `TraceEntrypoint` | Discriminated union — `http_request`, `test_case`, `function`, `cli_command` |
| `CaptureLevel` | Structured capture-level value (0–5) with per-adapter breakdown |
| `TraceBaseline` | Stored "known-good" snapshot used for diff comparisons |
| `BehaviorDiff` | Result of diffing a candidate trace against its baseline |
| `Finding` / `EvaluatedFinding` | A detected issue (pre- and post-evaluation) |
| `TraceReport` | Aggregated output of `tracegraph compare` |
| `Suppression` / `FindingApproval` | Records acknowledging findings or suppressing rules |
| `ScenarioDefinition` / `TraceBundle` | Multi-service scenario and the bundle linking cross-service traces |
| `ChangeCoverageReport` | Output of `tracegraph coverage` |
| `EXIT_CODES` | Numeric exit code constants used by the CLI |

## Installation

```bash
npm install @tracegraph/shared-types
```

This package ships both CJS and ESM builds with full TypeScript declarations.

## Usage

```typescript
import type {
  TraceEvent,
  TraceSession,
  TraceReport,
  EvaluatedFinding,
} from '@tracegraph/shared-types';

import { SCHEMA_VERSIONS, EXIT_CODES } from '@tracegraph/shared-types';

// Check artifact schema version
if (trace.schemaVersion !== SCHEMA_VERSIONS.trace) {
  console.error('Schema mismatch — run tracegraph schema doctor');
}

// Use the exit code constants in CLI tooling
process.exit(EXIT_CODES.FINDINGS_THRESHOLD);
```

## Capture levels

The `CaptureLevelValue` type (`0 | 1 | 2 | 3 | 4 | 5`) describes how much detail was collected in a trace:

| Level | Label | Means |
|-------|-------|-------|
| `0` | Runner metadata only | `trace_start` + `trace_end` + exit code |
| `1` | Framework adapter | HTTP, DB, auth via framework hooks |
| `2` | Manual wrappers | Level 1 + `traceFunction` / `traceMethod` calls |
| `3` | CJS require hook | Level 2 + auto-instrumented CJS modules |
| `4` | ESM import hook | Level 3 + limited ESM auto-instrumentation |
| `5` | Build-time / reporter | Per-test isolation; full test lifecycle |

## Notes

- **No runtime dependencies.** This package is types-only at runtime; the runtime value exports (`SCHEMA_VERSIONS`, `EXIT_CODES`) are plain objects with no third-party deps.
- All other TraceGraph packages depend on this one. Bump the version here when changing the data model, and run `tracegraph schema doctor` to detect artifacts that need migration.

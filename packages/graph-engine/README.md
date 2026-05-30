# @tracegraph/graph-engine

The core analysis engine for TraceGraph. Converts a `TraceSession` into a directed graph, derives baselines from traces, diffs candidate traces against those baselines, evaluates findings (structural changes, security issues, and reliability patterns), and emits the `TraceReport` consumed by the CLI and VS Code extension.

## What's in this package

| Export | Description |
|--------|-------------|
| `traceSessionToGraph(session)` | Converts a `TraceSession` into a `TraceGraph` (nodes + edges) for rendering in the webview |
| `sessionToBaseline(session)` | Derives a `TraceBaseline` from a trace — the "known-good" snapshot for future comparisons |
| `deriveTestId(session)` | Extracts a stable test ID from a trace's entrypoint (e.g. `POST /invoices`) for matching baselines to candidates |
| `diffBaseline(baseline, candidate)` | Produces a `BehaviorDiff` by comparing a candidate trace's event signatures against the baseline |
| `diffToFindings(diff, baseline)` | Converts a `BehaviorDiff` into a list of raw `Finding` objects |
| `evaluateFindings(findings, approvals, suppressions, trace)` | Evaluates findings against stored approvals and suppressions to produce `EvaluatedFinding[]`; suppressions self-invalidate when their `requiresEvidence` is absent |
| `analyseTraceFindings(session)` | Analyses a single trace for intrinsic security and reliability patterns (no baseline required) |
| `eventToSignature(event)` | Converts a `TraceEvent` into a structural signature (volatile values stripped) |
| `signatureToIdentityHash(sig)` | Deterministic hash of a signature — used as the diff key |
| `computeFingerprint(finding)` | Stable fingerprint for a finding (survives refactors; never includes file/line) |
| `classifyRole(event)` | Classifies an event as `authorization`, `authentication`, `data-access`, or `side-effect` for finding severity |
| `ANALYSE_RULES` | String constants for the built-in security and reliability rule IDs |

## Installation

```bash
npm install @tracegraph/graph-engine
```

## Usage

### Generating a graph for the webview

```typescript
import { traceSessionToGraph } from '@tracegraph/graph-engine';

const graph = traceSessionToGraph(trace);
// graph.nodes — array of GraphNode (id, type, label, colour, position)
// graph.edges — array of GraphEdge (from, to, kind)
```

### Creating a baseline

```typescript
import { sessionToBaseline, deriveTestId } from '@tracegraph/graph-engine';
import { writeFileSync } from 'fs';

const testId   = deriveTestId(trace);       // e.g. 'POST /invoices'
const baseline = sessionToBaseline(trace);
writeFileSync(`.tracegraph/baselines/${testId}.baseline.json`, JSON.stringify(baseline));
```

### Diffing against a baseline

```typescript
import { diffBaseline, diffToFindings, evaluateFindings } from '@tracegraph/graph-engine';

const diff     = diffBaseline(baseline, candidateTrace);
const findings = diffToFindings(diff, baseline);
const evaluated = evaluateFindings(findings, approvals, suppressions, candidateTrace);

const open = evaluated.filter(f => f.status === 'open');
console.log(`${open.length} open finding(s)`);
```

### Intrinsic trace analysis (no baseline needed)

```typescript
import { analyseTraceFindings, ANALYSE_RULES } from '@tracegraph/graph-engine';

const findings = analyseTraceFindings(trace);

for (const f of findings) {
  if (f.ruleId === ANALYSE_RULES.N_PLUS_ONE_QUERY) {
    console.warn('N+1 query detected');
  }
}
```

## Built-in analysis rules

These rules fire on a single trace regardless of any baseline:

| Rule ID | Severity | Trigger |
|---------|----------|---------|
| `security.sensitive_data.in_response` | high | Sensitive field names (`password`, `token`, `apikey`, …) present in an HTTP response body |
| `reliability.n_plus_one_query` | medium | Same `(table, operation)` DB query repeated ≥ 5 times in one trace |
| `reliability.duplicate_side_effects` | high | Same queue event or non-GET outbound URL dispatched ≥ 2 times |
| `reliability.missing_transaction` | medium | Writes to ≥ 2 distinct tables with no `transaction_start`/`commit`/`rollback` events |

## Diff rules (baseline-relative)

These rules fire when comparing a candidate trace against a stored baseline:

| Situation | Severity |
|-----------|----------|
| `auth_check` / `authorization_check` event present in baseline but absent from candidate | critical |
| Any other event type removed from baseline | varies by `classifyRole()` |
| New event type added vs baseline | info |

## Fingerprinting

Fingerprints are computed from `hash(ruleId + routePathPattern + resourceType + resourceKey + resourceOperation)` — **never** including file paths or line numbers. This makes fingerprints stable across refactors and renames so approvals remain valid after code moves.

## Suppression self-invalidation

A `Suppression` with `requiresEvidence: [{ eventType, displayName }]` is only applied when all its evidence events are present in the current trace. If a compensating control (e.g. an upstream auth middleware) disappears from the trace, the suppression automatically stops applying and the finding resurfaces.

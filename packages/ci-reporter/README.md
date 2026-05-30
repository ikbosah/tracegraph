# @tracegraph/ci-reporter

Renders a TraceGraph `TraceReport` into human-readable output for CI pipelines, PR comments, and terminals. Supports three output formats: Markdown, JSON passthrough, and GitHub Actions Step Summary.

## What's in this package

| Export | Description |
|--------|-------------|
| `renderReport(report, options?)` | Renders a `TraceReport` to the requested format and returns it as a string |
| `ReportFormat` | `'markdown' \| 'json' \| 'github-step-summary'` |
| `RenderOptions` | `{ format?, projectName? }` |

## Installation

```bash
npm install @tracegraph/ci-reporter
```

## Usage

### Render to Markdown

```typescript
import { renderReport } from '@tracegraph/ci-reporter';
import { readReport } from '@tracegraph/trace-core';

const report   = readReport('.tracegraph/reports/rep_abc123.report.json');
const markdown = renderReport(report, { projectName: 'invoice-api' });

console.log(markdown);
```

### Write a GitHub Actions Step Summary

```typescript
import { renderReport } from '@tracegraph/ci-reporter';
import { writeFileSync } from 'fs';

const output = renderReport(report, { format: 'github-step-summary' });
writeFileSync(process.env.GITHUB_STEP_SUMMARY!, output);
```

### Machine-readable JSON

```typescript
const json = renderReport(report, { format: 'json' });
// Equivalent to JSON.stringify(report, null, 2)
```

## Markdown output structure

The Markdown renderer produces a report with the following sections:

1. **Summary table** — traces compared, total findings by severity, security and reliability counts, suppression file status
2. **Security Findings** — grouped by severity with title, description, recommendation, fingerprint, and rule ID
3. **Reliability Findings** — same structure as security
4. **Policy Findings** — e.g. suppression file modified
5. **Other Findings** — behaviour changes that don't fit the above categories
6. **Approved / Suppressed Findings** — collapsed `<details>` block
7. **Behaviour Changes** — added and removed signatures per trace
8. **Capture Level** — reminder to run `tracegraph diagnose` if level is low
9. **Do not merge block** — appended when critical findings are open

### Example output

```markdown
## invoice-api — Behaviour Diff Report

_Generated: Sat, 30 May 2026 12:00:00 GMT_

### Summary

| | |
|---|---|
| Traces compared | 3 |
| Total findings | 2 |
| 🔴 Critical findings | 1 |
| 🟠 High findings | 1 |
| 🔐 Security findings | 1 |

### 🔐 Security Findings

#### 🔴 Critical

**Authorization middleware removed from POST /orders**

> A route-level authorization middleware that guarded POST /orders has been removed.

_Recommendation: Restore the middleware or confirm this route is intentionally public._

`fingerprint: a1b2c3d4e5f6` · `rule: security.authorization.middleware_removed`

---

> 🚫 **Do not merge** — Critical findings are open.
```

## Used by

The `tracegraph report` CLI command delegates entirely to `renderReport`. You can also call it directly in custom CI scripts or integrations.

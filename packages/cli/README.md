# @tracegraph/cli

The TraceGraph command-line interface — a CLI-first runtime assurance platform. Wraps your test and application commands to capture structured execution traces, diffs behaviour between runs, surfaces security and reliability findings, and generates offline HTML reports, AI context packs, and CI-ready output.

## Installation

### Global (for use across projects)

```bash
npm install -g @tracegraph/cli
tracegraph --version
```

### Project-local (recommended for CI)

```bash
npm install -D @tracegraph/cli
npx tracegraph --version
```

## Commands

### `tracegraph init`

One-time project setup. Detects your package manager and test runner, adds four npm scripts (`trace:test`, `trace:baseline`, `trace:compare`, `trace:report`), creates `tracegraph.config.json`, and appends `.tracegraph/` to `.gitignore`.

```bash
npx tracegraph init
```

### `tracegraph run`

Wraps any shell command with tracing. Sets `TRACEGRAPH_ENABLED=1`, `TRACEGRAPH_RUN_DIR`, and `TRACEGRAPH_TRACE_ID` for the child process. Automatically injects the Vitest or Jest reporter when detected.

```bash
tracegraph run -- npm test
tracegraph run -- npx vitest run
tracegraph run -- node src/server.js
```

### `tracegraph open --html`

Produces a self-contained offline HTML report from a `.trace.json` file and optionally opens it in your default browser.

```bash
tracegraph open --html .tracegraph/traces/trace_abc123.trace.json
tracegraph open --html .tracegraph/traces/trace_abc123.trace.json --out report.html
tracegraph open --html .tracegraph/traces/trace_abc123.trace.json --no-open
```

The HTML report embeds the webview bundle (interactive SVG call graph, Gantt timeline, Error Path view) and the trace data. Fully offline — no external resources.

### `tracegraph baseline`

Manages baseline snapshots — the "known-good" behaviour that future runs are compared against.

```bash
tracegraph baseline create --reason "Initial baseline"
tracegraph baseline create --only-passed --reason "Post-fix baseline"
tracegraph baseline list
tracegraph baseline approve "POST /invoices" --reason "Added tax step"
tracegraph baseline migrate          # upgrade old baseline files to current schema
tracegraph baseline migrate --dry-run
```

### `tracegraph compare`

Compares candidate traces against stored baselines. Produces a `.report.json` with `BehaviorDiff` entries and evaluated `Finding` objects.

```bash
tracegraph compare
tracegraph compare --fail-on-critical   # exits 3 when critical findings are open
tracegraph compare --candidate .tracegraph/traces/trace_abc.trace.json
tracegraph compare --bundle .tracegraph/bundles/scenario_run_abc.bundle.json
```

### `tracegraph finding`

Lists, approves, suppresses, and explains findings from the latest report.

```bash
tracegraph finding list
tracegraph finding approve <fingerprint> --reason "Known false positive"
tracegraph finding suppress <fingerprint> --reason "Handled by gateway" \
  --requires-evidence "authorization_check:GatewayPolicy.validate"
tracegraph finding explain <fingerprint>
```

### `tracegraph report`

Renders the latest (or specified) `.report.json` as Markdown, JSON, or GitHub Actions Step Summary.

```bash
tracegraph report
tracegraph report --format github-step-summary --out $GITHUB_STEP_SUMMARY
tracegraph report --format json --out artifacts/report.json
```

### `tracegraph diagnose`

Reads the latest trace and prints a human-readable capture report with ranked recommendations for improving instrumentation depth.

```bash
tracegraph diagnose
tracegraph diagnose --trace trace_abc123 --json
```

### `tracegraph scenario`

Runs multi-service declarative scenarios, producing a `TraceBundle` that links cross-service calls.

```bash
tracegraph scenario run .tracegraph/scenarios/create-invoice.scenario.json
tracegraph scenario validate .tracegraph/scenarios/create-invoice.scenario.json
tracegraph scenario list
```

### `tracegraph coverage`

Maps changed functions (from a git diff) to runtime trace events and reports coverage gaps.

```bash
tracegraph coverage --base origin/main --head HEAD
tracegraph coverage --fail-uncovered
```

### `tracegraph pack`

Generates AI context packs (Cursor, Claude Code, Copilot, MCP) from the latest report and traces.

```bash
tracegraph pack
tracegraph pack --format claude-code
tracegraph pack --dry-run
```

### `tracegraph import xdebug`

Imports an Xdebug `.xt` trace file, optionally merging it with a Laravel semantic trace.

```bash
tracegraph import xdebug ./trace.xt
tracegraph import xdebug ./trace.xt --semantic trace.events.jsonl --include "app/"
```

### `tracegraph schema`

Inspects and migrates artifact schema versions.

```bash
tracegraph schema doctor
tracegraph schema doctor --json
```

### `tracegraph clean`

Removes old run directories from `.tracegraph/runs/`.

```bash
tracegraph clean --older-than 7d
tracegraph clean --keep-last 5
tracegraph clean --all-runs
```

### `tracegraph storage status`

Prints a summary of disk usage in `.tracegraph/`.

```bash
tracegraph storage status
```

## GitHub Actions

```yaml
- name: Run tests with tracing
  run: npx tracegraph run -- npm test

- name: Compare against baseline
  run: npx tracegraph compare --fail-on-critical

- name: Write step summary
  if: always()
  run: npx tracegraph report --format github-step-summary --out $GITHUB_STEP_SUMMARY
```

`--fail-on-critical` exits with code **3** (not 1) so CI can distinguish findings regressions from ordinary test failures.

## Exit codes

| Code | Constant | Meaning |
|------|----------|---------|
| `0` | `SUCCESS` | Everything passed |
| `1` | `COMMAND_FAILURE` | Wrapped command exited non-zero |
| `2` | `CLI_ERROR` | Bad arguments, missing file, or internal error |
| `3` | `FINDINGS_THRESHOLD` | Open findings at or above the severity threshold |
| `4` | `POLICY_REVIEW` | Suppressions file modified since last approved baseline |
| `5` | `SCHEMA_MIGRATION` | Artifact schema version mismatch |
| `6` | `CAPTURE_LEVEL_INSUFFICIENT` | Capture level below configured minimum |

## Configuration

`tracegraph.config.json` (created by `tracegraph init`):

```json
{
  "language": "typescript",
  "framework": "express",
  "sanitize": {
    "redactKeys":      ["password", "authorization", "token"],
    "maxDepth":        4,
    "maxStringLength": 500,
    "maxArrayLength":  50
  },
  "storage": {
    "maxRuns":    20,
    "maxAgeDays": 7,
    "maxSizeMB":  500
  }
}
```

## What to commit to git

```
✅ tracegraph.config.json
✅ .tracegraph/baselines/
✅ .tracegraph/approvals/
✅ .tracegraph/suppressions/
✅ .tracegraph/scenarios/

🚫 .tracegraph/runs/        (gitignored by tracegraph init)
🚫 .tracegraph/traces/      (gitignored)
🚫 .tracegraph/reports/     (gitignored)
```

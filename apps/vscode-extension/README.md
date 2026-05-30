# TraceGraph for VS Code

**See exactly what your code does at runtime — without leaving the editor.**

TraceGraph captures structured execution traces from your tests and application code, then lets you explore them as interactive call graphs, timelines, and error chains directly inside VS Code. It also surfaces security and reliability findings when behaviour changes between runs, so regressions are caught before they merge.

---

## What You Get

| | |
|---|---|
| **Interactive call graph** | SVG graph of every HTTP request, DB query, auth check, function call, and test result — click any node for full details |
| **Gantt timeline** | Horizontal duration bars proportional to each event's real elapsed time |
| **Error path view** | Causal chain from every error event traced back to the root call — de-duplicated when the same error fires repeatedly |
| **Live sidebar** | Four trees (Traces, Findings, Baselines, Scenarios) that auto-refresh whenever new artifacts are written |
| **Source navigation** | Click **↗** on any event that has a file + line number to jump directly to that line in the editor |
| **One-click commands** | Run tests with tracing, compare against a baseline, create a baseline, and generate AI context packs — all from the Command Palette |

---

## Requirements

- **VS Code** 1.85 or later
- **Node.js** 18 or later
- **TraceGraph CLI** installed in your project or globally:

  ```bash
  npm install -D tracegraph          # project-local (recommended)
  # or
  npm install -g tracegraph          # global
  ```

- Your project must be initialised with `tracegraph init` (creates `.tracegraph/` and adds npm scripts)

---

## Quick Start

### 1 — Initialise your project

```bash
npx tracegraph init
```

This detects your package manager and test runner, adds four scripts to `package.json`, and creates `tracegraph.config.json`.

### 2 — Add the Express adapter *(TypeScript/Node.js projects)*

```typescript
import { traceExpress } from '@tracegraph/trace-js';

const app = express();
app.use(express.json());
app.use(traceExpress());   // add before your route handlers
```

### 3 — Run your tests with tracing

Use the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run:

> **TraceGraph: Run with Tracing**

Or run directly in your terminal:

```bash
npm run trace:test
# equivalent to: npx tracegraph run -- npx vitest run
```

The TraceGraph icon appears in the activity bar. Click it — your trace is already there.

### 4 — Explore the trace

Click any trace in the **Traces** panel to open the graph viewer. Switch between **Graph**, **Timeline**, and **Error Path** tabs.

### 5 — Set a baseline and catch regressions

```bash
# Approve the current behaviour as the expected baseline
npm run trace:baseline

# On your next run, compare and see what changed
npm run trace:compare
```

Open findings appear immediately in the **Findings** sidebar panel.

---

## Sidebar Panels

The TraceGraph activity bar icon opens four collapsible trees.

### Traces

Lists every `.trace.json` file grouped by run. Each run shows the traces captured in that invocation. Click any trace to open it in the graph panel.

In **multi-root workspaces**, traces from each project folder are shown with the folder name as a suffix so you can tell them apart at a glance.

### Findings

Shows open findings from the most recent comparison report, grouped by severity. Findings are raised when behaviour changes relative to the stored baseline — for example: an authorization middleware was removed, an N+1 query pattern appeared, or sensitive data was found in a response.

| Severity | Badge | Example |
|----------|-------|---------|
| Critical | 🔴 | Auth middleware removed from a route |
| High | 🟠 | Sensitive field (e.g. `password`) found in HTTP response |
| Medium | 🟡 | Same DB query executed ≥ 5 times (N+1 pattern) |

Run **TraceGraph: Compare Latest Run** from the Command Palette (or the `$(diff)` button in the Findings panel header) to refresh this list after running tests.

### Baselines

Lists every `.baseline.json` file with its approval status. Baselines record the *expected* behaviour — future runs are compared against them.

### Scenarios

Lists declarative multi-step scenario files (`.scenario.json`). Scenarios start servers, execute HTTP steps with automatic correlation headers, and produce a `TraceBundle` that links cross-service calls.

---

## Graph Panel

Clicking a trace opens a dedicated editor panel with three views. Use the tab bar at the top to switch between them.

### Graph view

An SVG call graph showing all events in the trace connected by parent–child and causal relationships.

- **Click any node** to open the detail panel on the right, showing event type, timing, inputs/outputs, and metadata
- **Colour coding** tells you the event type at a glance:

  | Colour | Event types |
  |--------|-------------|
  | Blue | `http_request` / `http_response` |
  | Orange | `db_query` |
  | Red | `authorization_check` / `auth_check` / `error` |
  | Purple | `external_http_call` |
  | Teal | `queue_event` |
  | Cyan | `test_run` |
  | Grey | `function_call` / `method_call` |

- Nodes with file + line information show an **↗** button that opens the source file in the editor

### Timeline view

A Gantt-style horizontal chart where each row is one event and the bar width is proportional to that event's real elapsed duration. Events are sorted by start time.

- Spot slow operations instantly — the longest bar is the most expensive call
- Error events are highlighted in red
- Click **↗** on any row to jump to the source location in the editor
- For very large traces (> 500 events), the longest-running events are shown first

### Error Path view

For traces that contain errors, this view reconstructs the causal chain from the error event back to the trace root — showing exactly which calls led to the failure.

- **De-duplication**: identical error chains are grouped with a `×N` badge, so a test suite that triggers the same error 17 times shows as one block with `×17` rather than 17 identical blocks
- **Stack traces** are shown inline when available
- A summary bar at the top shows the total error count and number of unique patterns
- The connector between steps shows whether the relationship is `caused by` (causal link) or `called by` (call stack)

---

## Commands

Access all commands via the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) — type `TraceGraph` to filter.

| Command | Description |
|---------|-------------|
| **TraceGraph: Run with Tracing** | Runs your test or application command wrapped with `tracegraph run`. Uses the `tracegraph.runCommand` setting, or prompts if not set. Output streams to the integrated terminal. |
| **TraceGraph: Compare Latest Run** | Runs `tracegraph compare --latest` against your stored baselines and refreshes the Findings panel. |
| **TraceGraph: Open Trace** | Shows a quick-pick list of available trace files. Select one to open it in the graph panel. |
| **TraceGraph: View Latest Report** | Opens the most recent `.report.json` in the graph panel's report mode, showing the diff table and all findings. |
| **TraceGraph: Create Baseline** | Prompts for a reason, then runs `tracegraph baseline create`. The current run's traces become the new expected behaviour. |
| **TraceGraph: Generate AI Context Packs** | Runs `tracegraph pack` to write open findings and trace summaries to `.cursor/tracegraph-context.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, and `.tracegraph/mcp-context.json`. |
| **TraceGraph: Refresh** | Forces an immediate refresh of all sidebar trees. |

Toolbar buttons also appear directly in panel headers:
- `$(play)` in the **Traces** panel header → Run with Tracing
- `$(diff)` in the **Findings** panel header → Compare Latest Run
- `$(refresh)` in all panel headers → Refresh

---

## Extension Settings

Configure these in VS Code's Settings UI or in `settings.json`.

| Setting | Default | Description |
|---------|---------|-------------|
| `tracegraph.cliPath` | `""` | Full path to the `tracegraph` executable. Leave empty to use `node_modules/.bin/tracegraph` (project-local) or `tracegraph` from `$PATH` (global). |
| `tracegraph.runCommand` | `""` | The command passed to `tracegraph run --` when using **Run with Tracing** — for example `npx vitest run` or `npm test`. If empty, VS Code prompts you each time. |
| `tracegraph.autoRefresh` | `true` | Automatically refresh all sidebar trees when new `.trace.json`, `.report.json`, `.baseline.json`, or `.scenario.json` files are detected. |

---

## Typical Workflow

```
┌─────────────────────────────────────────────────────────────┐
│                  TraceGraph PR workflow                      │
│                                                             │
│  1. Run with Tracing  →  .trace.json written to disk        │
│                                                             │
│  2. Explore the graph  →  find slow queries, error paths    │
│                                                             │
│  3. Create Baseline   →  current behaviour is now expected  │
│                                                             │
│  4. Make code changes                                       │
│                                                             │
│  5. Run with Tracing  →  new trace captured                 │
│                                                             │
│  6. Compare Latest Run  →  findings panel shows changes     │
│                                                             │
│  7. Review findings                                         │
│       ├── Real regression?  →  fix the code, re-run        │
│       ├── Intentional change?  →  Create Baseline           │
│       └── False positive?  →  tracegraph finding approve   │
└─────────────────────────────────────────────────────────────┘
```

### Approving a finding from the terminal

```bash
# List open findings with their fingerprints
npx tracegraph finding list

# Accept a specific finding (it won't block CI)
npx tracegraph finding approve <fingerprint> --reason "Auth handled by gateway"

# Re-baseline after an intentional change
npx tracegraph baseline create --reason "Added coupon validation"
```

---

## Multi-Root Workspace Support

TraceGraph works in multi-root VS Code workspaces. When your workspace contains multiple folders, the extension scans each for a `.tracegraph/` directory and merges the results across all four sidebar panels. Traces, baselines, and scenarios from each project are displayed with a `[project-name]` suffix so you can tell them apart at a glance.

---

## CI Integration

The extension complements a CI gate — run the same workflow in your pipeline:

```yaml
# .github/workflows/trace.yml
- name: Run tests with tracing
  run: npx tracegraph run -- npm test

- name: Compare against baseline
  run: npx tracegraph compare --fail-on-critical

- name: Write step summary
  if: always()
  run: npx tracegraph report --format github-step-summary --out $GITHUB_STEP_SUMMARY
```

`--fail-on-critical` exits with code **3** (not 1) so CI can distinguish findings regressions from ordinary test failures.

Baselines, approvals, and suppressions live in `.tracegraph/baselines/`, `.tracegraph/approvals/`, and `.tracegraph/suppressions/` — commit these to git so CI uses the same expected state as your local machine.

---

## Supported Languages and Frameworks

| Language | Framework | Adapter |
|----------|-----------|---------|
| TypeScript / JavaScript | Express | `@tracegraph/trace-js` — `traceExpress()` middleware |
| TypeScript / JavaScript | Any | `traceFunction()` / `traceMethod()` manual wrappers |
| TypeScript / JavaScript | Vitest | `@tracegraph/vitest` reporter (per-test trace isolation) |
| TypeScript / JavaScript | Jest | `@tracegraph/jest` reporter |
| PHP | Laravel 10 / 11 / 12 | `tracegraph/laravel` — auto-discovers via Composer |

---

## Troubleshooting

**The TraceGraph icon doesn't appear in the activity bar**

The extension activates when the workspace contains a `.tracegraph/` directory. Run `npx tracegraph init` in your project root first.

**"No traces found" in the sidebar after running tests**

- Confirm the run completed: check the integrated terminal for `[tracegraph] trace.completed` output
- Check `.tracegraph/traces/` exists and contains `.trace.json` files
- Try **TraceGraph: Refresh** from the Command Palette

**Error path or timeline shows nothing**

- Switch to the **Graph** tab first to confirm the trace loaded correctly
- If the graph is empty, the trace file may have been generated with an older version of the CLI — regenerate it with `npx tracegraph run -- <your-command>`

**"Command 'tracegraph' not found"**

Set `tracegraph.cliPath` in VS Code settings to the full path of the CLI binary, or install it globally:
```bash
npm install -g tracegraph
```

**Findings panel is empty after comparing**

The Findings panel only shows findings from the most recent `.report.json`. Run **TraceGraph: Compare Latest Run** to generate a fresh report after your test run.

---

## Links

- **CLI documentation:** [tracegraph CLI User Guide](https://github.com/ikbosah/tracegraph)
- **Repository:** [github.com/ikbosah/tracegraph](https://github.com/ikbosah/tracegraph)
- **Issues:** [github.com/ikbosah/tracegraph/issues](https://github.com/ikbosah/tracegraph/issues)

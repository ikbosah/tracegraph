# @tracegraph/ai-coverage

AI Change Coverage and Prompt Pack Builder for TraceGraph. Parses unified git diffs to identify changed functions, maps those functions to runtime trace events to detect coverage gaps, and generates structured AI context packs for Cursor, Claude Code, GitHub Copilot, and MCP-compatible tools.

Used internally by `tracegraph coverage` and `tracegraph pack`.

## What's in this package

| Export | Description |
|--------|-------------|
| `parseDiff(diffText)` | Parses a unified diff string (output of `git diff`) and returns a list of changed function/method declarations with file paths and line numbers |
| `computeCoverage(options)` | Maps changed functions to runtime trace events across `.trace.json` files; returns a `ChangeCoverageReport` |
| `getDiff(base, head)` | Runs `git diff <base>..<head>` and returns the raw diff text |
| `scanTracesForCoverage(functions, traceFiles)` | Lower-level — scans an array of trace files and returns which functions appear in at least one trace event |
| `eventMatchesFunction(event, fn)` | Returns true if a `TraceEvent` is evidence that a specific changed function was exercised |
| `buildPromptPacks(report, traces, options)` | Generates AI context packs from a `TraceReport` and optional trace context |
| `CoverageOptions` | Options for `computeCoverage` — git refs, trace dir, output path |
| `CoverageMatch` | A matched function: `{ functionName, file, line, matchingTraceIds }` |
| `PromptPackOptions` | Options for `buildPromptPacks` — format, project name, max chars |

## Installation

```bash
npm install @tracegraph/ai-coverage
```

## Usage

### Computing change coverage

```typescript
import { computeCoverage } from '@tracegraph/ai-coverage';

const report = await computeCoverage({
  base:      'origin/main',
  head:      'HEAD',
  tracesDir: '.tracegraph/traces',
  outPath:   '.tracegraph/reports/coverage.json',
});

console.log(`Coverage: ${report.summary.coveragePercent}%`);
console.log(`Uncovered: ${report.uncovered.map(f => f.functionName).join(', ')}`);
```

### Generating AI context packs

```typescript
import { buildPromptPacks } from '@tracegraph/ai-coverage';

await buildPromptPacks(traceReport, traceSessions, {
  format:      'all',           // 'cursor' | 'claude-code' | 'copilot' | 'mcp' | 'all'
  projectName: 'invoice-api',
  outDir:      process.cwd(),
  maxChars:    40_000,
});
```

Output files written:

| Format | File |
|--------|------|
| `cursor` | `.cursor/tracegraph-context.md` |
| `claude-code` | `CLAUDE.md` |
| `copilot` | `.github/copilot-instructions.md` |
| `mcp` | `.tracegraph/mcp-context.json` |

### Parsing a git diff directly

```typescript
import { parseDiff, getDiff } from '@tracegraph/ai-coverage';

const rawDiff  = await getDiff('HEAD~1', 'HEAD');
const changed  = parseDiff(rawDiff);

for (const fn of changed) {
  console.log(`${fn.functionName}  (${fn.file}:${fn.line})`);
}
```

### CLI equivalents

```bash
# Change coverage report
tracegraph coverage --base origin/main --head HEAD

# Fail CI if any changed function has no trace coverage
tracegraph coverage --fail-uncovered

# Generate all AI context packs
tracegraph pack

# Generate only Cursor and Claude Code packs
tracegraph pack --format cursor
tracegraph pack --format claude-code
```

## How coverage matching works

1. `getDiff` runs `git diff <base> <head>` filtered to TypeScript, JavaScript, and PHP files
2. `parseDiff` extracts added and modified function/method declarations from the unified diff
3. `scanTracesForCoverage` loads each `.trace.json` and checks whether any `function_call` or `method_call` event has a `name` or `displayName` matching the changed function
4. `computeCoverage` assembles covered/uncovered lists and calculates `coveragePercent`

## AI context pack content

Each pack contains:
- **Open findings** — severity, rule ID, description, and recommendation for every non-approved, non-suppressed finding in the latest report
- **Runtime trace summaries** — summarised event sequences from recent traces, up to `maxChars` characters
- **Coverage gaps** — which changed functions were not exercised at runtime

Suppressed and approved findings are intentionally excluded so the AI assistant only sees actionable issues.

# TraceGraph

Runtime behaviour tracing for VS Code. Captures execution traces from your
tests and application code, then lets you explore them as interactive call
graphs directly in the editor.

## Features

- **Sidebar** — browse traces, findings, baselines, and scenarios
- **Graph view** — interactive SVG call graph with node detail panel
- **Timeline view** — Gantt-style event timeline with duration bars
- **Error Path view** — causal chain from error events to trace root
- **Source navigation** — click any event with a file + line to jump to that location

## Requirements

Run `tracegraph init` in your project first, then run your tests with:

    tracegraph run -- npx vitest run

## Extension Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `tracegraph.cliPath` | `""` | Path to the tracegraph CLI binary |
| `tracegraph.runCommand` | `""` | Command to run with tracing |
| `tracegraph.autoRefresh` | `true` | Auto-refresh sidebar when artifacts change |
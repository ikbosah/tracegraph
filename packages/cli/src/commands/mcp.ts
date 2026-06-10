/**
 * G10 — MCP Static + Runtime Query Server
 *
 * Starts a Model Context Protocol (MCP) server over stdin/stdout that exposes
 * the local TraceGraph static graph, runtime traces, and findings as queryable
 * tools. This lets AI coding assistants (Claude Code, Cursor, Copilot etc.)
 * query architecture and coverage data without running the full CLI.
 *
 * Usage:
 *   tracegraph mcp start
 *   tracegraph mcp start --project-dir /path/to/project
 *   tracegraph mcp start --no-traces --no-findings
 *
 * Protocol: JSON-RPC 2.0 over newline-delimited stdin/stdout (MCP 2024-11-05).
 *
 * Tools exposed:
 *   tracegraph.graph.get_node            — look up a node by FQN, class.method, or display name
 *   tracegraph.graph.get_neighbors       — get callers and callees of a node
 *   tracegraph.graph.get_community       — get community metadata and member list
 *   tracegraph.graph.get_god_nodes       — list high-centrality (god) nodes
 *   tracegraph.graph.find_path           — BFS shortest path between two nodes
 *   tracegraph.trace.find_events_for_node — find trace events that exercised a node
 *   tracegraph.coverage.get_uncovered_changed_nodes — changed nodes with no trace coverage
 *   tracegraph.findings.explain_with_architecture  — enrich a finding with graph context
 */
import fs   from 'fs';
import path from 'path';
import readline from 'readline';
import {
  loadOrRebuildGraphIndex,
  loadNormalizedGraph,
} from '@tracegraph/static-graph';
import type { NormalizedGraph, NormalizedNode } from '@tracegraph/static-graph';
import type { GraphIndex }      from '@tracegraph/static-graph';
import type { TraceSession, EvaluatedFinding } from '@tracegraph/shared-types';

// ─── MCP JSON-RPC helpers ─────────────────────────────────────────────────────

type JsonRpcRequest = {
  jsonrpc: '2.0';
  id?:     string | number | null;
  method:  string;
  params?: Record<string, unknown>;
};

type JsonRpcResponse = {
  jsonrpc: '2.0';
  id:      string | number | null;
  result?: unknown;
  error?:  { code: number; message: string; data?: unknown };
};

function reply(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(
  id:      string | number | null,
  code:    number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function send(obj: JsonRpcResponse): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// ─── Tool schema definitions ──────────────────────────────────────────────────

const TOOLS = [
  {
    name:        'tracegraph.graph.get_node',
    description: 'Look up a node in the static architecture graph by fully-qualified name, class.method, or display name. Returns node metadata including community, centrality, and whether the node is a "god node".',
    inputSchema: {
      type:       'object',
      properties: {
        query: {
          type:        'string',
          description: 'Fully-qualified name (e.g. "App\\Http\\Controllers\\Foo::bar"), class.method ("Foo.bar"), or display name ("bar").',
        },
      },
      required: ['query'],
    },
  },
  {
    name:        'tracegraph.graph.get_neighbors',
    description: 'Get the direct callers and callees of a node in the static graph.',
    inputSchema: {
      type:       'object',
      properties: {
        fqn:       { type: 'string', description: 'Fully-qualified symbol name of the node.' },
        direction: {
          type:        'string',
          enum:        ['callers', 'callees', 'both'],
          description: 'Which direction to follow edges (default: both).',
        },
        limit: {
          type:        'number',
          description: 'Maximum number of neighbors to return (default: 20).',
        },
      },
      required: ['fqn'],
    },
  },
  {
    name:        'tracegraph.graph.get_community',
    description: 'Get a community by its ID, including its label, size, sensitive flag, and member nodes.',
    inputSchema: {
      type:       'object',
      properties: {
        communityId: { type: 'string', description: 'Community ID from the static graph.' },
      },
      required: ['communityId'],
    },
  },
  {
    name:        'tracegraph.graph.get_god_nodes',
    description: 'List all god nodes (high-centrality nodes that are touched by many call paths). These are high-risk change targets.',
    inputSchema: {
      type:       'object',
      properties: {
        limit: {
          type:        'number',
          description: 'Maximum number of god nodes to return (default: 20).',
        },
        communityId: {
          type:        'string',
          description: 'Optional: only return god nodes from this community.',
        },
      },
    },
  },
  {
    name:        'tracegraph.graph.find_path',
    description: 'Find the shortest call path between two nodes in the static graph (BFS over directed edges).',
    inputSchema: {
      type:       'object',
      properties: {
        from: { type: 'string', description: 'Fully-qualified name of the source node.' },
        to:   { type: 'string', description: 'Fully-qualified name of the target node.' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name:        'tracegraph.trace.find_events_for_node',
    description: 'Find runtime trace events that exercised a given static graph node (requires enriched traces).',
    inputSchema: {
      type:       'object',
      properties: {
        symbolName: {
          type:        'string',
          description: 'Fully-qualified symbol name of the static node to match.',
        },
        tracesDir: {
          type:        'string',
          description: 'Directory of .trace.json files (default: .tracegraph/traces/).',
        },
        limit: {
          type:        'number',
          description: 'Maximum number of matching events to return (default: 10).',
        },
      },
      required: ['symbolName'],
    },
  },
  {
    name:        'tracegraph.coverage.get_uncovered_changed_nodes',
    description: 'List nodes whose source files were changed (git diff) but that have no runtime trace coverage.',
    inputSchema: {
      type:       'object',
      properties: {
        base: {
          type:        'string',
          description: 'Git ref to diff from (default: HEAD~1).',
        },
        head: {
          type:        'string',
          description: 'Git ref to diff to (default: HEAD).',
        },
        tracesDir: {
          type:        'string',
          description: 'Directory of .trace.json files (default: .tracegraph/traces/).',
        },
      },
    },
  },
  {
    name:        'tracegraph.findings.explain_with_architecture',
    description: 'Explain a TraceGraph finding in the context of the static architecture graph — shows which community it belongs to, how central the affected node is, and related god nodes.',
    inputSchema: {
      type:       'object',
      properties: {
        fingerprint: {
          type:        'string',
          description: 'Finding fingerprint (16-char hex) from the latest report.',
        },
        reportFile: {
          type:        'string',
          description: 'Path to a .report.json file (default: latest report in .tracegraph/reports/).',
        },
      },
      required: ['fingerprint'],
    },
  },
];

// ─── MCP start command options ────────────────────────────────────────────────

export type McpStartOptions = {
  projectDir?: string;
  graph?:      boolean;
  traces?:     boolean;
  findings?:   boolean;
};

// ─── Main MCP server entrypoint ───────────────────────────────────────────────

export function mcpStartCommand(options: McpStartOptions = {}): void {
  const cwd        = options.projectDir ?? process.cwd();
  const useGraph    = options.graph    !== false;
  const useTraces   = options.traces   !== false;
  const useFindings = options.findings !== false;

  // ── Lazy-load the graph index on first use ────────────────────────────────
  let graph: NormalizedGraph | null        = null;
  let index: GraphIndex | null             = null;
  let graphLoaded                          = false;

  function ensureGraph(): { graph: NormalizedGraph; index: GraphIndex } | null {
    if (graphLoaded) return graph && index ? { graph, index } : null;
    graphLoaded = true;
    try {
      graph = loadNormalizedGraph(cwd);
      index = loadOrRebuildGraphIndex(cwd);
      return graph && index ? { graph, index } : null;
    } catch {
      return null;
    }
  }

  // ── Message handler ───────────────────────────────────────────────────────
  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  rl.on('line', (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      // Ignore parse errors on malformed lines
      return;
    }

    const id = req.id ?? null;

    // ── Dispatch ──────────────────────────────────────────────────────────
    switch (req.method) {

      case 'initialize': {
        send(reply(id, {
          protocolVersion: '2024-11-05',
          serverInfo: { name: 'tracegraph-mcp', version: '1.0.0' },
          capabilities: { tools: {} },
        }));
        break;
      }

      case 'notifications/initialized': {
        // Notification — no response required
        break;
      }

      case 'ping': {
        send(reply(id, {}));
        break;
      }

      case 'tools/list': {
        const tools = TOOLS.filter(t => {
          if (!useGraph    && t.name.startsWith('tracegraph.graph.'))     return false;
          if (!useTraces   && t.name.startsWith('tracegraph.trace.'))     return false;
          if (!useTraces   && t.name.startsWith('tracegraph.coverage.'))  return false;
          if (!useFindings && t.name.startsWith('tracegraph.findings.'))  return false;
          return true;
        });
        send(reply(id, { tools }));
        break;
      }

      case 'tools/call': {
        const p    = (req.params ?? {}) as Record<string, unknown>;
        const name = p['name'] as string | undefined;
        const args = (p['arguments'] ?? {}) as Record<string, unknown>;
        handleToolCall(id, name, args, cwd, ensureGraph, useTraces, useFindings);
        break;
      }

      default: {
        if (id !== null && id !== undefined) {
          send(rpcError(id, -32601, `Method not found: ${req.method}`));
        }
        break;
      }
    }
  });

  rl.on('close', () => {
    process.exit(0);
  });
}

// ─── Tool call dispatcher ─────────────────────────────────────────────────────

function handleToolCall(
  id:          string | number | null,
  name:        string | undefined,
  args:        Record<string, unknown>,
  cwd:         string,
  ensureGraph: () => { graph: NormalizedGraph; index: GraphIndex } | null,
  useTraces:   boolean,
  useFindings: boolean,
): void {
  try {
    switch (name) {

      case 'tracegraph.graph.get_node': {
        const g = ensureGraph();
        if (!g) { send(graphUnavailable(id)); return; }
        const query = String(args['query'] ?? '');
        const node  = findNode(g.index, query);
        if (!node) {
          send(textResult(id, `No node found matching: "${query}"`));
        } else {
          send(textResult(id, formatNode(node)));
        }
        break;
      }

      case 'tracegraph.graph.get_neighbors': {
        const g = ensureGraph();
        if (!g) { send(graphUnavailable(id)); return; }
        const fqn       = String(args['fqn'] ?? '');
        const direction = String(args['direction'] ?? 'both') as 'callers' | 'callees' | 'both';
        const limit     = Math.min(Number(args['limit'] ?? 20), 100);
        const node      = findNode(g.index, fqn);
        if (!node) {
          send(textResult(id, `No node found matching: "${fqn}"`));
          return;
        }
        const result = getNeighbors(g.graph, g.index, node.nodeId, direction, limit);
        send(textResult(id, result));
        break;
      }

      case 'tracegraph.graph.get_community': {
        const g = ensureGraph();
        if (!g) { send(graphUnavailable(id)); return; }
        const communityId = String(args['communityId'] ?? '');
        const community   = g.graph.communities.find(c => c.communityId === communityId);
        if (!community) {
          send(textResult(id, `No community found with ID: "${communityId}"`));
          return;
        }
        const members = community.memberNodeIds
          .slice(0, 30)
          .map(nid => {
            const n = Object.values(g.index.byFqn).find(x => x.nodeId === nid);
            return n ? `  • ${n.symbolName}${n.isGodNode ? ' [GOD NODE]' : ''}` : `  • ${nid}`;
          })
          .join('\n');
        const text =
          `Community: ${community.label} (${community.communityId})\n` +
          `  Size:      ${community.size} nodes\n` +
          `  Sensitive: ${community.isSensitive ? 'YES' : 'no'}\n` +
          `  Members (first 30):\n${members}\n` +
          (community.size > 30 ? `  … and ${community.size - 30} more\n` : '');
        send(textResult(id, text));
        break;
      }

      case 'tracegraph.graph.get_god_nodes': {
        const g = ensureGraph();
        if (!g) { send(graphUnavailable(id)); return; }
        const limit       = Math.min(Number(args['limit'] ?? 20), 100);
        const communityId = args['communityId'] ? String(args['communityId']) : undefined;
        let godNodes      = g.index.godNodes;
        if (communityId) godNodes = godNodes.filter(n => n.communityId === communityId);
        godNodes = godNodes.slice(0, limit);
        if (godNodes.length === 0) {
          send(textResult(id, 'No god nodes found.'));
          return;
        }
        const lines = godNodes.map(n =>
          `  • ${n.symbolName}\n` +
          `    community: ${n.communityLabel ?? n.communityId ?? 'unknown'}\n` +
          `    degree: ${n.degree}  centrality: ${n.centralityPercentile}th %ile\n` +
          (n.file ? `    file: ${n.file}\n` : ''),
        );
        send(textResult(id, `God nodes (${godNodes.length}):\n${lines.join('\n')}`));
        break;
      }

      case 'tracegraph.graph.find_path': {
        const g = ensureGraph();
        if (!g) { send(graphUnavailable(id)); return; }
        const fromFqn = String(args['from'] ?? '');
        const toFqn   = String(args['to']   ?? '');
        const fromNode = findNode(g.index, fromFqn);
        const toNode   = findNode(g.index, toFqn);
        if (!fromNode) { send(textResult(id, `Source node not found: "${fromFqn}"`)); return; }
        if (!toNode)   { send(textResult(id, `Target node not found: "${toFqn}"`));   return; }
        const pathResult = bfsPath(g.graph, g.index, fromNode.nodeId, toNode.nodeId);
        send(textResult(id, pathResult));
        break;
      }

      case 'tracegraph.trace.find_events_for_node': {
        if (!useTraces) { send(textResult(id, 'Trace tools disabled (start with --traces).')); return; }
        const symbolName = String(args['symbolName'] ?? '');
        const tracesDir  = args['tracesDir']
          ? String(args['tracesDir'])
          : path.join(cwd, '.tracegraph', 'traces');
        const limit      = Math.min(Number(args['limit'] ?? 10), 50);
        const result     = findEventsForNode(symbolName, tracesDir, limit);
        send(textResult(id, result));
        break;
      }

      case 'tracegraph.coverage.get_uncovered_changed_nodes': {
        if (!useTraces) { send(textResult(id, 'Trace tools disabled (start with --traces).')); return; }
        const g = ensureGraph();
        if (!g) { send(graphUnavailable(id)); return; }
        const base      = String(args['base'] ?? 'HEAD~1');
        const head      = String(args['head'] ?? 'HEAD');
        const tracesDir = args['tracesDir']
          ? String(args['tracesDir'])
          : path.join(cwd, '.tracegraph', 'traces');
        const result = getUncoveredChangedNodes(g.graph, g.index, cwd, base, head, tracesDir);
        send(textResult(id, result));
        break;
      }

      case 'tracegraph.findings.explain_with_architecture': {
        if (!useFindings) { send(textResult(id, 'Findings tools disabled (start with --findings).')); return; }
        const g           = ensureGraph();
        const fingerprint = String(args['fingerprint'] ?? '');
        const reportFile  = args['reportFile'] ? String(args['reportFile']) : resolveLatestReport(cwd);
        const result      = explainFindingWithArchitecture(fingerprint, reportFile, g);
        send(textResult(id, result));
        break;
      }

      default: {
        send(rpcError(id, -32601, `Unknown tool: ${name ?? '(none)'}`));
        break;
      }
    }
  } catch (err) {
    send(rpcError(id, -32603, `Internal error: ${String(err)}`));
  }
}

// ─── Tool implementations ─────────────────────────────────────────────────────

function graphUnavailable(id: string | number | null): JsonRpcResponse {
  return textResult(
    id,
    'Static graph not available. Run `tracegraph graph build` first.',
  );
}

function textResult(id: string | number | null, text: string): JsonRpcResponse {
  return reply(id, { content: [{ type: 'text', text }] });
}

/** Look up a node via all index strategies. */
function findNode(index: GraphIndex, query: string): NormalizedNode | null {
  // 1. Exact FQN
  if (index.byFqn[query]) return index.byFqn[query]!;

  // 2. file:Class.method format
  if (index.byFileClassMethod[query]) return index.byFileClassMethod[query]!;

  // 3. Class.method (no file)
  if (index.byClassMethod[query]) return index.byClassMethod[query]!;

  // 4. file:function format
  if (index.byFileFunction[query]) return index.byFileFunction[query]!;

  // 5. Display name (may be ambiguous — return first)
  const byName = index.byDisplayName[query];
  if (byName && byName.length > 0) return byName[0]!;

  // 6. Case-insensitive display name search
  const lower = query.toLowerCase();
  const keys  = Object.keys(index.byDisplayName);
  const match = keys.find(k => k.toLowerCase() === lower);
  if (match) return index.byDisplayName[match]![0]!;

  return null;
}

function formatNode(node: NormalizedNode): string {
  return (
    `Node: ${node.symbolName}\n` +
    `  Type:        ${node.type}\n` +
    `  Display:     ${node.displayName}\n` +
    (node.file     ? `  File:        ${node.file}${node.line ? `:${node.line}` : ''}\n` : '') +
    `  Community:   ${node.communityLabel ?? node.communityId ?? 'none'}\n` +
    `  Degree:      ${node.degree}\n` +
    `  Centrality:  ${node.centralityPercentile}th percentile\n` +
    `  God node:    ${node.isGodNode ? 'YES ⚠' : 'no'}\n` +
    (node.docstring ? `  Docstring:   ${node.docstring.slice(0, 120)}\n` : '')
  );
}

function getNeighbors(
  graph:     NormalizedGraph,
  index:     GraphIndex,
  nodeId:    string,
  direction: 'callers' | 'callees' | 'both',
  limit:     number,
): string {
  const callerEdges = direction !== 'callees'
    ? graph.edges.filter(e => e.targetId === nodeId).slice(0, limit)
    : [];
  const calleeEdges = direction !== 'callers'
    ? graph.edges.filter(e => e.sourceId === nodeId).slice(0, limit)
    : [];

  const nodeByIdFn = (nid: string): NormalizedNode | undefined =>
    Object.values(index.byFqn).find(n => n.nodeId === nid);

  const fmt = (nid: string): string => {
    const n = nodeByIdFn(nid);
    return n ? `  • ${n.symbolName}${n.isGodNode ? ' [GOD NODE]' : ''}` : `  • ${nid}`;
  };

  const lines: string[] = [];
  if (callerEdges.length > 0) {
    lines.push(`Callers (${callerEdges.length}):`);
    callerEdges.forEach(e => lines.push(fmt(e.sourceId)));
  }
  if (calleeEdges.length > 0) {
    lines.push(`Callees (${calleeEdges.length}):`);
    calleeEdges.forEach(e => lines.push(fmt(e.targetId)));
  }
  if (lines.length === 0) {
    return 'No neighbors found.';
  }
  return lines.join('\n');
}

function bfsPath(
  graph:    NormalizedGraph,
  index:    GraphIndex,
  fromId:   string,
  toId:     string,
): string {
  if (fromId === toId) {
    const n = Object.values(index.byFqn).find(x => x.nodeId === fromId);
    return `Source and target are the same node: ${n?.symbolName ?? fromId}`;
  }

  // Build adjacency list (directed: source → targets)
  const adj = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!adj.has(edge.sourceId)) adj.set(edge.sourceId, []);
    adj.get(edge.sourceId)!.push(edge.targetId);
  }

  // BFS
  const visited  = new Set<string>([fromId]);
  const queue: Array<string[]> = [[fromId]];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const last    = current[current.length - 1]!;

    for (const next of (adj.get(last) ?? [])) {
      if (next === toId) {
        // Found — build a readable path
        const fullPath = [...current, next];
        const nodeByIdFn = (nid: string): NormalizedNode | undefined =>
          Object.values(index.byFqn).find(n => n.nodeId === nid);
        const names = fullPath.map(nid => {
          const n = nodeByIdFn(nid);
          return n?.symbolName ?? nid;
        });
        return `Call path (${names.length} hops):\n` + names.map(n => `  → ${n}`).join('\n');
      }
      if (!visited.has(next)) {
        visited.add(next);
        if (current.length < 15) {
          // Limit depth to prevent infinite loops on large graphs
          queue.push([...current, next]);
        }
      }
    }
  }

  const fromNode = Object.values(index.byFqn).find(n => n.nodeId === fromId);
  const toNode   = Object.values(index.byFqn).find(n => n.nodeId === toId);
  return (
    `No path found from "${fromNode?.symbolName ?? fromId}" ` +
    `to "${toNode?.symbolName ?? toId}" within 15 hops.`
  );
}

function findEventsForNode(
  symbolName: string,
  tracesDir:  string,
  limit:      number,
): string {
  if (!fs.existsSync(tracesDir)) {
    return `Traces directory not found: ${tracesDir}`;
  }

  const files = fs.readdirSync(tracesDir)
    .filter(f => f.endsWith('.trace.json'))
    .map(f => path.join(tracesDir, f));

  const matched: Array<{ traceId: string; entrypoint: string; eventName: string; eventType: string }> = [];

  for (const file of files) {
    if (matched.length >= limit) break;
    try {
      const session = JSON.parse(fs.readFileSync(file, 'utf8')) as TraceSession;
      const events  = session.events ?? [];
      for (const evt of events) {
        const m = (evt as Record<string, unknown>)['metadata'] as Record<string, unknown> | undefined;
        if (
          m?.['staticNodeId'] === symbolName ||
          m?.['fqn']          === symbolName ||
          m?.['symbolName']   === symbolName
        ) {
          const ep = session.entrypoint;
          const epStr = ep.type === 'http_request'
            ? `${ep.method} ${ep.path}`
            : ep.type === 'cli_command'
              ? ep.command
              : ep.type;
          matched.push({
            traceId:   session.traceId,
            entrypoint: epStr,
            eventName:  evt.name,
            eventType:  evt.type,
          });
          break; // one match per trace
        }
      }
    } catch { /* skip malformed */ }
  }

  if (matched.length === 0) {
    return (
      `No trace events found for "${symbolName}".\n` +
      `  Hint: run \`tracegraph graph enrich\` to attach architecture metadata to traces first.`
    );
  }

  const lines = matched.map(m =>
    `  • [${m.traceId}] ${m.entrypoint} — ${m.eventType}:${m.eventName}`,
  );
  return `Traces exercising "${symbolName}" (${matched.length}):\n${lines.join('\n')}`;
}

function getUncoveredChangedNodes(
  graph:     NormalizedGraph,
  index:     GraphIndex,
  cwd:       string,
  base:      string,
  head:      string,
  tracesDir: string,
): string {
  // Get changed files from git diff
  const { spawnSync } = require('child_process') as typeof import('child_process');
  const diffResult = spawnSync(
    'git',
    ['diff', '--name-only', base, head],
    { cwd, encoding: 'utf8', timeout: 15_000, shell: process.platform === 'win32' },
  );

  if (diffResult.status !== 0) {
    return `Could not run git diff: ${(diffResult.stderr ?? '').toString().trim()}`;
  }

  const changedFiles = (diffResult.stdout ?? '')
    .split('\n')
    .map((f: string) => f.trim())
    .filter(Boolean);

  if (changedFiles.length === 0) {
    return `No files changed between ${base} and ${head}.`;
  }

  // Find nodes in changed files
  const changedNodes = graph.nodes.filter(n => {
    if (!n.file) return false;
    return changedFiles.some(f => n.file === f || n.file!.endsWith(f) || f.endsWith(n.file!));
  });

  if (changedNodes.length === 0) {
    return `No static graph nodes found in the ${changedFiles.length} changed file(s).`;
  }

  // Build set of covered nodeIds from enriched traces
  const coveredSymbolNames = new Set<string>();
  if (fs.existsSync(tracesDir)) {
    for (const file of fs.readdirSync(tracesDir).filter(f => f.endsWith('.trace.json'))) {
      try {
        const session = JSON.parse(
          fs.readFileSync(path.join(tracesDir, file), 'utf8'),
        ) as TraceSession;
        for (const evt of (session.events ?? [])) {
          const m = (evt as Record<string, unknown>)['metadata'] as Record<string, unknown> | undefined;
          if (m?.['staticNodeId']) coveredSymbolNames.add(String(m['staticNodeId']));
          if (m?.['fqn'])          coveredSymbolNames.add(String(m['fqn']));
          if (m?.['symbolName'])   coveredSymbolNames.add(String(m['symbolName']));
        }
      } catch { /* skip */ }
    }
  }

  const uncovered = changedNodes.filter(n => !coveredSymbolNames.has(n.symbolName));

  if (uncovered.length === 0) {
    return (
      `All ${changedNodes.length} changed node(s) have runtime trace coverage. ✓\n` +
      `  Changed files: ${changedFiles.length}\n` +
      `  Checked against: ${fs.existsSync(tracesDir) ? fs.readdirSync(tracesDir).filter(f => f.endsWith('.trace.json')).length : 0} trace(s)`
    );
  }

  const lines = uncovered.slice(0, 30).map(n => {
    const godFlag = n.isGodNode ? ' ⚠ GOD NODE' : '';
    return `  • ${n.symbolName}${godFlag}\n    file: ${n.file}`;
  });
  return (
    `Uncovered changed nodes (${uncovered.length}/${changedNodes.length}):\n` +
    lines.join('\n') +
    (uncovered.length > 30 ? `\n  … and ${uncovered.length - 30} more` : '') +
    `\n\n  Hint: run \`tracegraph graph enrich\` to attach architecture metadata, then re-check.`
  );
}

function explainFindingWithArchitecture(
  fingerprint: string,
  reportFile:  string | null,
  graphData:   { graph: NormalizedGraph; index: GraphIndex } | null,
): string {
  if (!reportFile || !fs.existsSync(reportFile)) {
    return 'No report file found. Run `tracegraph compare` first, or specify --reportFile.';
  }

  let findings: EvaluatedFinding[] = [];
  try {
    const report = JSON.parse(fs.readFileSync(reportFile, 'utf8')) as { findings?: EvaluatedFinding[] };
    findings = report.findings ?? [];
  } catch {
    return `Could not read report file: ${reportFile}`;
  }

  const finding = findings.find(f =>
    f.fingerprint === fingerprint || f.fingerprint.startsWith(fingerprint),
  );

  if (!finding) {
    return `Finding not found: "${fingerprint}" in ${reportFile}`;
  }

  const lines: string[] = [
    `Finding: ${finding.title}`,
    `  Rule:        ${finding.ruleId}`,
    `  Severity:    ${finding.severity}`,
    `  Fingerprint: ${finding.fingerprint}`,
    `  Status:      ${finding.status}`,
    '',
    `Description: ${finding.description ?? '(none)'}`,
  ];

  if (!graphData) {
    lines.push('', '(Static graph not available — run `tracegraph graph build` for architecture context.)');
    return lines.join('\n');
  }

  // Try to find the relevant node from the finding's evidence
  const evidence = finding.evidence ?? [];
  const routeEvt = evidence.find(e => 'path' in e);
  const entrypoint = finding.entrypoint ?? routeEvt;

  lines.push('', '── Architecture context ──────────────────────────────────────────');

  // Look for nodes that might be related to the finding's route/function
  const route    = (entrypoint as Record<string, unknown> | undefined)?.['path'] as string | undefined;
  const funcName = (entrypoint as Record<string, unknown> | undefined)?.['name'] as string | undefined;

  const searchTerms = [route, funcName].filter(Boolean) as string[];
  const relatedNodes: NormalizedNode[] = [];

  for (const term of searchTerms) {
    const node = findNode(graphData.index, term);
    if (node) relatedNodes.push(node);
  }

  // Fallback: search display names
  if (relatedNodes.length === 0 && (route ?? funcName)) {
    const term = (route ?? funcName)!;
    const parts = term.split('/').filter(Boolean);
    for (const part of parts) {
      const candidates = graphData.index.byDisplayName[part];
      if (candidates?.length) {
        relatedNodes.push(candidates[0]!);
        break;
      }
    }
  }

  if (relatedNodes.length > 0) {
    for (const node of relatedNodes) {
      lines.push(formatNode(node));
      // Show god nodes in the same community
      const communityGodNodes = graphData.index.godNodes
        .filter(n => n.communityId === node.communityId && n.nodeId !== node.nodeId)
        .slice(0, 3);
      if (communityGodNodes.length > 0) {
        lines.push(`  God nodes in community "${node.communityLabel ?? node.communityId}":`);
        communityGodNodes.forEach(g => lines.push(`    • ${g.symbolName}`));
      }
    }
  } else {
    lines.push('  No matching static graph nodes found for this finding.');
    lines.push(`  Total god nodes in graph: ${graphData.index.godNodes.length}`);
    lines.push(`  Communities: ${graphData.graph.communities.length}`);
  }

  return lines.join('\n');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Resolve the most recently modified .report.json in .tracegraph/reports/. */
function resolveLatestReport(cwd: string): string | null {
  const reportsDir = path.join(cwd, '.tracegraph', 'reports');
  if (!fs.existsSync(reportsDir)) return null;
  const files = fs.readdirSync(reportsDir)
    .filter(f => f.endsWith('.report.json'))
    .map(f => ({ f, mtime: fs.statSync(path.join(reportsDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files[0] ? path.join(reportsDir, files[0].f) : null;
}

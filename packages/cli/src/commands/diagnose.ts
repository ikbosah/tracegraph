import fs   from 'fs';
import path from 'path';
import { readTrace, readTraceIndex } from '@tracegraph/trace-core';
import { EXIT_CODES } from '@tracegraph/shared-types';
import type { TraceSession, CaptureLevel } from '@tracegraph/shared-types';

export type DiagnoseOptions = {
  trace?: string;
  json?:  boolean;
};

/**
 * `tracegraph diagnose [--trace <traceId>]`
 *
 * Reads the latest (or specified) trace and prints an actionable report:
 *   - Current capture level + label
 *   - Language / framework detected
 *   - What IS and IS NOT currently captured
 *   - Ranked recommendations to improve the capture level
 */
export function diagnoseCommand(options: DiagnoseOptions): number {
  const workspaceRoot    = process.cwd();
  const tracegraphDir    = path.join(workspaceRoot, '.tracegraph');
  const tracesDir        = path.join(tracegraphDir, 'traces');

  // ── Locate the trace file ──────────────────────────────────────────────────
  let traceFile: string | undefined;

  if (options.trace) {
    // Try by traceId (look for matching .trace.json) or as a direct path
    if (fs.existsSync(options.trace)) {
      traceFile = options.trace;
    } else {
      const candidate = path.join(tracesDir, `${options.trace}.trace.json`);
      if (fs.existsSync(candidate)) traceFile = candidate;
    }
    if (!traceFile) {
      process.stderr.write(`[tracegraph diagnose] Trace not found: ${options.trace}\n`);
      return EXIT_CODES.CLI_ERROR;
    }
  } else {
    // Use the most recent trace in the index
    if (!fs.existsSync(tracegraphDir)) {
      noTracesMessage();
      return EXIT_CODES.SUCCESS;
    }
    const index = readTraceIndex(tracegraphDir);
    if (index.traces.length === 0) {
      noTracesMessage();
      return EXIT_CODES.SUCCESS;
    }
    const latest = [...index.traces].sort((a, b) => b.createdAt - a.createdAt)[0]!;
    traceFile = path.resolve(workspaceRoot, latest.file);
  }

  // ── Load the trace ────────────────────────────────────────────────────────
  let session: TraceSession;
  try {
    session = readTrace(traceFile);
  } catch (err) {
    process.stderr.write(`[tracegraph diagnose] Failed to read trace: ${String(err)}\n`);
    return EXIT_CODES.CLI_ERROR;
  }

  if (options.json) {
    process.stdout.write(JSON.stringify(buildReport(session), null, 2) + '\n');
    return EXIT_CODES.SUCCESS;
  }

  printReport(session);
  return EXIT_CODES.SUCCESS;
}

// ─── Report builder ───────────────────────────────────────────────────────────

type Recommendation = { rank: number; title: string; command: string; level: number };
type DiagnoseReport = {
  traceId:        string;
  captureLevel:   { overall: number; label: string };
  language:       string;
  framework?:     string;
  captured:       string[];
  notCaptured:    string[];
  recommendations: Recommendation[];
};

function buildReport(session: TraceSession): DiagnoseReport {
  const cl = session.captureLevel;
  const level = cl.overall;

  const eventTypes = new Set(session.events.map((e) => e.type));

  // ── What is captured ───────────────────────────────────────────────────────
  const captured: string[] = [];
  const notCaptured: string[] = [];

  if (eventTypes.has('http_request') || eventTypes.has('http_response')) {
    captured.push('HTTP requests and responses');
  } else {
    notCaptured.push('HTTP requests and responses (add traceExpress / TraceMiddleware)');
  }

  if (eventTypes.has('db_query')) {
    captured.push('Database queries (SQL, duration, table, operation)');
  } else {
    notCaptured.push('Database queries (enable DB::listen / query logging)');
  }

  if (eventTypes.has('auth_check') || eventTypes.has('authorization_check')) {
    captured.push('Authentication and authorisation checks');
  } else {
    notCaptured.push('Auth / Gate checks (add auth listener)');
  }

  if (eventTypes.has('external_http_call')) {
    captured.push('Outbound HTTP calls (observed via undici / fetch)');
  } else {
    notCaptured.push('Outbound HTTP calls (add @tracegraph/js fetch tracking)');
  }

  if (eventTypes.has('function_call') || eventTypes.has('method_call')) {
    captured.push('Internal function and method calls');
  } else {
    notCaptured.push('Internal function calls (use traceFunction() for critical logic)');
  }

  if (eventTypes.has('test_run')) {
    captured.push('Per-test lifecycle (test_file → test_suite → test_run events)');
  } else {
    notCaptured.push('Per-test isolation (add @tracegraph/vitest or @tracegraph/jest reporter)');
  }

  if (eventTypes.has('queue_event')) {
    captured.push('Queue job dispatch and lifecycle');
  } else {
    notCaptured.push('Queue events (enable queue lifecycle hooks)');
  }

  // ── Recommendations ────────────────────────────────────────────────────────
  const recommendations: Recommendation[] = [];
  const isJsLang = session.language === 'javascript';
  const isPhpLang = session.language === 'php';

  if (level < 5 && !eventTypes.has('test_run')) {
    if (isJsLang) {
      const fw = session.framework ?? 'vitest';
      const pkg = fw === 'jest' ? '@tracegraph/jest' : '@tracegraph/vitest';
      const flag = fw === 'jest'
        ? `--reporters=default --reporters=${pkg}`
        : `--reporter=default --reporter=${pkg}`;
      recommendations.push({
        rank:    1,
        title:   `Add ${pkg} reporter → Level 5 (per-test traces + full structure)`,
        command: `npm install -D ${pkg}\n       Then add to vitest.config.ts: reporters: ['verbose', new TraceGraphReporter()]\n       Or run: tracegraph run -- npx ${fw} ${flag}`,
        level:   5,
      });
    } else if (isPhpLang) {
      recommendations.push({
        rank:    1,
        title:   'Add TraceGraphPHPUnitExtension → Level 1 (per-test lifecycle)',
        command: 'Add <extension class="Tracegraph\\PhpUnit\\TraceGraphPHPUnitExtension"/> to phpunit.xml',
        level:   1,
      });
    }
  }

  if (level < 2 && isJsLang && !eventTypes.has('function_call')) {
    recommendations.push({
      rank:    2,
      title:   'Use traceFunction() for critical business logic → Level 2',
      command: `import { traceFunction } from "@tracegraph/js"\nconst traced = traceFunction("InvoiceService.create", createInvoice)`,
      level:   2,
    });
  }

  if (!eventTypes.has('db_query') && isPhpLang) {
    recommendations.push({
      rank:    3,
      title:   'Enable DB::listen in TraceServiceProvider for query tracing',
      command: `// TraceServiceProvider already includes DB::listen when TRACEGRAPH_ENABLED=1\n// Ensure the provider is registered in config/app.php`,
      level:   3,
    });
  }

  if (!eventTypes.has('auth_check') && !eventTypes.has('authorization_check')) {
    if (isPhpLang) {
      recommendations.push({
        rank:    4,
        title:   'Enable Gate::after hook for authorisation tracing',
        command: `// TraceServiceProvider registers Gate::after automatically when TRACEGRAPH_ENABLED=1`,
        level:   4,
      });
    }
  }

  return {
    traceId:        session.traceId,
    captureLevel:   { overall: level, label: cl.label },
    language:       session.language,
    ...(session.framework ? { framework: session.framework } : {}),
    captured,
    notCaptured,
    recommendations: recommendations.sort((a, b) => a.rank - b.rank),
  };
}

// ─── Formatting ───────────────────────────────────────────────────────────────

const LINE = '─'.repeat(56);

function printReport(session: TraceSession): void {
  const report = buildReport(session);
  const cl = report.captureLevel;

  const lines: string[] = [];

  lines.push('');
  lines.push('TraceGraph Capture Report');
  lines.push(LINE);
  lines.push(`Trace ID:       ${report.traceId}`);
  lines.push(`Capture level:  ${cl.overall} — ${cl.label}`);
  lines.push(`Language:       ${report.language}`);
  if (report.framework) lines.push(`Framework:      ${report.framework}`);
  lines.push('');

  if (report.captured.length > 0) {
    lines.push('Captured:');
    for (const item of report.captured) {
      lines.push(`  ✓ ${item}`);
    }
  }

  if (report.notCaptured.length > 0) {
    lines.push('Not captured:');
    for (const item of report.notCaptured) {
      lines.push(`  ✗ ${item}`);
    }
  }

  if (report.recommendations.length > 0) {
    lines.push('');
    lines.push('Recommendations:');
    let i = 1;
    for (const rec of report.recommendations) {
      lines.push(`  ${i}. ${rec.title}`);
      for (const cmdLine of rec.command.split('\n')) {
        lines.push(`     ${cmdLine}`);
      }
      i++;
    }
  } else {
    lines.push('');
    lines.push('  ✓ Capture level is optimal — no recommendations.');
  }

  lines.push(LINE);
  lines.push('');

  process.stdout.write(lines.join('\n'));
}

function noTracesMessage(): void {
  process.stdout.write([
    '',
    'TraceGraph Capture Report',
    LINE,
    'No traces found in .tracegraph/traces/',
    '',
    'Run a command with tracing first:',
    '  tracegraph run -- npm test',
    '  tracegraph run -- npx vitest',
    LINE,
    '',
  ].join('\n'));
}

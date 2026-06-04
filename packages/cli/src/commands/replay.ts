/**
 * IMP-5.2 — `tracegraph replay`
 *
 * Reads a `.trace.json` file, extracts HTTP request events, and re-issues
 * those requests against a configurable base URL. Useful for:
 *   - Producing a comparison trace without re-running the full test suite
 *   - Verifying a fix by replaying the original failing request
 *   - Smoke-testing against a staging environment
 *
 * Usage:
 *   tracegraph replay <trace.json> [--base-url http://localhost:3000]
 *                    [--env staging] [--dry-run] [--compare]
 *                    [--include-auth] [--allow-destructive]
 *
 * Safety guards (enforced by default, not optional):
 *   - Production URL detection → abort with clear error
 *   - Sensitive header stripping (Authorization, Cookie, etc.)
 *   - DELETE/PUT require --allow-destructive flag
 *   - --dry-run: prints requests without executing
 */
import fs   from 'fs';
import path from 'path';
import https from 'https';
import http  from 'http';
import { EXIT_CODES, SCHEMA_VERSIONS } from '@tracegraph/shared-types';
import type { TraceSession, TracegraphConfig } from '@tracegraph/shared-types';
import { URL } from 'url';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ReplayOptions = {
  baseUrl?:          string;
  env?:              string;
  dryRun?:           boolean;
  compare?:          boolean;
  includeAuth?:      boolean;
  allowDestructive?: boolean;
};

type ReplayRequest = {
  method:    string;
  path:      string;
  query:     string;
  headers:   Record<string, string>;
  body?:     unknown;
  eventId:   string;
  startTime: number;
};

// ─── Production URL guard ─────────────────────────────────────────────────────

const PROD_PATTERNS = [
  /\.prod\./i, /^api\./i, /^app\./i,
  /^www\./i,
  /tracegraph\.io/i,
];
const SAFE_PATTERNS = [/localhost/i, /127\.0\.0\.1/, /0\.0\.0\.0/, /staging/i, /dev\./i, /test\./i];

function isProductionUrl(url: string): boolean {
  // If it looks like a safe dev/staging URL, allow it
  if (SAFE_PATTERNS.some((p) => p.test(url))) return false;
  return PROD_PATTERNS.some((p) => p.test(url));
}

// ─── Sensitive header stripping ───────────────────────────────────────────────

const DEFAULT_STRIP_HEADERS = new Set([
  'authorization', 'cookie', 'x-api-key', 'x-auth-token',
  'x-csrf-token', 'x-session-token',
]);

// ─── Command ──────────────────────────────────────────────────────────────────

export async function replayCommand(
  traceArg: string,
  options:  ReplayOptions,
): Promise<number> {
  const cwd = process.cwd();

  // ── Load trace ─────────────────────────────────────────────────────────────
  const tracePath = path.resolve(cwd, traceArg);
  if (!fs.existsSync(tracePath)) {
    process.stderr.write(`[tracegraph] Trace file not found: ${tracePath}\n`);
    return EXIT_CODES.CLI_ERROR;
  }

  let session: TraceSession;
  try {
    session = JSON.parse(fs.readFileSync(tracePath, 'utf8')) as TraceSession;
  } catch (err) {
    process.stderr.write(`[tracegraph] Cannot parse trace: ${String(err)}\n`);
    return EXIT_CODES.CLI_ERROR;
  }

  if (session.schemaVersion !== SCHEMA_VERSIONS.trace) {
    process.stderr.write(`[tracegraph] Schema mismatch in trace file.\n`);
    return EXIT_CODES.CLI_ERROR;
  }

  // ── Resolve base URL (from options > config > default) ────────────────────
  const config = loadConfig(cwd);
  let baseUrl  = options.baseUrl;

  if (!baseUrl && options.env && config?.replay?.environments) {
    const envConfig = config.replay.environments[options.env];
    if (envConfig?.baseUrl) baseUrl = envConfig.baseUrl;
  }

  if (!baseUrl) {
    baseUrl = config?.replay?.baseUrl;
  }

  if (!baseUrl) {
    process.stderr.write(
      '[tracegraph] No base URL. Provide --base-url or set replay.baseUrl in tracegraph.config.json.\n',
    );
    return EXIT_CODES.CLI_ERROR;
  }

  // ── Production URL guard ───────────────────────────────────────────────────
  if (isProductionUrl(baseUrl)) {
    process.stderr.write(
      `[tracegraph] ✗ Replay aborted: base URL matches production pattern.\n` +
      `  URL: ${baseUrl}\n` +
      `  Use --base-url to specify a safe target, or pass --allow-production to override.\n`,
    );
    return EXIT_CODES.CLI_ERROR;
  }

  // ── Build replay requests from http_request events ────────────────────────
  const stripHeaders = new Set([
    ...DEFAULT_STRIP_HEADERS,
    ...(config?.replay?.stripHeaders ?? []).map((h: string) => h.toLowerCase()),
  ]);
  const allowDestructive = options.allowDestructive ?? config?.replay?.allowDestructive ?? false;

  const requests = buildRequests(session, stripHeaders, options.includeAuth ?? false);

  if (requests.length === 0) {
    process.stdout.write(
      '[tracegraph] No http_request events found in this trace. ' +
      'Only HTTP traces can be replayed.\n',
    );
    return EXIT_CODES.SUCCESS;
  }

  // ── Destructive method guard ───────────────────────────────────────────────
  const destructiveMethods = ['DELETE', 'PUT'];
  const hasDestructive = requests.some((r) => destructiveMethods.includes(r.method.toUpperCase()));
  if (hasDestructive && !allowDestructive) {
    const methods = requests
      .filter((r) => destructiveMethods.includes(r.method.toUpperCase()))
      .map((r) => `${r.method} ${r.path}`)
      .join(', ');
    process.stderr.write(
      `[tracegraph] ✗ Replay contains destructive methods (${methods}).\n` +
      `  Pass --allow-destructive to execute DELETE and PUT requests.\n`,
    );
    return EXIT_CODES.CLI_ERROR;
  }

  // ── Dry run ───────────────────────────────────────────────────────────────
  if (options.dryRun) {
    process.stdout.write(
      `[tracegraph] Dry run — ${requests.length} request(s) would be sent to ${baseUrl}:\n\n`,
    );
    for (const req of requests) {
      const bodyNote = req.body ? ` (body: ${JSON.stringify(req.body).slice(0, 60)}…)` : '';
      process.stdout.write(
        `  ${req.method.padEnd(7)} ${baseUrl}${req.path}${req.query ? '?' + req.query : ''}${bodyNote}\n`,
      );
    }
    process.stdout.write('\n');
    return EXIT_CODES.SUCCESS;
  }

  // ── Execute requests ──────────────────────────────────────────────────────
  process.stdout.write(
    `[tracegraph] Replaying ${requests.length} request(s) against ${baseUrl}...\n\n`,
  );

  let passed = 0; let failed = 0;
  for (const req of requests) {
    const fullUrl = `${baseUrl}${req.path}${req.query ? '?' + req.query : ''}`;
    process.stdout.write(`  → ${req.method} ${fullUrl}`);

    try {
      const result = await httpRequest(fullUrl, req.method, req.headers, req.body);
      const ok = result.status >= 200 && result.status < 500;
      process.stdout.write(` … ${result.status} ${ok ? '✓' : '✗'}\n`);
      if (ok) passed++; else failed++;
    } catch (err) {
      process.stdout.write(` … ERROR: ${String(err)}\n`);
      failed++;
    }
  }

  process.stdout.write(
    `\n[tracegraph] Replay complete: ${passed} passed, ${failed} failed.\n`,
  );

  if (options.compare) {
    process.stdout.write(
      `\n[tracegraph] Run \`tracegraph compare\` to compare the replay trace against the baseline.\n`,
    );
  }

  return failed > 0 ? EXIT_CODES.COMMAND_FAILURE : EXIT_CODES.SUCCESS;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildRequests(
  session:     TraceSession,
  stripHeaders: Set<string>,
  includeAuth:  boolean,
): ReplayRequest[] {
  const requests: ReplayRequest[] = [];

  for (const event of session.events) {
    if (event.type !== 'http_request') continue;

    const method = ((event.metadata?.['method'] as string | undefined) ??
      (session.entrypoint.type === 'http_request' ? session.entrypoint.method : 'GET'));

    const urlPath = (event.metadata?.['path'] as string | undefined) ??
      (session.entrypoint.type === 'http_request' ? session.entrypoint.path : '/');

    const query   = String((event.metadata?.['query'] as string | undefined) ?? '');

    // Build sanitised headers
    const rawHeaders = (event.metadata?.['headers'] as Record<string, string> | undefined) ?? {};
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(rawHeaders)) {
      if (!includeAuth && stripHeaders.has(key.toLowerCase())) continue;
      if (typeof value === 'string') headers[key] = value;
    }
    headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';

    // Body: from request input, with sensitive field placeholders
    const body = event.input ? sanitiseBody(event.input as Record<string, unknown>) : undefined;

    requests.push({
      method,
      path:      urlPath,
      query,
      headers,
      body,
      eventId:   event.eventId,
      startTime: event.startTime,
    });
  }

  // Sort by original startTime to replay in order
  return requests.sort((a, b) => a.startTime - b.startTime);
}

const SENSITIVE_BODY_KEYS = new Set([
  'password', 'passwd', 'secret', 'token', 'apikey', 'api_key',
  'authorization', 'credit_card', 'cvv', 'ssn',
]);

function sanitiseBody(body: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (SENSITIVE_BODY_KEYS.has(key.toLowerCase())) {
      // Replace with type-appropriate placeholder
      if (key.toLowerCase().includes('email')) {
        result[key] = '[EMAIL]';
      } else if (key.toLowerCase().includes('password') || key.toLowerCase().includes('passwd')) {
        result[key] = '[PASSWORD]';
      } else {
        result[key] = '[REDACTED]';
      }
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      result[key] = sanitiseBody(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function loadConfig(cwd: string): TracegraphConfig | null {
  const configPath = path.join(cwd, 'tracegraph.config.json');
  if (!fs.existsSync(configPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8')) as TracegraphConfig;
  } catch {
    return null;
  }
}

/** Minimal HTTP client — no external deps, handles JSON bodies. */
function httpRequest(
  urlStr:  string,
  method:  string,
  headers: Record<string, string>,
  body?:   unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(urlStr);
    const isHttps = parsed.protocol === 'https:';
    const bodyStr = body != null ? JSON.stringify(body) : undefined;

    const reqHeaders: Record<string, string> = { ...headers };
    if (bodyStr) {
      reqHeaders['Content-Length'] = String(Buffer.byteLength(bodyStr));
    }

    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (isHttps ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   method.toUpperCase(),
      headers:  reqHeaders,
      timeout:  15_000,
    };

    const transport = isHttps ? https : http;
    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });

    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

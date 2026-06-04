/**
 * T-IMP6.4 — `tracegraph testgen`
 *
 * Generates HTTP-level test files from a .trace.json file.
 *
 *   tracegraph testgen <trace.json>
 *     [--framework express|laravel|fastapi|gin]
 *     [--out <dir>]
 *     [--dry-run]
 *
 * For each unique HTTP route found in the trace:
 *   - Generates an authenticated test (the observed status code)
 *   - Generates an unauthenticated 401 variant when authorization_check events are present
 *   - Generates per-role variants when multiple auth roles are detected
 *
 * Sensitive fields in request bodies (passwords, emails, tokens) are replaced
 * with typed placeholders ([PASSWORD], [EMAIL]) before embedding in test code.
 */
import fs   from 'fs';
import path from 'path';
import { EXIT_CODES } from '@tracegraph/shared-types';
import type { TraceSession, TraceEvent } from '@tracegraph/shared-types';

// ─── Public API ────────────────────────────────────────────────────────────────

export type TestgenOptions = {
  /** Target test framework. Auto-detected from trace when omitted. */
  framework?: string;
  /** Directory to write the generated test file into. Defaults to stdout. */
  out?:       string;
  /** Print the generated file content without writing it. */
  dryRun?:    boolean;
};

export async function testgenCommand(
  traceArg: string,
  options:  TestgenOptions,
): Promise<number> {
  const cwd       = process.cwd();
  const tracePath = path.resolve(cwd, traceArg);

  if (!fs.existsSync(tracePath)) {
    process.stderr.write(`[tracegraph] Trace file not found: ${tracePath}\n`);
    return EXIT_CODES.CLI_ERROR;
  }

  let session: TraceSession;
  try {
    session = JSON.parse(fs.readFileSync(tracePath, 'utf8')) as TraceSession;
  } catch (err) {
    process.stderr.write(`[tracegraph] Cannot parse trace file: ${String(err)}\n`);
    return EXIT_CODES.CLI_ERROR;
  }

  const routes = extractRoutes(session);

  if (routes.length === 0) {
    process.stderr.write(
      '[tracegraph] No HTTP route events (http_request) found in this trace.\n' +
      '  Make sure the trace was captured with a web framework adapter (Express, Laravel, etc.).\n',
    );
    return EXIT_CODES.CLI_ERROR;
  }

  const framework = resolveFramework(options.framework, session);

  // Generate test content and derive the output filename
  const baseName = path.basename(tracePath, '.trace.json').replace(/[^a-z0-9\-_]/gi, '-');
  const { content, fileName } = generateTestFile(routes, framework, baseName);

  // Print route summary to stderr so it doesn't pollute a piped stdout test file
  const out = options.out ? process.stdout : process.stderr;
  out.write(
    `[tracegraph] testgen: ${routes.length} route(s) — framework: ${framework}\n`,
  );
  for (const r of routes) {
    const authNote = r.hasAuth
      ? ` (auth${r.authRoles.length > 0 ? ': ' + r.authRoles.join(', ') : ''})`
      : '';
    out.write(`  ${r.method.padEnd(7)} ${r.routePath}  →  ${r.statusCode}${authNote}\n`);
  }
  out.write('\n');

  if (options.dryRun) {
    process.stdout.write(`[tracegraph] --dry-run: would write ${fileName}\n`);
    process.stdout.write('─'.repeat(60) + '\n');
    process.stdout.write(content);
    return EXIT_CODES.SUCCESS;
  }

  if (options.out) {
    const outDir  = path.resolve(cwd, options.out);
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, fileName);
    fs.writeFileSync(outPath, content, 'utf8');
    process.stdout.write(`[tracegraph] Written: ${path.relative(cwd, outPath)}\n`);
  } else {
    // No --out: stream to stdout (pipe-friendly)
    process.stdout.write(content);
  }

  return EXIT_CODES.SUCCESS;
}

// ─── Internal types ────────────────────────────────────────────────────────────

type RouteTestCase = {
  method:     string;
  routePath:  string;
  body:       Record<string, unknown> | null;
  statusCode: number;
  hasAuth:    boolean;
  authRoles:  string[];
};

// ─── Sensitive field sanitisation ─────────────────────────────────────────────

const SENSITIVE_KEY_RE  = /password|passwd|secret|token|api.?key|access.?token|refresh.?token|private.?key/i;
const EMAIL_KEY_RE      = /^e.?mail$/i;
const EMAIL_VALUE_RE    = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function sanitiseValue(key: string, value: unknown): unknown {
  if (typeof value === 'string') {
    if (SENSITIVE_KEY_RE.test(key))                             return '[PASSWORD]';
    if (EMAIL_KEY_RE.test(key) || EMAIL_VALUE_RE.test(value))  return '[EMAIL]';
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return sanitiseBody(value as Record<string, unknown>);
  }
  return value;
}

function sanitiseBody(obj: unknown): Record<string, unknown> | null {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    result[k] = sanitiseValue(k, v);
  }
  return result;
}

// ─── Route extraction from trace ──────────────────────────────────────────────

/**
 * Collect all eventIds in the subtree rooted at `rootId` using BFS.
 * Pre-builds a parent→children index for O(n) rather than O(n²).
 */
function buildDescendantSet(events: TraceEvent[], rootId: string): Set<string> {
  const byParent = new Map<string, string[]>();
  for (const e of events) {
    if (e.parentEventId) {
      const bucket = byParent.get(e.parentEventId) ?? [];
      bucket.push(e.eventId);
      byParent.set(e.parentEventId, bucket);
    }
  }

  const result = new Set<string>();
  const queue  = [rootId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const childId of (byParent.get(id) ?? [])) {
      if (!result.has(childId)) {
        result.add(childId);
        queue.push(childId);
      }
    }
  }
  return result;
}

/**
 * Try to extract the HTTP method from an http_request event.
 * Checks: metadata.method → input.method → name prefix.
 */
function extractMethod(e: TraceEvent): string {
  const fromMeta = e.metadata?.['method'];
  if (typeof fromMeta === 'string' && fromMeta) return fromMeta.toUpperCase();

  if (e.input !== null && typeof e.input === 'object' && !Array.isArray(e.input)) {
    const method = (e.input as Record<string, unknown>)['method'];
    if (typeof method === 'string' && method) return method.toUpperCase();
  }

  // Fall back to parsing "GET /invoices" style names
  const parts = e.name.split(' ');
  if (parts.length >= 2) return (parts[0] ?? 'GET').toUpperCase();
  return 'GET';
}

/**
 * Try to extract the route path from an http_request event.
 * Prefers the parametrized route pattern over the actual path.
 * Falls back to normalising numeric/UUID segments in the actual path.
 */
function extractRoutePath(e: TraceEvent): string {
  // Prefer the route pattern (e.g. /invoices/:id over /invoices/42)
  const routePattern = e.metadata?.['route'] ?? e.metadata?.['routePattern'];
  if (typeof routePattern === 'string' && routePattern) return routePattern;

  const fromMeta = e.metadata?.['path'] ?? e.metadata?.['url'];
  if (typeof fromMeta === 'string' && fromMeta) return normalisePath(fromMeta);

  if (e.input !== null && typeof e.input === 'object' && !Array.isArray(e.input)) {
    const rec  = e.input as Record<string, unknown>;
    const path = rec['path'] ?? rec['url'] ?? rec['uri'];
    if (typeof path === 'string' && path) return normalisePath(path);
  }

  // Parse "GET /invoices" style name
  const parts = e.name.split(' ');
  if (parts.length >= 2) return normalisePath(parts.slice(1).join(' '));
  return e.name;
}

/** Replace concrete IDs in paths with `:id` so routes deduplicate correctly. */
function normalisePath(p: string): string {
  return p
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
    .replace(/\/\d+/g, '/:id');
}

/** Extract the HTTP status code from an http_response event. */
function extractStatus(e: TraceEvent | undefined): number {
  if (!e) return 200;

  if (e.output !== null && typeof e.output === 'object' && !Array.isArray(e.output)) {
    const rec    = e.output as Record<string, unknown>;
    const status = rec['status'] ?? rec['statusCode'] ?? rec['code'];
    if (typeof status === 'number') return status;
    if (typeof status === 'string') { const n = parseInt(status, 10); if (!isNaN(n)) return n; }
  }

  const metaStatus = e.metadata?.['status'] ?? e.metadata?.['statusCode'];
  if (typeof metaStatus === 'number') return metaStatus;

  // Parse "200 OK", "201 Created" from name
  const m = e.name.match(/^(\d{3})/);
  if (m) return parseInt(m[1]!, 10);

  return 200;
}

/** Extract the request body, preferring nested `body` key over raw input. */
function extractBody(e: TraceEvent): Record<string, unknown> | null {
  const input = e.input;
  if (input === null || input === undefined) return null;
  if (typeof input !== 'object' || Array.isArray(input)) return null;

  const rec = input as Record<string, unknown>;

  // If input looks like a request envelope, pull out the body field
  if ('method' in rec || 'path' in rec || 'url' in rec || 'headers' in rec) {
    const body = rec['body'] ?? rec['data'] ?? rec['payload'];
    if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
      return sanitiseBody(body);
    }
    return null;
  }

  // input IS the body
  return sanitiseBody(rec);
}

function extractRoutes(session: TraceSession): RouteTestCase[] {
  const events = session.events;

  // Index http_response events by parentEventId for fast pairing
  const responseByParent = new Map<string, TraceEvent>();
  for (const e of events) {
    if (e.type === 'http_response' && e.parentEventId) {
      responseByParent.set(e.parentEventId, e);
    }
  }

  const cases: RouteTestCase[]  = [];
  const seen  = new Set<string>(); // method + path — deduplicate across test cases

  for (const e of events) {
    if (e.type !== 'http_request') continue;

    const method    = extractMethod(e);
    const routePath = extractRoutePath(e);
    const routeKey  = `${method} ${routePath}`;
    if (seen.has(routeKey)) continue;
    seen.add(routeKey);

    const response   = responseByParent.get(e.eventId);
    const statusCode = extractStatus(response);
    const body       = extractBody(e);

    // Find authorization_check events in the call subtree
    const descendants = buildDescendantSet(events, e.eventId);
    const authEvents  = events.filter(
      (ev) => descendants.has(ev.eventId) && ev.type === 'authorization_check',
    );
    const hasAuth   = authEvents.length > 0;
    const authRoles = [...new Set(
      authEvents
        .map((ev) => {
          const m = ev.metadata ?? {};
          return String(m['ability'] ?? m['role'] ?? m['permission'] ?? '');
        })
        .filter((r) => r !== ''),
    )];

    cases.push({ method, routePath, body, statusCode, hasAuth, authRoles });
  }

  return cases;
}

// ─── Framework resolution ──────────────────────────────────────────────────────

const VALID_FRAMEWORKS = ['express', 'laravel', 'fastapi', 'gin'] as const;
type Framework = typeof VALID_FRAMEWORKS[number];

function resolveFramework(requested: string | undefined, session: TraceSession): Framework {
  const raw = requested ?? session.framework ?? detectFrameworkFromEvents(session);
  switch (raw) {
    case 'laravel':
    case 'symfony': return 'laravel';
    case 'fastapi': return 'fastapi';
    case 'gin':     return 'gin';
    default:        return 'express';
  }
}

function detectFrameworkFromEvents(session: TraceSession): string {
  for (const e of session.events) {
    if (e.framework && !['vitest', 'jest', 'xdebug', 'plain'].includes(e.framework)) {
      return e.framework;
    }
  }
  return 'express';
}

// ─── Code generation helpers ──────────────────────────────────────────────────

/** Derive a safe identifier from method + path for use in function/test names. */
function toIdentifier(method: string, routePath: string): string {
  return (method + '_' + routePath)
    .replace(/[^a-zA-Z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Serialise body as a multi-line JS object literal. Returns '' if empty. */
function bodyAsJs(body: Record<string, unknown> | null): string {
  if (!body || Object.keys(body).length === 0) return '';
  try {
    return JSON.stringify(body, null, 4)
      .replace(/^(\s*)"([^"]+)":/gm, '$1$2:')   // unquote keys
      .replace(/"/g, "'");                        // single quotes
  } catch {
    return '';
  }
}

/** Serialise body as a PHP array literal. */
function bodyAsPhp(body: Record<string, unknown> | null): string {
  if (!body || Object.keys(body).length === 0) return '[]';
  const pairs = Object.entries(body)
    .map(([k, v]) => `'${k}' => ${typeof v === 'string' ? `'${v}'` : String(v)}`)
    .join(', ');
  return `[${pairs}]`;
}

/** Serialise body as a Python dict literal. */
function bodyAsPython(body: Record<string, unknown> | null): string {
  if (!body || Object.keys(body).length === 0) return '{}';
  const pairs = Object.entries(body)
    .map(([k, v]) => `"${k}": ${typeof v === 'string' ? `"${v}"` : JSON.stringify(v)}`)
    .join(', ');
  return `{${pairs}}`;
}

/** Serialise body as a Go map[string]interface{} literal. */
function bodyAsGo(body: Record<string, unknown> | null): string {
  if (!body || Object.keys(body).length === 0) return 'map[string]interface{}{}';
  const pairs = Object.entries(body)
    .map(([k, v]) => `"${k}": ${typeof v === 'string' ? `"${v}"` : JSON.stringify(v)}`)
    .join(', ');
  return `map[string]interface{}{${pairs}}`;
}

// ─── Framework generators ─────────────────────────────────────────────────────

function generateExpressTests(routes: RouteTestCase[]): string {
  const lines: string[] = [
    '// Generated by tracegraph testgen — edit as needed',
    "import request from 'supertest';",
    "import app from '../src/app';",
    '',
  ];

  for (const r of routes) {
    const method  = r.method.toLowerCase();
    const body    = bodyAsJs(r.body);
    const label   = `${r.method} ${r.routePath}`;

    lines.push(`describe('${label}', () => {`);

    // Authenticated (or unauthenticated if no auth check)
    lines.push(
      `  it('returns ${r.statusCode}${r.hasAuth ? ' when authenticated' : ''}', async () => {`,
      `    const res = await request(app)`,
      `      .${method}('${r.routePath}')`,
      ...(r.hasAuth ? [`      .set('Authorization', 'Bearer <token>')`] : []),
      ...(body      ? [`      .send(${body.split('\n').join('\n      ')})`] : []),
      `      .expect(${r.statusCode});`,
      `    expect(res.body).toBeDefined();`,
      `  });`,
    );

    // Unauthenticated variant
    if (r.hasAuth) {
      lines.push(
        '',
        `  it('returns 401 when unauthenticated', async () => {`,
        `    await request(app)`,
        `      .${method}('${r.routePath}')`,
        ...(body ? [`      .send(${body.split('\n').join('\n      ')})`] : []),
        `      .expect(401);`,
        `  });`,
      );
    }

    // Per-role variants
    for (const role of r.authRoles) {
      lines.push(
        '',
        `  it('returns ${r.statusCode} for role: ${role}', async () => {`,
        `    const res = await request(app)`,
        `      .${method}('${r.routePath}')`,
        `      .set('Authorization', 'Bearer <${role}-token>')`,
        ...(body ? [`      .send(${body.split('\n').join('\n      ')})`] : []),
        `      .expect(${r.statusCode});`,
        `    expect(res.body).toBeDefined();`,
        `  });`,
      );
    }

    lines.push(`});`, '');
  }

  return lines.join('\n');
}

function generateLaravelTests(routes: RouteTestCase[]): string {
  const lines: string[] = [
    '<?php',
    '',
    '// Generated by tracegraph testgen — edit as needed',
    '',
    'namespace Tests\\Feature;',
    '',
    'use Illuminate\\Foundation\\Testing\\RefreshDatabase;',
    'use Tests\\TestCase;',
    '',
    'class GeneratedApiTest extends TestCase',
    '{',
    '    use RefreshDatabase;',
    '',
  ];

  for (const r of routes) {
    const httpMethod = r.method.toLowerCase() + 'Json';
    const phpBody    = bodyAsPhp(r.body);
    const fnBase     = toIdentifier(r.method, r.routePath);

    // Authenticated test
    lines.push(`    /** @test */`);
    lines.push(`    public function ${fnBase}_returns_${r.statusCode}${r.hasAuth ? '_when_authenticated' : ''}(): void`);
    lines.push(`    {`);
    if (r.hasAuth) {
      lines.push(
        `        $this->actingAs($this->user())`,
        `             ->${httpMethod}('${r.routePath}', ${phpBody})`,
        `             ->assertStatus(${r.statusCode});`,
      );
    } else {
      lines.push(
        `        $this->${httpMethod}('${r.routePath}', ${phpBody})`,
        `             ->assertStatus(${r.statusCode});`,
      );
    }
    lines.push(`    }`, '');

    // Unauthenticated variant
    if (r.hasAuth) {
      lines.push(
        `    /** @test */`,
        `    public function ${fnBase}_returns_401_when_unauthenticated(): void`,
        `    {`,
        `        $this->${httpMethod}('${r.routePath}', ${phpBody})`,
        `             ->assertStatus(401);`,
        `    }`,
        '',
      );
    }

    // Per-role variants
    for (const role of r.authRoles) {
      const safeRole = role.replace(/[^a-zA-Z0-9]/g, '_');
      lines.push(
        `    /** @test */`,
        `    public function ${fnBase}_returns_${r.statusCode}_for_role_${safeRole}(): void`,
        `    {`,
        `        $this->actingAs($this->userWithRole('${role}'))`,
        `             ->${httpMethod}('${r.routePath}', ${phpBody})`,
        `             ->assertStatus(${r.statusCode});`,
        `    }`,
        '',
      );
    }
  }

  lines.push('}');
  return lines.join('\n');
}

function generateFastapiTests(routes: RouteTestCase[]): string {
  const lines: string[] = [
    '# Generated by tracegraph testgen — edit as needed',
    'import pytest',
    'from fastapi.testclient import TestClient',
    'from app.main import app',
    '',
    'client = TestClient(app)',
    '',
  ];

  for (const r of routes) {
    const method  = r.method.toLowerCase();
    const pyBody  = bodyAsPython(r.body);
    const fnBase  = toIdentifier(r.method, r.routePath);
    const hasBody = r.body && Object.keys(r.body).length > 0;

    // Authenticated test
    lines.push(
      `def test_${fnBase}_returns_${r.statusCode}${r.hasAuth ? '_when_authenticated' : ''}():`,
      `    response = client.${method}(`,
      `        '${r.routePath}',`,
      ...(hasBody   ? [`        json=${pyBody},`] : []),
      ...(r.hasAuth ? [`        headers={'Authorization': 'Bearer <token>'},`] : []),
      `    )`,
      `    assert response.status_code == ${r.statusCode}`,
      '',
    );

    // Unauthenticated variant
    if (r.hasAuth) {
      lines.push(
        `def test_${fnBase}_returns_401_when_unauthenticated():`,
        `    response = client.${method}(`,
        `        '${r.routePath}',`,
        ...(hasBody ? [`        json=${pyBody},`] : []),
        `    )`,
        `    assert response.status_code == 401`,
        '',
      );
    }

    // Per-role variants
    for (const role of r.authRoles) {
      lines.push(
        `def test_${fnBase}_returns_${r.statusCode}_for_role_${role}():`,
        `    response = client.${method}(`,
        `        '${r.routePath}',`,
        ...(hasBody ? [`        json=${pyBody},`] : []),
        `        headers={'Authorization': 'Bearer <${role}-token>'},`,
        `    )`,
        `    assert response.status_code == ${r.statusCode}`,
        '',
      );
    }
  }

  return lines.join('\n');
}

function generateGinTests(routes: RouteTestCase[]): string {
  const lines: string[] = [
    '// Generated by tracegraph testgen — edit as needed',
    'package main_test',
    '',
    'import (',
    '\t"bytes"',
    '\t"encoding/json"',
    '\t"net/http"',
    '\t"net/http/httptest"',
    '\t"testing"',
    ')',
    '',
    '// setupRouter initialises and returns your Gin / net/http router.',
    '// Replace the panic with your actual router construction.',
    'func setupRouter() http.Handler { panic("implement me") }',
    '',
  ];

  for (const r of routes) {
    const capFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
    const fnBase   = 'Test' + toIdentifier(r.method, r.routePath)
      .split('_')
      .map(capFirst)
      .join('');
    const goBody  = bodyAsGo(r.body);
    const hasBody = r.body && Object.keys(r.body).length > 0;

    // Authenticated test
    lines.push(
      `func ${fnBase}Returns${r.statusCode}${r.hasAuth ? 'WhenAuthenticated' : ''}(t *testing.T) {`,
      `\trouter := setupRouter()`,
    );
    if (hasBody) {
      lines.push(
        `\tbody, _ := json.Marshal(${goBody})`,
        `\treq, _ := http.NewRequest("${r.method}", "${r.routePath}", bytes.NewBuffer(body))`,
        `\treq.Header.Set("Content-Type", "application/json")`,
      );
    } else {
      lines.push(`\treq, _ := http.NewRequest("${r.method}", "${r.routePath}", nil)`);
    }
    if (r.hasAuth) lines.push(`\treq.Header.Set("Authorization", "Bearer <token>")`);
    lines.push(
      `\tw := httptest.NewRecorder()`,
      `\trouter.ServeHTTP(w, req)`,
      `\tif w.Code != ${r.statusCode} {`,
      `\t\tt.Errorf("expected ${r.statusCode}, got %d", w.Code)`,
      `\t}`,
      `}`,
      '',
    );

    // Unauthenticated variant
    if (r.hasAuth) {
      lines.push(`func ${fnBase}Returns401WhenUnauthenticated(t *testing.T) {`);
      lines.push(`\trouter := setupRouter()`);
      if (hasBody) {
        lines.push(
          `\tbody, _ := json.Marshal(${goBody})`,
          `\treq, _ := http.NewRequest("${r.method}", "${r.routePath}", bytes.NewBuffer(body))`,
          `\treq.Header.Set("Content-Type", "application/json")`,
        );
      } else {
        lines.push(`\treq, _ := http.NewRequest("${r.method}", "${r.routePath}", nil)`);
      }
      lines.push(
        `\tw := httptest.NewRecorder()`,
        `\trouter.ServeHTTP(w, req)`,
        `\tif w.Code != 401 {`,
        `\t\tt.Errorf("expected 401, got %d", w.Code)`,
        `\t}`,
        `}`,
        '',
      );
    }
  }

  return lines.join('\n');
}

// ─── Dispatcher ───────────────────────────────────────────────────────────────

function generateTestFile(
  routes:    RouteTestCase[],
  framework: Framework,
  baseName:  string,
): { content: string; fileName: string } {
  switch (framework) {
    case 'laravel':
      return { content: generateLaravelTests(routes), fileName: 'GeneratedApiTest.php' };
    case 'fastapi':
      return { content: generateFastapiTests(routes), fileName: `test_${baseName}.py` };
    case 'gin':
      return { content: generateGinTests(routes), fileName: `${baseName}_test.go` };
    default: // express
      return { content: generateExpressTests(routes), fileName: `${baseName}.test.ts` };
  }
}

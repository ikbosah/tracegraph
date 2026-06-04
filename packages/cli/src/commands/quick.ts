/**
 * IMP-2 T-IMP2.1 — `tracegraph quick`
 *
 * Zero-config quick-start demo. Creates a minimal Express + Vitest project in
 * a temp directory, runs tracing, and opens the HTML report — all in one command.
 *
 *   tracegraph quick [--out-dir <path>]
 *
 * The demo project is written from inline templates (no bundling, no network),
 * so it works offline after the CLI is installed.
 */
import fs            from 'fs';
import path          from 'path';
import os            from 'os';
import { spawnSync } from 'child_process';
import { EXIT_CODES } from '@tracegraph/shared-types';

export type QuickOptions = {
  outDir?: string;
};

export function quickCommand(options: QuickOptions): number {
  const demoDir = options.outDir
    ? path.resolve(options.outDir)
    : path.join(os.tmpdir(), `tracegraph-demo-${Date.now()}`);

  process.stdout.write(`\n[tracegraph] Creating demo project in:\n  ${demoDir}\n\n`);

  // ── Write project files ───────────────────────────────────────────────────
  try {
    writeDemoProject(demoDir);
  } catch (err) {
    process.stderr.write(`[tracegraph] Failed to create demo project: ${String(err)}\n`);
    return EXIT_CODES.CLI_ERROR;
  }

  process.stdout.write('[tracegraph] → Installing dependencies (this may take 30s)...\n');

  // ── npm install ───────────────────────────────────────────────────────────
  const install = spawnSync('npm', ['install', '--silent'], {
    cwd:   demoDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (install.error || (install.status !== 0)) {
    process.stderr.write(
      `[tracegraph] npm install failed. Make sure Node.js and npm are installed.\n`,
    );
    return EXIT_CODES.COMMAND_FAILURE;
  }

  process.stdout.write('[tracegraph] → Running test suite with TraceGraph...\n');

  // ── tracegraph run -- npx vitest run ──────────────────────────────────────
  // Use the CLI binary from the demo project's node_modules if available,
  // otherwise fall back to whatever tracegraph is on PATH.
  const tgBin = resolveTracegraphBin(demoDir);

  const traceRun = spawnSync(tgBin, ['run', '--', 'npx', 'vitest', 'run', '--reporter=verbose'], {
    cwd:   demoDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (traceRun.error) {
    process.stderr.write(`[tracegraph] trace run failed: ${traceRun.error.message}\n`);
    return EXIT_CODES.COMMAND_FAILURE;
  }

  process.stdout.write('\n[tracegraph] → Creating baseline...\n');

  // ── tracegraph baseline create ────────────────────────────────────────────
  spawnSync(tgBin, ['baseline', 'create', '--reason', 'Demo baseline'], {
    cwd:   demoDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  process.stdout.write('[tracegraph] → Opening trace viewer...\n\n');

  // ── tracegraph open --html (latest trace) ─────────────────────────────────
  const tracesDir = path.join(demoDir, '.tracegraph', 'traces');
  const latestTrace = findLatestTrace(tracesDir);

  if (latestTrace) {
    spawnSync(tgBin, ['open', '--html', latestTrace], {
      cwd:   demoDir,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
  }

  process.stdout.write(
    `[tracegraph] ✅ Demo complete!\n\n` +
    `  The demo project is in:\n    ${demoDir}\n\n` +
    `  Try making a change — remove the auth check from the invoice route,\n` +
    `  then run:\n\n` +
    `    cd ${demoDir}\n` +
    `    ${tgBin} run -- npx vitest run && ${tgBin} compare\n\n`,
  );

  return EXIT_CODES.SUCCESS;
}

// ─── Demo project template ────────────────────────────────────────────────────

function writeDemoProject(dir: string): void {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src', 'routes'), { recursive: true });
  fs.mkdirSync(path.join(dir, '__tests__'), { recursive: true });

  // package.json
  writeJson(path.join(dir, 'package.json'), {
    name: 'tracegraph-demo',
    version: '1.0.0',
    private: true,
    type: 'module',
    scripts: {
      test: 'vitest run',
      'trace:test':     'tracegraph run -- npx vitest run',
      'trace:compare':  'tracegraph compare',
      'trace:baseline': 'tracegraph baseline create',
    },
    dependencies: {
      express: '^4.18.2',
    },
    devDependencies: {
      '@tracegraph/trace-js': '*',
      '@types/express': '^4.17.21',
      vitest: '^1.6.0',
    },
  });

  // tsconfig.json
  writeJson(path.join(dir, 'tsconfig.json'), {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      esModuleInterop: true,
    },
  });

  // tracegraph.config.json
  writeJson(path.join(dir, 'tracegraph.config.json'), {
    language: 'typescript',
    framework: 'express',
    sanitize: { redactKeys: ['password', 'token', 'secret'] },
  });

  // src/app.ts
  fs.writeFileSync(path.join(dir, 'src', 'app.ts'), `
import express from 'express';
import { traceExpress } from '@tracegraph/trace-js';
import { invoiceRouter } from './routes/invoices.js';

export const app = express();
app.use(express.json());
app.use(traceExpress());
app.use('/invoices', invoiceRouter);

export default app;
`.trimStart(), 'utf8');

  // src/routes/invoices.ts
  fs.writeFileSync(path.join(dir, 'src', 'routes', 'invoices.ts'), `
import { Router } from 'express';

export const invoiceRouter = Router();

// In-memory store for demo purposes
const invoices: Array<{ id: number; customer: string; amount: number; status: string }> = [
  { id: 1, customer: 'Acme Corp',    amount: 1200, status: 'paid'    },
  { id: 2, customer: 'Globex Corp',  amount: 850,  status: 'pending' },
  { id: 3, customer: 'Initech Ltd',  amount: 3400, status: 'paid'    },
];

// Authentication guard — TraceGraph will alert if this is removed
function requireAuth(req: any, _res: any, next: any): void {
  if (!req.headers['authorization']) {
    throw new Error('Unauthorized: missing Authorization header');
  }
  next();
}

invoiceRouter.get('/', (_req, res) => {
  res.json({ invoices });
});

invoiceRouter.get('/:id', (req, res) => {
  const inv = invoices.find((i) => i.id === Number(req.params['id']));
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  res.json(inv);
});

// Protected route — auth check present (TraceGraph baselines this)
invoiceRouter.post('/', requireAuth, (req, res) => {
  const { customer, amount } = req.body as { customer?: string; amount?: number };
  if (!customer || !amount) {
    return res.status(400).json({ error: 'customer and amount are required' });
  }
  const inv = { id: invoices.length + 1, customer, amount, status: 'pending' };
  invoices.push(inv);
  res.status(201).json(inv);
});

// Protected route — try removing requireAuth and running tracegraph compare!
invoiceRouter.delete('/:id', requireAuth, (req, res) => {
  const idx = invoices.findIndex((i) => i.id === Number(req.params['id']));
  if (idx === -1) return res.status(404).json({ error: 'Invoice not found' });
  const [removed] = invoices.splice(idx, 1);
  res.json({ deleted: removed });
});
`.trimStart(), 'utf8');

  // __tests__/invoices.test.ts
  fs.writeFileSync(path.join(dir, '__tests__', 'invoices.test.ts'), `
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';

describe('GET /invoices', () => {
  it('returns a list of invoices', async () => {
    const res = await request(app).get('/invoices');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.invoices)).toBe(true);
    expect(res.body.invoices.length).toBeGreaterThan(0);
  });
});

describe('GET /invoices/:id', () => {
  it('returns a single invoice', async () => {
    const res = await request(app).get('/invoices/1');
    expect(res.status).toBe(200);
    expect(res.body.customer).toBe('Acme Corp');
  });

  it('returns 404 for unknown id', async () => {
    const res = await request(app).get('/invoices/999');
    expect(res.status).toBe(404);
  });
});

describe('POST /invoices', () => {
  it('creates a new invoice when authenticated', async () => {
    const res = await request(app)
      .post('/invoices')
      .set('Authorization', 'Bearer demo-token')
      .send({ customer: 'Demo Co', amount: 500 });
    expect(res.status).toBe(201);
    expect(res.body.customer).toBe('Demo Co');
  });
});
`.trimStart(), 'utf8');
}

function writeJson(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function resolveTracegraphBin(projectDir: string): string {
  const local = path.join(projectDir, 'node_modules', '.bin', 'tracegraph');
  if (fs.existsSync(local)) return local;
  return 'tracegraph'; // fall back to PATH
}

function findLatestTrace(tracesDir: string): string | null {
  if (!fs.existsSync(tracesDir)) return null;
  const files = fs.readdirSync(tracesDir)
    .filter((f) => f.endsWith('.trace.json'))
    .map((f) => ({ f, mtime: fs.statSync(path.join(tracesDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length > 0 ? path.join(tracesDir, files[0]!.f) : null;
}

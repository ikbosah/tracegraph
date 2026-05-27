/**
 * Integration test for the Express adapter.
 *
 * Starts a real Express server on a random port, sends requests, and verifies
 * that http_request + http_response events are written to the .events.jsonl.tmp file.
 *
 * Top-level imports ensure module cache is consistent.
 * ChildEventWriter singleton is reset between tests via _resetForTest().
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { traceExpress } from '../src/express';
import { ChildEventWriter } from '../src/child-writer';

const TRACE_ID = 'trace_expr';

let tmpDir: string;
let jsonlPath: string;

beforeEach(() => {
  tmpDir    = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-express-'));
  jsonlPath = path.join(tmpDir, `${TRACE_ID}.events.jsonl.tmp`);

  process.env.TRACEGRAPH_ENABLED    = '1';
  process.env.TRACEGRAPH_RUN_DIR    = tmpDir;
  process.env.TRACEGRAPH_TRACE_ID   = TRACE_ID;
  process.env.TRACEGRAPH_RUN_ID     = 'run_expr';
  process.env.TRACEGRAPH_SESSION_ID = 'sess_expr';
  ChildEventWriter._resetForTest();
});

afterEach(() => {
  ChildEventWriter._resetForTest();
  delete process.env.TRACEGRAPH_ENABLED;
  delete process.env.TRACEGRAPH_RUN_DIR;
  delete process.env.TRACEGRAPH_TRACE_ID;
  delete process.env.TRACEGRAPH_RUN_ID;
  delete process.env.TRACEGRAPH_SESSION_ID;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function readEvents(): unknown[] {
  if (!fs.existsSync(jsonlPath)) return [];
  return fs.readFileSync(jsonlPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function makeRequest(
  server: http.Server,
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const addr   = server.address() as { port: number };
    const data   = body ? JSON.stringify(body) : undefined;
    const req    = http.request(
      {
        hostname: '127.0.0.1',
        port:     addr.port,
        path:     urlPath,
        method,
        headers: {
          'Content-Type':   'application/json',
          'Content-Length': data ? Buffer.byteLength(data) : 0,
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (chunk: Buffer) => { buf += chunk.toString(); });
        res.on('end',  () => resolve({ status: res.statusCode!, body: buf }));
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function startServer(app: express.Application): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('traceExpress() integration', () => {
  it('emits http_request + http_response for a POST request', async () => {
    const app = express();
    app.use(express.json());
    app.use(traceExpress());

    app.post('/invoices', (req, res) => {
      res.status(201).json({ id: 1, ...req.body });
    });

    const server = await startServer(app);

    try {
      const resp = await makeRequest(server, 'POST', '/invoices', {
        amount:        100,
        authorization: 'Bearer secret-token', // should be redacted in headers
      });
      expect(resp.status).toBe(201);
    } finally {
      await closeServer(server);
    }

    // Wait for the 'finish' event to fire and the event to be written
    await new Promise((r) => setTimeout(r, 50));

    const events = readEvents() as Array<{
      type:          string;
      name:          string;
      traceId:       string;
      parentEventId: string | null;
      durationMs?:   number;
    }>;

    expect(events.length, `Events: ${JSON.stringify(events)}`).toBeGreaterThanOrEqual(2);

    const reqEvt  = events.find((e) => e.type === 'http_request');
    const respEvt = events.find((e) => e.type === 'http_response');

    expect(reqEvt,  'http_request event missing').toBeDefined();
    expect(reqEvt!.traceId).toBe(TRACE_ID);
    expect(reqEvt!.name).toContain('POST');
    expect(reqEvt!.name).toContain('/invoices');

    expect(respEvt, 'http_response event missing').toBeDefined();
    expect(typeof respEvt!.durationMs).toBe('number');
    expect(respEvt!.durationMs!).toBeGreaterThanOrEqual(0);
  });

  it('emits an error event when next(err) is called', async () => {
    const app = express();
    app.use(express.json());
    app.use(traceExpress());

    app.get('/crash', (_req, _res, next) => {
      next(new Error('deliberate crash'));
    });

    // Error handler to prevent unhandled rejection
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err.message });
    });

    const server = await startServer(app);

    try {
      const resp = await makeRequest(server, 'GET', '/crash');
      expect(resp.status).toBe(500);
    } finally {
      await closeServer(server);
    }

    await new Promise((r) => setTimeout(r, 50));

    const events = readEvents() as Array<{ type: string; error?: { type?: string; message: string } }>;
    const errEvt = events.find((e) => e.type === 'error');
    expect(errEvt, 'error event missing').toBeDefined();
    // Express routes next(err) directly to its error chain, bypassing our wrappedNext.
    // We detect the error via res.statusCode >= 500 in the finish handler, so the
    // error message reflects the HTTP status rather than the original Error message.
    expect(errEvt!.error).toBeDefined();
    expect(errEvt!.error?.type).toMatch(/Error|HttpError/);
  });

  it('is transparent when TRACEGRAPH_ENABLED is not set', async () => {
    ChildEventWriter._resetForTest();
    delete process.env.TRACEGRAPH_ENABLED;

    const app = express();
    app.use(express.json());
    app.use(traceExpress());
    app.get('/ok', (_req, res) => res.json({ ok: true }));

    const server = await startServer(app);
    try {
      const resp = await makeRequest(server, 'GET', '/ok');
      expect(resp.status).toBe(200);
    } finally {
      await closeServer(server);
    }

    expect(readEvents()).toHaveLength(0);
  });
});

/**
 * Sample project integration tests.
 *
 * These run as the wrapped command: `tracegraph run -- pnpm test`
 * They produce a trace with http_request, function_call, etc. events.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { createApp } from '../src/app';

let server: http.Server;
let baseUrl: string;

beforeAll(
  () =>
    new Promise<void>((resolve) => {
      const app = createApp();
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    }),
);

afterAll(
  () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    }),
);

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function request(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const data = body ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const req = http.request(
      {
        hostname: url.hostname,
        port:     Number(url.port),
        path:     url.pathname,
        method,
        headers: {
          'Content-Type':   'application/json',
          'Content-Length': data ? Buffer.byteLength(data) : 0,
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (chunk: Buffer) => { buf += chunk.toString(); });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode!, body: JSON.parse(buf) });
          } catch {
            resolve({ status: res.statusCode!, body: buf });
          }
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /invoices', () => {
  it('creates an invoice and returns 201', async () => {
    const res = await request('POST', '/invoices', {
      customerId:  'cust_001',
      amount:      500,
      currency:    'USD',
      description: 'Consulting services',
    });

    expect(res.status).toBe(201);
    const body = res.body as {
      id: number; amount: number; taxAmount: number; totalAmount: number; status: string;
    };
    expect(body.id).toBe(1);
    expect(body.amount).toBe(500);
    expect(body.taxAmount).toBe(40);          // 500 * 8%
    expect(body.totalAmount).toBe(540);
    expect(body.status).toBe('draft');
  });

  it('returns 500 for missing required fields', async () => {
    const res = await request('POST', '/invoices', { amount: 100 });
    expect(res.status).toBe(500);
    const body = res.body as { error: string };
    expect(body.error).toMatch(/customerId/);
  });

  it('calculates GBP tax at 20%', async () => {
    const res = await request('POST', '/invoices', {
      customerId:  'cust_002',
      amount:      200,
      currency:    'GBP',
      description: 'Design work',
    });
    expect(res.status).toBe(201);
    const body = res.body as { taxAmount: number; totalAmount: number };
    expect(body.taxAmount).toBe(40);    // 200 * 20%
    expect(body.totalAmount).toBe(240);
  });
});

describe('GET /invoices/:id', () => {
  it('retrieves a created invoice', async () => {
    // Create first
    await request('POST', '/invoices', {
      customerId: 'cust_003', amount: 300, currency: 'EUR', description: 'Dev work',
    });

    // There are now at least 2 invoices from previous tests but IDs reset per
    // test run (in-memory store, no cleanup — sequential IDs starting at 1)
    const res = await request('GET', '/invoices/1');
    expect(res.status).toBe(200);
    const body = res.body as { id: number; customerId: string };
    expect(body.id).toBe(1);
  });

  it('returns 500 for non-existent invoice', async () => {
    const res = await request('GET', '/invoices/99999');
    expect(res.status).toBe(500);
    const body = res.body as { error: string };
    expect(body.error).toMatch(/not found/);
  });
});

describe('PUT /invoices/:id', () => {
  it('updates invoice status', async () => {
    const res = await request('PUT', '/invoices/1', { status: 'sent' });
    expect(res.status).toBe(200);
    const body = res.body as { status: string };
    expect(body.status).toBe('sent');
  });
});

describe('DELETE /invoices/:id', () => {
  it('deletes an invoice and returns 204', async () => {
    const res = await request('DELETE', '/invoices/1');
    expect(res.status).toBe(204);
  });
});

describe('GET /health', () => {
  it('returns ok', async () => {
    const res = await request('GET', '/health');
    expect(res.status).toBe(200);
    const body = res.body as { status: string };
    expect(body.status).toBe('ok');
  });
});

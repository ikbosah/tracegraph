/**
 * Inventory Service integration tests.
 * Starts a real server on a random port; no mocking.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import { createApp } from '../src/app';
import { inventoryStore } from '../src/data/inventory';

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

beforeEach(() => {
  inventoryStore._reset();
});

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
          try   { resolve({ status: res.statusCode!, body: JSON.parse(buf) }); }
          catch { resolve({ status: res.statusCode!, body: buf }); }
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /inventory/:productId', () => {
  it('returns stock info for a known product', async () => {
    const res = await request('GET', '/inventory/PROD-laptop');
    expect(res.status).toBe(200);
    const body = res.body as {
      productId: string; stock: number; reserved: number; available: number;
    };
    expect(body.productId).toBe('PROD-laptop');
    expect(body.stock).toBe(50);
    expect(body.reserved).toBe(0);
    expect(body.available).toBe(50);
  });

  it('returns 404 for an unknown product', async () => {
    const res = await request('GET', '/inventory/UNKNOWN');
    expect(res.status).toBe(404);
  });
});

describe('POST /inventory/:productId/reserve', () => {
  it('reserves units when stock is available', async () => {
    const res = await request('POST', '/inventory/PROD-phone/reserve', { units: 5 });
    expect(res.status).toBe(200);
    const body = res.body as { reserved: boolean; available: number };
    expect(body.reserved).toBe(true);
    expect(body.available).toBe(95);  // 100 − 5
  });

  it('returns reserved:false when insufficient stock', async () => {
    const res = await request('POST', '/inventory/PROD-tablet/reserve', { units: 999 });
    expect(res.status).toBe(200);
    const body = res.body as { reserved: boolean; available: number };
    expect(body.reserved).toBe(false);
    expect(body.available).toBe(25);
  });

  it('returns 400 for negative units', async () => {
    const res = await request('POST', '/inventory/PROD-phone/reserve', { units: -1 });
    expect(res.status).toBe(400);
  });

  it('returns 400 when units field is missing', async () => {
    const res = await request('POST', '/inventory/PROD-phone/reserve', {});
    expect(res.status).toBe(400);
  });

  it('handles sequential reservations correctly', async () => {
    await request('POST', '/inventory/PROD-headphones/reserve', { units: 50 });
    const res = await request('POST', '/inventory/PROD-headphones/reserve', { units: 100 });
    const body = res.body as { reserved: boolean; available: number };
    expect(body.reserved).toBe(true);
    expect(body.available).toBe(50);   // 200 − 50 − 100
  });
});

describe('POST /inventory/:productId/release', () => {
  it('releases previously reserved units', async () => {
    await request('POST', '/inventory/PROD-laptop/reserve', { units: 10 });
    const res = await request('POST', '/inventory/PROD-laptop/release', { units: 5 });
    const body = res.body as { released: boolean; available: number };
    expect(body.released).toBe(true);
    expect(body.available).toBe(45);   // 50 − 10 + 5
  });
});

describe('GET /health', () => {
  it('returns ok', async () => {
    const res = await request('GET', '/health');
    expect(res.status).toBe(200);
    const body = res.body as { status: string; service: string };
    expect(body.status).toBe('ok');
    expect(body.service).toBe('inventory-service');
  });
});

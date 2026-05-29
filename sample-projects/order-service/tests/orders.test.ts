/**
 * Order Service integration tests.
 *
 * Inventory service calls are mocked via vi.stubGlobal('fetch').
 * The real fetch is replaced before the app is created so every
 * outbound call goes to the mock without network access.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import { createApp } from '../src/app';
import { orderStore } from '../src/data/orders';

// ── Mock fetch ────────────────────────────────────────────────────────────────

vi.stubGlobal('fetch', vi.fn());

/** Queue a mock response for the next fetch() call. */
function mockFetchOnce(body: unknown, status = 200): void {
  vi.mocked(globalThis.fetch).mockResolvedValueOnce({
    ok:     status >= 200 && status < 300,
    status,
    json:   async () => body,
    text:   async () => JSON.stringify(body),
  } as Response);
}

/** Queue stock-check then reserve responses (the common happy path). */
function mockInventoryHappyPath(
  productId:  string,
  stock:      number,
  quantity:   number,
): void {
  mockFetchOnce({ productId, name: 'Test Product', stock, reserved: 0, available: stock });
  mockFetchOnce({ reserved: true, available: stock - quantity });
}

// ── Server setup ──────────────────────────────────────────────────────────────

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
  vi.mocked(globalThis.fetch).mockReset();
  orderStore._reset();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /orders', () => {
  it('creates a confirmed order when stock is available', async () => {
    mockInventoryHappyPath('PROD-laptop', 50, 2);

    const res = await request('POST', '/orders', {
      customerId: 'CUST-abc',
      productId:  'PROD-laptop',
      quantity:   2,
    });

    expect(res.status).toBe(201);
    const body = res.body as { id: number; status: string; customerId: string; productId: string };
    expect(body.id).toBe(1);
    expect(body.status).toBe('confirmed');
    expect(body.customerId).toBe('CUST-abc');
    expect(body.productId).toBe('PROD-laptop');
  });

  it('returns 409 when stock is insufficient', async () => {
    // Only stock-check needed — we never reach reserve
    mockFetchOnce({ productId: 'PROD-tablet', name: 'Tablet', stock: 2, reserved: 0, available: 2 });

    const res = await request('POST', '/orders', {
      customerId: 'CUST-abc',
      productId:  'PROD-tablet',
      quantity:   10,
    });

    expect(res.status).toBe(409);
    const body = res.body as { error: string };
    expect(body.error).toMatch(/Insufficient stock/);
  });

  it('returns 409 when reservation fails due to concurrent update', async () => {
    mockFetchOnce({ productId: 'PROD-phone', name: 'Phone', stock: 100, reserved: 0, available: 100 });
    mockFetchOnce({ reserved: false, available: 0 });  // race lost

    const res = await request('POST', '/orders', {
      customerId: 'CUST-abc',
      productId:  'PROD-phone',
      quantity:   1,
    });

    expect(res.status).toBe(409);
  });

  it('returns 400 when required fields are missing', async () => {
    const res = await request('POST', '/orders', { customerId: 'CUST-abc' });
    expect(res.status).toBe(400);
  });

  it('returns 401 when customerId is empty (auth check fires)', async () => {
    const res = await request('POST', '/orders', {
      customerId: '',
      productId:  'PROD-laptop',
      quantity:   1,
    });
    expect(res.status).toBe(401);
    const body = res.body as { error: string };
    expect(body.error).toMatch(/Unauthorized/);
  });

  it('assigns sequential IDs to multiple orders', async () => {
    mockInventoryHappyPath('PROD-laptop', 50, 1);
    mockInventoryHappyPath('PROD-phone',  100, 1);

    await request('POST', '/orders', { customerId: 'CUST-1', productId: 'PROD-laptop', quantity: 1 });
    const res = await request('POST', '/orders', { customerId: 'CUST-2', productId: 'PROD-phone',  quantity: 1 });

    const body = res.body as { id: number };
    expect(body.id).toBe(2);
  });
});

describe('GET /orders/:id', () => {
  it('returns an existing order', async () => {
    mockInventoryHappyPath('PROD-laptop', 50, 3);
    await request('POST', '/orders', { customerId: 'CUST-xyz', productId: 'PROD-laptop', quantity: 3 });

    const res = await request('GET', '/orders/1');
    expect(res.status).toBe(200);
    const body = res.body as { id: number; productId: string; quantity: number };
    expect(body.id).toBe(1);
    expect(body.productId).toBe('PROD-laptop');
    expect(body.quantity).toBe(3);
  });

  it('returns 404 for a non-existent order', async () => {
    const res = await request('GET', '/orders/99999');
    expect(res.status).toBe(404);
  });
});

describe('DELETE /orders/:id', () => {
  it('cancels an existing order', async () => {
    mockInventoryHappyPath('PROD-headphones', 200, 1);
    await request('POST', '/orders', { customerId: 'CUST-del', productId: 'PROD-headphones', quantity: 1 });

    const res = await request('DELETE', '/orders/1');
    expect(res.status).toBe(204);
  });

  it('returns 404 when cancelling a non-existent order', async () => {
    const res = await request('DELETE', '/orders/99999');
    expect(res.status).toBe(404);
  });
});

describe('GET /health', () => {
  it('returns ok', async () => {
    const res = await request('GET', '/health');
    expect(res.status).toBe(200);
    const body = res.body as { status: string; service: string };
    expect(body.status).toBe('ok');
    expect(body.service).toBe('order-service');
  });
});

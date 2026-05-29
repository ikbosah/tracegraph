/**
 * HTTP client for the Inventory Service.
 *
 * Wrapped with traceFunction so calls appear as nodes in the graph.
 *
 * When running under `tracegraph run`, the register hook patches globalThis.fetch
 * and injects `x-tracegraph-correlation-id` headers automatically — linking the
 * order-service trace to the inventory-service trace in the viewer.
 *
 * Set INVENTORY_SERVICE_URL to point at the inventory service:
 *   INVENTORY_SERVICE_URL=http://localhost:3001
 */
import { traceFunction } from '@tracegraph/trace-js';

const INVENTORY_URL =
  process.env['INVENTORY_SERVICE_URL'] ?? 'http://localhost:3001';

export type StockInfo = {
  productId: string;
  name:      string;
  stock:     number;
  reserved:  number;
  available: number;
};

export type ReserveResult = {
  reserved:  boolean;
  available: number;
};

export const checkStock = traceFunction(
  'InventoryClient.checkStock',
  async (productId: string): Promise<StockInfo> => {
    const res = await fetch(`${INVENTORY_URL}/inventory/${encodeURIComponent(productId)}`);
    if (res.status === 404) {
      const err = new Error(`Product not found: ${productId}`);
      (err as Error & { status: number }).status = 404;
      throw err;
    }
    if (!res.ok) {
      throw new Error(`Inventory service error: HTTP ${res.status}`);
    }
    return res.json() as Promise<StockInfo>;
  },
);

export const reserveStock = traceFunction(
  'InventoryClient.reserveStock',
  async (productId: string, units: number): Promise<ReserveResult> => {
    const res = await fetch(
      `${INVENTORY_URL}/inventory/${encodeURIComponent(productId)}/reserve`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ units }),
      },
    );
    if (!res.ok) {
      throw new Error(`Stock reservation failed: HTTP ${res.status}`);
    }
    return res.json() as Promise<ReserveResult>;
  },
);

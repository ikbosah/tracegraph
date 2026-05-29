import { traceFunction } from '@tracegraph/trace-js';
import { inventoryStore } from '../data/inventory';

export const getStock = traceFunction(
  'InventoryService.getStock',
  (productId: string) => {
    const product = inventoryStore.findById(productId);
    if (!product) {
      const err = new Error(`Product not found: ${productId}`);
      (err as Error & { status: number }).status = 404;
      throw err;
    }
    return {
      productId: product.productId,
      name:      product.name,
      stock:     product.stock,
      reserved:  product.reserved,
      available: product.stock - product.reserved,
    };
  },
);

export const reserveStock = traceFunction(
  'InventoryService.reserveStock',
  (productId: string, units: number) => {
    if (units <= 0) {
      const err = new Error('units must be positive');
      (err as Error & { status: number }).status = 400;
      throw err;
    }
    const available = inventoryStore.available(productId);
    if (available < units) {
      return { reserved: false, available };
    }
    const ok = inventoryStore.reserve(productId, units);
    return { reserved: ok, available: inventoryStore.available(productId) };
  },
);

export const releaseStock = traceFunction(
  'InventoryService.releaseStock',
  (productId: string, units: number) => {
    if (units <= 0) {
      const err = new Error('units must be positive');
      (err as Error & { status: number }).status = 400;
      throw err;
    }
    const ok = inventoryStore.release(productId, units);
    return { released: ok, available: inventoryStore.available(productId) };
  },
);

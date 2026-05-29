export type Product = {
  productId: string;
  name:      string;
  stock:     number;
  reserved:  number;
};

/**
 * In-memory inventory store.
 * A real implementation would use a database with row-level locking.
 */
export class InventoryStore {
  private products: Map<string, Product> = new Map([
    ['PROD-laptop',     { productId: 'PROD-laptop',     name: 'Laptop Pro 14',  stock: 50,  reserved: 0 }],
    ['PROD-phone',      { productId: 'PROD-phone',      name: 'Phone Ultra X',  stock: 100, reserved: 0 }],
    ['PROD-tablet',     { productId: 'PROD-tablet',     name: 'Tablet Air 11',  stock: 25,  reserved: 0 }],
    ['PROD-headphones', { productId: 'PROD-headphones', name: 'Headphones Pro', stock: 200, reserved: 0 }],
  ]);

  findById(productId: string): Product | undefined {
    const p = this.products.get(productId);
    return p ? { ...p } : undefined;
  }

  available(productId: string): number {
    const p = this.products.get(productId);
    return p ? p.stock - p.reserved : 0;
  }

  reserve(productId: string, units: number): boolean {
    const p = this.products.get(productId);
    if (!p) return false;
    if (p.stock - p.reserved < units) return false;
    p.reserved += units;
    return true;
  }

  release(productId: string, units: number): boolean {
    const p = this.products.get(productId);
    if (!p) return false;
    p.reserved = Math.max(0, p.reserved - units);
    return true;
  }

  /** Reset reserved counts — used between tests. */
  _reset(): void {
    for (const p of this.products.values()) {
      p.reserved = 0;
    }
  }
}

export const inventoryStore = new InventoryStore();

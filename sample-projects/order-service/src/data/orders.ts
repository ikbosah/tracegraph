export type OrderStatus = 'pending' | 'confirmed' | 'cancelled' | 'failed';

export type Order = {
  id:         number;
  customerId: string;
  productId:  string;
  quantity:   number;
  status:     OrderStatus;
  createdAt:  number;
  updatedAt:  number;
};

export class OrderStore {
  private orders: Order[] = [];
  private nextId = 1;

  create(data: Omit<Order, 'id' | 'createdAt' | 'updatedAt'>): Order {
    const order: Order = {
      ...data,
      id:        this.nextId++,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.orders.push(order);
    return order;
  }

  findById(id: number): Order | undefined {
    return this.orders.find((o) => o.id === id);
  }

  updateStatus(id: number, status: OrderStatus): Order | undefined {
    const order = this.findById(id);
    if (!order) return undefined;
    order.status    = status;
    order.updatedAt = Date.now();
    return order;
  }

  list(): Order[] {
    return [...this.orders];
  }

  /** Reset state between tests. */
  _reset(): void {
    this.orders = [];
    this.nextId = 1;
  }
}

export const orderStore = new OrderStore();

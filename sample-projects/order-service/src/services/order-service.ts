import { traceFunction } from '@tracegraph/trace-js';
import { orderStore } from '../data/orders';
import { assertCanPlaceOrder } from '../auth';
import { checkStock, reserveStock } from './inventory-client';

export type CreateOrderInput = {
  customerId: string;
  productId:  string;
  quantity:   number;
};

/**
 * Creates a confirmed order.
 *
 * Flow (each step visible in the TraceGraph call graph):
 *   1. assertCanPlaceOrder  → auth_check event (Critical if removed)
 *   2. checkStock           → external_http_call to inventory-service
 *   3. reserveStock         → external_http_call to inventory-service
 *   4. orderStore.create    → order persisted
 */
export const createOrder = traceFunction(
  'OrderService.createOrder',
  async (input: CreateOrderInput) => {
    // 1. Authorization — removal of this call triggers a Critical finding
    assertCanPlaceOrder(input.customerId);

    // 2. Check available stock
    const stock = await checkStock(input.productId);
    if (stock.available < input.quantity) {
      const err = new Error(
        `Insufficient stock: ${input.quantity} requested, ${stock.available} available`,
      );
      (err as Error & { status: number }).status = 409;
      throw err;
    }

    // 3. Reserve the units
    const reservation = await reserveStock(input.productId, input.quantity);
    if (!reservation.reserved) {
      const err = new Error('Stock reservation failed — concurrent update, please retry');
      (err as Error & { status: number }).status = 409;
      throw err;
    }

    // 4. Persist the order
    return orderStore.create({
      customerId: input.customerId,
      productId:  input.productId,
      quantity:   input.quantity,
      status:     'confirmed',
    });
  },
);

export const getOrder = traceFunction(
  'OrderService.getOrder',
  (id: number) => {
    const order = orderStore.findById(id);
    if (!order) {
      const err = new Error(`Order ${id} not found`);
      (err as Error & { status: number }).status = 404;
      throw err;
    }
    return order;
  },
);

export const cancelOrder = traceFunction(
  'OrderService.cancelOrder',
  (id: number) => {
    const order = orderStore.updateStatus(id, 'cancelled');
    if (!order) {
      const err = new Error(`Order ${id} not found`);
      (err as Error & { status: number }).status = 404;
      throw err;
    }
    return order;
  },
);

import { Router as createRouter } from 'express';
import type { Router, Request, Response, NextFunction } from 'express';
import { createOrder, getOrder, cancelOrder } from '../services/order-service';

export function ordersRouter(): Router {
  const router = createRouter();

  // POST /orders  →  place an order
  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { customerId, productId, quantity } = req.body as {
        customerId?: unknown;
        productId?:  unknown;
        quantity?:   unknown;
      };
      if (
        typeof customerId !== 'string' ||
        typeof productId  !== 'string' ||
        typeof quantity   !== 'number'
      ) {
        res.status(400).json({ error: 'customerId (string), productId (string), and quantity (number) are required' });
        return;
      }
      const order = await createOrder({ customerId, productId, quantity });
      res.status(201).json(order);
    } catch (err) {
      next(err);
    }
  });

  // GET /orders/:id
  router.get('/:id', (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = Number(req.params['id']);
      if (!Number.isInteger(id) || id <= 0) {
        res.status(400).json({ error: 'Invalid order ID' });
        return;
      }
      res.json(getOrder(id));
    } catch (err) {
      next(err);
    }
  });

  // DELETE /orders/:id  →  cancel
  router.delete('/:id', (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = Number(req.params['id']);
      if (!Number.isInteger(id) || id <= 0) {
        res.status(400).json({ error: 'Invalid order ID' });
        return;
      }
      cancelOrder(id);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  return router;
}

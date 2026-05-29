import { Router as createRouter } from 'express';
import type { Router, Request, Response, NextFunction } from 'express';
import { getStock, reserveStock, releaseStock } from '../services/inventory-service';

export function inventoryRouter(): Router {
  const router = createRouter();

  // GET /inventory/:productId  →  stock levels
  router.get('/:productId', (req: Request, res: Response, next: NextFunction) => {
    try {
      res.json(getStock(req.params['productId']!));
    } catch (err) {
      next(err);
    }
  });

  // POST /inventory/:productId/reserve  body: { units }
  router.post('/:productId/reserve', (req: Request, res: Response, next: NextFunction) => {
    try {
      const { units } = req.body as { units?: unknown };
      if (typeof units !== 'number') {
        res.status(400).json({ error: 'units must be a number' });
        return;
      }
      res.json(reserveStock(req.params['productId']!, units));
    } catch (err) {
      next(err);
    }
  });

  // POST /inventory/:productId/release  body: { units }
  router.post('/:productId/release', (req: Request, res: Response, next: NextFunction) => {
    try {
      const { units } = req.body as { units?: unknown };
      if (typeof units !== 'number') {
        res.status(400).json({ error: 'units must be a number' });
        return;
      }
      res.json(releaseStock(req.params['productId']!, units));
    } catch (err) {
      next(err);
    }
  });

  return router;
}

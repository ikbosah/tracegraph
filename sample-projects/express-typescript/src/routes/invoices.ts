import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { InvoiceService } from '../services/invoice-service';

export function invoiceRouter(service: InvoiceService): Router {
  const router = Router();

  // POST /invoices
  router.post('/', (req: Request, res: Response, next: NextFunction) => {
    try {
      const invoice = service.createInvoice(req.body as {
        customerId: string; amount: number; currency: string; description: string;
      });
      res.status(201).json(invoice);
    } catch (err) {
      next(err);
    }
  });

  // GET /invoices/:id
  router.get('/:id', (req: Request, res: Response, next: NextFunction) => {
    try {
      const invoice = service.getInvoice(Number(req.params.id));
      res.json(invoice);
    } catch (err) {
      next(err);
    }
  });

  // PUT /invoices/:id
  router.put('/:id', (req: Request, res: Response, next: NextFunction) => {
    try {
      const invoice = service.updateInvoice(Number(req.params.id), req.body as object);
      res.json(invoice);
    } catch (err) {
      next(err);
    }
  });

  // DELETE /invoices/:id
  router.delete('/:id', (req: Request, res: Response, next: NextFunction) => {
    try {
      service.deleteInvoice(Number(req.params.id));
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  return router;
}

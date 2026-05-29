/**
 * Inventory Service — Express app factory.
 *
 * Instruments all requests via traceExpress().
 * traceFunction wrappers in the service layer produce method_call nodes
 * in the call graph.
 */
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { traceExpress } from '@tracegraph/trace-js';
import { inventoryRouter } from './routes/inventory';

export function createApp(): express.Application {
  const app = express();

  app.use(express.json());
  app.use(traceExpress());

  app.use('/inventory', inventoryRouter());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'inventory-service' });
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    const status = (err as Error & { status?: number }).status ?? 500;
    res.status(status).json({ error: err.message });
  });

  return app;
}

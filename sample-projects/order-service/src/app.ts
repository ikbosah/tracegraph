/**
 * Order Service — Express app factory.
 *
 * traceExpress() captures every HTTP request as an http_request event.
 * assertCanPlaceOrder() in the order flow emits an auth_check event.
 * InventoryClient calls emit external_http_call events (when under tracegraph run).
 */
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { traceExpress } from '@tracegraph/trace-js';
import { ordersRouter } from './routes/orders';

export function createApp(): express.Application {
  const app = express();

  app.use(express.json());
  app.use(traceExpress());

  app.use('/orders', ordersRouter());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'order-service' });
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    const status = (err as Error & { status?: number }).status ?? 500;
    res.status(status).json({ error: err.message });
  });

  return app;
}

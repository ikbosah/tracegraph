/**
 * Express TypeScript Sample — TraceGraph M1 Demo
 *
 * The traceExpress() middleware is intentionally registered BEFORE routes
 * so it captures every request in its AsyncLocalStorage context.
 */
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { traceExpress } from '@tracegraph/trace-js';
import { invoiceRouter } from './routes/invoices';
import { InvoiceService } from './services/invoice-service';
import { InvoiceRepository } from './repositories/invoice-repository';
import { TaxService } from './services/tax-service';

export function createApp(): express.Application {
  const app = express();

  // ── Middleware ────────────────────────────────────────────────────────────
  app.use(express.json());
  app.use(traceExpress({
    sanitizerConfig: {
      redactKeys: ['cardNumber', 'cvv'],
    },
  }));

  // ── Dependencies ──────────────────────────────────────────────────────────
  const repo    = new InvoiceRepository();
  const taxSvc  = new TaxService();
  const invSvc  = new InvoiceService(repo, taxSvc);

  // ── Routes ────────────────────────────────────────────────────────────────
  app.use('/invoices', invoiceRouter(invSvc));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // ── Error handler ─────────────────────────────────────────────────────────
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    const status = (err as Error & { status?: number }).status ?? 500;
    res.status(status).json({
      error:   err.message,
      type:    err.constructor?.name ?? 'Error',
    });
  });

  return app;
}

// ── Start server if run directly ──────────────────────────────────────────────
if (require.main === module) {
  const app  = createApp();
  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  app.listen(port, () => {
    process.stdout.write(`[sample] Express server listening on http://localhost:${port}\n`);
  });
}

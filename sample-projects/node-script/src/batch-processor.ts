/**
 * Invoice batch processor.
 *
 * processBatch() is the top-level traced function.
 * It calls processInvoice() per invoice, which calls validateInvoice()
 * and calculateTax() — producing a nested call graph in TraceGraph.
 *
 * Run with tracing:
 *   tracegraph run -- tsx src/index.ts
 *   tracegraph run -- pnpm test
 */
import { traceFunction } from '@tracegraph/trace-js';
import type { RawInvoice } from './data';
import { validateInvoice } from './validators';
import { calculateTax } from './tax-calculator';

export type ProcessedInvoice = RawInvoice & {
  taxAmount:    number;
  totalAmount:  number;
  processedAt:  number;
};

export type FailedInvoice = {
  invoice: RawInvoice;
  reason:  string;
};

export type BatchSummary = {
  total:      number;
  succeeded:  number;
  failed:     number;
  totalValue: number;
};

export type BatchResult = {
  processed: ProcessedInvoice[];
  failed:    FailedInvoice[];
  summary:   BatchSummary;
};

// ─── Individual invoice processing ───────────────────────────────────────────

export const processInvoice = traceFunction(
  'processInvoice',
  (invoice: RawInvoice): ProcessedInvoice => {
    const validation = validateInvoice(invoice);
    if (!validation.valid) {
      throw new Error(validation.reason);
    }

    const taxAmount = calculateTax(invoice.amount, invoice.currency);

    return {
      ...invoice,
      status:      'paid',
      taxAmount,
      totalAmount: invoice.amount + taxAmount,
      processedAt: Date.now(),
    };
  },
);

// ─── Summary generation ───────────────────────────────────────────────────────

export const generateSummary = traceFunction(
  'generateSummary',
  (processed: ProcessedInvoice[], failed: FailedInvoice[]): BatchSummary => {
    const totalValue = processed.reduce((sum, inv) => sum + inv.totalAmount, 0);
    return {
      total:      processed.length + failed.length,
      succeeded:  processed.length,
      failed:     failed.length,
      totalValue: Math.round(totalValue * 100) / 100,
    };
  },
);

// ─── Batch entry point ────────────────────────────────────────────────────────

export const processBatch = traceFunction(
  'processBatch',
  (invoices: RawInvoice[]): BatchResult => {
    const processed: ProcessedInvoice[] = [];
    const failed: FailedInvoice[]       = [];

    for (const invoice of invoices) {
      try {
        processed.push(processInvoice(invoice));
      } catch (err) {
        failed.push({
          invoice,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const summary = generateSummary(processed, failed);
    return { processed, failed, summary };
  },
);

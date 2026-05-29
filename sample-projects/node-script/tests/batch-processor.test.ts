/**
 * Unit tests for the invoice batch processor.
 *
 * Run with tracing:
 *   tracegraph run -- pnpm test
 *
 * The traceFunction wrappers are transparent when TRACEGRAPH_ENABLED is not set,
 * so these tests work identically with and without tracing active.
 */
import { describe, it, expect } from 'vitest';
import { processBatch, processInvoice, generateSummary } from '../src/batch-processor';
import { validateInvoice } from '../src/validators';
import { calculateTax, applyEarlyPaymentDiscount } from '../src/tax-calculator';
import type { RawInvoice } from '../src/data';

const BASE: RawInvoice = {
  id:          'INV-TEST',
  customerId:  'CUST-test',
  amount:      1000,
  currency:    'USD',
  description: 'Test invoice',
  status:      'pending',
};

// ─── validateInvoice ──────────────────────────────────────────────────────────

describe('validateInvoice', () => {
  it('accepts a fully valid invoice', () => {
    expect(validateInvoice(BASE)).toEqual({ valid: true });
  });

  it('rejects an empty customerId', () => {
    const r = validateInvoice({ ...BASE, customerId: '' });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toMatch(/customerId/);
  });

  it('rejects a whitespace-only customerId', () => {
    const r = validateInvoice({ ...BASE, customerId: '   ' });
    expect(r.valid).toBe(false);
  });

  it('rejects a negative amount', () => {
    const r = validateInvoice({ ...BASE, amount: -50 });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toMatch(/positive/);
  });

  it('rejects a zero amount', () => {
    const r = validateInvoice({ ...BASE, amount: 0 });
    expect(r.valid).toBe(false);
  });

  it('rejects a missing description', () => {
    const r = validateInvoice({ ...BASE, description: '' });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toMatch(/description/);
  });
});

// ─── calculateTax ─────────────────────────────────────────────────────────────

describe('calculateTax', () => {
  it('applies 8% for USD', ()  => { expect(calculateTax(1000, 'USD')).toBe(80);  });
  it('applies 20% for GBP', () => { expect(calculateTax(1000, 'GBP')).toBe(200); });
  it('applies 19% for EUR', () => { expect(calculateTax(1000, 'EUR')).toBe(190); });

  it('falls back to 10% for an unknown currency', () => {
    expect(calculateTax(1000, 'JPY')).toBe(100);
  });
});

describe('applyEarlyPaymentDiscount', () => {
  it('applies a 10% discount correctly', () => {
    expect(applyEarlyPaymentDiscount(1000, 10)).toBe(900);
  });

  it('throws for an out-of-range discount', () => {
    expect(() => applyEarlyPaymentDiscount(1000, 110)).toThrow(/Invalid discount/);
  });
});

// ─── processInvoice ───────────────────────────────────────────────────────────

describe('processInvoice', () => {
  it('marks a valid invoice as paid and attaches tax', () => {
    const result = processInvoice(BASE);
    expect(result.status).toBe('paid');
    expect(result.taxAmount).toBe(80);        // 1000 * 8%
    expect(result.totalAmount).toBe(1080);
    expect(result.processedAt).toBeGreaterThan(0);
  });

  it('throws for an invalid invoice', () => {
    expect(() => processInvoice({ ...BASE, customerId: '' }))
      .toThrow(/customerId/);
  });

  it('calculates GBP tax correctly', () => {
    const result = processInvoice({ ...BASE, amount: 500, currency: 'GBP' });
    expect(result.taxAmount).toBe(100);       // 500 * 20%
    expect(result.totalAmount).toBe(600);
  });
});

// ─── processBatch ─────────────────────────────────────────────────────────────

describe('processBatch', () => {
  it('processes all valid invoices', () => {
    const invoices: RawInvoice[] = [
      { ...BASE, id: 'A', amount: 500,  currency: 'USD' },
      { ...BASE, id: 'B', amount: 200,  currency: 'GBP' },
      { ...BASE, id: 'C', amount: 1000, currency: 'EUR' },
    ];
    const result = processBatch(invoices);
    expect(result.processed).toHaveLength(3);
    expect(result.failed).toHaveLength(0);
    expect(result.summary.succeeded).toBe(3);
    expect(result.summary.failed).toBe(0);
  });

  it('separates valid and invalid invoices', () => {
    const invoices: RawInvoice[] = [
      { ...BASE, id: 'GOOD' },
      { ...BASE, id: 'BAD-NO-CUSTOMER', customerId: '' },
      { ...BASE, id: 'BAD-NEG-AMOUNT',  amount: -50 },
    ];
    const result = processBatch(invoices);
    expect(result.processed).toHaveLength(1);
    expect(result.failed).toHaveLength(2);
    expect(result.processed[0]!.id).toBe('GOOD');
  });

  it('computes the correct totalValue in the summary', () => {
    const invoices: RawInvoice[] = [
      { ...BASE, id: 'X', amount: 1000, currency: 'USD' },  // +80 tax  = 1080
      { ...BASE, id: 'Y', amount: 500,  currency: 'GBP' },  // +100 tax = 600
    ];
    const result = processBatch(invoices);
    expect(result.summary.totalValue).toBe(1680);
  });

  it('returns zero totalValue and correct counts when all invoices fail', () => {
    const invoices: RawInvoice[] = [
      { ...BASE, id: 'BAD1', amount: 0 },
      { ...BASE, id: 'BAD2', customerId: '' },
    ];
    const result = processBatch(invoices);
    expect(result.processed).toHaveLength(0);
    expect(result.failed).toHaveLength(2);
    expect(result.summary.totalValue).toBe(0);
  });
});

// ─── generateSummary ──────────────────────────────────────────────────────────

describe('generateSummary', () => {
  it('sums totalAmount across processed invoices', () => {
    const processed = [
      { ...BASE, taxAmount: 80,  totalAmount: 1080, processedAt: Date.now(), status: 'paid' as const },
      { ...BASE, taxAmount: 100, totalAmount: 600,  processedAt: Date.now(), status: 'paid' as const },
    ];
    const summary = generateSummary(processed, []);
    expect(summary.totalValue).toBe(1680);
    expect(summary.succeeded).toBe(2);
    expect(summary.failed).toBe(0);
    expect(summary.total).toBe(2);
  });
});

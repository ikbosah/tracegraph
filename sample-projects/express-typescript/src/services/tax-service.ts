/**
 * TaxService — calculates tax for an invoice.
 *
 * Intentionally wrapped with traceFunction to demonstrate M1 capture level 2.
 */
import { traceFunction } from '@tracegraph/trace-js';

const TAX_RATES: Record<string, number> = {
  USD: 0.08,   // US ~8% average
  GBP: 0.20,   // UK VAT
  EUR: 0.19,   // EU average
  AUD: 0.10,   // Australian GST
};

export class TaxService {
  /** Calculate the tax amount for a given amount and currency. */
  calculate = traceFunction(
    'TaxService.calculate',
    (amount: number, currency: string): number => {
      const rate = TAX_RATES[currency] ?? 0.10;
      return Math.round(amount * rate * 100) / 100;
    },
  );

  /** Return the effective tax rate for a currency. */
  getRate = traceFunction(
    'TaxService.getRate',
    (currency: string): number => {
      return TAX_RATES[currency] ?? 0.10;
    },
  );
}

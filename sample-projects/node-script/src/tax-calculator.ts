import { traceFunction } from '@tracegraph/trace-js';

/**
 * Simplified tax rates by currency/jurisdiction.
 * A real system would call a tax authority API or a config service.
 */
const TAX_RATES: Record<string, number> = {
  USD: 0.08,   // 8%  — US sales tax (simplified)
  GBP: 0.20,   // 20% — UK VAT
  EUR: 0.19,   // 19% — EU VAT (Germany as proxy)
};

export const calculateTax = traceFunction(
  'calculateTax',
  (amount: number, currency: string): number => {
    const rate = TAX_RATES[currency] ?? 0.10;
    return Math.round(amount * rate * 100) / 100;
  },
);

export const applyEarlyPaymentDiscount = traceFunction(
  'applyEarlyPaymentDiscount',
  (amount: number, discountPct: number): number => {
    if (discountPct < 0 || discountPct > 100) {
      throw new Error(`Invalid discount percentage: ${discountPct}`);
    }
    return Math.round(amount * (1 - discountPct / 100) * 100) / 100;
  },
);

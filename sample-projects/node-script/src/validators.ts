import { traceFunction } from '@tracegraph/trace-js';
import type { RawInvoice } from './data';

export type ValidationResult =
  | { valid: true }
  | { valid: false; reason: string };

/**
 * Validates a raw invoice before processing.
 * Wrapped with traceFunction so it appears as a node in the call graph.
 */
export const validateInvoice = traceFunction(
  'validateInvoice',
  (invoice: RawInvoice): ValidationResult => {
    if (!invoice.customerId?.trim()) {
      return { valid: false, reason: 'customerId is required' };
    }
    if (typeof invoice.amount !== 'number' || invoice.amount <= 0) {
      return { valid: false, reason: `amount must be positive (got ${invoice.amount})` };
    }
    if (!invoice.currency) {
      return { valid: false, reason: 'currency is required' };
    }
    if (!invoice.description?.trim()) {
      return { valid: false, reason: 'description is required' };
    }
    return { valid: true };
  },
);

/**
 * Sample invoice data for the batch processor.
 * In a real system this would be read from a database or a CSV/SFTP drop.
 */

export type Currency = 'USD' | 'GBP' | 'EUR';

export type RawInvoice = {
  id:          string;
  customerId:  string;
  amount:      number;
  currency:    Currency;
  description: string;
  status:      'pending' | 'processing' | 'paid' | 'failed';
};

export const PENDING_INVOICES: RawInvoice[] = [
  {
    id:          'INV-001',
    customerId:  'CUST-acme',
    amount:      1500,
    currency:    'USD',
    description: 'Consulting services Q1',
    status:      'pending',
  },
  {
    id:          'INV-002',
    customerId:  'CUST-globex',
    amount:      2750,
    currency:    'GBP',
    description: 'Software licence renewal',
    status:      'pending',
  },
  {
    id:          'INV-003',
    customerId:  '',          // missing customerId — fails validation
    amount:      800,
    currency:    'USD',
    description: 'Ad hoc support',
    status:      'pending',
  },
  {
    id:          'INV-004',
    customerId:  'CUST-initech',
    amount:      -100,        // negative amount — fails validation
    currency:    'USD',
    description: 'Refund adjustment',
    status:      'pending',
  },
  {
    id:          'INV-005',
    customerId:  'CUST-umbrella',
    amount:      4200,
    currency:    'EUR',
    description: 'Annual maintenance contract',
    status:      'pending',
  },
];

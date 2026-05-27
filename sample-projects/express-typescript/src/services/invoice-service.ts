/**
 * InvoiceService — business logic layer.
 *
 * Methods are wrapped with traceFunction to appear in traces at capture level 2.
 */
import { traceFunction } from '@tracegraph/trace-js';
import type { Invoice, CreateInvoiceInput, UpdateInvoiceInput } from '../repositories/invoice-repository';
import { InvoiceRepository } from '../repositories/invoice-repository';
import { TaxService } from './tax-service';

export type CreateInvoiceRequest = {
  customerId:  string;
  amount:      number;
  currency:    string;
  description: string;
};

export type InvoiceWithTax = Invoice & { taxAmount: number; totalAmount: number };

export class InvoiceService {
  constructor(
    private readonly repo: InvoiceRepository,
    private readonly taxService: TaxService,
  ) {}

  createInvoice = traceFunction(
    'InvoiceService.createInvoice',
    (req: CreateInvoiceRequest): InvoiceWithTax => {
      this.validateCreateRequest(req);

      const taxAmount = this.taxService.calculate(req.amount, req.currency);

      const input: CreateInvoiceInput = {
        customerId:  req.customerId,
        amount:      req.amount,
        currency:    req.currency,
        description: req.description,
        status:      'draft',
      };

      const invoice = this.repo.create(input);
      return { ...invoice, taxAmount, totalAmount: invoice.amount + taxAmount };
    },
  );

  getInvoice = traceFunction(
    'InvoiceService.getInvoice',
    (id: number): InvoiceWithTax => {
      const invoice = this.repo.findById(id);
      if (!invoice) throw new Error(`Invoice ${id} not found`);

      const taxAmount = this.taxService.calculate(invoice.amount, invoice.currency);
      return { ...invoice, taxAmount, totalAmount: invoice.amount + taxAmount };
    },
  );

  updateInvoice = traceFunction(
    'InvoiceService.updateInvoice',
    (id: number, updates: UpdateInvoiceInput): InvoiceWithTax => {
      const invoice = this.repo.update(id, updates);
      if (!invoice) throw new Error(`Invoice ${id} not found`);

      const taxAmount = this.taxService.calculate(invoice.amount, invoice.currency);
      return { ...invoice, taxAmount, totalAmount: invoice.amount + taxAmount };
    },
  );

  deleteInvoice = traceFunction(
    'InvoiceService.deleteInvoice',
    (id: number): void => {
      const deleted = this.repo.delete(id);
      if (!deleted) throw new Error(`Invoice ${id} not found`);
    },
  );

  listInvoices = traceFunction(
    'InvoiceService.listInvoices',
    (): Invoice[] => {
      return this.repo.findAll();
    },
  );

  private validateCreateRequest(req: CreateInvoiceRequest): void {
    if (!req.customerId)  throw new Error('customerId is required');
    if (req.amount <= 0)  throw new Error('amount must be positive');
    if (!req.currency)    throw new Error('currency is required');
    if (!req.description) throw new Error('description is required');
  }
}

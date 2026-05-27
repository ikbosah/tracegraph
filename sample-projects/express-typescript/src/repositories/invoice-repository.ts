/**
 * In-memory invoice repository.
 * Simulates a database for the sample project — no actual DB required.
 */

export type Invoice = {
  id:          number;
  customerId:  string;
  amount:      number;
  currency:    string;
  status:      'draft' | 'sent' | 'paid' | 'cancelled';
  description: string;
  createdAt:   string;
  updatedAt:   string;
};

export type CreateInvoiceInput = Omit<Invoice, 'id' | 'createdAt' | 'updatedAt'>;
export type UpdateInvoiceInput = Partial<Omit<Invoice, 'id' | 'createdAt' | 'updatedAt'>>;

export class InvoiceRepository {
  private store = new Map<number, Invoice>();
  private nextId = 1;

  create(input: CreateInvoiceInput): Invoice {
    const now     = new Date().toISOString();
    const invoice: Invoice = {
      id:        this.nextId++,
      ...input,
      createdAt: now,
      updatedAt: now,
    };
    this.store.set(invoice.id, invoice);
    return invoice;
  }

  findById(id: number): Invoice | undefined {
    return this.store.get(id);
  }

  findAll(): Invoice[] {
    return Array.from(this.store.values());
  }

  update(id: number, input: UpdateInvoiceInput): Invoice | undefined {
    const existing = this.store.get(id);
    if (!existing) return undefined;

    const updated: Invoice = {
      ...existing,
      ...input,
      id,              // id is immutable
      createdAt: existing.createdAt, // createdAt is immutable
      updatedAt: new Date().toISOString(),
    };
    this.store.set(id, updated);
    return updated;
  }

  delete(id: number): boolean {
    return this.store.delete(id);
  }

  /** Reset for testing. */
  clear(): void {
    this.store.clear();
    this.nextId = 1;
  }
}

/**
 * Invoice Batch Processor — CLI entry point.
 *
 * This is the entrypoint TraceGraph wraps. The trace session gets:
 *   entrypoint: { type: 'cli_command', command: 'tsx src/index.ts' }
 *
 * Usage:
 *   tsx src/index.ts                     — run directly
 *   tracegraph run -- tsx src/index.ts   — run with tracing
 *   tracegraph run -- pnpm test          — trace the test suite instead
 */
import { PENDING_INVOICES } from './data';
import { processBatch } from './batch-processor';

async function main(): Promise<void> {
  process.stdout.write(`Processing ${PENDING_INVOICES.length} pending invoices...\n`);

  const result = processBatch(PENDING_INVOICES);

  process.stdout.write(
    `\nBatch complete:\n` +
    `  ${result.summary.succeeded} succeeded  ` +
    `(total billed: ${result.summary.totalValue})\n` +
    `  ${result.summary.failed} failed\n`,
  );

  if (result.failed.length > 0) {
    process.stdout.write('\nFailed invoices:\n');
    for (const f of result.failed) {
      process.stdout.write(`  ✗ ${f.invoice.id} — ${f.reason}\n`);
    }
  }

  // Non-zero exit if any invoice failed — the CLI records this as status:'failed'
  if (result.summary.failed > 0) {
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Fatal error: ${msg}\n`);
  process.exit(2);
});

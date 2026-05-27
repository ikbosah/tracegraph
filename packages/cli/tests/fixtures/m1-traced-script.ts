/**
 * Fixture script used by the M1 integration test.
 *
 * Run via: tsx m1-traced-script.ts (with TRACEGRAPH_* env vars set)
 *
 * 1. Imports @tracegraph/trace-js/register which auto-initialises (calls init() at module load)
 *    so that capture-level.json is written on process.exit.
 * 2. Runs several traceFunction-wrapped calls to produce function_call / return events.
 *
 * Exit code 0 = success.
 */

// Auto-init: register.ts calls init() at module load time.
// This patches fetch, sets up diagnostics_channel, and arranges capture-level.json on exit.
import '@tracegraph/trace-js/register';

import { traceFunction } from '@tracegraph/trace-js';

const add      = traceFunction('add',      (a: number, b: number) => a + b);
const multiply = traceFunction('multiply', (a: number, b: number) => a * b);
const pipeline = traceFunction('pipeline', (x: number) => {
  const sum = add(x, 10);
  return multiply(sum, 2);
});

const result = pipeline(5);   // → add(5,10)=15 → multiply(15,2)=30

process.stdout.write(JSON.stringify({ result }) + '\n');

// process.exit(0) fires the 'exit' handler in register.ts → writes capture-level.json
process.exit(0);

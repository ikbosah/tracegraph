import fs from 'fs';
import path from 'path';
import type { TraceEvent } from '@tracegraph/shared-types';

/**
 * Streams TraceEvent objects as JSON Lines to a `.jsonl.tmp` file.
 *
 * The file is only written to during an active run.
 * After the run, `finaliseTrace()` reads this file, compiles the complete
 * TraceSession, and atomically renames it to `.trace.json`.
 *
 * VS Code must never read `.tmp` files — it waits for the `trace.completed`
 * stdout protocol event which is only emitted after the atomic rename.
 */
export class TraceEventWriter {
  private readonly stream: fs.WriteStream;
  private closed = false;

  constructor(readonly tmpPath: string) {
    fs.mkdirSync(path.dirname(tmpPath), { recursive: true });
    this.stream = fs.createWriteStream(tmpPath, { flags: 'a', encoding: 'utf8' });
  }

  write(event: TraceEvent): void {
    if (this.closed) {
      throw new Error(`TraceEventWriter: attempted write after close on ${this.tmpPath}`);
    }
    this.stream.write(JSON.stringify(event) + '\n');
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    return new Promise((resolve, reject) => {
      this.stream.end((err: Error | null | undefined) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}

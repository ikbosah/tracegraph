/**
 * M9A T9A.1 — SQLite database connection and initialisation
 *
 * Uses better-sqlite3 for synchronous, file-based SQLite storage.
 * Database path is resolved from the TRACEGRAPH_DATA_DIR env var or
 * defaults to `./data/tracegraph.db` relative to CWD.
 */
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { SCHEMA_SQL } from './schema';

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  const dataDir = process.env['TRACEGRAPH_DATA_DIR']
    ?? path.join(process.cwd(), 'data');

  fs.mkdirSync(dataDir, { recursive: true });

  const dbPath = path.join(dataDir, 'tracegraph.db');
  _db = new Database(dbPath);

  // Performance pragmas
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.pragma('synchronous = NORMAL');

  // Run schema migrations
  _db.exec(SCHEMA_SQL);

  return _db;
}

/** Close the database connection (for graceful shutdown). */
export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

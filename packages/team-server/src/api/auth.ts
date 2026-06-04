/**
 * M9A T9A.7 — Token authentication middleware
 *
 * Tokens are stored as bcrypt hashes in the `tokens` table.
 * CLI uses `TRACEGRAPH_TOKEN` env var or `tracegraph auth login`.
 *
 * Routes:
 *   POST /api/v1/auth/token   — issue a bearer token
 *   GET  /api/v1/auth/me      — validate token + return email
 */
import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/database';

const router = Router();

// ── POST /api/v1/auth/token ──────────────────────────────────────────────────

router.post('/token', async (req: Request, res: Response): Promise<void> => {
  const { email, password } = req.body as { email?: string; password?: string };

  if (!email || !password) {
    res.status(400).json({ error: 'email and password are required' });
    return;
  }

  const db = getDb();

  // Look up the admin password hash from server config
  const adminEmail    = process.env['TRACEGRAPH_ADMIN_EMAIL']    ?? 'admin@localhost';
  const adminPassword = process.env['TRACEGRAPH_ADMIN_PASSWORD'] ?? 'changeme';

  if (email !== adminEmail) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const passwordOk = await bcrypt.compare(password, adminPassword).catch(() => {
    // If the env var is not bcrypt-hashed, do a plain comparison (dev mode)
    return password === adminPassword;
  });

  if (!passwordOk) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  // Generate a random bearer token
  const rawToken   = uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '');
  const tokenHash  = await bcrypt.hash(rawToken, 10);
  const tokenId    = `tok_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
  const expiresAt  = Date.now() + 90 * 24 * 60 * 60 * 1000; // 90 days

  db.prepare(
    'INSERT INTO tokens (id, email, hash, expires_at) VALUES (?, ?, ?, ?)',
  ).run(tokenId, email, tokenHash, expiresAt);

  res.json({
    token:      rawToken,
    tokenId,
    email,
    expiresAt: new Date(expiresAt).toISOString(),
  });
});

// ── GET /api/v1/auth/me ───────────────────────────────────────────────────────

router.get('/me', requireAuth, (req: Request, res: Response): void => {
  res.json({ email: (req as AuthedRequest).tokenEmail });
});

// ─── Auth middleware ──────────────────────────────────────────────────────────

export interface AuthedRequest extends Request {
  tokenId:    string;
  tokenEmail: string;
}

/**
 * Middleware that validates the `Authorization: Bearer <token>` header.
 * Attaches `req.tokenId` and `req.tokenEmail` on success.
 */
export async function requireAuth(
  req:  Request,
  res:  Response,
  next: NextFunction,
): Promise<void> {
  const header = req.headers['authorization'];
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }

  const rawToken = header.slice(7);
  const db       = getDb();

  const rows = db.prepare(
    'SELECT id, email, hash, expires_at FROM tokens WHERE expires_at > ?',
  ).all(Date.now()) as Array<{ id: string; email: string; hash: string; expires_at: number }>;

  for (const row of rows) {
    const ok = await bcrypt.compare(rawToken, row.hash).catch(() => false);
    if (ok) {
      (req as AuthedRequest).tokenId    = row.id;
      (req as AuthedRequest).tokenEmail = row.email;
      next();
      return;
    }
  }

  res.status(401).json({ error: 'Invalid or expired token' });
}

export default router;

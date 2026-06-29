import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { db } from './db.js';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const JWT_EXPIRES_IN = '7d';

/** Build the public user object (never includes password_hash). */
function publicUser(row) {
  return { id: row.id, username: row.username, role: row.role };
}

/** Sign a JWT for a user row. Payload = {id, username, role}. */
function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

export const router = express.Router();

// POST /api/auth/register  {username, password} -> {token, user}
router.post('/register', (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  const existing = db.prepare(`SELECT id FROM users WHERE username = ?`).get(username);
  if (existing) {
    return res.status(409).json({ error: 'username already taken' });
  }

  const hash = bcrypt.hashSync(password, 10);
  const info = db
    .prepare(`INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'user')`)
    .run(username, hash);

  const row = db.prepare(`SELECT id, username, role FROM users WHERE id = ?`).get(info.lastInsertRowid);
  const user = publicUser(row);
  return res.status(201).json({ token: signToken(user), user });
});

// POST /api/auth/login  {username, password} -> {token, user} | 401
router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  const row = db
    .prepare(`SELECT id, username, role, password_hash FROM users WHERE username = ?`)
    .get(username);
  if (!row || !bcrypt.compareSync(password, row.password_hash)) {
    return res.status(401).json({ error: 'invalid credentials' });
  }

  const user = publicUser(row);
  return res.json({ token: signToken(user), user });
});

/**
 * authRequired — verifies the Bearer token and attaches req.user = {id, username, role}.
 * Responds 401 if the token is missing or invalid.
 */
export function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'missing or malformed Authorization header' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = { id: payload.id, username: payload.username, role: payload.role };
    return next();
  } catch {
    return res.status(401).json({ error: 'invalid or expired token' });
  }
}

/**
 * adminRequired — runs authRequired, then enforces role === 'admin' (else 403).
 */
export function adminRequired(req, res, next) {
  authRequired(req, res, () => {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'admin only' });
    }
    return next();
  });
}

export default router;

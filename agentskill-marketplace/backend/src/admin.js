// Admin router — manage tags / categories / groups, and group membership.
//
// Mounted at /api/admin (see app.js). EVERY route requires an admin user
// (adminRequired runs authRequired first, then enforces role === 'admin').

import express from 'express';

import { db } from './db.js';
import { adminRequired } from './auth.js';

export const router = express.Router();

// All admin routes are gated.
router.use(adminRequired);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validate a {name} body. Returns the trimmed name, or null (and sends a 400)
 * when the body is missing/blank.
 */
function requireName(req, res) {
  const name = req.body?.name;
  if (typeof name !== 'string' || !name.trim()) {
    res.status(400).json({ error: 'name must be a non-empty string' });
    return null;
  }
  return name.trim();
}

/**
 * Generic "create a master row with a UNIQUE name" handler.
 * Returns 201 {id, name}, or 409 when the name already exists.
 */
function createNamed(table, req, res) {
  const name = requireName(req, res);
  if (name === null) return;

  const existing = db.prepare(`SELECT id FROM ${table} WHERE name = ?`).get(name);
  if (existing) {
    return res.status(409).json({ error: `${table} name already exists` });
  }

  const info = db.prepare(`INSERT INTO ${table} (name) VALUES (?)`).run(name);
  return res.status(201).json({ id: info.lastInsertRowid, name });
}

/** Generic delete-by-id handler. Always {ok:true} (idempotent). */
function deleteById(table, req, res) {
  db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(req.params.id);
  return res.json({ ok: true });
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

// POST /tags  {name} -> 201 {id, name} | 409
router.post('/tags', (req, res) => createNamed('tags', req, res));

// DELETE /tags/:id -> {ok:true}
router.delete('/tags/:id', (req, res) => deleteById('tags', req, res));

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

// POST /categories  {name} -> 201 {id, name} | 409
router.post('/categories', (req, res) => createNamed('categories', req, res));

// DELETE /categories/:id -> {ok:true}
router.delete('/categories/:id', (req, res) => deleteById('categories', req, res));

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

// POST /groups  {name} -> 201 {id, name} | 409
router.post('/groups', (req, res) => createNamed('groups', req, res));

// DELETE /groups/:id -> {ok:true}  (user_groups / skill_groups rows cascade)
router.delete('/groups/:id', (req, res) => deleteById('groups', req, res));

// GET /groups -> { groups: [{id, name, members:[{id, username}]}] }
router.get('/groups', (_req, res) => {
  const groups = db.prepare(`SELECT id, name FROM groups ORDER BY name`).all();
  const memberStmt = db.prepare(
    `SELECT u.id AS id, u.username AS username
       FROM user_groups ug
       JOIN users u ON u.id = ug.user_id
      WHERE ug.group_id = ?
      ORDER BY u.username`
  );
  const withMembers = groups.map((g) => ({
    id: g.id,
    name: g.name,
    members: memberStmt.all(g.id),
  }));
  res.json({ groups: withMembers });
});

// ---------------------------------------------------------------------------
// Users (for member management)
// ---------------------------------------------------------------------------

// GET /users -> { users: [{id, username, role}] }
router.get('/users', (_req, res) => {
  const users = db
    .prepare(`SELECT id, username, role FROM users ORDER BY username`)
    .all();
  res.json({ users });
});

// ---------------------------------------------------------------------------
// Group membership
// ---------------------------------------------------------------------------

// POST /groups/:id/members  {user_id} -> {ok:true} | 404
router.post('/groups/:id/members', (req, res) => {
  const groupId = Number(req.params.id);
  const userId = req.body?.user_id;

  if (!Number.isInteger(userId)) {
    return res.status(400).json({ error: 'user_id must be an integer' });
  }

  const group = db.prepare(`SELECT id FROM groups WHERE id = ?`).get(groupId);
  if (!group) return res.status(404).json({ error: 'group not found' });

  const user = db.prepare(`SELECT id FROM users WHERE id = ?`).get(userId);
  if (!user) return res.status(404).json({ error: 'user not found' });

  // Ignore duplicate membership.
  db.prepare(
    `INSERT OR IGNORE INTO user_groups (user_id, group_id) VALUES (?, ?)`
  ).run(userId, groupId);

  res.json({ ok: true });
});

// DELETE /groups/:id/members/:user_id -> {ok:true}  (idempotent)
router.delete('/groups/:id/members/:user_id', (req, res) => {
  db.prepare(
    `DELETE FROM user_groups WHERE group_id = ? AND user_id = ?`
  ).run(req.params.id, req.params.user_id);
  res.json({ ok: true });
});

export default router;

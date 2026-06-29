// Meta router — master lists of tags, categories, and groups.
//
// Mounted at /api (see app.js) so routes resolve to /api/tags,
// /api/categories and /api/groups. All require auth. Lists are ordered by
// name. /groups here is read-only and NOT admin-gated — skill owners use it
// to pick groups to share a private skill with (admin group management lives
// under /api/admin/groups).

import express from 'express';

import { db } from './db.js';
import { authRequired } from './auth.js';

export const router = express.Router();

// GET /tags -> { tags: [{id, name}] }
router.get('/tags', authRequired, (_req, res) => {
  const tags = db.prepare(`SELECT id, name FROM tags ORDER BY name`).all();
  res.json({ tags });
});

// GET /categories -> { categories: [{id, name}] }
router.get('/categories', authRequired, (_req, res) => {
  const categories = db
    .prepare(`SELECT id, name FROM categories ORDER BY name`)
    .all();
  res.json({ categories });
});

// GET /groups -> { groups: [{id, name}] }
// Read-only list for owners to pick groups when sharing a private skill.
router.get('/groups', authRequired, (_req, res) => {
  const groups = db.prepare(`SELECT id, name FROM groups ORDER BY name`).all();
  res.json({ groups });
});

export default router;

// Meta router — master lists of tags and categories.
//
// Mounted at /api (see app.js) so routes resolve to /api/tags and
// /api/categories. Both require auth. Lists are ordered by name.

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

export default router;

// Stats + recommendations router — charts (§4) and content-based recommend (§6).
//
// Mounted at /api (see app.js) so routes resolve to /api/stats/... and
// /api/recommendations. EVERY route requires auth and is computed over
// getVisibleSkillRows(req.user) — so private skills the viewer can't see are
// never counted, charted, or recommended.

import express from 'express';

import { db } from './db.js';
import { authRequired } from './auth.js';
import { getVisibleSkillRows, skillSummary } from './skills.js';

export const router = express.Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** date(created_at) -> "YYYY-MM-DD". created_at is a SQLite datetime string
 *  like "2026-06-29 12:34:56"; take the date portion (split on space/T). */
function dateOf(createdAt) {
  if (typeof createdAt !== 'string') return '';
  return createdAt.split(/[ T]/)[0];
}

/** Round to 1 decimal place (numeric). */
function pct(count, total) {
  if (!total) return 0;
  return Math.round((count / total) * 1000) / 10;
}

/** Tag ids attached to a skill (array of ints). */
function tagIdsOf(skillId) {
  return db
    .prepare(`SELECT tag_id FROM skill_tags WHERE skill_id = ?`)
    .all(skillId)
    .map((r) => r.tag_id);
}

/** Tag name for a tag id (or the id stringified if it vanished). */
function tagName(tagId) {
  return db.prepare(`SELECT name FROM tags WHERE id = ?`).get(tagId)?.name ?? String(tagId);
}

/** Category name for a category id, or "Uncategorized" when null/missing. */
function categoryName(categoryId) {
  if (categoryId == null) return 'Uncategorized';
  return db.prepare(`SELECT name FROM categories WHERE id = ?`).get(categoryId)?.name ?? 'Uncategorized';
}

/** Number of stars on a skill. */
function starCountOf(skillId) {
  return db.prepare(`SELECT COUNT(*) AS n FROM stars WHERE skill_id = ?`).get(skillId).n;
}

// ---------------------------------------------------------------------------
// GET /stats/uploads-over-time
//   -> { points: [{ date:"YYYY-MM-DD", count, cumulative }] }
//
// Visible skills grouped by date(created_at), ascending, with a running
// cumulative lifetime total.
// ---------------------------------------------------------------------------
router.get('/stats/uploads-over-time', authRequired, (req, res) => {
  const rows = getVisibleSkillRows(req.user);

  const byDate = new Map();
  for (const row of rows) {
    const d = dateOf(row.created_at);
    byDate.set(d, (byDate.get(d) || 0) + 1);
  }

  const dates = [...byDate.keys()].sort(); // ascending YYYY-MM-DD
  let cumulative = 0;
  const points = dates.map((date) => {
    const count = byDate.get(date);
    cumulative += count;
    return { date, count, cumulative };
  });

  res.json({ points });
});

// ---------------------------------------------------------------------------
// GET /stats/recent  -> { skills: [summary] }
//   The 5 most-recently-created visible skills.
// ---------------------------------------------------------------------------
router.get('/stats/recent', authRequired, (req, res) => {
  // getVisibleSkillRows already returns newest-first.
  const rows = getVisibleSkillRows(req.user).slice(0, 5);
  res.json({ skills: rows.map((row) => skillSummary(row, req.user.id)) });
});

// ---------------------------------------------------------------------------
// GET /stats/by-category
//   -> { data: [{ category, count, pct }] }
//   Count of visible skills per category name (null -> "Uncategorized");
//   pct = count / total * 100, rounded to 1 decimal. Descending by count.
// ---------------------------------------------------------------------------
router.get('/stats/by-category', authRequired, (req, res) => {
  const rows = getVisibleSkillRows(req.user);
  const total = rows.length;

  const counts = new Map();
  for (const row of rows) {
    const name = categoryName(row.category_id);
    counts.set(name, (counts.get(name) || 0) + 1);
  }

  const data = [...counts.entries()]
    .map(([category, count]) => ({ category, count, pct: pct(count, total) }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));

  res.json({ data });
});

// ---------------------------------------------------------------------------
// GET /stats/top-tags  -> { data: [{ tag, count }] }
//   Top 10 tags by number of visible skills carrying them, descending.
// ---------------------------------------------------------------------------
router.get('/stats/top-tags', authRequired, (req, res) => {
  const rows = getVisibleSkillRows(req.user);

  const counts = new Map(); // tag_id -> count of visible skills
  for (const row of rows) {
    for (const tid of tagIdsOf(row.id)) {
      counts.set(tid, (counts.get(tid) || 0) + 1);
    }
  }

  const data = [...counts.entries()]
    .map(([tagId, count]) => ({ tag: tagName(tagId), count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    .slice(0, 10);

  res.json({ data });
});

// ---------------------------------------------------------------------------
// GET /stats/internal-external
//   -> { data: [{ type, count, pct }] }
//   Counts for 'internal' vs 'external' over visible skills, with pct.
//   Both types are always present (count 0 when none).
// ---------------------------------------------------------------------------
router.get('/stats/internal-external', authRequired, (req, res) => {
  const rows = getVisibleSkillRows(req.user);
  const total = rows.length;

  const counts = { internal: 0, external: 0 };
  for (const row of rows) {
    if (row.type === 'internal' || row.type === 'external') counts[row.type] += 1;
  }

  const data = ['internal', 'external'].map((type) => ({
    type,
    count: counts[type],
    pct: pct(counts[type], total),
  }));

  res.json({ data });
});

// ---------------------------------------------------------------------------
// GET /recommendations  -> { skills: [summary] }
//
// Content-based (spec §6). From the user's starred skills, collect their
// category_ids + tag_ids. Score each VISIBLE, NON-starred skill by overlap:
//   shared category  => +1
//   each shared tag   => +1
// Return the top 6 by score desc; ties broken by more stars, then newer.
//
// Fallback: if the user has no stars, or no candidate scores > 0, return the
// most-starred visible non-starred skills (tie-break: newer). Always excludes
// skills the user already starred and skills they can't see.
// ---------------------------------------------------------------------------
router.get('/recommendations', authRequired, (req, res) => {
  const userId = req.user.id;
  const visible = getVisibleSkillRows(req.user); // newest-first

  // Skills the user has starred.
  const starredIds = new Set(
    db.prepare(`SELECT skill_id FROM stars WHERE user_id = ?`).all(userId).map((r) => r.skill_id)
  );

  // Candidate pool: visible AND not already starred.
  const candidates = visible.filter((row) => !starredIds.has(row.id));

  // Profile: categories + tags from the user's starred skills.
  const likedCategories = new Set();
  const likedTags = new Set();
  for (const row of visible) {
    if (!starredIds.has(row.id)) continue;
    if (row.category_id != null) likedCategories.add(row.category_id);
    for (const tid of tagIdsOf(row.id)) likedTags.add(tid);
  }

  // Pre-compute stars + index for stable tie-breaks. `visible` is newest-first,
  // so a smaller index == newer.
  const starsById = new Map();
  const orderById = new Map();
  visible.forEach((row, i) => {
    starsById.set(row.id, starCountOf(row.id));
    orderById.set(row.id, i);
  });

  const hasProfile = likedCategories.size > 0 || likedTags.size > 0;

  let ranked = [];
  if (hasProfile) {
    const scored = candidates.map((row) => {
      let score = 0;
      if (row.category_id != null && likedCategories.has(row.category_id)) score += 1;
      for (const tid of tagIdsOf(row.id)) if (likedTags.has(tid)) score += 1;
      return { row, score };
    }).filter((c) => c.score > 0);

    scored.sort(
      (a, b) =>
        b.score - a.score ||
        starsById.get(b.row.id) - starsById.get(a.row.id) || // more stars first
        orderById.get(a.row.id) - orderById.get(b.row.id)     // newer first
    );
    ranked = scored.map((c) => c.row);
  }

  // Fallback: no profile or no positive-score matches -> most-starred candidates.
  if (ranked.length === 0) {
    ranked = [...candidates].sort(
      (a, b) =>
        starsById.get(b.id) - starsById.get(a.id) || // more stars first
        orderById.get(a.id) - orderById.get(b.id)     // newer first
    );
  }

  const top = ranked.slice(0, 6);
  res.json({ skills: top.map((row) => skillSummary(row, userId)) });
});

export default router;

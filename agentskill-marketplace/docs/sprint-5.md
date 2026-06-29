# Sprint 5 — Charts + Recommend ✅

**Goal:** Timeline dashboard (5 charts), content-based recommendations, and the recommended zone on the marketplace.
**Status:** Complete & verified. **77/77 backend tests pass**, frontend builds, all stats + recommendation endpoints verified live.

## What was built

### Backend — by *bob*
- `src/skills.js` — exported `skillSummary(row, userId)` and new `getVisibleSkillRows(user)` (factored out the visibility filter; `GET /` now uses it — no behavior change).
- `src/stats.js` (new, all routes `authRequired`, computed over the **viewer-visible** skill set):
  - `GET /api/stats/uploads-over-time` → `{points:[{date,count,cumulative}]}`.
  - `GET /api/stats/recent` → `{skills}` (5 newest).
  - `GET /api/stats/by-category` → `{data:[{category,count,pct}]}` (null → "Uncategorized").
  - `GET /api/stats/top-tags` → `{data:[{tag,count}]}` (top 10).
  - `GET /api/stats/internal-external` → `{data:[{type,count,pct}]}` (both rows always present).
  - `GET /api/recommendations` → `{skills}` — §6 content-based: profile = categories+tags of starred skills; score visible non-starred candidates (shared category +1, each shared tag +1); top 6; fallback = most-starred when no taste profile.
- `src/app.js` — mounts stats router at `/api`.

### Frontend — by *jack*
- `Timeline.jsx` — 5 Recharts charts (uploads line↔bar toggle + cumulative, recent-5 list, by-category pie %, top-10 tags horizontal bar, internal/external pie colored red/black). `ResponsiveContainer`, loading/empty states.
- `Marketplace.jsx` — **Recommended** zone above the list (hidden when empty), horizontal scroll of recommended cards.
- `SkillCard.jsx` (new) — extracted shared card (border, ⭐ toggle, click→detail) used by both the recommended zone and the all-skills grid; star state synced across both.

### Tests — by *john*
- `tests/stats.test.js` — 14 tests: all 5 stats shapes (+ cumulative monotonic, numeric pct), data-reflection, recommendation §6 (shares-tag recommended, starred excluded, invisible private not leaked), auth 401.

## Verified live end-to-end (PORT 4107)
2 internal skills (one starred with category+tag, one sharing the tag):
- by-category → `data 50% / Uncategorized 50%`; top-tags → `ai ×2`; internal-external → `internal 100%`; uploads-over-time → `count 2, cumulative 2`; recent → 2 skills.
- recommendations → returns the shared-tag skill, **excludes** the starred one. ✓
- stats without a token → 401. ✓
- 77/77 tests pass; frontend build OK (recharts pushes the bundle >500 KB — a dev-only size warning, acceptable for local).

## Next → Sprint 6: Polish + Verify
Final pass: richer seed data (sample skills/tags/categories/group), full end-to-end wiring check (both servers up together), README/run docs, any remaining bug fixes.

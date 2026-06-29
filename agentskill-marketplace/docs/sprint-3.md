# Sprint 3 — Browse + Detail ✅

**Goal:** Marketplace filters (tag/category/⭐) + star toggle; skill detail page with file viewer, folder download, and owner/admin edit (file content, tags, category, visibility).
**Status:** Complete & verified end-to-end. **53/53 backend tests pass**, frontend builds, all new routes verified live.

## What was built

### Backend — by *bob*
- `src/skills.js`:
  - `skillSummary(row, userId)` now includes `starred` (per-viewer) + `starCount`.
  - `GET /` filters: `?tag=<name>`, `?category=<name>`, `?starred=true` (AND-combined, applied after visibility).
  - `POST /:id/star` — toggle → `{starred, starCount}`.
  - `GET /:id/file?path=` — file content (visibility + path-traversal safe).
  - `GET /:id/download` — `archiver` zip stream of the folder.
  - `PATCH /:id` (owner/admin) — `{name?, category_id?, tag_ids?, visibility?}` with validation.
  - `PUT /:id/file` (owner/admin) — save file content (must exist; traversal-safe).
- `src/storage.js` — added `safeJoin` + `writeSkillFile`.
- `src/meta.js` (new) — `GET /api/tags`, `GET /api/categories` (`{id,name}` lists).

### Frontend — by *jack*
- `Marketplace.jsx` — tag + category filter chips (click to filter, click again to clear; AND), starred-only toggle, ⭐ star button per card (stopPropagation), red/black borders, click → detail.
- `SkillPage.jsx` — metadata + file tree + file viewer; **download-with-auth** (fetch+blob+objectURL, since `<a href>` can't send the Bearer token); owner/admin edit mode (textarea→`PUT /file`, tag/category/visibility→`PATCH`).
- New components `FileViewer.jsx`, `SkillEditPanel.jsx`; CSS for chips/star/file-browser/edit panel.

### Tests — by *john*
- `tests/skills.test.js` — 11 integration tests: star toggle + per-user isolation, tag/category filters, edit permission (owner 200 / non-owner 403 / admin 200), file GET/PUT (+403), download is zip. Builds in-memory zips with adm-zip.

## Issues found & resolved (lead)
1. **Contract drift — `tags` vs `tag_ids`.** Spec §5 said `tags`; bob/jack both implemented `tag_ids` (per task prompts), so the running system is consistent — but a spec-following client would have its tags **silently ignored** (PATCH returned 200, no change). **Resolved:** updated spec §5 to `tag_ids` (source of truth now matches code). john's test guards against the silent-ignore by asserting the tag is actually attached.
2. **Verification harness gotcha (not app code):** `pkill -f "node src/server.js"` inside a test script *also matches the shell running that script* (its argv contains the string), so it killed itself → "exit 1, no output". Fixed by dropping pkill and tracking the server PID via `$!` + unique ports.

## Verified end-to-end (PORT 4105)
- PATCH set `tags:["ai"]`, `category:"data"`, `visibility:"private"` ✓
- star toggle → `{starred:true,starCount:1}` then `{starred:false,starCount:0}` ✓
- PUT file then GET → content updated ✓
- download → valid zip (`SKILL.md` + `sub/notes.txt`, 357 bytes) ✓
- Frontend production build OK (185 KB).

## Next → Sprint 4: Groups + Visibility + Admin
groups M:N + admin page (create/delete tags/categories/groups, add members), per-skill private + group assignment, full visibility wiring.

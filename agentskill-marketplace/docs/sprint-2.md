# Sprint 2 — Upload + Storage ✅

**Goal:** Upload skills (internal `.zip` + external GitHub clone with `SKILL.md` traversal), store folders on disk, expose skills read API, basic marketplace list + upload UI.
**Status:** Complete & verified end-to-end. **42/42 backend tests pass**, frontend builds, internal & external uploads work against real data.

## What was built

### Backend — by *bob*
- `src/storage.js` — `storeSkillFolder(id, srcDir)` (copies into `storage/skills/<id>/`), `buildFileTree(dir)` (relative POSIX paths + sizes), `readSkillFile(dir, relPath)` (path-traversal-safe), `copyDir`.
- `src/github.js` — `cloneRepo(url)` (validates http(s) github.com, `git clone --depth 1` to temp, 60s timeout), `cleanup`, `isGithubUrl`.
- `src/skills.js` — router mounted at `/api/skills`:
  - `GET /` — lists skills visible to the viewer (per-row `canSee`).
  - `GET /:id` — detail + file tree (404 missing / 403 not-visible).
  - `POST /internal` — multipart `file` zip → extract (adm-zip) → find `SKILL.md` → store → DB row.
  - `POST /external` — `{url}` → clone → `findSkillFolders` → one skill per folder.
- `src/app.js` — mounts the skills router.

### Detection logic — by *john*
- `src/skill-detect.js` — `folderHasSkillMd(dir)`, `findSkillFolders(rootDir)` (recursive, skips `.git`/`node_modules`), `pickSkillName(dir)` (SKILL.md frontmatter `name:` else basename, minimal regex parser).
- `tests/skill-detect.test.js` — 17 tests (0/1/3-folder trees, case-insensitivity, frontmatter name + fallbacks).

### Frontend — by *jack*
- `src/components/UploadModal.jsx` — two tabs: Internal (`.zip` multipart) + External (GitHub URL JSON). Loading/success/error states; `onUploaded()` refresh callback.
- `src/pages/Marketplace.jsx` — fetches `/api/skills`, renders card grid (name, type badge, owner, category, tags). **Border red=internal / black=external.** Click → `/skills/:id`. Upload button opens the modal.
- `src/index.css` — grid/card/modal styles.

## Integration bug found & resolved (lead)
The first e2e run hit a **stale Sprint-1 server** still bound to `:4000` (from earlier testing) — it answered `/health` & `/login` but 404'd the new skill routes, looking like a mount bug. Root cause was a leftover process, not code. Killed it, re-ran on a clean port. The skills router code was correct. (No code change needed; noted here so future runs `pkill -f "node src/server.js"` or use a fresh port.)

## Verified end-to-end (PORT 4100/4101)
- Internal: uploaded `my-cool-skill.zip` → `201` skill "My Cool Skill" (name pulled from `SKILL.md` frontmatter); files stored at `storage/skills/1/SKILL.md` + `sub/notes.txt`; `GET /skills/1` returns the recursive file tree.
- External (real clones):
  - `github.com/anthropics/skills` → **18 skills created** (algorithmic-art, brand-guidelines, canvas-design, …).
  - `github.com/obra/superpowers` → **14 skills created** (brainstorming, dispatching-parallel-agents, …).
  - `github.com/octocat/Hello-World` → `400 no SKILL.md found` (clone works, correctly no skills).
  - bad URL (gitlab) → `400 invalid url`.
- Frontend production build OK (44 modules).

## Next → Sprint 3: Browse + Detail
marketplace filters (tag/category/⭐) + star/like, skill page (file viewer, download `.zip`, owner/admin edit).

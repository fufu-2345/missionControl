# Sprint 6 — Polish + Verify ✅ (FINAL)

**Goal:** Sample seed data, run docs, self-sufficient test setup, and a full both-servers-up end-to-end verification.
**Status:** Complete. **82/82 backend tests pass from a clean DB**, both servers run together, the Vite→backend proxy works end-to-end.

## What was built

### Seed data — by *bob* (`src/seed.js`)
6 sample skills with real on-disk folders (SKILL.md + extra files, so download/viewer work): Hello CLI, CSV Formatter, JSON Pretty Printer, Git Cleanup Helper, AI Prompt Toolkit (external), Repo Stats Reporter (**external, private**, shared with `internal-team`; alice added to the group). Categories + tags assigned, 6 stars sprinkled. Idempotent (guards on skill count).

### Docs + polish — by *jack*
- `README.md` — overview, features (5 pages + groups/visibility/recommendations), stack, **run commands**, seed credentials (`admin/admin123`, `alice/alice123`), API overview, project tree.
- UI polish: active nav-link highlight (`NavLink` + `.nav-link-active`), filter-aware empty-state copy.

### Integration test — by *john* (`tests/integration.test.js`)
One ordered cross-cutting happy path (5 steps): register→upload→PATCH category/tag→star→stats reflect→recommendations (shared-tag in, starred out)→edit file + download zip→group visibility flip. 5 tests.

### Lead fix — self-sufficient tests
john found `npm test` failed on a clean DB (suites depend on seed users/tags). **Fix:** added `"pretest": "node src/seed.js"` (and a `seed` script) to `backend/package.json`, so `npm test` seeds first. Verified: from a deleted DB, `npm test` → seeds → **82/82 pass**.

## Final end-to-end verification (both servers live)
- Backend `:4000` + Vite dev `:5173` started together.
- `:5173/` serves the SPA (`id="root"`).
- **`:5173/api/health` → `{ok:true}`** — the Vite `/api`→`:4000` proxy works.
- Admin login through the proxy → `role:admin`.
- All **6 seeded skills** visible to admin (incl. the private one).
- `npm test` (clean DB) → **82/82 across 7 files**; frontend `npm run build` OK.

## Project complete — all 6 sprints ✅
1. Foundation + Auth · 2. Upload + Storage · 3. Browse + Detail · 4. Groups + Visibility + Admin · 5. Charts + Recommend · 6. Polish + Verify.

Run: `cd backend && npm install && npm run dev` + `cd frontend && npm install && npm run dev` → http://localhost:5173 (login `admin`/`admin123`).

# Sprint 1 — Foundation + Auth ✅

**Goal:** Scaffold backend + frontend, DB schema + seed, local register/login with JWT, app layout & routing.
**Status:** Complete & verified. **25/25 backend tests pass**, frontend builds, login works end-to-end.

## What was built

### Backend (`backend/`) — by *bob*
- `package.json` — Express + better-sqlite3 + bcryptjs + jsonwebtoken + multer + adm-zip + archiver + cors (vitest/supertest dev).
- `src/db.js` — better-sqlite3 at `backend/db.sqlite`; **all 9 tables** from spec §3 created (`CREATE TABLE IF NOT EXISTS`, FKs ON, WAL). Schema is fully laid out now so later sprints just use it.
- `src/seed.js` — idempotent seed: **admin / admin123** (role admin), **alice / alice123** (role user), categories `[utility, data, devtools]`, tags `[cli, ai, format, git]`, group `internal-team`.
- `src/auth.js` — `POST /api/auth/register` (201) + `POST /api/auth/login` (200/401); `authRequired` & `adminRequired` middleware (exported for later sprints).
- `src/app.js` — configured Express app (`cors`, `json`, `/api/auth`, `GET /api/health`), exported for tests; `src/server.js` boots it on **:4000**.

### Tests + logic (`backend/`) — by *john*
- `src/visibility.js` — pure `canSee({user, skill, userGroupIds, skillGroupIds})` resolver (spec §2). **Used to wire visibility in Sprint 4.**
- `tests/visibility.test.js` — 19 unit tests (all branches: public/private × owner/admin/group-member/non-member/anonymous).
- `tests/auth.test.js` — 6 supertest integration tests (health, register, duplicate, login ok/wrong-pw/unknown-user).

### Frontend (`frontend/`) — by *jack*
- React + Vite + React Router. `vite.config.js` proxies `/api` → `:4000`.
- `src/auth/AuthContext.jsx` (`useAuth`, token in localStorage, `isAdmin`), `src/api/client.js` (`apiFetch` with Bearer header), `src/components/Layout.jsx` + `ProtectedRoute`/`AdminRoute`.
- `src/App.jsx` routes: `/login`, `/marketplace`, `/skills/:id`, `/timeline`, `/admin` (admin-gated). `src/pages/Login.jsx` (login/register toggle); Marketplace/Skill/Timeline/Admin are placeholder stubs for now.

## Bug found & fixed (lead integration)
`db.js` created tables only inside `initDb()`, which `server.js` called but `app.js` did not — so test/import paths hit a DB with no `users` table → **500 instead of 401** on 5 auth tests. **Fix:** `db.js` now calls `initDb()` on module load (idempotent), so every importer (server, tests, scripts) gets a ready schema. All 25 tests green afterward.

## How to run
```bash
# backend
cd agentskill-marketplace/backend && npm install && npm run dev   # http://localhost:4000
# frontend (separate terminal)
cd agentskill-marketplace/frontend && npm install && npm run dev  # http://localhost:5173
# tests
cd agentskill-marketplace/backend && npm test
```
Login with **admin / admin123** or **alice / alice123**, or register a new account.

## Verified
- `GET /api/health` → `{ok:true}` · register → token+user · login admin → token+user(role admin) · wrong pw → 401 · frontend production build OK.

## Next → Sprint 2: Upload + Storage
internal (`.zip`) + external (GitHub clone + `SKILL.md` traversal) upload, on-disk folder storage, skills read API.

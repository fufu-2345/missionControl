# agentSkill Marketplace — Design Spec

**Date:** 2026-06-29
**Source requirement:** `req.md`
**Location:** `soulbrew/agentskill-marketplace/`
**Branch:** `feat/agentskill-marketplace`

A web platform where users upload "skills" (folders of `.md` + files) and others browse, view, and download them.

---

## 1. Stack

| Layer | Choice |
|---|---|
| Frontend | React + Vite + React Router + Recharts |
| Backend | Node + Express |
| DB | SQLite (`better-sqlite3`) — file-based |
| Auth | bcrypt password hash + JWT |
| File storage | Skill folders on disk: `backend/storage/skills/<skillId>/` |
| Upload (internal) | `.zip` of a folder → unzip (`adm-zip`), must contain `SKILL.md`/`skill.md` |
| Upload (external) | `git clone` repo server-side → traverse for folders containing `SKILL.md`/`skill.md` (case-insensitive); each such folder = 1 skill |
| Download | zip the whole skill folder on the fly (`archiver`) |

Backend deps: `express`, `better-sqlite3`, `bcryptjs`, `jsonwebtoken`, `multer`, `adm-zip`, `archiver`, `cors`. Dev: `vitest`, `supertest`.
Frontend deps: `react`, `react-dom`, `react-router-dom`, `recharts`. Dev: `vite`, `@vitejs/plugin-react`.

**Agents: do NOT run `npm install`** — only create source + `package.json`. The lead installs & verifies during integration.

---

## 2. Roles & Visibility

- **Roles:** `user`, `admin`.
- **Groups:** many-to-many with users. Default: user has no group.
- **Skill visibility rule** — a viewer U can see skill S if ANY of:
  1. `S.visibility = 'public'`, OR
  2. U is the owner (`S.owner_id = U.id`), OR
  3. U is `admin`, OR
  4. `S.visibility = 'private'` AND U belongs to a group linked to S (`skill_groups` ∩ `user_groups`).

---

## 3. Data Model (SQLite)

```
users(id, username UNIQUE, password_hash, role TEXT 'user'|'admin', created_at)
groups(id, name UNIQUE, created_at)
user_groups(user_id, group_id)                  -- M:N
categories(id, name UNIQUE)
tags(id, name UNIQUE)
skills(id, name, owner_id, type 'internal'|'external', category_id NULLABLE,
       visibility 'public'|'private' DEFAULT 'public', source_url NULLABLE,
       folder_path, created_at)
skill_tags(skill_id, tag_id)                     -- M:N
skill_groups(skill_id, group_id)                 -- groups that can see a private skill
stars(user_id, skill_id, created_at)             -- like/favorite
```

- 1 category per skill (`category_id`); multiple tags via `skill_tags`.
- Tags/categories master list is **admin-managed**; owners only attach existing ones to their own skills.

---

## 4. Pages (5)

1. **`/login`** — register + login (local, bcrypt+JWT). Toggle register/login.
2. **`/marketplace`** —
   - Zone A **Recommended** (content-based on the user's starred skills).
   - Zone B **All skills** — card grid. Card = auto-generated (icon + color by category), **border red=internal / black=external**, shows name, tags, category, ⭐ toggle (top-right).
   - Filter chips: tag / category / ⭐-only. Click chip to filter (only exact matches), click again to clear.
   - **Upload** button → modal: (a) internal: upload `.zip`; (b) external: paste GitHub URL.
   - Click a card → `/skills/:id`.
3. **`/skills/:id`** — file tree of the skill folder; click a file → view content; **Download** (whole folder as `.zip`, no per-file). If viewer is owner or admin → edit mode: edit file content, add/remove tags, change category, set public/private + attach groups.
4. **`/timeline`** — 5 charts (Recharts):
   1. Skill uploads over time — line chart (toggle to bar); daily count + cumulative lifetime.
   2. Recent uploads — 5 latest skills.
   3. Skill distribution by category — pie + %.
   4. Top tags — top 10 tags by skill count.
   5. Internal vs external ratio — pie + %.
5. **`/admin`** (admin only) — manage tags / categories / groups (create + delete); add members to groups.

---

## 5. API Surface (REST, prefix `/api`)

```
POST   /auth/register            {username,password}            -> {token,user}
POST   /auth/login               {username,password}            -> {token,user}

GET    /skills        ?tag=&category=&starred=true              -> visible skills for current user
GET    /skills/:id                                              -> detail + file tree
GET    /skills/:id/file?path=                                   -> file content (text)
GET    /skills/:id/download                                     -> zip stream
POST   /skills/internal          multipart: zip                 -> created skill
POST   /skills/external          {url}                          -> created skill(s)
PATCH  /skills/:id               {name?,category_id?,tags?,visibility?,groups?,files?}  (owner/admin)
POST   /skills/:id/star          toggle                         -> {starred}

GET    /recommendations                                         -> recommended skills
GET    /tags          GET /categories                           -> master lists
GET    /groups                                                  (auth)

-- admin only --
POST   /admin/tags  DELETE /admin/tags/:id
POST   /admin/categories  DELETE /admin/categories/:id
POST   /admin/groups  DELETE /admin/groups/:id
POST   /admin/groups/:id/members  {user_id}    DELETE /admin/groups/:id/members/:user_id

-- charts --
GET    /stats/uploads-over-time   /stats/recent   /stats/by-category
GET    /stats/top-tags            /stats/internal-external
```

JWT in `Authorization: Bearer <token>`. Auth middleware attaches `req.user`. Visibility enforced server-side on every skill read.

---

## 6. Recommendation (simple, content-based)

From the user's starred skills, collect their categories+tags. Score every visible non-starred skill by overlap count (shared category + shared tags). Return top N by score (fallback: most-starred overall if user has no stars).

---

## 7. Sprint Plan (each ends with `agentskill-marketplace/docs/sprint-N.md`)

| Sprint | Deliverable | bob (backend) | jack (frontend) | john (logic/tests) |
|---|---|---|---|---|
| 1 Foundation+Auth | scaffold, DB schema+seed, register/login+JWT, layout/routing | Express app, DB init+schema+seed, /auth, JWT mw | Vite+Router scaffold, layout, login/register page, auth context, api client | auth + visibility-resolver unit tests |
| 2 Upload+Storage | internal(zip)+external(clone/traversal), disk storage, skills CRUD-read | storage + external clone/traversal + /skills, /skills/internal, /skills/external | upload modal (internal/external) | traversal + zip handling tests |
| 3 Browse+Detail | marketplace grid+filter+⭐, skill page (tree/viewer/download/edit) | /skills/:id, /file, /download, PATCH, /star | marketplace grid+filters+card, skill page+viewer+edit | star + edit-permission tests |
| 4 Groups+Visibility+Admin | groups M:N, visibility, admin page, per-skill private+groups | /groups, /admin/*, visibility wiring | admin page, skill visibility+group UI | visibility matrix tests |
| 5 Charts+Recommend | 5 charts + recommendation + recommended zone | /stats/*, /recommendations | timeline charts, recommended zone | recommendation scoring tests |
| 6 Polish+Verify | full test pass, seed data, bug fixes, end-to-end wiring | — whole team — | | |

**Seed data:** 1 admin, 1 sample user, a few sample skills, some tags/categories, 1 group.

**Testing:** logic-focused (auth, visibility resolver, github traversal, zip, recommendation scoring) with `vitest`. Skip heavy UI tests.

---

## 8. Out of Scope (YAGNI)

No cloud deploy (local dev only), no private-repo tokens for external upload (public repos only), no per-file download, no email/social login, no real-time, no pagination beyond basic limits.

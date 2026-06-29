# agentSkill Marketplace

A web platform where users upload **agentSkills** — folders of `.md` and supporting files — and others browse, view, star, and download them. Skills come from two sources: **internal** uploads (a `.zip` of a folder containing a `SKILL.md`) and **external** imports (a public GitHub repo cloned server-side, where every folder containing a `SKILL.md` becomes one skill). Visibility is controlled per skill (public or private-to-groups), and a lightweight content-based recommender surfaces skills similar to the ones you've starred.

## Features

The app is organised around five pages, plus cross-cutting groups, visibility, and recommendation logic:

- **Login / Register** (`/login`) — local accounts with bcrypt-hashed passwords and JWT sessions; one form toggles between sign-in and registration.
- **Marketplace + Upload** (`/marketplace`) — a card grid of every skill you're allowed to see. Cards are auto-styled (icon and colour by category) with a **red border for internal** and **black border for external** skills, and a ⭐ toggle. Filter chips for tag, category, and "starred only". An **Upload** button opens a modal for either an internal `.zip` or an external GitHub URL.
- **Skill detail + download + edit** (`/skills/:id`) — a file tree of the skill folder; click a file to view its contents; **Download** the whole folder as a `.zip`. Owners and admins get an edit mode: edit file contents, change category, attach/detach tags, and set public/private visibility with group access.
- **Timeline charts** (`/timeline`) — five Recharts visualisations: uploads over time (line/bar toggle, daily + cumulative), 5 most recent uploads, skill distribution by category (pie), top 10 tags, and internal-vs-external ratio (pie).
- **Admin** (`/admin`, admin only) — manage the master lists of tags, categories, and groups (create / delete) and add or remove group members.

Cross-cutting:

- **Groups** — many-to-many between users and groups; used to grant access to private skills.
- **Visibility** — a viewer can see a skill if it is public, OR they own it, OR they are an admin, OR it is private and they belong to a group linked to that skill. Enforced server-side on every skill read.
- **Recommendations** — content-based: from your starred skills' categories and tags, every visible non-starred skill is scored by overlap and the top matches are returned (falls back to most-starred overall when you have no stars).

## Tech Stack

| Layer | Choice |
|---|---|
| Frontend | React + Vite + React Router + Recharts |
| Backend | Node + Express |
| Database | SQLite via `better-sqlite3` (single file) |
| Auth | bcrypt password hashing + JWT (`Authorization: Bearer <token>`) |
| File storage | Skill folders on disk under `backend/storage/skills/<skillId>/` |
| Internal upload | `.zip` → unzipped with `adm-zip`; must contain a `SKILL.md` |
| External import | `git clone` of a public repo, traversed for folders containing `SKILL.md` |
| Download | skill folder zipped on the fly with `archiver` |

## How to Run

Two processes — backend (port **4000**) and frontend (port **5173**). The Vite dev server proxies `/api` to the backend, so run both.

**Backend** (API + SQLite + auto-seed on startup):

```bash
cd backend
npm install
npm run dev          # serves http://localhost:4000
```

**Frontend** (Vite dev server, proxies `/api` → `http://localhost:4000`):

```bash
cd frontend
npm install
npm run dev          # serves http://localhost:5173
```

Open http://localhost:5173 and log in with a seed account below.

**Tests** (backend logic — auth, visibility, traversal, zip, stats, recommendation):

```bash
cd backend
npm test
```

## Seed Credentials

The backend seeds these accounts automatically on startup (idempotent — safe to restart):

| Username | Password | Role |
|---|---|---|
| `admin` | `admin` | admin |
| `alice` | `alice123` | user |

It also seeds a few categories (`utility`, `data`, `devtools`), tags (`cli`, `ai`, `format`, `git`), and one group (`internal-team`).

## API Overview

REST, all routes prefixed with `/api`. JWT is passed in the `Authorization: Bearer <token>` header; auth middleware attaches `req.user` and visibility is enforced server-side.

- **Auth** — `POST /auth/register`, `POST /auth/login` → `{ token, user }`.
- **Skills** — `GET /skills?tag=&category=&starred=`, `GET /skills/:id` (detail + file tree), `GET /skills/:id/file?path=`, `GET /skills/:id/download` (zip stream), `POST /skills/internal` (multipart zip), `POST /skills/external` (`{ url }`), `PATCH /skills/:id` (owner/admin metadata), `PUT /skills/:id/file` (owner/admin edit), `POST /skills/:id/star` (toggle).
- **Recommendations** — `GET /recommendations`.
- **Meta** — `GET /tags`, `GET /categories`, `GET /groups`.
- **Admin** (admin only) — `POST`/`DELETE /admin/tags[/:id]`, `POST`/`DELETE /admin/categories[/:id]`, `POST`/`DELETE /admin/groups[/:id]`, `POST /admin/groups/:id/members` and `DELETE /admin/groups/:id/members/:user_id`.
- **Stats** (charts) — `GET /stats/uploads-over-time`, `/stats/recent`, `/stats/by-category`, `/stats/top-tags`, `/stats/internal-external`.

## Project Structure

```
agentskill-marketplace/
├── backend/                  # Node + Express + SQLite
│   ├── src/
│   │   ├── app.js            # Express app, route mounting (/api/*)
│   │   ├── server.js         # entrypoint: initDb + seed + listen (port 4000)
│   │   ├── db.js             # SQLite connection + schema init
│   │   ├── seed.js           # idempotent seed (users, tags, categories, group)
│   │   ├── auth.js           # register/login + JWT middleware
│   │   ├── skills.js         # skills CRUD-read, upload, download, file, star
│   │   ├── storage.js        # on-disk skill folder helpers
│   │   ├── github.js         # external repo clone
│   │   ├── skill-detect.js   # traversal for folders containing SKILL.md
│   │   ├── visibility.js     # who-can-see-which-skill resolver
│   │   ├── meta.js           # /tags, /categories, /groups
│   │   ├── admin.js          # admin-only tag/category/group management
│   │   └── stats.js          # /stats/* charts + /recommendations
│   └── tests/                # vitest: auth, visibility, traversal, zip, stats
├── frontend/                 # React + Vite
│   ├── src/
│   │   ├── App.jsx           # routes
│   │   ├── main.jsx          # entry
│   │   ├── index.css         # global styles
│   │   ├── api/client.js     # fetch wrapper (adds Bearer token)
│   │   ├── auth/AuthContext.jsx
│   │   ├── components/       # Layout, ProtectedRoute, SkillCard,
│   │   │                     # UploadModal, FileViewer, SkillEditPanel
│   │   └── pages/            # Login, Marketplace, SkillPage, Timeline, Admin
│   └── vite.config.js        # dev server :5173, proxies /api → :4000
└── docs/                     # design spec + per-sprint notes
```

> **Note:** The SQLite database file (`backend/db.sqlite`) and the uploaded skill folders (`backend/storage/skills/`) live under `backend/` and are **gitignored** — they are generated at runtime by the seed and by uploads, not committed.

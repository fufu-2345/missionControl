# Sprint 4 — Groups + Visibility + Admin ✅

**Goal:** Admin console (manage tags/categories/groups + group membership), per-skill private + group assignment, full group-based visibility wiring.
**Status:** Complete & verified. **63/63 backend tests pass**, frontend builds, the private-visibility matrix verified live end-to-end.

## What was built

### Backend — by *bob*
- `src/admin.js` (new, all routes `adminRequired`, mounted `/api/admin`):
  - `POST/DELETE /tags`, `/categories`, `/groups` (201/409/400; deletes idempotent).
  - `GET /groups` → groups with `members:[{id,username}]`; `GET /users` → all users.
  - `POST /groups/:id/members {user_id}`, `DELETE /groups/:id/members/:user_id`.
- `src/meta.js` — `GET /api/groups` (auth, non-admin) read-only group list so owners can pick share targets.
- `src/skills.js` — `PATCH /:id` now accepts `groups:int[]` (validated, replaces `skill_groups`); `GET /:id` detail summary now includes `groups:[{id,name}]`. List endpoint unchanged.
- `src/app.js` — mounts admin router.

### Frontend — by *jack*
- `Admin.jsx` — full console: Tags + Categories (reusable `MasterListSection`: list/add/delete), Groups (create/delete + per-group member add/remove via user dropdown + member chips).
- `SkillEditPanel.jsx` — when visibility=private, a group multi-select (from `GET /api/groups`), pre-seeded from `skill.groups`; PATCH sends `groups` (public → `[]` clears them).

### Tests — by *john*
- `tests/groups-visibility.test.js` — 10 tests: admin auth gate (403/401), group CRUD + membership, the **full private+group visibility matrix**, `/api/groups` for non-admins.

## Visibility rule — now fully exercised
`canSee` (from Sprint 1) intersects `skill_groups ∩ user_groups`. With group assignment (PATCH) + membership (admin) now wired, a private skill is visible to: owner, admin, and members of any linked group — and nobody else.

## Verified live end-to-end (PORT 4106)
- non-admin → `POST /api/admin/groups` = **403**.
- outsider → private skill detail = **403**, and skill **absent** from their list.
- admin adds outsider to the linked group → outsider → detail = **200**, skill **present** in list.
- 63/63 tests pass; frontend build OK (191 KB).

## Next → Sprint 5: Charts + Recommend
5 timeline charts (uploads-over-time line/bar + cumulative, recent 5, by-category pie, top-10 tags, internal/external pie) + content-based recommendations + the recommended zone on marketplace.

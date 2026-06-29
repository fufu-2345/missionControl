// Sprint 4 — Groups + Visibility + Admin backend tests (john, LOGIC & TEST).
//
// Exercises the routes bob owns for Sprint 4 (spec §5):
//   GET    /api/groups                                (auth, non-admin) pick list
//   POST   /api/admin/groups          {name}          (admin) -> {id,name}
//   GET    /api/admin/groups                          (admin) list
//   DELETE /api/admin/groups/:id                      (admin)
//   POST   /api/admin/groups/:id/members  {user_id}   (admin) add member
//   DELETE /api/admin/groups/:id/members/:user_id     (admin) remove member
//   PATCH  /api/skills/:id  {visibility,groups:[ids]} (owner/admin) per-skill private+groups
//   GET    /api/skills/:id        + GET /api/skills    visibility enforcement
//
// Like the Sprint 3 suite, these run against the SAME persistent dev SQLite
// file as the app, so everything here is self-contained and id-agnostic:
//   * every run registers FRESH random users (unique usernames),
//   * the seeded admin (admin/admin123) is logged in, never assumed by id,
//   * skills are CREATED via the API (internal zip built in-memory with
//     adm-zip) — we never assume a pre-existing skill id,
//   * groups are CREATED via the admin API and looked up by the id returned —
//     no hardcoded group ids.
//
// CONTRACT NOTES are inlined where the spec and the live server diverge.

import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import AdmZip from 'adm-zip';
import { app } from '../src/app.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const rand = () => `${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
const auth = (token) => ({ Authorization: `Bearer ${token}` });

/** Register a brand-new (non-admin) user; returns { token, user, username }. */
async function registerUser(prefix = 'u') {
  const username = `${prefix}_${rand()}`;
  const password = 'S3cret-pass!';
  const res = await request(app)
    .post('/api/auth/register')
    .send({ username, password });
  expect([200, 201]).toContain(res.status);
  expect(typeof res.body.token).toBe('string');
  return { token: res.body.token, user: res.body.user, username, password };
}

/** Log in an existing user (e.g. the seeded admin); returns { token, user }. */
async function login(username, password) {
  const res = await request(app).post('/api/auth/login').send({ username, password });
  expect(res.status).toBe(200);
  return { token: res.body.token, user: res.body.user };
}

/** Build an in-memory zip containing SKILL.md (+ an extra file). */
function makeSkillZip(skillName, skillBody = '# Demo Skill\n\nHello.') {
  const zip = new AdmZip();
  const md = `---\nname: ${skillName}\n---\n${skillBody}\n`;
  zip.addFile('SKILL.md', Buffer.from(md, 'utf8'));
  zip.addFile('extra.txt', Buffer.from('extra file contents\n', 'utf8'));
  return zip.toBuffer();
}

/** Create an internal skill via the API as `token`. Returns its summary (has id). */
async function createSkill(token, name = `skill_${rand()}`) {
  const buf = makeSkillZip(name);
  const res = await request(app)
    .post('/api/skills/internal')
    .set(auth(token))
    .field('name', name)
    .attach('file', buf, 'skill.zip');
  expect(
    [200, 201],
    `internal upload failed: ${res.status} ${JSON.stringify(res.body)}`,
  ).toContain(res.status);
  const body = res.body || {};
  const skill = body.id ? body : body.skill || body.created || body;
  expect(skill && skill.id, `created skill has no id: ${JSON.stringify(body)}`).toBeTruthy();
  return skill;
}

/** Create a group as admin. Returns { id, name } per spec §5. */
async function createGroup(adminToken, name = `grp_${rand()}`) {
  const res = await request(app)
    .post('/api/admin/groups')
    .set(auth(adminToken))
    .send({ name });
  expect(
    [200, 201],
    `POST /api/admin/groups failed (route missing or contract mismatch): ${res.status} ${JSON.stringify(res.body)}`,
  ).toContain(res.status);
  expect(res.body && res.body.id, `created group has no id: ${JSON.stringify(res.body)}`).toBeTruthy();
  return { id: res.body.id, name: res.body.name ?? name };
}

/** Add `userId` to group `groupId` as admin. */
async function addMember(adminToken, groupId, userId) {
  return request(app)
    .post(`/api/admin/groups/${groupId}/members`)
    .set(auth(adminToken))
    .send({ user_id: userId });
}

/** PATCH a skill's visibility + groups per the spec contract {visibility, groups:[ids]}. */
async function setPrivateGroups(token, skillId, groupIds) {
  return request(app)
    .patch(`/api/skills/${skillId}`)
    .set(auth(token))
    .send({ visibility: 'private', groups: groupIds });
}

/** True if a skill id appears in this token's GET /api/skills list. */
async function listContains(token, skillId) {
  const res = await request(app).get('/api/skills').set(auth(token));
  expect(res.status).toBe(200);
  return res.body.skills.map((s) => s.id).includes(skillId);
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

let admin;       // seeded admin (admin/admin123)
let userA;       // owns the private skill
let userB;       // will be added to the group
let userC;       // never in any group — must never see the private skill

beforeAll(async () => {
  admin = await login('admin', 'admin123');
  expect(admin.user.role).toBe('admin');
  userA = await registerUser('alpha');
  userB = await registerUser('bravo');
  userC = await registerUser('charlie');
});

// ===========================================================================
// 1. Admin auth gate — non-admin gets 403, admin gets through
// ===========================================================================
describe('Admin auth gate (/api/admin/*)', () => {
  it('a normal user calling POST /api/admin/groups → 403', async () => {
    const res = await request(app)
      .post('/api/admin/groups')
      .set(auth(userA.token))
      .send({ name: `nope_${rand()}` });
    expect(
      res.status,
      `expected 403 for non-admin; got ${res.status} ${JSON.stringify(res.body)}`,
    ).toBe(403);
  });

  it('a normal user calling GET /api/admin/groups → 403', async () => {
    const res = await request(app).get('/api/admin/groups').set(auth(userA.token));
    expect(res.status).toBe(403);
  });

  it('an unauthenticated caller → 401', async () => {
    const res = await request(app).post('/api/admin/groups').send({ name: 'x' });
    expect(res.status).toBe(401);
  });

  it('the admin calling POST /api/admin/groups → 200/201', async () => {
    const res = await request(app)
      .post('/api/admin/groups')
      .set(auth(admin.token))
      .send({ name: `ok_${rand()}` });
    expect([200, 201]).toContain(res.status);
  });
});

// ===========================================================================
// 2. Group CRUD (admin): create → list → add member → remove → delete
// ===========================================================================
describe('Group CRUD (admin)', () => {
  it('create returns {id,name} and appears in GET /api/admin/groups', async () => {
    const name = `crud_${rand()}`;
    const g = await createGroup(admin.token, name);
    expect(g.id).toBeTruthy();
    expect(g.name).toBe(name);

    const list = await request(app).get('/api/admin/groups').set(auth(admin.token));
    expect(list.status).toBe(200);
    const groups = list.body.groups || list.body; // tolerate {groups:[]} or bare []
    const found = groups.find((x) => x.id === g.id);
    expect(found, `group ${g.id} not found in admin group list`).toBeTruthy();
    expect(found.name).toBe(name);
  });

  it('add a member → shows in members; remove → gone; then delete group', async () => {
    const g = await createGroup(admin.token);
    const member = await registerUser('member');

    // Add member.
    const add = await addMember(admin.token, g.id, member.user.id);
    expect(
      [200, 201],
      `add member failed: ${add.status} ${JSON.stringify(add.body)}`,
    ).toContain(add.status);

    // Confirm membership. The members view may live on the list endpoint
    // (each group carries a members array) or a dedicated members endpoint.
    const afterAdd = await request(app).get('/api/admin/groups').set(auth(admin.token));
    expect(afterAdd.status).toBe(200);
    const groupsAdd = afterAdd.body.groups || afterAdd.body;
    const gAdd = groupsAdd.find((x) => x.id === g.id);
    expect(gAdd, 'group missing after add').toBeTruthy();
    const memberIds = (gAdd.members || []).map((m) => (typeof m === 'object' ? m.id : m));
    expect(
      memberIds,
      `member ${member.user.id} not present in group members: ${JSON.stringify(gAdd.members)}`,
    ).toContain(member.user.id);

    // Remove member.
    const remove = await request(app)
      .delete(`/api/admin/groups/${g.id}/members/${member.user.id}`)
      .set(auth(admin.token));
    expect([200, 204]).toContain(remove.status);

    const afterRemove = await request(app).get('/api/admin/groups').set(auth(admin.token));
    const groupsRem = afterRemove.body.groups || afterRemove.body;
    const gRem = groupsRem.find((x) => x.id === g.id);
    const memberIdsRem = ((gRem && gRem.members) || []).map((m) =>
      typeof m === 'object' ? m.id : m,
    );
    expect(memberIdsRem).not.toContain(member.user.id);

    // Delete group.
    const del = await request(app)
      .delete(`/api/admin/groups/${g.id}`)
      .set(auth(admin.token));
    expect([200, 204]).toContain(del.status);

    const afterDel = await request(app).get('/api/admin/groups').set(auth(admin.token));
    const groupsDel = afterDel.body.groups || afterDel.body;
    expect(groupsDel.find((x) => x.id === g.id)).toBeFalsy();
  });
});

// ===========================================================================
// 3. Private + group visibility matrix (the heart of Sprint 4)
//
//   - userA owns a skill, PATCH it private with groups:[G].
//   - userB (NOT in G): GET /api/skills/:id → 403 AND absent from their list.
//   - admin adds userB to G.
//   - userB now: GET /api/skills/:id → 200 AND present in their list.
//   - admin sees it regardless; owner (userA) always sees it.
//   - userC (no groups) never sees it.
// ===========================================================================
describe('Private + group visibility matrix', () => {
  it('enforces the full spec §2 matrix end-to-end', async () => {
    // userA creates a skill (defaults to public) and makes it private+group-scoped.
    const skill = await createSkill(userA.token);
    const g = await createGroup(admin.token);

    const patch = await setPrivateGroups(userA.token, skill.id, [g.id]);
    expect(
      patch.status,
      `PATCH {visibility:'private',groups:[${g.id}]} failed: ${patch.status} ${JSON.stringify(patch.body)}`,
    ).toBe(200);
    expect(patch.body.visibility).toBe('private');

    // --- userB is NOT in G yet ---
    const bDeniedDetail = await request(app)
      .get(`/api/skills/${skill.id}`)
      .set(auth(userB.token));
    expect(
      bDeniedDetail.status,
      `userB (not in group) should be 403 on detail; got ${bDeniedDetail.status}`,
    ).toBe(403);
    expect(await listContains(userB.token, skill.id)).toBe(false);

    // owner always sees it; admin always sees it.
    const aDetail = await request(app)
      .get(`/api/skills/${skill.id}`)
      .set(auth(userA.token));
    expect(aDetail.status).toBe(200);
    expect(await listContains(userA.token, skill.id)).toBe(true);

    const adminDetail = await request(app)
      .get(`/api/skills/${skill.id}`)
      .set(auth(admin.token));
    expect(adminDetail.status).toBe(200);
    expect(await listContains(admin.token, skill.id)).toBe(true);

    // userC (no groups) cannot see it.
    const cDetail = await request(app)
      .get(`/api/skills/${skill.id}`)
      .set(auth(userC.token));
    expect(cDetail.status).toBe(403);
    expect(await listContains(userC.token, skill.id)).toBe(false);

    // --- admin adds userB to G ---
    const add = await addMember(admin.token, g.id, userB.user.id);
    expect([200, 201]).toContain(add.status);

    // userB now sees it in both detail and list.
    const bAllowedDetail = await request(app)
      .get(`/api/skills/${skill.id}`)
      .set(auth(userB.token));
    expect(
      bAllowedDetail.status,
      `userB (now in group) should be 200 on detail; got ${bAllowedDetail.status}`,
    ).toBe(200);
    expect(bAllowedDetail.body.id).toBe(skill.id);
    expect(await listContains(userB.token, skill.id)).toBe(true);

    // userC still cannot see it (membership is per-user, not global).
    expect(await listContains(userC.token, skill.id)).toBe(false);
    const cStill = await request(app)
      .get(`/api/skills/${skill.id}`)
      .set(auth(userC.token));
    expect(cStill.status).toBe(403);

    // --- removing userB from G revokes access again ---
    const remove = await request(app)
      .delete(`/api/admin/groups/${g.id}/members/${userB.user.id}`)
      .set(auth(admin.token));
    expect([200, 204]).toContain(remove.status);

    const bRevoked = await request(app)
      .get(`/api/skills/${skill.id}`)
      .set(auth(userB.token));
    expect(bRevoked.status).toBe(403);
    expect(await listContains(userB.token, skill.id)).toBe(false);
  });

  it('making a private skill public again exposes it to everyone', async () => {
    const skill = await createSkill(userA.token);
    const g = await createGroup(admin.token);
    const patchPriv = await setPrivateGroups(userA.token, skill.id, [g.id]);
    expect(patchPriv.status).toBe(200);

    // userC denied while private.
    let cDetail = await request(app).get(`/api/skills/${skill.id}`).set(auth(userC.token));
    expect(cDetail.status).toBe(403);

    // Flip back to public.
    const patchPub = await request(app)
      .patch(`/api/skills/${skill.id}`)
      .set(auth(userA.token))
      .send({ visibility: 'public' });
    expect(patchPub.status).toBe(200);
    expect(patchPub.body.visibility).toBe('public');

    cDetail = await request(app).get(`/api/skills/${skill.id}`).set(auth(userC.token));
    expect(cDetail.status).toBe(200);
    expect(await listContains(userC.token, skill.id)).toBe(true);
  });
});

// ===========================================================================
// 4. GET /api/groups (auth, non-admin) — owners can pick groups
// ===========================================================================
describe('GET /api/groups (auth, non-admin)', () => {
  it('returns the group list including a freshly created group', async () => {
    const name = `pick_${rand()}`;
    const g = await createGroup(admin.token, name);

    // A plain authenticated (non-admin) user can read the list.
    const res = await request(app).get('/api/groups').set(auth(userA.token));
    expect(
      res.status,
      `GET /api/groups should be 200 for any authed user; got ${res.status} ${JSON.stringify(res.body)}`,
    ).toBe(200);
    const groups = res.body.groups || res.body; // tolerate {groups:[]} or bare []
    expect(Array.isArray(groups)).toBe(true);
    const found = groups.find((x) => x.id === g.id);
    expect(found, `group ${g.id} (${name}) not present in /api/groups`).toBeTruthy();
    expect(found.name).toBe(name);
  });

  it('requires auth → 401 without a token', async () => {
    const res = await request(app).get('/api/groups');
    expect(res.status).toBe(401);
  });
});

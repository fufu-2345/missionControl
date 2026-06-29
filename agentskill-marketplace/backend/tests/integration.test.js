// Sprint 6 — Cross-cutting INTEGRATION test (john, LOGIC & TEST).
//
// One full happy-path flow that threads through MULTIPLE subsystems in a
// single sequence: auth → upload → PATCH (category+tag) → star → starred list
// → recent/top-tags stats → recommendations (shared-tag overlap, own-star
// exclusion) → file edit → download → admin groups + per-skill private
// visibility re-check.
//
// Self-contained & id-agnostic (same conventions as the per-sprint suites):
//   * runs against the SAME persistent dev SQLite file as the app,
//   * registers FRESH random users every run (unique usernames),
//   * the seeded admin (admin/admin123) is logged in, never assumed by id,
//   * skills are CREATED via the API (zip built in-memory with adm-zip),
//   * tags/categories/groups are looked up or created via the API and
//     referenced by the id returned — never hardcoded.
//
// CONTRACT NOTES are inlined where the spec (§5) and the live server diverge.

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

/** Build an in-memory zip containing SKILL.md (+ an extra editable file). */
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

/** Create a tag as admin (unique name); returns { id, name }. */
async function createTag(adminToken, name = `itag_${rand()}`) {
  const res = await request(app)
    .post('/api/admin/tags')
    .set(auth(adminToken))
    .send({ name });
  expect(
    [200, 201],
    `POST /api/admin/tags failed: ${res.status} ${JSON.stringify(res.body)}`,
  ).toContain(res.status);
  expect(res.body && res.body.id, `created tag has no id: ${JSON.stringify(res.body)}`).toBeTruthy();
  return { id: res.body.id, name: res.body.name ?? name };
}

/** Create a group as admin; returns { id, name } per spec §5. */
async function createGroup(adminToken, name = `igrp_${rand()}`) {
  const res = await request(app)
    .post('/api/admin/groups')
    .set(auth(adminToken))
    .send({ name });
  expect(
    [200, 201],
    `POST /api/admin/groups failed: ${res.status} ${JSON.stringify(res.body)}`,
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

/** True if a skill id appears in this token's GET /api/skills list. */
async function listContains(token, skillId) {
  const res = await request(app).get('/api/skills').set(auth(token));
  expect(res.status).toBe(200);
  return res.body.skills.map((s) => s.id).includes(skillId);
}

/**
 * PATCH category + tags onto a skill (owner/admin).
 *
 * CONTRACT NOTE (reported to lead): spec §5 documents the PATCH body tag field
 * as `tags`, but bob's implementation reads `tag_ids` (sending `tags` is
 * silently ignored — returns 200 with the tag NOT attached). We send `tag_ids`
 * to match the *live* server contract; switch to `tags` once reconciled.
 */
async function patchCategoryAndTags(token, skillId, { categoryId, tagIds }) {
  return request(app)
    .patch(`/api/skills/${skillId}`)
    .set(auth(token))
    .send({ category_id: categoryId, tag_ids: tagIds });
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

let userA;     // owner of the primary skill
let userB;     // a second user; uploads a skill sharing userA's tag
let admin;     // seeded admin (admin/admin123)
let category;  // a category looked up from the seed master list
let sharedTag; // a fresh, unique tag created for this run (overlap signal)

beforeAll(async () => {
  userA = await registerUser('userA');
  userB = await registerUser('userB');
  admin = await login('admin', 'admin123');
  expect(admin.user.role).toBe('admin');

  // Category from the seed master list (utility/data/devtools).
  const catRes = await request(app).get('/api/categories').set(auth(userA.token));
  expect(catRes.status).toBe(200);
  expect(Array.isArray(catRes.body.categories)).toBe(true);
  category = catRes.body.categories[0];
  expect(category, 'seed must provide at least one category').toBeTruthy();

  // A FRESH unique tag so the recommendation overlap + top-tags assertions are
  // not polluted by skills from other (parallel) test files reusing seed tags.
  sharedTag = await createTag(admin.token);

  // The fresh tag must show up in the auth'd /api/tags master list.
  const tagsRes = await request(app).get('/api/tags').set(auth(userA.token));
  expect(tagsRes.status).toBe(200);
  expect(tagsRes.body.tags.map((t) => t.id)).toContain(sharedTag.id);
});

// ===========================================================================
// FULL CROSS-CUTTING HAPPY PATH
// ===========================================================================
describe('integration: full cross-cutting happy path', () => {
  // Threaded state across the ordered steps below.
  let skillA; // userA's internal skill
  let skillB; // userB's skill sharing the same tag

  // -------------------------------------------------------------------------
  // 1. userA uploads an internal skill, then PATCHes a category + tag onto it.
  //    (ids resolved dynamically from /api/categories and /api/tags.)
  // -------------------------------------------------------------------------
  it('1) userA uploads an internal skill and PATCHes category + tag', async () => {
    skillA = await createSkill(userA.token, `A_primary_${rand()}`);
    expect(skillA.type).toBe('internal');
    expect(skillA.owner.id).toBe(userA.user.id);

    const patch = await patchCategoryAndTags(userA.token, skillA.id, {
      categoryId: category.id,
      tagIds: [sharedTag.id],
    });
    expect(
      patch.status,
      `PATCH category+tag failed: ${patch.status} ${JSON.stringify(patch.body)}`,
    ).toBe(200);

    // The PATCH response must reflect BOTH the category and the attached tag.
    expect(patch.body.category).toBe(category.name);
    expect(
      patch.body.tags,
      `PATCH 200 but tag not attached: ${JSON.stringify(patch.body.tags)}`,
    ).toContain(sharedTag.name);
  });

  // -------------------------------------------------------------------------
  // 2. userA stars it; it must appear in ?starred=true and in /stats/recent,
  //    and the tag must surface in /stats/top-tags.
  // -------------------------------------------------------------------------
  it('2) userA stars it → starred list, recent stats, and top-tags reflect it', async () => {
    const star = await request(app)
      .post(`/api/skills/${skillA.id}/star`)
      .set(auth(userA.token));
    expect(star.status).toBe(200);
    expect(star.body.starred).toBe(true);

    // ?starred=true must contain the freshly-starred skill.
    const starredList = await request(app)
      .get('/api/skills?starred=true')
      .set(auth(userA.token));
    expect(starredList.status).toBe(200);
    expect(starredList.body.skills.map((s) => s.id)).toContain(skillA.id);

    // /stats/recent = the 5 newest visible skills. We just created skillA, so
    // it is among the newest; assert presence. (Checked right after creation to
    // keep the window tight against the shared persistent DB.)
    const recent = await request(app).get('/api/stats/recent').set(auth(userA.token));
    expect(recent.status).toBe(200);
    expect(
      recent.body.skills.map((s) => s.id),
      `skillA not in /stats/recent (newest-5): ${JSON.stringify(recent.body.skills.map((s) => s.id))}`,
    ).toContain(skillA.id);

    // /stats/top-tags must include our fresh tag (count >= 1: skillA carries it).
    const topTags = await request(app).get('/api/stats/top-tags').set(auth(userA.token));
    expect(topTags.status).toBe(200);
    const tagEntry = topTags.body.data.find((d) => d.tag === sharedTag.name);
    expect(
      tagEntry,
      `fresh tag not in /stats/top-tags: ${JSON.stringify(topTags.body.data)}`,
    ).toBeTruthy();
    expect(tagEntry.count).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // 3. userB uploads a skill sharing the SAME tag; userA's /recommendations
  //    must surface userB's skill (shared tag overlap) and exclude userA's own
  //    starred skill.
  // -------------------------------------------------------------------------
  it('3) userB shares the tag → userA recommendations surface it, exclude own star', async () => {
    skillB = await createSkill(userB.token, `B_shared_${rand()}`);
    expect(skillB.owner.id).toBe(userB.user.id);

    // userB attaches the SAME shared tag (owners may attach existing tags).
    const patchB = await patchCategoryAndTags(userB.token, skillB.id, {
      categoryId: null,
      tagIds: [sharedTag.id],
    });
    expect(
      patchB.status,
      `userB PATCH tag failed: ${patchB.status} ${JSON.stringify(patchB.body)}`,
    ).toBe(200);
    expect(patchB.body.tags).toContain(sharedTag.name);

    // userA's recommendations: built from userA's starred-skill profile
    // (category + tags of skillA). skillB shares sharedTag → positive overlap.
    const recs = await request(app).get('/api/recommendations').set(auth(userA.token));
    expect(recs.status).toBe(200);
    const recIds = recs.body.skills.map((s) => s.id);

    // (a) userB's shared-tag skill is recommended.
    expect(
      recIds,
      `userB's shared-tag skill not recommended to userA: ${JSON.stringify(recIds)}`,
    ).toContain(skillB.id);

    // (b) userA's OWN starred skill is excluded from its own recommendations.
    expect(
      recIds,
      `userA's own starred skill leaked into its recommendations: ${JSON.stringify(recIds)}`,
    ).not.toContain(skillA.id);
  });

  // -------------------------------------------------------------------------
  // 4. userA edits a file via PUT /:id/file, then downloads the folder as a zip.
  // -------------------------------------------------------------------------
  it('4) userA edits a file and downloads a 200 zip', async () => {
    const newContent = `# Edited\n\nintegration edit ${rand()}\n`;

    const put = await request(app)
      .put(`/api/skills/${skillA.id}/file`)
      .set(auth(userA.token))
      .send({ path: 'extra.txt', content: newContent });
    expect(
      put.status,
      `PUT file failed: ${put.status} ${JSON.stringify(put.body)}`,
    ).toBe(200);

    // The edit must be readable back.
    const read = await request(app)
      .get(`/api/skills/${skillA.id}/file?path=extra.txt`)
      .set(auth(userA.token));
    expect(read.status).toBe(200);
    expect(read.body.content).toBe(newContent);

    // Download the whole folder as a zip → 200 + zip content-type + non-empty.
    const dl = await request(app)
      .get(`/api/skills/${skillA.id}/download`)
      .set(auth(userA.token))
      .buffer(true)
      .parse((res, cb) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(dl.status).toBe(200);
    expect(String(dl.headers['content-type'] || '')).toMatch(/zip/i);
    expect(Buffer.isBuffer(dl.body) ? dl.body.length : 0).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // 5. Admin creates a group, makes userA's skill private+group; userB cannot
  //    see it until admin adds userB to the group (mini visibility re-check).
  // -------------------------------------------------------------------------
  it('5) private+group visibility: userB blocked, then allowed after group add', async () => {
    const group = await createGroup(admin.token);

    // Admin flips skillA to private and shares it with the new group.
    // (Admin acts as a privileged editor; spec §5 PATCH allows owner OR admin.)
    const patchPriv = await request(app)
      .patch(`/api/skills/${skillA.id}`)
      .set(auth(admin.token))
      .send({ visibility: 'private', groups: [group.id] });
    expect(
      patchPriv.status,
      `PATCH private+groups failed: ${patchPriv.status} ${JSON.stringify(patchPriv.body)}`,
    ).toBe(200);
    expect(patchPriv.body.visibility).toBe('private');
    expect(patchPriv.body.groups.map((g) => g.id)).toContain(group.id);

    // BEFORE membership: userB (not in the group, not owner/admin) cannot see it.
    const detailBlocked = await request(app)
      .get(`/api/skills/${skillA.id}`)
      .set(auth(userB.token));
    expect(detailBlocked.status).toBe(403);
    expect(await listContains(userB.token, skillA.id)).toBe(false);

    // userA (owner) can still see their own private skill.
    const ownerDetail = await request(app)
      .get(`/api/skills/${skillA.id}`)
      .set(auth(userA.token));
    expect(ownerDetail.status).toBe(200);

    // Admin adds userB to the group.
    const add = await addMember(admin.token, group.id, userB.user.id);
    expect(add.status).toBe(200);

    // AFTER membership: userB can now see the private skill (detail + list).
    const detailAllowed = await request(app)
      .get(`/api/skills/${skillA.id}`)
      .set(auth(userB.token));
    expect(
      detailAllowed.status,
      `userB still blocked after group add: ${detailAllowed.status} ${JSON.stringify(detailAllowed.body)}`,
    ).toBe(200);
    expect(await listContains(userB.token, skillA.id)).toBe(true);
  });
});

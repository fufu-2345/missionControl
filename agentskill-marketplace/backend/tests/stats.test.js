// Sprint 5 — Charts + Recommendation backend tests (john, LOGIC & TEST).
//
// Exercises the routes bob owns for Sprint 5 (spec §4 charts, §5 API, §6 reco):
//   GET /api/stats/uploads-over-time   -> { points: [{date, count, cumulative}] }
//   GET /api/stats/recent              -> { skills: [...] }            (<= 5)
//   GET /api/stats/by-category         -> { data: [{category, count, pct}] }
//   GET /api/stats/top-tags            -> { data: [{tag, count}] }     (<= 10)
//   GET /api/stats/internal-external   -> { data: [{type, count, pct}] }
//   GET /api/recommendations           -> { skills: [...] }            (§6)
//
// Like the earlier suites, these run against the SAME persistent dev SQLite
// file as the app, so everything here is self-contained and id-agnostic:
//   * every run registers FRESH random users (unique usernames),
//   * skills are CREATED via the API (internal zip built in-memory with
//     adm-zip) — we never assume a pre-existing skill id,
//   * tags/categories are looked up by NAME from /api/tags & /api/categories
//     (bob's seed: categories utility/data/devtools, tags cli/ai/format/git),
//   * tags/category are attached via PATCH /api/skills/:id, stars via
//     POST /api/skills/:id/star.
//
// Because the DB is shared and pre-populated by other suites, every assertion
// here is written to tolerate "noise" rows: we never assert exact totals or
// exact array lengths beyond the documented caps, and we locate OUR skills by
// the unique ids returned at creation time. CONTRACT NOTES are inlined where
// the spec and the live server diverge.

import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import AdmZip from 'adm-zip';
import { app } from '../src/app.js';

// ---------------------------------------------------------------------------
// Helpers (mirrors the conventions in skills.test.js / groups-visibility.test.js)
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

/** Set the category on a skill via PATCH (numeric id). Returns the response. */
async function setCategory(token, skillId, categoryId) {
  return request(app)
    .patch(`/api/skills/${skillId}`)
    .set(auth(token))
    .send({ category_id: categoryId });
}

/**
 * Attach tags to a skill via PATCH, tolerating the spec/impl field-name
 * mismatch documented in skills.test.js (spec §5 says `tags`, bob's server
 * reads `tag_ids`). Tries `tags` first; if 200 but not actually attached,
 * retries with `tag_ids`. Returns the final PATCH response.
 */
async function attachTags(token, skillId, tagIds, tagNamesById) {
  const wantNames = tagIds.map((id) => tagNamesById.get(id)).filter(Boolean);
  const attached = (res) =>
    res.status === 200 && wantNames.every((n) => (res.body.tags || []).includes(n));

  let res = await request(app)
    .patch(`/api/skills/${skillId}`)
    .set(auth(token))
    .send({ tags: tagIds });
  if (attached(res)) return res;

  res = await request(app)
    .patch(`/api/skills/${skillId}`)
    .set(auth(token))
    .send({ tag_ids: tagIds });
  return res;
}

/** Toggle a star on as `token`. Asserts the star ends up ON (starred:true). */
async function starOn(token, skillId) {
  const res = await request(app)
    .post(`/api/skills/${skillId}/star`)
    .set(auth(token));
  expect(res.status).toBe(200);
  if (res.body.starred !== true) {
    // It was already starred and we just toggled it OFF; toggle back ON.
    const again = await request(app)
      .post(`/api/skills/${skillId}/star`)
      .set(auth(token));
    expect(again.status).toBe(200);
    expect(again.body.starred).toBe(true);
  }
  return res;
}

/** Make a skill private with NO groups → only owner + admins can see it. */
async function makePrivate(token, skillId) {
  return request(app)
    .patch(`/api/skills/${skillId}`)
    .set(auth(token))
    .send({ visibility: 'private', groups: [] });
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

let user;        // primary viewer / actor for most tests
let tags;        // [{id,name}] from seed
let categories;  // [{id,name}] from seed
let tagNamesById;

beforeAll(async () => {
  user = await registerUser('john');

  const tagsRes = await request(app).get('/api/tags').set(auth(user.token));
  expect(tagsRes.status).toBe(200);
  tags = tagsRes.body.tags;
  expect(Array.isArray(tags) && tags.length > 0, 'seed must provide tags').toBe(true);
  tagNamesById = new Map(tags.map((t) => [t.id, t.name]));

  const catRes = await request(app).get('/api/categories').set(auth(user.token));
  expect(catRes.status).toBe(200);
  categories = catRes.body.categories;
  expect(Array.isArray(categories) && categories.length > 0, 'seed must provide categories').toBe(true);
});

// ===========================================================================
// 4. Auth gate — every stats route + recommendations needs a token (401)
//    (Listed first so it runs regardless of whether the routes are mounted.)
// ===========================================================================
describe('Auth: stats + recommendations require a token', () => {
  const protectedGets = [
    '/api/stats/uploads-over-time',
    '/api/stats/recent',
    '/api/stats/by-category',
    '/api/stats/top-tags',
    '/api/stats/internal-external',
    '/api/recommendations',
  ];

  for (const path of protectedGets) {
    it(`GET ${path} without a token → 401`, async () => {
      const res = await request(app).get(path);
      expect(
        res.status,
        `expected 401 (no token) for ${path}; got ${res.status} ${JSON.stringify(res.body)}`,
      ).toBe(401);
    });
  }
});

// ===========================================================================
// 1. Shapes — each /api/stats/* route returns 200 with the documented shape.
// ===========================================================================
describe('Stats endpoint shapes (spec §4 / §5)', () => {
  it('GET /api/stats/uploads-over-time → { points:[{date,count,cumulative}] }, cumulative non-decreasing', async () => {
    // Ensure there is at least one upload so points is non-trivial.
    await createSkill(user.token);

    const res = await request(app)
      .get('/api/stats/uploads-over-time')
      .set(auth(user.token));
    expect(
      res.status,
      `expected 200; got ${res.status} ${JSON.stringify(res.body)}`,
    ).toBe(200);

    const points = res.body.points;
    expect(Array.isArray(points), `points must be an array: ${JSON.stringify(res.body)}`).toBe(true);

    let prev = -Infinity;
    for (const p of points) {
      expect(typeof p.date).toBe('string');
      expect(isNum(p.count), `count must be a number: ${JSON.stringify(p)}`).toBe(true);
      expect(isNum(p.cumulative), `cumulative must be a number: ${JSON.stringify(p)}`).toBe(true);
      // cumulative is the running lifetime total → non-decreasing across points.
      expect(
        p.cumulative >= prev,
        `cumulative must be non-decreasing; saw ${prev} then ${p.cumulative}`,
      ).toBe(true);
      prev = p.cumulative;
    }
  });

  it('GET /api/stats/recent → { skills:[...] } with at most 5 entries', async () => {
    const res = await request(app).get('/api/stats/recent').set(auth(user.token));
    expect(res.status, `expected 200; got ${res.status} ${JSON.stringify(res.body)}`).toBe(200);
    expect(Array.isArray(res.body.skills), `skills must be an array: ${JSON.stringify(res.body)}`).toBe(true);
    expect(
      res.body.skills.length,
      `recent must cap at 5; got ${res.body.skills.length}`,
    ).toBeLessThanOrEqual(5);
    // Each entry should at least carry an id + name (skill summary shape).
    for (const s of res.body.skills) {
      expect(s.id, `recent skill missing id: ${JSON.stringify(s)}`).toBeTruthy();
      expect(typeof s.name).toBe('string');
    }
  });

  it('GET /api/stats/by-category → { data:[{category,count,pct}] }, pct numeric', async () => {
    const res = await request(app).get('/api/stats/by-category').set(auth(user.token));
    expect(res.status, `expected 200; got ${res.status} ${JSON.stringify(res.body)}`).toBe(200);
    const data = res.body.data;
    expect(Array.isArray(data), `data must be an array: ${JSON.stringify(res.body)}`).toBe(true);
    for (const row of data) {
      // category may be a string or null (uncategorized bucket) — both ok.
      expect(['string', 'object']).toContain(typeof row.category);
      expect(isNum(row.count), `count must be a number: ${JSON.stringify(row)}`).toBe(true);
      expect(isNum(row.pct), `pct must be a number: ${JSON.stringify(row)}`).toBe(true);
    }
  });

  it('GET /api/stats/top-tags → { data:[{tag,count}] } with at most 10 entries', async () => {
    const res = await request(app).get('/api/stats/top-tags').set(auth(user.token));
    expect(res.status, `expected 200; got ${res.status} ${JSON.stringify(res.body)}`).toBe(200);
    const data = res.body.data;
    expect(Array.isArray(data), `data must be an array: ${JSON.stringify(res.body)}`).toBe(true);
    expect(data.length, `top-tags must cap at 10; got ${data.length}`).toBeLessThanOrEqual(10);
    for (const row of data) {
      expect(typeof row.tag).toBe('string');
      expect(isNum(row.count), `count must be a number: ${JSON.stringify(row)}`).toBe(true);
    }
  });

  it('GET /api/stats/internal-external → { data:[{type,count,pct}] }, pct numeric', async () => {
    const res = await request(app).get('/api/stats/internal-external').set(auth(user.token));
    expect(res.status, `expected 200; got ${res.status} ${JSON.stringify(res.body)}`).toBe(200);
    const data = res.body.data;
    expect(Array.isArray(data), `data must be an array: ${JSON.stringify(res.body)}`).toBe(true);
    for (const row of data) {
      expect(['internal', 'external']).toContain(row.type);
      expect(isNum(row.count), `count must be a number: ${JSON.stringify(row)}`).toBe(true);
      expect(isNum(row.pct), `pct must be a number: ${JSON.stringify(row)}`).toBe(true);
    }
  });
});

// ===========================================================================
// 2. by-category / top-tags reflect newly created data.
// ===========================================================================
describe('Stats reflect created data', () => {
  it('a skill with a known category bumps that category to count >= 1 in by-category', async () => {
    const cat = categories[0];
    const skill = await createSkill(user.token);
    const patch = await setCategory(user.token, skill.id, cat.id);
    expect(
      patch.status,
      `set category failed: ${patch.status} ${JSON.stringify(patch.body)}`,
    ).toBe(200);
    expect(patch.body.category).toBe(cat.name);

    const res = await request(app).get('/api/stats/by-category').set(auth(user.token));
    expect(res.status).toBe(200);
    const row = (res.body.data || []).find((r) => r.category === cat.name);
    expect(row, `category '${cat.name}' missing from by-category: ${JSON.stringify(res.body.data)}`).toBeTruthy();
    expect(row.count).toBeGreaterThanOrEqual(1);
  });

  it('a skill with a known tag bumps that tag to count >= 1 in top-tags', async () => {
    const tag = tags[0];
    const skill = await createSkill(user.token);
    const patch = await attachTags(user.token, skill.id, [tag.id], tagNamesById);
    expect(
      patch.status,
      `attach tag failed: ${patch.status} ${JSON.stringify(patch.body)}`,
    ).toBe(200);
    expect(
      patch.body.tags,
      `PATCH returned 200 but tag not attached: ${JSON.stringify(patch.body.tags)}`,
    ).toContain(tag.name);

    const res = await request(app).get('/api/stats/top-tags').set(auth(user.token));
    expect(res.status).toBe(200);
    // NOTE: top-tags caps at 10 by count; on a noisy shared DB our freshly
    // tagged skill's tag may already be in the top 10 (it usually is, since
    // seed tags are few). If absent we still assert it exists with count >= 1
    // via the un-capped path would be ideal, but the documented contract only
    // exposes the capped list — so we assert presence and treat absence as a
    // soft signal. Here we require presence because the seed tag set is tiny
    // (4 tags) and cannot overflow the 10-cap.
    const row = (res.body.data || []).find((r) => r.tag === tag.name);
    expect(
      row,
      `tag '${tag.name}' missing from top-tags (cap=10, seed has ${tags.length} tags): ${JSON.stringify(res.body.data)}`,
    ).toBeTruthy();
    expect(row.count).toBeGreaterThanOrEqual(1);
  });
});

// ===========================================================================
// 3. Recommendation (spec §6) — content-based on the viewer's starred skills.
//
//   - viewer creates + STARS a "seed" skill with category C and tag T,
//   - viewer creates another VISIBLE, NON-starred skill sharing tag T (+ cat C),
//   - GET /api/recommendations { skills:[...] } should:
//       * NOT include the already-starred seed skill,
//       * include (or at least rank) the overlapping skill,
//       * never include a skill the viewer can't see (private, owned by someone
//         else, shared with no group).
// ===========================================================================
describe('Recommendations (spec §6)', () => {
  it('recommends a visible non-starred skill that overlaps the viewer’s taste, excludes the starred seed, and never leaks invisible skills', async () => {
    const cat = categories[0];
    // Use as many seed tags as available (up to all) so the viewer's taste
    // profile is rich. The candidate will match category C + ALL these tags,
    // giving it the maximum possible overlap score — this keeps it above the
    // implementation's top-N cap even on a noisy shared DB where other skills
    // overlap on a single tag/category (score 1-2). T is the primary tag.
    const tag = tags[0];
    const seedTagIds = tags.map((t) => t.id);
    const seedTagNames = tags.map((t) => t.name);

    // --- 1. The viewer's "seed of taste": create + star a skill with C + tags.
    const seed = await createSkill(user.token, `seed_${rand()}`);
    const seedCat = await setCategory(user.token, seed.id, cat.id);
    expect(seedCat.status, `seed category PATCH: ${seedCat.status} ${JSON.stringify(seedCat.body)}`).toBe(200);
    const seedTag = await attachTags(user.token, seed.id, seedTagIds, tagNamesById);
    expect(seedTag.status).toBe(200);
    for (const n of seedTagNames) expect(seedTag.body.tags).toContain(n);
    await starOn(user.token, seed.id);

    // --- 2. A VISIBLE, non-starred skill that shares category C + ALL the
    //     viewer's tags → maximal overlap score. Owned by a *different* user so
    //     the viewer hasn't starred it and it is a genuine candidate. Public by
    //     default → visible.
    const author = await registerUser('author');
    const candidate = await createSkill(author.token, `cand_${rand()}`);
    const candCat = await setCategory(author.token, candidate.id, cat.id);
    expect(candCat.status).toBe(200);
    const candTag = await attachTags(author.token, candidate.id, seedTagIds, tagNamesById);
    expect(candTag.status).toBe(200);
    for (const n of seedTagNames) expect(candTag.body.tags).toContain(n);

    // --- 3. A skill the viewer must NEVER be recommended: private, owned by a
    //     third party, shared with no group (only owner + admins can see it),
    //     yet it ALSO shares C + T so a buggy reco that ignores visibility
    //     would surface it.
    const stranger = await registerUser('stranger');
    const secret = await createSkill(stranger.token, `secret_${rand()}`);
    await setCategory(stranger.token, secret.id, cat.id);
    const secretTag = await attachTags(stranger.token, secret.id, [tag.id], tagNamesById);
    expect(secretTag.status).toBe(200);
    const priv = await makePrivate(stranger.token, secret.id);
    expect(
      priv.status,
      `make-private PATCH failed: ${priv.status} ${JSON.stringify(priv.body)}`,
    ).toBe(200);
    expect(priv.body.visibility).toBe('private');
    // Sanity: the viewer genuinely cannot see `secret`.
    const seeSecret = await request(app)
      .get(`/api/skills/${secret.id}`)
      .set(auth(user.token));
    expect(
      seeSecret.status,
      `viewer should be forbidden from the private skill; got ${seeSecret.status}`,
    ).toBe(403);

    // --- Recommendations for the viewer.
    const res = await request(app).get('/api/recommendations').set(auth(user.token));
    expect(
      res.status,
      `expected 200; got ${res.status} ${JSON.stringify(res.body)}`,
    ).toBe(200);
    expect(Array.isArray(res.body.skills), `skills must be an array: ${JSON.stringify(res.body)}`).toBe(true);

    const recIds = res.body.skills.map((s) => s.id);

    // (a) the already-starred seed is NOT recommended (§6: "non-starred").
    expect(
      recIds,
      `recommendations must exclude the viewer's already-starred seed (${seed.id})`,
    ).not.toContain(seed.id);

    // (b) the overlapping, visible candidate IS recommended.
    expect(
      recIds,
      `overlapping visible skill (${candidate.id}) should be recommended: got ${JSON.stringify(recIds)}`,
    ).toContain(candidate.id);

    // (c) the invisible private skill is NEVER leaked.
    expect(
      recIds,
      `recommendations leaked a skill the viewer cannot see (${secret.id})`,
    ).not.toContain(secret.id);

    // None of the returned skills should ever be one the viewer can't see:
    // spot-check that every recommended skill is actually fetchable (200).
    for (const id of recIds) {
      const detail = await request(app).get(`/api/skills/${id}`).set(auth(user.token));
      expect(
        detail.status,
        `recommended skill ${id} is not visible to the viewer (got ${detail.status})`,
      ).toBe(200);
    }
  });
});

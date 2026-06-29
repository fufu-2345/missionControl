// Skills router — list / detail / upload (internal zip + external clone).
//
// Mounted at /api/skills (see app.js). All routes require auth.
// Visibility is enforced server-side via canSee (visibility.js) using the
// viewer's group ids and each skill's group ids.

import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import multer from 'multer';
import AdmZip from 'adm-zip';
import archiver from 'archiver';

import { db } from './db.js';
import { authRequired } from './auth.js';
import { canSee } from './visibility.js';
import {
  buildFileTree,
  storeSkillFolder,
  readSkillFile,
  writeSkillFile,
} from './storage.js';
import { cloneRepo, cleanup } from './github.js';
import {
  findSkillFolders,
  folderHasSkillMd,
  pickSkillName,
} from './skill-detect.js';

export const router = express.Router();

// Multer: store uploaded zip into a temp dir on disk (single field `file`).
const upload = multer({ dest: os.tmpdir() });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Group ids the user belongs to (array of ints). */
function userGroupIds(userId) {
  return db
    .prepare(`SELECT group_id FROM user_groups WHERE user_id = ?`)
    .all(userId)
    .map((r) => r.group_id);
}

/** Group ids that can see a private skill (array of ints). */
function skillGroupIds(skillId) {
  return db
    .prepare(`SELECT group_id FROM skill_groups WHERE skill_id = ?`)
    .all(skillId)
    .map((r) => r.group_id);
}

/** Groups linked to a skill as {id, name} pairs, ordered by name. */
function skillGroups(skillId) {
  return db
    .prepare(
      `SELECT g.id AS id, g.name AS name
         FROM skill_groups sg
         JOIN groups g ON g.id = sg.group_id
        WHERE sg.skill_id = ?
        ORDER BY g.name`
    )
    .all(skillId);
}

/**
 * Build the public summary for a skill row.
 * @param {object} row    a row from the skills table (must include id, name,
 *                        type, owner_id, category_id, visibility, source_url)
 * @param {number} [userId] the viewer's id — used to compute `starred`. When
 *                        omitted, `starred` is always false.
 * @returns {{id, name, type, owner:{id,username}, category:(string|null),
 *            tags:string[], visibility, source_url, starred:boolean,
 *            starCount:number}}
 */
function skillSummary(row, userId) {
  const owner = db
    .prepare(`SELECT id, username FROM users WHERE id = ?`)
    .get(row.owner_id) || { id: row.owner_id, username: null };

  const category = row.category_id
    ? (db.prepare(`SELECT name FROM categories WHERE id = ?`).get(row.category_id)?.name ?? null)
    : null;

  const tags = db
    .prepare(
      `SELECT t.name AS name
         FROM skill_tags st
         JOIN tags t ON t.id = st.tag_id
        WHERE st.skill_id = ?
        ORDER BY t.name`
    )
    .all(row.id)
    .map((r) => r.name);

  const starCount = db
    .prepare(`SELECT COUNT(*) AS n FROM stars WHERE skill_id = ?`)
    .get(row.id).n;

  const starred = userId != null
    ? !!db
        .prepare(`SELECT 1 FROM stars WHERE user_id = ? AND skill_id = ?`)
        .get(userId, row.id)
    : false;

  return {
    id: row.id,
    name: row.name,
    type: row.type,
    owner: { id: owner.id, username: owner.username },
    category,
    tags,
    visibility: row.visibility,
    source_url: row.source_url ?? null,
    starred,
    starCount,
  };
}

/** True if user is an admin or owns the skill row. */
function isOwnerOrAdmin(user, row) {
  return user.role === 'admin' || row.owner_id === user.id;
}

/**
 * Resolve whether req.user may see the given skill row, loading group ids only
 * when the skill is private. Returns a boolean.
 */
function viewerCanSee(user, row) {
  return canSee({
    user,
    skill: row,
    userGroupIds: userGroupIds(user.id),
    skillGroupIds: row.visibility === 'private' ? skillGroupIds(row.id) : [],
  });
}

const SELECT_SKILL = `SELECT id, name, owner_id, type, category_id, visibility, source_url, folder_path, created_at FROM skills`;

// ---------------------------------------------------------------------------
// GET /  — list every skill the viewer can see
//
// Optional filters, applied AFTER the visibility filter and combined with AND:
//   ?tag=<name>         only skills having that tag
//   ?category=<name>    only skills in that category
//   ?starred=true       only skills the viewer has starred
// ---------------------------------------------------------------------------
router.get('/', authRequired, (req, res) => {
  const rows = db.prepare(`${SELECT_SKILL} ORDER BY created_at DESC, id DESC`).all();
  const ugids = userGroupIds(req.user.id);

  let visible = rows.filter((row) =>
    canSee({
      user: req.user,
      skill: row,
      userGroupIds: ugids,
      skillGroupIds: row.visibility === 'private' ? skillGroupIds(row.id) : [],
    })
  );

  // --- post-visibility filters (AND) ---
  const { tag, category, starred } = req.query;

  if (typeof tag === 'string' && tag.trim()) {
    const name = tag.trim();
    const ids = new Set(
      db
        .prepare(
          `SELECT st.skill_id AS id
             FROM skill_tags st
             JOIN tags t ON t.id = st.tag_id
            WHERE t.name = ?`
        )
        .all(name)
        .map((r) => r.id)
    );
    visible = visible.filter((row) => ids.has(row.id));
  }

  if (typeof category === 'string' && category.trim()) {
    const name = category.trim();
    const cat = db.prepare(`SELECT id FROM categories WHERE name = ?`).get(name);
    if (!cat) {
      visible = [];
    } else {
      visible = visible.filter((row) => row.category_id === cat.id);
    }
  }

  if (starred === 'true') {
    const ids = new Set(
      db
        .prepare(`SELECT skill_id AS id FROM stars WHERE user_id = ?`)
        .all(req.user.id)
        .map((r) => r.id)
    );
    visible = visible.filter((row) => ids.has(row.id));
  }

  res.json({ skills: visible.map((row) => skillSummary(row, req.user.id)) });
});

// ---------------------------------------------------------------------------
// GET /:id  — detail + file tree
// ---------------------------------------------------------------------------
router.get('/:id', authRequired, (req, res) => {
  const row = db.prepare(`${SELECT_SKILL} WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'skill not found' });

  if (!viewerCanSee(req.user, row)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const summary = skillSummary(row, req.user.id);
  // Detail-only: the groups this skill is shared with (kept off the list
  // endpoint to keep it light). Owners use this to render the share UI.
  summary.groups = skillGroups(row.id);
  summary.files = buildFileTree(row.folder_path);
  res.json(summary);
});

// ---------------------------------------------------------------------------
// POST /:id/star  — toggle a star for the current user
// ---------------------------------------------------------------------------
router.post('/:id/star', authRequired, (req, res) => {
  const row = db.prepare(`${SELECT_SKILL} WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'skill not found' });

  if (!viewerCanSee(req.user, row)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const existing = db
    .prepare(`SELECT 1 FROM stars WHERE user_id = ? AND skill_id = ?`)
    .get(req.user.id, row.id);

  let starred;
  if (existing) {
    db.prepare(`DELETE FROM stars WHERE user_id = ? AND skill_id = ?`)
      .run(req.user.id, row.id);
    starred = false;
  } else {
    db.prepare(`INSERT INTO stars (user_id, skill_id) VALUES (?, ?)`)
      .run(req.user.id, row.id);
    starred = true;
  }

  const starCount = db
    .prepare(`SELECT COUNT(*) AS n FROM stars WHERE skill_id = ?`)
    .get(row.id).n;

  res.json({ starred, starCount });
});

// ---------------------------------------------------------------------------
// GET /:id/file?path=<rel>  — read one text file from the skill folder
// ---------------------------------------------------------------------------
router.get('/:id/file', authRequired, (req, res) => {
  const row = db.prepare(`${SELECT_SKILL} WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'skill not found' });

  if (!viewerCanSee(req.user, row)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const rel = req.query.path;
  if (typeof rel !== 'string' || !rel.trim()) {
    return res.status(400).json({ error: 'path query param is required' });
  }

  let content;
  try {
    content = readSkillFile(row.folder_path, rel);
  } catch (err) {
    if (err.message === 'path traversal rejected') {
      return res.status(400).json({ error: 'invalid path' });
    }
    // ENOENT / EISDIR / unreadable -> treat as missing file.
    return res.status(404).json({ error: 'file not found' });
  }

  res.json({ path: rel, content });
});

// ---------------------------------------------------------------------------
// GET /:id/download  — stream the whole skill folder as a .zip
// ---------------------------------------------------------------------------
router.get('/:id/download', authRequired, (req, res) => {
  const row = db.prepare(`${SELECT_SKILL} WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'skill not found' });

  if (!viewerCanSee(req.user, row)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  // Sanitize the skill name for use in a filename.
  const safeName =
    (row.name || 'skill').replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') ||
    'skill';

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}.zip"`);

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => {
    // Headers may already be sent; just destroy the stream.
    if (!res.headersSent) {
      res.status(500).json({ error: `zip failed: ${err.message}` });
    } else {
      res.destroy(err);
    }
  });

  archive.pipe(res);
  // Place folder contents at the zip root.
  archive.directory(row.folder_path, false);
  archive.finalize();
});

// ---------------------------------------------------------------------------
// PATCH /:id  — owner/admin: update name, category, tags, visibility
// ---------------------------------------------------------------------------
router.patch('/:id', authRequired, (req, res) => {
  const row = db.prepare(`${SELECT_SKILL} WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'skill not found' });

  if (!isOwnerOrAdmin(req.user, row)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const body = req.body || {};
  const hasOwn = (k) => Object.prototype.hasOwnProperty.call(body, k);

  // Validate everything before mutating anything.
  const updates = [];
  const params = [];

  if (hasOwn('name')) {
    if (typeof body.name !== 'string' || !body.name.trim()) {
      return res.status(400).json({ error: 'name must be a non-empty string' });
    }
    updates.push('name = ?');
    params.push(body.name.trim());
  }

  if (hasOwn('category_id')) {
    const cid = body.category_id;
    if (cid === null) {
      updates.push('category_id = ?');
      params.push(null);
    } else if (Number.isInteger(cid)) {
      const cat = db.prepare(`SELECT id FROM categories WHERE id = ?`).get(cid);
      if (!cat) return res.status(400).json({ error: 'category_id does not exist' });
      updates.push('category_id = ?');
      params.push(cid);
    } else {
      return res.status(400).json({ error: 'category_id must be an integer or null' });
    }
  }

  if (hasOwn('visibility')) {
    if (body.visibility !== 'public' && body.visibility !== 'private') {
      return res.status(400).json({ error: "visibility must be 'public' or 'private'" });
    }
    updates.push('visibility = ?');
    params.push(body.visibility);
  }

  let tagIds = null;
  if (hasOwn('tag_ids')) {
    if (!Array.isArray(body.tag_ids) || !body.tag_ids.every((t) => Number.isInteger(t))) {
      return res.status(400).json({ error: 'tag_ids must be an array of integers' });
    }
    for (const tid of body.tag_ids) {
      const tag = db.prepare(`SELECT id FROM tags WHERE id = ?`).get(tid);
      if (!tag) return res.status(400).json({ error: `tag_id ${tid} does not exist` });
    }
    tagIds = body.tag_ids;
  }

  let groupIds = null;
  if (hasOwn('groups')) {
    if (!Array.isArray(body.groups) || !body.groups.every((g) => Number.isInteger(g))) {
      return res.status(400).json({ error: 'groups must be an array of integers' });
    }
    for (const gid of body.groups) {
      const group = db.prepare(`SELECT id FROM groups WHERE id = ?`).get(gid);
      if (!group) return res.status(400).json({ error: `group ${gid} does not exist` });
    }
    groupIds = body.groups;
  }

  // Apply scalar field updates.
  if (updates.length > 0) {
    params.push(row.id);
    db.prepare(`UPDATE skills SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  }

  // Replace the tag set if tag_ids was provided.
  if (tagIds !== null) {
    db.prepare(`DELETE FROM skill_tags WHERE skill_id = ?`).run(row.id);
    const insert = db.prepare(
      `INSERT OR IGNORE INTO skill_tags (skill_id, tag_id) VALUES (?, ?)`
    );
    for (const tid of tagIds) insert.run(row.id, tid);
  }

  // Replace the group set if groups was provided.
  if (groupIds !== null) {
    db.prepare(`DELETE FROM skill_groups WHERE skill_id = ?`).run(row.id);
    const insert = db.prepare(
      `INSERT OR IGNORE INTO skill_groups (skill_id, group_id) VALUES (?, ?)`
    );
    for (const gid of groupIds) insert.run(row.id, gid);
  }

  const updated = db.prepare(`${SELECT_SKILL} WHERE id = ?`).get(row.id);
  const summary = skillSummary(updated, req.user.id);
  // Reflect the (possibly updated) group set in the response, mirroring the
  // detail endpoint so the client can re-render the share UI after a PATCH.
  summary.groups = skillGroups(updated.id);
  res.json(summary);
});

// ---------------------------------------------------------------------------
// PUT /:id/file  — owner/admin: overwrite an existing file's content
// ---------------------------------------------------------------------------
router.put('/:id/file', authRequired, (req, res) => {
  const row = db.prepare(`${SELECT_SKILL} WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'skill not found' });

  if (!isOwnerOrAdmin(req.user, row)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const { path: rel, content } = req.body || {};
  if (typeof rel !== 'string' || !rel.trim()) {
    return res.status(400).json({ error: 'path is required' });
  }
  if (typeof content !== 'string') {
    return res.status(400).json({ error: 'content (string) is required' });
  }

  try {
    writeSkillFile(row.folder_path, rel, content);
  } catch (err) {
    if (err.message === 'path traversal rejected') {
      return res.status(400).json({ error: 'invalid path' });
    }
    if (err.code === 'ENOENT') {
      return res.status(404).json({ error: 'file not found' });
    }
    return res.status(500).json({ error: `write failed: ${err.message}` });
  }

  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /internal  — upload a .zip of a skill folder
// ---------------------------------------------------------------------------
router.post('/internal', authRequired, upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'file (zip) is required' });
  }

  const zipPath = req.file.path;
  // Unique extraction dir under tmp.
  const extractDir = path.join(
    os.tmpdir(),
    `agentskill-extract-${Date.now()}-${randomBytes(6).toString('hex')}`
  );

  const tempsToClean = [extractDir];
  const removeUpload = () => {
    try { fs.rmSync(zipPath, { force: true }); } catch { /* ignore */ }
  };
  const cleanAll = () => {
    removeUpload();
    for (const d of tempsToClean) cleanup(d);
  };

  try {
    fs.mkdirSync(extractDir, { recursive: true });
    let zip;
    try {
      zip = new AdmZip(zipPath);
      zip.extractAllTo(extractDir, /* overwrite */ true);
    } catch {
      cleanAll();
      return res.status(400).json({ error: 'invalid zip file' });
    }

    // Determine the skill folder: prefer the extracted root if it has a
    // SKILL.md, else fall back to the first findSkillFolders() match.
    let skillFolder = null;
    if (folderHasSkillMd(extractDir)) {
      skillFolder = extractDir;
    } else {
      const found = findSkillFolders(extractDir);
      if (found.length > 0) skillFolder = found[0];
    }

    if (!skillFolder) {
      cleanAll();
      return res.status(400).json({ error: 'no SKILL.md found' });
    }

    // Optional name override from multipart field; else john's picker.
    const override = typeof req.body?.name === 'string' && req.body.name.trim()
      ? req.body.name.trim()
      : null;
    const name = override || pickSkillName(skillFolder);

    // Insert with a placeholder folder_path, then store and update it.
    const info = db
      .prepare(
        `INSERT INTO skills (name, owner_id, type, visibility, folder_path)
         VALUES (?, ?, 'internal', 'public', '')`
      )
      .run(name, req.user.id);
    const id = info.lastInsertRowid;

    const dest = storeSkillFolder(id, skillFolder);
    db.prepare(`UPDATE skills SET folder_path = ? WHERE id = ?`).run(dest, id);

    cleanAll();

    const row = db.prepare(`${SELECT_SKILL} WHERE id = ?`).get(id);
    return res.status(201).json(skillSummary(row, req.user.id));
  } catch (err) {
    cleanAll();
    return res.status(500).json({ error: `internal upload failed: ${err.message}` });
  }
});

// ---------------------------------------------------------------------------
// POST /external  — clone a public GitHub repo, one skill per SKILL.md folder
// ---------------------------------------------------------------------------
router.post('/external', authRequired, async (req, res) => {
  const url = req.body?.url;
  if (typeof url !== 'string' || !url.trim()) {
    return res.status(400).json({ error: 'url is required' });
  }

  let repoDir;
  try {
    repoDir = await cloneRepo(url.trim());
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  try {
    const folders = findSkillFolders(repoDir);
    if (folders.length === 0) {
      cleanup(repoDir);
      return res.status(400).json({ error: 'no SKILL.md found' });
    }

    const created = [];
    for (const folder of folders) {
      const name = pickSkillName(folder);
      const info = db
        .prepare(
          `INSERT INTO skills (name, owner_id, type, visibility, source_url, folder_path)
           VALUES (?, ?, 'external', 'public', ?, '')`
        )
        .run(name, req.user.id, url.trim());
      const id = info.lastInsertRowid;

      const dest = storeSkillFolder(id, folder);
      db.prepare(`UPDATE skills SET folder_path = ? WHERE id = ?`).run(dest, id);

      const row = db.prepare(`${SELECT_SKILL} WHERE id = ?`).get(id);
      created.push(skillSummary(row, req.user.id));
    }

    cleanup(repoDir);
    return res.status(201).json({ count: created.length, created });
  } catch (err) {
    cleanup(repoDir);
    return res.status(500).json({ error: `external upload failed: ${err.message}` });
  }
});

export default router;

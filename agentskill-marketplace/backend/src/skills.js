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

import { db } from './db.js';
import { authRequired } from './auth.js';
import { canSee } from './visibility.js';
import {
  buildFileTree,
  storeSkillFolder,
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

/**
 * Build the public summary for a skill row.
 * @param {object} row    a row from the skills table (must include id, name,
 *                        type, owner_id, category_id, visibility, source_url)
 * @returns {{id, name, type, owner:{id,username}, category:(string|null),
 *            tags:string[], visibility, source_url}}
 */
function skillSummary(row) {
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

  return {
    id: row.id,
    name: row.name,
    type: row.type,
    owner: { id: owner.id, username: owner.username },
    category,
    tags,
    visibility: row.visibility,
    source_url: row.source_url ?? null,
  };
}

const SELECT_SKILL = `SELECT id, name, owner_id, type, category_id, visibility, source_url, folder_path, created_at FROM skills`;

// ---------------------------------------------------------------------------
// GET /  — list every skill the viewer can see
// ---------------------------------------------------------------------------
router.get('/', authRequired, (req, res) => {
  const rows = db.prepare(`${SELECT_SKILL} ORDER BY created_at DESC, id DESC`).all();
  const ugids = userGroupIds(req.user.id);

  const visible = rows.filter((row) =>
    canSee({
      user: req.user,
      skill: row,
      userGroupIds: ugids,
      skillGroupIds: row.visibility === 'private' ? skillGroupIds(row.id) : [],
    })
  );

  res.json({ skills: visible.map((row) => skillSummary(row)) });
});

// ---------------------------------------------------------------------------
// GET /:id  — detail + file tree
// ---------------------------------------------------------------------------
router.get('/:id', authRequired, (req, res) => {
  const row = db.prepare(`${SELECT_SKILL} WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'skill not found' });

  const allowed = canSee({
    user: req.user,
    skill: row,
    userGroupIds: userGroupIds(req.user.id),
    skillGroupIds: row.visibility === 'private' ? skillGroupIds(row.id) : [],
  });
  if (!allowed) return res.status(403).json({ error: 'forbidden' });

  const summary = skillSummary(row);
  summary.files = buildFileTree(row.folder_path);
  res.json(summary);
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
    return res.status(201).json(skillSummary(row));
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
      created.push(skillSummary(row));
    }

    cleanup(repoDir);
    return res.status(201).json({ count: created.length, created });
  } catch (err) {
    cleanup(repoDir);
    return res.status(500).json({ error: `external upload failed: ${err.message}` });
  }
});

export default router;

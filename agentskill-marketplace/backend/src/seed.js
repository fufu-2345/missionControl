import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { db, initDb } from './db.js';
import { storeSkillFolder } from './storage.js';

/**
 * Idempotent seed. Safe to run repeatedly — rows that already exist are skipped.
 * Seeds: admin user, sample user (alice), categories, tags, one group, and a
 * set of sample skills (only when the skills table is empty).
 */
export function seed() {
  initDb();

  const insertUser = db.prepare(
    `INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)`
  );
  const findUser = db.prepare(`SELECT id FROM users WHERE username = ?`);

  function ensureUser(username, password, role) {
    if (findUser.get(username)) return;
    const hash = bcrypt.hashSync(password, 10);
    insertUser.run(username, hash, role);
  }

  ensureUser('admin', 'admin', 'admin');
  ensureUser('alice', 'alice123', 'user');

  const insertCategory = db.prepare(
    `INSERT OR IGNORE INTO categories (name) VALUES (?)`
  );
  for (const name of ['utility', 'data', 'devtools']) {
    insertCategory.run(name);
  }

  const insertTag = db.prepare(`INSERT OR IGNORE INTO tags (name) VALUES (?)`);
  for (const name of ['cli', 'ai', 'format', 'git']) {
    insertTag.run(name);
  }

  const insertGroup = db.prepare(`INSERT OR IGNORE INTO groups (name) VALUES (?)`);
  insertGroup.run('internal-team');

  // Sample skills (idempotent — only runs when the skills table is empty).
  seedSkills();

  return db;
}

/**
 * Seed a handful of real, downloadable sample skills.
 *
 * Idempotent: guarded by `SELECT COUNT(*) FROM skills` — if any skill already
 * exists this is a no-op, so re-running the seed never duplicates folders/rows.
 *
 * For each sample we:
 *   1. write a real skill folder (SKILL.md + 1-2 extra files) to a temp dir,
 *   2. insert a `skills` row with a placeholder folder_path,
 *   3. copy the folder into storage/skills/<id>/ via storeSkillFolder,
 *   4. update folder_path to the on-disk location,
 *   5. attach its category + tags, and (when private) its group.
 * Finally we add a few stars so recommendations / starCount have data.
 */
export function seedSkills() {
  const { n } = db.prepare(`SELECT COUNT(*) AS n FROM skills`).get();
  if (n > 0) return; // already seeded — keep idempotent

  // --- id lookups by name (order-independent) ---
  const userId = (name) =>
    db.prepare(`SELECT id FROM users WHERE username = ?`).get(name)?.id;
  const categoryId = (name) =>
    db.prepare(`SELECT id FROM categories WHERE name = ?`).get(name)?.id;
  const tagId = (name) =>
    db.prepare(`SELECT id FROM tags WHERE name = ?`).get(name)?.id;
  const groupId = (name) =>
    db.prepare(`SELECT id FROM groups WHERE name = ?`).get(name)?.id;

  const adminId = userId('admin');
  const aliceId = userId('alice');

  // --- prepared statements (reuse existing schema) ---
  const insertSkill = db.prepare(
    `INSERT INTO skills (name, owner_id, type, category_id, visibility, source_url, folder_path)
     VALUES (@name, @owner_id, @type, @category_id, @visibility, @source_url, '')`
  );
  const setFolderPath = db.prepare(
    `UPDATE skills SET folder_path = ? WHERE id = ?`
  );
  const linkTag = db.prepare(
    `INSERT OR IGNORE INTO skill_tags (skill_id, tag_id) VALUES (?, ?)`
  );
  const linkGroup = db.prepare(
    `INSERT OR IGNORE INTO skill_groups (skill_id, group_id) VALUES (?, ?)`
  );
  const addUserToGroup = db.prepare(
    `INSERT OR IGNORE INTO user_groups (user_id, group_id) VALUES (?, ?)`
  );
  const addStar = db.prepare(
    `INSERT OR IGNORE INTO stars (user_id, skill_id) VALUES (?, ?)`
  );

  /**
   * Write {filename: content} into a fresh temp dir and return its path.
   * The temp dir is the source for storeSkillFolder; storage holds the real copy.
   */
  function writeTempSkill(files) {
    const dir = path.join(
      os.tmpdir(),
      `agentskill-seed-${Date.now()}-${randomBytes(6).toString('hex')}`
    );
    fs.mkdirSync(dir, { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf8');
    }
    return dir;
  }

  const skillMd = (name, body) => `---\nname: ${name}\n---\n\n# ${name}\n\n${body}\n`;

  // --- sample skill definitions ---
  const samples = [
    {
      name: 'Hello CLI',
      owner_id: aliceId,
      type: 'internal',
      category: 'utility',
      tags: ['cli'],
      visibility: 'public',
      source_url: null,
      files: {
        'SKILL.md': skillMd(
          'Hello CLI',
          'A tiny command-line greeter. Run it to print a friendly hello to the terminal.'
        ),
        'README.md':
          '# Hello CLI\n\nUsage: `node hello.js [name]`\n\nPrints a greeting. Defaults to "world".\n',
        'hello.js':
          "#!/usr/bin/env node\nconst who = process.argv[2] || 'world';\nconsole.log(`hello, ${who}!`);\n",
      },
    },
    {
      name: 'CSV Formatter',
      owner_id: aliceId,
      type: 'internal',
      category: 'data',
      tags: ['format', 'cli'],
      visibility: 'public',
      source_url: null,
      files: {
        'SKILL.md': skillMd(
          'CSV Formatter',
          'Pretty-print and re-align CSV files into neat columns for easier reading.'
        ),
        'README.md':
          '# CSV Formatter\n\nReads a CSV from stdin and prints aligned columns to stdout.\n',
        'format.js':
          "// Align CSV columns.\nconst rows = require('fs').readFileSync(0, 'utf8').trim().split('\\n').map((l) => l.split(','));\nconst widths = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] || '').length)));\nfor (const r of rows) console.log(r.map((c, i) => (c || '').padEnd(widths[i])).join('  '));\n",
      },
    },
    {
      name: 'Git Cleanup Helper',
      owner_id: adminId,
      type: 'internal',
      category: 'devtools',
      tags: ['git', 'cli'],
      visibility: 'public',
      source_url: null,
      files: {
        'SKILL.md': skillMd(
          'Git Cleanup Helper',
          'Prune merged local branches and stale remote-tracking refs in one command.'
        ),
        'README.md':
          '# Git Cleanup Helper\n\nRun `./cleanup.sh` to delete branches already merged into main.\n',
        'cleanup.sh':
          "#!/usr/bin/env bash\nset -euo pipefail\ngit fetch --prune\ngit branch --merged main | grep -vE '^\\*|main' | xargs -r git branch -d\n",
      },
    },
    {
      name: 'JSON Pretty Printer',
      owner_id: aliceId,
      type: 'internal',
      category: 'data',
      tags: ['format'],
      visibility: 'public',
      source_url: null,
      files: {
        'SKILL.md': skillMd(
          'JSON Pretty Printer',
          'Reformat compact JSON into indented, human-readable output.'
        ),
        'pretty.js':
          "const data = require('fs').readFileSync(0, 'utf8');\nconsole.log(JSON.stringify(JSON.parse(data), null, 2));\n",
      },
    },
    {
      name: 'AI Prompt Toolkit',
      owner_id: adminId,
      type: 'external',
      category: 'utility',
      tags: ['ai'],
      visibility: 'public',
      source_url: 'https://github.com/example/ai-prompt-toolkit',
      files: {
        'SKILL.md': skillMd(
          'AI Prompt Toolkit',
          'A curated collection of reusable prompt templates for common LLM tasks.'
        ),
        'README.md':
          '# AI Prompt Toolkit\n\nDrop-in prompt templates for summarization, extraction, and rewriting.\n',
        'prompts.md':
          '# Prompt Library\n\n## Summarize\n> Summarize the following text in 3 bullet points.\n\n## Extract\n> Extract every email address as a JSON array.\n',
      },
    },
    {
      name: 'Repo Stats Reporter',
      owner_id: adminId,
      type: 'external',
      category: 'devtools',
      tags: ['git', 'ai'],
      visibility: 'private',
      source_url: 'https://github.com/example/repo-stats-reporter',
      files: {
        'SKILL.md': skillMd(
          'Repo Stats Reporter',
          'Internal-only tool that summarizes commit activity and contributor stats for a repo.'
        ),
        'README.md':
          '# Repo Stats Reporter\n\nPrivate skill shared only with the internal team.\nRun `node report.js` inside a git repo.\n',
        'report.js':
          "const { execSync } = require('node:child_process');\nconst out = execSync('git shortlog -sn --all', { encoding: 'utf8' });\nconsole.log('Contributors by commit count:\\n' + out);\n",
      },
    },
  ];

  // Insert each sample inside a single transaction for consistency.
  const created = [];
  const tx = db.transaction(() => {
    for (const s of samples) {
      const info = insertSkill.run({
        name: s.name,
        owner_id: s.owner_id,
        type: s.type,
        category_id: categoryId(s.category) ?? null,
        visibility: s.visibility,
        source_url: s.source_url,
      });
      const id = info.lastInsertRowid;

      // Write real files to a temp dir, then copy into storage/skills/<id>/.
      const srcDir = writeTempSkill(s.files);
      const dest = storeSkillFolder(id, srcDir);
      setFolderPath.run(dest, id);
      fs.rmSync(srcDir, { recursive: true, force: true }); // temp src no longer needed

      for (const t of s.tags) {
        const tid = tagId(t);
        if (tid != null) linkTag.run(id, tid);
      }

      created.push({ id, ...s });
    }

    // --- private skill <-> group wiring ---
    const internalTeam = groupId('internal-team');
    const privateSkill = created.find((c) => c.visibility === 'private');
    if (internalTeam != null && privateSkill) {
      linkGroup.run(privateSkill.id, internalTeam);
      // Add alice to the group so group-based visibility is demonstrable.
      if (aliceId != null) addUserToGroup.run(aliceId, internalTeam);
    }

    // --- stars (drives starCount + content-based recommendations) ---
    const byName = (name) => created.find((c) => c.name === name)?.id;
    const starPairs = [
      [aliceId, byName('Hello CLI')],
      [aliceId, byName('CSV Formatter')],
      [aliceId, byName('Git Cleanup Helper')],
      [adminId, byName('AI Prompt Toolkit')],
      [adminId, byName('CSV Formatter')],
      [adminId, byName('Repo Stats Reporter')],
    ];
    for (const [uid, sid] of starPairs) {
      if (uid != null && sid != null) addStar.run(uid, sid);
    }
  });
  tx();

  return created;
}

export default seed;

// Run when invoked directly: `node src/seed.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  seed();
  console.log(
    '[seed] done — admin/alice users, categories, tags, group, and sample skills ensured.'
  );
}

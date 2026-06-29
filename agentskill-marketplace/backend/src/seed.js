import bcrypt from 'bcryptjs';
import { db, initDb } from './db.js';

/**
 * Idempotent seed. Safe to run repeatedly — rows that already exist are skipped.
 * Seeds: admin user, sample user (alice), categories, tags, one group.
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

  ensureUser('admin', 'admin123', 'admin');
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

  return db;
}

export default seed;

// Run when invoked directly: `node src/seed.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  seed();
  console.log('[seed] done — admin/alice users, categories, tags, group ensured.');
}

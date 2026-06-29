import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// DB lives at backend/db.sqlite (one level up from src/).
const DB_PATH = process.env.DB_PATH || join(__dirname, '..', 'db.sqlite');

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS groups (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_groups (
      user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, group_id)
    );

    CREATE TABLE IF NOT EXISTS categories (
      id   INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS tags (
      id   INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS skills (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      owner_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type        TEXT NOT NULL CHECK (type IN ('internal','external')),
      category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
      visibility  TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private')),
      source_url  TEXT,
      folder_path TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS skill_tags (
      skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      tag_id   INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (skill_id, tag_id)
    );

    CREATE TABLE IF NOT EXISTS skill_groups (
      skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      PRIMARY KEY (skill_id, group_id)
    );

    CREATE TABLE IF NOT EXISTS stars (
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      skill_id   INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, skill_id)
    );
  `);

  return db;
}

// Ensure the schema exists for ANY importer (server, tests, scripts).
// initDb() is idempotent (CREATE TABLE IF NOT EXISTS), so this is safe to run
// on module load and again from server.js.
initDb();

export default db;

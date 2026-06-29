// Disk storage helpers for skill folders.
//
// Skills are stored on disk at backend/storage/skills/<skillId>/.
// All functions are pure filesystem operations — no DB access.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// storage/ lives at backend/storage (one level up from src/).
export const STORAGE_ROOT = path.join(__dirname, '..', 'storage', 'skills');

/**
 * Recursively copy a directory tree from srcDir to destDir.
 * Creates destDir (and parents) as needed. Files and nested dirs are copied;
 * symlinks are dereferenced into regular files/dirs.
 *
 * @param {string} srcDir
 * @param {string} destDir
 */
export function copyDir(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    let isDir = entry.isDirectory();
    // Resolve symlinks so we copy real content, not broken links.
    if (entry.isSymbolicLink()) {
      try {
        isDir = fs.statSync(srcPath).isDirectory();
      } catch {
        continue; // dangling symlink — skip
      }
    }
    if (isDir) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Copy a source folder into storage/skills/<skillId>/.
 * The destination is wiped first so re-stores are clean.
 *
 * @param {number|string} skillId
 * @param {string} srcDir
 * @returns {string} the destination path (storage/skills/<skillId>)
 */
export function storeSkillFolder(skillId, srcDir) {
  const destDir = path.join(STORAGE_ROOT, String(skillId));
  fs.rmSync(destDir, { recursive: true, force: true });
  copyDir(srcDir, destDir);
  return destDir;
}

/**
 * Walk a skill directory and return every file as {path, size}, where `path`
 * is RELATIVE to skillDir (POSIX-style separators) and `size` is in bytes.
 * Recurses into all subdirectories. Directories themselves are not listed.
 *
 * @param {string} skillDir
 * @returns {Array<{path: string, size: number}>}
 */
export function buildFileTree(skillDir) {
  const out = [];

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // missing/unreadable dir — return what we have
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        let size = 0;
        try {
          size = fs.statSync(abs).size;
        } catch {
          size = 0;
        }
        const rel = path.relative(skillDir, abs).split(path.sep).join('/');
        out.push({ path: rel, size });
      }
    }
  }

  walk(skillDir);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

/**
 * Resolve a relative path inside skillDir, rejecting any traversal that would
 * escape skillDir. Returns the absolute path on success.
 *
 * @param {string} skillDir
 * @param {string} relPath
 * @returns {string} absolute path inside skillDir
 * @throws {Error} if the resolved path escapes skillDir
 */
export function safeJoin(skillDir, relPath) {
  const root = path.resolve(skillDir);
  const target = path.resolve(root, relPath);
  // Must be inside root: equal to root (unlikely for a file) or below it.
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error('path traversal rejected');
  }
  return target;
}

/**
 * Safely read a file inside a skill directory by its relative path.
 * Rejects path traversal that would escape skillDir.
 *
 * @param {string} skillDir
 * @param {string} relPath
 * @returns {string} file content as UTF-8 text
 * @throws {Error} if the resolved path escapes skillDir or the file is missing
 */
export function readSkillFile(skillDir, relPath) {
  const target = safeJoin(skillDir, relPath);
  return fs.readFileSync(target, 'utf8');
}

/**
 * Safely write text content to an EXISTING file inside a skill directory.
 * Rejects path traversal that would escape skillDir, and refuses to create
 * new files — the target must already exist as a regular file.
 *
 * @param {string} skillDir
 * @param {string} relPath
 * @param {string} content  UTF-8 text to write
 * @throws {Error} if the path escapes skillDir or the file does not exist
 */
export function writeSkillFile(skillDir, relPath, content) {
  const target = safeJoin(skillDir, relPath);
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    const err = new Error('file not found');
    err.code = 'ENOENT';
    throw err;
  }
  if (!stat.isFile()) {
    const err = new Error('file not found');
    err.code = 'ENOENT';
    throw err;
  }
  fs.writeFileSync(target, content, 'utf8');
}

export default {
  STORAGE_ROOT,
  copyDir,
  storeSkillFolder,
  buildFileTree,
  safeJoin,
  readSkillFile,
  writeSkillFile,
};

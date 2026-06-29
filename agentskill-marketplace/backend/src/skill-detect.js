// Pure filesystem helpers for detecting skill folders.
//
// A "skill folder" is any directory that directly contains a file named
// SKILL.md / skill.md (case-insensitive). Spec §1: external uploads clone a
// repo, traverse for such folders, and treat EACH one as a separate skill.
//
// These helpers are pure (filesystem-only, no DB, no Express) and are imported
// by bob's src/skills.js with EXACTLY these names/signatures:
//   folderHasSkillMd(dir)  -> boolean
//   findSkillFolders(root) -> string[]   (absolute paths)
//   pickSkillName(dir)     -> string

import fs from 'node:fs';
import path from 'node:path';

// Directories we never descend into during traversal.
const IGNORED_DIRS = new Set(['.git', 'node_modules']);

/** True if `name` is a SKILL.md marker file (case-insensitive). */
function isSkillMd(name) {
  return name.toLowerCase() === 'skill.md';
}

/**
 * folderHasSkillMd(dir) -> boolean
 * True iff `dir` directly contains a file named SKILL.md / skill.md
 * (case-insensitive). Only the immediate children of `dir` are checked —
 * it does NOT recurse. A directory named "SKILL.md" does not count.
 */
export function folderHasSkillMd(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some((e) => e.isFile() && isSkillMd(e.name));
}

/**
 * findSkillFolders(rootDir) -> string[]
 * Recursively walk `rootDir` and return the absolute path of every folder that
 * directly contains a SKILL.md / skill.md (case-insensitive). Skips `.git` and
 * `node_modules`. A repo with 3 skill folders yields 3 paths. The result is
 * deduplicated and sorted for deterministic ordering.
 */
export function findSkillFolders(rootDir) {
  const root = path.resolve(rootDir);
  const found = new Set();

  const walk = (dir) => {
    if (folderHasSkillMd(dir)) {
      found.add(dir);
    }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (IGNORED_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name));
    }
  };

  walk(root);
  return [...found].sort();
}

/**
 * pickSkillName(dir) -> string
 * Read the SKILL.md / skill.md inside `dir`. If it begins with a YAML
 * frontmatter block (a `---` line, content, then a closing `---` line) that
 * contains a `name:` field, return that value. Otherwise fall back to the
 * folder's basename.
 *
 * Frontmatter parsing is intentionally minimal (no yaml dependency):
 *   - the file must START with a line that is exactly `---`;
 *   - we capture everything up to the next line that is exactly `---`;
 *   - within that block we regex the first `name:` line and take its value,
 *     stripping surrounding quotes and a trailing inline `# comment`.
 */
export function pickSkillName(dir) {
  const fallback = path.basename(path.resolve(dir));

  // Locate the marker file (case-insensitive) inside dir.
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return fallback;
  }
  const markerEntry = entries.find((e) => e.isFile() && isSkillMd(e.name));
  if (!markerEntry) return fallback;

  let content;
  try {
    content = fs.readFileSync(path.join(dir, markerEntry.name), 'utf8');
  } catch {
    return fallback;
  }

  const name = parseFrontmatterName(content);
  return name || fallback;
}

/**
 * parseFrontmatterName(content) -> string | null
 * Extract the `name:` value from a leading `---`…`---` YAML frontmatter block.
 * Returns null when there is no frontmatter or no name field.
 */
function parseFrontmatterName(content) {
  // Match a leading frontmatter block: `---` on the first line, then the body,
  // then a closing `---` on its own line. Tolerate a UTF-8 BOM and \r\n.
  const fmMatch = content
    .replace(/^﻿/, '')
    .match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!fmMatch) return null;

  const block = fmMatch[1];
  // First `name:` line within the block (must be a key at line start).
  const nameMatch = block.match(/^[ \t]*name[ \t]*:[ \t]*(.+?)[ \t]*$/m);
  if (!nameMatch) return null;

  let value = nameMatch[1].trim();
  const quote = value[0] === '"' || value[0] === "'" ? value[0] : null;
  if (quote) {
    // Quoted value: take everything up to the matching closing quote and
    // ignore any trailing inline comment that follows it.
    const closing = value.indexOf(quote, 1);
    if (closing !== -1) {
      value = value.slice(1, closing);
    } else {
      value = value.slice(1); // unterminated quote — take the rest
    }
  } else {
    // Unquoted value: strip a trailing inline `# comment`.
    value = value.replace(/\s+#.*$/, '').trim();
  }
  return value.trim() || null;
}

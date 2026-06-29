import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  folderHasSkillMd,
  findSkillFolders,
  pickSkillName,
} from '../src/skill-detect.js';

// ---------------------------------------------------------------------------
// Fixture helpers — everything is built under a single mkdtemp root that is
// removed in afterAll, so no real repo files are touched.
// ---------------------------------------------------------------------------

let root; // unique temp root for the whole suite

const mkdir = (...parts) => {
  const p = path.join(root, ...parts);
  fs.mkdirSync(p, { recursive: true });
  return p;
};

const writeFile = (dir, name, content = '') => {
  fs.writeFileSync(path.join(dir, name), content);
};

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-detect-'));

  // -- folderHasSkillMd fixtures --
  const hasUpper = mkdir('has-upper'); // SKILL.md
  writeFile(hasUpper, 'SKILL.md', '# upper');

  const hasLower = mkdir('has-lower'); // skill.md
  writeFile(hasLower, 'skill.md', '# lower');

  const hasMixed = mkdir('has-mixed'); // SkIlL.Md
  writeFile(hasMixed, 'SkIlL.Md', '# mixed');

  const noSkill = mkdir('no-skill'); // README.md only
  writeFile(noSkill, 'README.md', '# nope');

  // A directory literally NAMED SKILL.md should NOT count as having one.
  const dirNamedSkill = mkdir('dir-named-skill');
  fs.mkdirSync(path.join(dirNamedSkill, 'SKILL.md'));

  // -- findSkillFolders: a "0 skills" tree --
  const treeZero = mkdir('tree-zero');
  writeFile(treeZero, 'README.md', 'no skills here');
  mkdir('tree-zero', 'sub');
  writeFile(path.join(treeZero, 'sub'), 'README.md', 'still none');

  // -- findSkillFolders: a "1 skill" tree --
  const treeOne = mkdir('tree-one');
  writeFile(treeOne, 'SKILL.md', '# one');
  mkdir('tree-one', 'docs'); // extra non-skill folder
  writeFile(path.join(treeOne, 'docs'), 'guide.md', '# guide');

  // -- findSkillFolders: a "3 skills" tree (nested) + .git that must be skipped --
  const treeThree = mkdir('tree-three');
  const a = mkdir('tree-three', 'alpha');
  writeFile(a, 'SKILL.md', '# alpha');
  const b = mkdir('tree-three', 'nested', 'beta');
  writeFile(b, 'skill.md', '# beta');
  const c = mkdir('tree-three', 'nested', 'deep', 'gamma');
  writeFile(c, 'Skill.MD', '# gamma');
  // Decoy folder with no marker.
  mkdir('tree-three', 'plain');
  writeFile(path.join(treeThree, 'plain'), 'notes.txt', 'hello');
  // A .git dir that itself contains a SKILL.md — must be skipped entirely.
  const gitDir = mkdir('tree-three', '.git');
  writeFile(gitDir, 'SKILL.md', '# should be ignored');
  const gitNested = mkdir('tree-three', '.git', 'hooks');
  writeFile(gitNested, 'skill.md', '# also ignored');
  // A node_modules dir with a SKILL.md — must also be skipped.
  const nm = mkdir('tree-three', 'node_modules', 'pkg');
  writeFile(nm, 'SKILL.md', '# ignored dep');

  // -- pickSkillName fixtures --
  // frontmatter with name
  const fmNamed = mkdir('fm-named');
  writeFile(
    fmNamed,
    'SKILL.md',
    ['---', 'name: Fancy Skill Name', 'description: whatever', '---', '', '# body'].join('\n'),
  );

  // frontmatter present but NO name -> fallback to basename
  const fmNoName = mkdir('fm-no-name');
  writeFile(
    fmNoName,
    'SKILL.md',
    ['---', 'description: just a desc', '---', '# body'].join('\n'),
  );

  // no frontmatter at all -> fallback to basename
  const fmNone = mkdir('fm-none');
  writeFile(fmNone, 'skill.md', '# Just a heading, no frontmatter');

  // quoted name + inline comment + lowercase marker
  const fmQuoted = mkdir('fm-quoted');
  writeFile(
    fmQuoted,
    'skill.md',
    ['---', 'name: "Quoted Name"  # inline comment', '---', 'body'].join('\n'),
  );

  // unquoted name with a trailing inline comment
  const fmComment = mkdir('fm-comment');
  writeFile(
    fmComment,
    'SKILL.md',
    ['---', 'name: bare-name # trailing comment', '---'].join('\n'),
  );

  // directory with no marker file at all -> fallback to basename
  mkdir('fm-missing');
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('folderHasSkillMd', () => {
  it('is true for a folder containing SKILL.md (uppercase)', () => {
    expect(folderHasSkillMd(path.join(root, 'has-upper'))).toBe(true);
  });

  it('is true for a folder containing skill.md (lowercase)', () => {
    expect(folderHasSkillMd(path.join(root, 'has-lower'))).toBe(true);
  });

  it('is true for mixed-case SkIlL.Md (case-insensitive)', () => {
    expect(folderHasSkillMd(path.join(root, 'has-mixed'))).toBe(true);
  });

  it('is false for a folder with no SKILL.md', () => {
    expect(folderHasSkillMd(path.join(root, 'no-skill'))).toBe(false);
  });

  it('is false when SKILL.md is a directory, not a file', () => {
    expect(folderHasSkillMd(path.join(root, 'dir-named-skill'))).toBe(false);
  });

  it('is false for a path that does not exist', () => {
    expect(folderHasSkillMd(path.join(root, 'does-not-exist'))).toBe(false);
  });
});

describe('findSkillFolders', () => {
  it('returns [] for a tree with 0 skill folders', () => {
    expect(findSkillFolders(path.join(root, 'tree-zero'))).toEqual([]);
  });

  it('returns 1 path for a tree with a single skill folder', () => {
    const result = findSkillFolders(path.join(root, 'tree-one'));
    expect(result).toEqual([path.join(root, 'tree-one')]);
  });

  it('returns 3 absolute paths for a nested tree with 3 skill folders', () => {
    const result = findSkillFolders(path.join(root, 'tree-three'));
    expect(result).toHaveLength(3);
    expect(result.every((p) => path.isAbsolute(p))).toBe(true);
    expect(result.sort()).toEqual(
      [
        path.join(root, 'tree-three', 'alpha'),
        path.join(root, 'tree-three', 'nested', 'beta'),
        path.join(root, 'tree-three', 'nested', 'deep', 'gamma'),
      ].sort(),
    );
  });

  it('skips .git and node_modules even when they contain SKILL.md', () => {
    const result = findSkillFolders(path.join(root, 'tree-three'));
    expect(result.some((p) => p.includes(`${path.sep}.git`))).toBe(false);
    expect(result.some((p) => p.includes('node_modules'))).toBe(false);
  });

  it('includes the root itself when it directly contains a SKILL.md', () => {
    const result = findSkillFolders(path.join(root, 'tree-one'));
    expect(result).toContain(path.join(root, 'tree-one'));
  });
});

describe('pickSkillName', () => {
  it('returns the frontmatter name when present', () => {
    expect(pickSkillName(path.join(root, 'fm-named'))).toBe('Fancy Skill Name');
  });

  it('falls back to the folder basename when frontmatter has no name', () => {
    expect(pickSkillName(path.join(root, 'fm-no-name'))).toBe('fm-no-name');
  });

  it('falls back to the folder basename when there is no frontmatter', () => {
    expect(pickSkillName(path.join(root, 'fm-none'))).toBe('fm-none');
  });

  it('strips surrounding quotes and inline comments from the name', () => {
    expect(pickSkillName(path.join(root, 'fm-quoted'))).toBe('Quoted Name');
  });

  it('strips a trailing inline comment from an unquoted name', () => {
    expect(pickSkillName(path.join(root, 'fm-comment'))).toBe('bare-name');
  });

  it('falls back to basename when no SKILL.md file exists in the folder', () => {
    expect(pickSkillName(path.join(root, 'fm-missing'))).toBe('fm-missing');
  });
});

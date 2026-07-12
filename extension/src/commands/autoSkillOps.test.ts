import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  AUTO_SKILL_BLOCK,
  BEGIN_MARKER,
  END_MARKER,
  isAutoSkillEnabled,
  setAutoSkillEnabled,
} from "./autoSkillOps";

// Point MC_CLAUDE_MD_PATH at a throwaway CLAUDE.md so nothing touches the real one.
let tmp: string;
let mdPath: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mc-autoskill-"));
  mdPath = path.join(tmp, "CLAUDE.md");
  process.env.MC_CLAUDE_MD_PATH = mdPath;
});

afterEach(() => {
  delete process.env.MC_CLAUDE_MD_PATH;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("auto-skill toggle", () => {
  test("missing file → disabled", () => {
    expect(isAutoSkillEnabled()).toBe(false);
  });

  test("enable on empty → block present + enabled", () => {
    setAutoSkillEnabled(true);
    const txt = fs.readFileSync(mdPath, "utf8");
    expect(txt.includes(BEGIN_MARKER)).toBe(true);
    expect(txt.includes(END_MARKER)).toBe(true);
    expect(isAutoSkillEnabled()).toBe(true);
  });

  test("enable is idempotent → block appears exactly once", () => {
    setAutoSkillEnabled(true);
    setAutoSkillEnabled(true);
    const txt = fs.readFileSync(mdPath, "utf8");
    const count = txt.split(BEGIN_MARKER).length - 1;
    expect(count).toBe(1);
  });

  test("enable preserves pre-existing content", () => {
    fs.writeFileSync(mdPath, "@RTK.md\n\n# Existing stuff\nkeep me\n");
    setAutoSkillEnabled(true);
    const txt = fs.readFileSync(mdPath, "utf8");
    expect(txt.includes("keep me")).toBe(true);
    expect(txt.includes(BEGIN_MARKER)).toBe(true);
  });

  test("disable removes the block but keeps the rest", () => {
    fs.writeFileSync(mdPath, "@RTK.md\n\nkeep me\n");
    setAutoSkillEnabled(true);
    expect(isAutoSkillEnabled()).toBe(true);
    setAutoSkillEnabled(false);
    const txt = fs.readFileSync(mdPath, "utf8");
    expect(isAutoSkillEnabled()).toBe(false);
    expect(txt.includes(BEGIN_MARKER)).toBe(false);
    expect(txt.includes(END_MARKER)).toBe(false);
    expect(txt.includes("# Skill Discipline")).toBe(false); // heading (inside markers) gone too
    expect(txt.includes("keep me")).toBe(true);
    expect(txt.includes("@RTK.md")).toBe(true);
  });

  test("disable when absent → no-op, no crash", () => {
    fs.writeFileSync(mdPath, "just this\n");
    setAutoSkillEnabled(false);
    expect(fs.readFileSync(mdPath, "utf8")).toBe("just this\n");
  });

  test("enable then disable is a clean round-trip", () => {
    fs.writeFileSync(mdPath, "line one\n");
    setAutoSkillEnabled(true);
    setAutoSkillEnabled(false);
    const txt = fs.readFileSync(mdPath, "utf8");
    expect(txt.includes("line one")).toBe(true);
    expect(txt).not.toContain(BEGIN_MARKER);
    // no runaway blank lines
    expect(txt).not.toMatch(/\n\n\n/);
  });

  test("block carries the writer invocation", () => {
    expect(AUTO_SKILL_BLOCK).toContain("auto_skill.py create");
    expect(AUTO_SKILL_BLOCK).toContain("--source");
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  orchesSettingsPath,
  readTestCapNoLimit,
  readTestCapNumber,
  writeTestCapNoLimit,
  writeTestCapNumber,
} from "./orchesConfigFile";

// Point ORCHES_SETTINGS at a throwaway file so nothing touches the real
// ~/.claude/orches/settings.json (same env override the bash cmd_test_cap uses).
let tmp: string;
let sp: string;
const read = () => JSON.parse(fs.readFileSync(sp, "utf8"));

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mc-orches-"));
  sp = path.join(tmp, "settings.json");
  process.env.ORCHES_SETTINGS = sp;
});
afterEach(() => {
  delete process.env.ORCHES_SETTINGS;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("read", () => {
  test("missing file → number 10, noLimit off", () => {
    expect(orchesSettingsPath()).toBe(sp);
    expect(readTestCapNumber()).toBe("10");
    expect(readTestCapNoLimit()).toBe(false);
  });
  test("two-key form", () => {
    fs.writeFileSync(sp, JSON.stringify({ testCap: 25, testCapNoLimit: true }));
    expect(readTestCapNumber()).toBe("25"); // number kept even while no-limit is on
    expect(readTestCapNoLimit()).toBe(true);
  });
  test("legacy single-value forms infer noLimit", () => {
    fs.writeFileSync(sp, JSON.stringify({ testCap: 0 }));
    expect(readTestCapNoLimit()).toBe(true);
    expect(readTestCapNumber()).toBe("10"); // 0 isn't a valid count → default shown
    fs.writeFileSync(sp, JSON.stringify({ testCap: "unlimited" }));
    expect(readTestCapNoLimit()).toBe(true);
  });
  test("corrupt file → defaults", () => {
    fs.writeFileSync(sp, "{not json");
    expect(readTestCapNumber()).toBe("10");
    expect(readTestCapNoLimit()).toBe(false);
  });
});

describe("writeTestCapNumber", () => {
  test("writes number, preserves toggle + other keys", () => {
    fs.writeFileSync(sp, JSON.stringify({ testCapNoLimit: true, other: "keep" }));
    expect(writeTestCapNumber("15")).toBe("15");
    expect(read().testCap).toBe(15);
    expect(read().testCapNoLimit).toBe(true); // toggle untouched
    expect(read().other).toBe("keep");
  });
  test("rejects non-integer / negative / zero / garbage", () => {
    expect(() => writeTestCapNumber("abc")).toThrow();
    expect(() => writeTestCapNumber("-3")).toThrow();
    expect(() => writeTestCapNumber("0")).toThrow();
    expect(() => writeTestCapNumber("3.5")).toThrow();
  });
});

describe("writeTestCapNoLimit", () => {
  test("toggle on/off preserves the typed number", () => {
    writeTestCapNumber("8");
    expect(writeTestCapNoLimit(true)).toBe(true);
    expect(read().testCap).toBe(8); // number survives turning limit off
    expect(readTestCapNumber()).toBe("8");
    expect(writeTestCapNoLimit(false)).toBe(false);
    expect(readTestCapNumber()).toBe("8");
  });
  test("toggling on with no prior number seeds default 10", () => {
    expect(writeTestCapNoLimit(true)).toBe(true);
    expect(read().testCap).toBe(10);
  });
  test("creates parent dir when absent", () => {
    const nested = path.join(tmp, "deep", "dir", "settings.json");
    process.env.ORCHES_SETTINGS = nested;
    writeTestCapNoLimit(true);
    expect(fs.existsSync(nested)).toBe(true);
  });
});

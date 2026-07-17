import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { orchesSettingsPath, readTestCap, writeTestCap } from "./orchesConfigFile";

// Point ORCHES_SETTINGS at a throwaway file so nothing touches the real
// ~/.claude/orches/settings.json (same env override the bash cmd_test_cap uses).
let tmp: string;
let sp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mc-orches-"));
  sp = path.join(tmp, "settings.json");
  process.env.ORCHES_SETTINGS = sp;
});
afterEach(() => {
  delete process.env.ORCHES_SETTINGS;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("readTestCap", () => {
  test("missing file → default 10", () => {
    expect(orchesSettingsPath()).toBe(sp);
    expect(readTestCap()).toBe("10");
  });
  test("numeric value", () => {
    fs.writeFileSync(sp, JSON.stringify({ testCap: 25 }));
    expect(readTestCap()).toBe("25");
  });
  test("word unlimited", () => {
    fs.writeFileSync(sp, JSON.stringify({ testCap: "unlimited" }));
    expect(readTestCap()).toBe("unlimited");
  });
  test("0 reads back as unlimited", () => {
    fs.writeFileSync(sp, JSON.stringify({ testCap: 0 }));
    expect(readTestCap()).toBe("unlimited");
  });
  test("corrupt file → default 10", () => {
    fs.writeFileSync(sp, "{not json");
    expect(readTestCap()).toBe("10");
  });
});

describe("writeTestCap", () => {
  test("writes a number and preserves other keys", () => {
    fs.writeFileSync(sp, JSON.stringify({ other: "keep" }));
    expect(writeTestCap("15")).toBe("15");
    const raw = JSON.parse(fs.readFileSync(sp, "utf8"));
    expect(raw.testCap).toBe(15);
    expect(raw.other).toBe("keep");
  });
  test("unlimited stored as the word", () => {
    expect(writeTestCap("unlimited")).toBe("unlimited");
    expect(JSON.parse(fs.readFileSync(sp, "utf8")).testCap).toBe("unlimited");
  });
  test("0 → unlimited", () => {
    expect(writeTestCap("0")).toBe("unlimited");
    expect(JSON.parse(fs.readFileSync(sp, "utf8")).testCap).toBe("unlimited");
  });
  test("creates parent dir when absent", () => {
    const nested = path.join(tmp, "deep", "dir", "settings.json");
    process.env.ORCHES_SETTINGS = nested;
    writeTestCap("7");
    expect(fs.existsSync(nested)).toBe(true);
    expect(readTestCap()).toBe("7");
  });
  test("rejects non-integer / negative / garbage", () => {
    expect(() => writeTestCap("abc")).toThrow();
    expect(() => writeTestCap("-3")).toThrow();
    expect(() => writeTestCap("3.5")).toThrow();
  });
});

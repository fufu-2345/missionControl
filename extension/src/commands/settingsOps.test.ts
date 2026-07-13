import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  getDefaultMemberModel,
  listSettings,
  readConfig,
  setSetting,
} from "./settingsOps";
import { DEFAULT_MODEL } from "./teamsModel";

// Point MC_CONFIG_PATH at a throwaway file so nothing touches the real
// ~/.mission-control/config.json.
let tmp: string;
let cfgPath: string;

function writeCfg(obj: Record<string, unknown>): void {
  fs.writeFileSync(cfgPath, JSON.stringify(obj));
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mc-settings-"));
  cfgPath = path.join(tmp, "config.json");
  process.env.MC_CONFIG_PATH = cfgPath;
});

afterEach(() => {
  delete process.env.MC_CONFIG_PATH;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("listSettings", () => {
  test("missing file → known keys fall back to defaults", () => {
    const s = listSettings();
    const merge = s.find((e) => e.key === "merge_mode");
    expect(merge?.value).toBe("online"); // the remembered default
    expect(merge?.known).toBe(true);
    // every schema field is present even with no file
    expect(s.some((e) => e.key === "default_member_model")).toBe(true);
    // the removed dead knob must not resurface
    expect(s.some((e) => e.key === "build_model")).toBe(false);
    // default_member_model falls back to the shared DEFAULT_MODEL constant
    expect(s.find((e) => e.key === "default_member_model")?.value).toBe(
      DEFAULT_MODEL,
    );
  });

  test("file value overrides the default", () => {
    writeCfg({ merge_mode: "local", default_member_model: "claude-opus-4-8" });
    const s = listSettings();
    expect(s.find((e) => e.key === "merge_mode")?.value).toBe("local");
    expect(s.find((e) => e.key === "default_member_model")?.value).toBe(
      "claude-opus-4-8",
    );
  });

  test("unknown on-disk key surfaces under Other, typed from its value", () => {
    writeCfg({ mystery: 42, flag: true });
    const s = listSettings();
    const mystery = s.find((e) => e.key === "mystery");
    expect(mystery?.group).toBe("Other");
    expect(mystery?.known).toBe(false);
    expect(mystery?.type).toBe("number");
    expect(s.find((e) => e.key === "flag")?.type).toBe("boolean");
  });

  test("search.* intent keys do not leak into the generic settings list", () => {
    writeCfg({ "search.hybrid_enabled": true, "search.mode": "graph", mystery: 42 });
    const s = listSettings();
    expect(s.some((e) => e.key === "search.hybrid_enabled")).toBe(false);
    expect(s.some((e) => e.key === "search.mode")).toBe(false);
    expect(s.find((e) => e.key === "mystery")?.group).toBe("Other"); // genuine unknown key still shows
  });
});

describe("setSetting", () => {
  test("select persists and preserves other keys", () => {
    writeCfg({ agents: 3 });
    setSetting("merge_mode", "local");
    const raw = readConfig();
    expect(raw.merge_mode).toBe("local");
    expect(raw.agents).toBe(3); // untouched
  });

  test("rejects an invalid select option", () => {
    expect(() => setSetting("merge_mode", "sideways")).toThrow();
  });

  test("boolean coerces from string 'true'/'false'", () => {
    setSetting("auto_loop", "true");
    expect(readConfig().auto_loop).toBe(true);
    setSetting("auto_loop", "false");
    expect(readConfig().auto_loop).toBe(false);
  });

  test("number rejects non-numeric input", () => {
    expect(() => setSetting("agents", "lots")).toThrow();
    setSetting("agents", "5");
    expect(readConfig().agents).toBe(5);
  });

  test("writes a fresh file (with dir) when none exists", () => {
    const deep = path.join(tmp, "nested", "config.json");
    process.env.MC_CONFIG_PATH = deep;
    setSetting("merge_mode", "online");
    expect(JSON.parse(fs.readFileSync(deep, "utf8")).merge_mode).toBe("online");
  });

  test("default_member_model accepts a known model, rejects a bogus one", () => {
    setSetting("default_member_model", "claude-opus-4-8");
    expect(readConfig().default_member_model).toBe("claude-opus-4-8");
    expect(() => setSetting("default_member_model", "gpt-9")).toThrow();
  });
});

describe("getDefaultMemberModel", () => {
  test("falls back to DEFAULT_MODEL when unset or blank", () => {
    expect(getDefaultMemberModel()).toBe(DEFAULT_MODEL); // no file
    writeCfg({ default_member_model: "   " });
    expect(getDefaultMemberModel()).toBe(DEFAULT_MODEL);
  });

  test("returns the configured model when set", () => {
    writeCfg({ default_member_model: "claude-haiku-4-5" });
    expect(getDefaultMemberModel()).toBe("claude-haiku-4-5");
  });
});

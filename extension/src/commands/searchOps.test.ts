import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { deriveEnabled, readIntent, writeIntent } from "./searchOps";
import { readConfig } from "./settingsOps";

let tmp: string;
let cfgPath: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mc-search-"));
  cfgPath = path.join(tmp, "config.json");
  process.env.MC_CONFIG_PATH = cfgPath;
});

afterEach(() => {
  delete process.env.MC_CONFIG_PATH;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("readIntent", () => {
  test("missing file → defaults (off, vector, no path)", () => {
    const i = readIntent();
    expect(i.hybridEnabled).toBe(false);
    expect(i.mode).toBe("vector");
    expect(i.modelPath).toBe("");
  });

  test("reads persisted intent", () => {
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({ "search.hybrid_enabled": true, "search.mode": "graph", "search.model_path": "/m/x.gguf" }),
    );
    const i = readIntent();
    expect(i.hybridEnabled).toBe(true);
    expect(i.mode).toBe("graph");
    expect(i.modelPath).toBe("/m/x.gguf");
  });
});

describe("writeIntent", () => {
  test("persists booleans as real booleans and preserves other keys", () => {
    fs.writeFileSync(cfgPath, JSON.stringify({ merge_mode: "local" }));
    writeIntent({ hybridEnabled: true, mode: "vector" });
    const raw = readConfig();
    expect(raw["search.hybrid_enabled"]).toBe(true); // boolean, not "true"
    expect(raw["search.mode"]).toBe("vector");
    expect(raw.merge_mode).toBe("local"); // untouched
  });

  test("merges partial patches", () => {
    writeIntent({ hybridEnabled: true, mode: "graph" });
    writeIntent({ mode: "vector" });
    const i = readIntent();
    expect(i.hybridEnabled).toBe(true);
    expect(i.mode).toBe("vector");
  });
});

describe("deriveEnabled", () => {
  test("truth table", () => {
    expect(deriveEnabled({ hybridEnabled: false, mode: "vector", modelPath: "" })).toBe(false);
    expect(deriveEnabled({ hybridEnabled: true, mode: "vector", modelPath: "" })).toBe(true);
    expect(deriveEnabled({ hybridEnabled: true, mode: "graph", modelPath: "" })).toBe(false);
  });
});

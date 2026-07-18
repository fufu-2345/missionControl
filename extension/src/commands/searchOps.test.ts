import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { deriveEnabled, fileToPayload, readIntent, writeIntent, reconcile, UI_MODELS } from "./searchOps";
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

const IDLE_INDEX = { status: "idle", current: 0, total: 0, eta: 0 };

function cfg(enabled: boolean, primary: string, colReady: Record<string, { ready: boolean; reason?: string }>) {
  const collections: Record<string, unknown> = {};
  for (const key of Object.keys(colReady)) {
    collections[key] = { key, ready: colReady[key].ready, reason: colReady[key].reason || "", adapter: "lancedb", model: key, provider: "ollama" };
  }
  return {
    source: "file",
    enabled,
    engine: "lancedb",
    state: { enabled, ready: colReady[primary]?.ready ?? false, primary, reason: colReady[primary]?.reason || "", recommendedAction: null, collections },
    options: { localEngines: ["lancedb"], embeddingProviders: ["ollama"] },
    config: { collections: { "bge-m3": { primary: primary === "bge-m3" }, nomic: { primary: primary === "nomic" }, qwen3: {} } },
  };
}

describe("reconcile", () => {
  const intentOff = { hybridEnabled: false, mode: "vector" as const, modelPath: "" };
  const intentGraph = { hybridEnabled: true, mode: "graph" as const, modelPath: "" };

  test("offline → banner, controls flagged offline", () => {
    const vm = reconcile({ online: false, config: null, health: null, docs: 0, index: IDLE_INDEX, intent: intentOff });
    expect(vm.oracleOnline).toBe(false);
  });

  test("offline reconciles from disk file: enabled + primary reflect vector-server.json", () => {
    const payload = fileToPayload({ enabled: true, collections: { "bge-m3": { primary: false }, nomic: { primary: true } } });
    const vm = reconcile({ online: false, config: payload, health: null, docs: 0, index: IDLE_INDEX, intent: intentOff });
    expect(vm.oracleOnline).toBe(false);
    expect(vm.hybridEnabled).toBe(true); // enabled=true in file wins over intent
    expect(vm.mode).toBe("vector");
    expect(vm.selectedModel).toBe("nomic");
  });

  test("fileToPayload(null) → null (no file yet)", () => {
    expect(fileToPayload(null)).toBe(null);
  });

  test("readiness derives from docs count: enabled + docs>0 → ready", () => {
    const on = fileToPayload({ enabled: true, collections: { "bge-m3": { primary: true } } }, 482);
    const vmReady = reconcile({ online: false, config: on, health: null, docs: 482, index: IDLE_INDEX, intent: intentOff });
    expect(vmReady.readiness.ready).toBe(true);

    const notYet = fileToPayload({ enabled: true, collections: { "bge-m3": { primary: true } } }, 0);
    const vmNot = reconcile({ online: false, config: notYet, health: null, docs: 0, index: IDLE_INDEX, intent: intentOff });
    expect(vmNot.readiness.ready).toBe(false);
    expect(vmNot.readiness.reason).toContain("index");
  });

  test("enabled=true → shows ON + Vector regardless of stored mode", () => {
    const c = cfg(true, "nomic", { nomic: { ready: true } });
    const vm = reconcile({ online: true, config: c, health: { vectorMode: "embedded" }, docs: 482, index: IDLE_INDEX, intent: intentGraph });
    expect(vm.hybridEnabled).toBe(true);
    expect(vm.mode).toBe("vector");
    expect(vm.docs).toBe(482);
    expect(vm.selectedModel).toBe("nomic");
  });

  test("enabled=false + intent graph → ON + Graph", () => {
    const c = cfg(false, "bge-m3", { "bge-m3": { ready: false, reason: "not installed" }, nomic: { ready: true } });
    const vm = reconcile({ online: true, config: c, health: { vectorMode: "disabled" }, docs: 0, index: IDLE_INDEX, intent: intentGraph });
    expect(vm.hybridEnabled).toBe(true);
    expect(vm.mode).toBe("graph");
  });

  test("enabled=false + intent off → OFF", () => {
    const c = cfg(false, "bge-m3", { "bge-m3": { ready: false }, nomic: { ready: true } });
    const vm = reconcile({ online: true, config: c, health: { vectorMode: "disabled" }, docs: 0, index: IDLE_INDEX, intent: intentOff });
    expect(vm.hybridEnabled).toBe(false);
  });

  test("exposes only nomic, maps status from reason", () => {
    const c = cfg(true, "nomic", { nomic: { ready: true } });
    const vm = reconcile({ online: true, config: c, health: { vectorMode: "embedded" }, docs: 0, index: IDLE_INDEX, intent: intentOff });
    expect(vm.models.map((m) => m.key)).toEqual(["nomic"]);
    expect(vm.models.find((m) => m.key === "nomic")?.status).toBe("ready");
  });

  test("env override note when runtime enabled but config disabled", () => {
    const c = cfg(false, "bge-m3", { "bge-m3": { ready: true }, nomic: { ready: true } });
    const vm = reconcile({ online: true, config: c, health: { vectorMode: "embedded" }, docs: 0, index: IDLE_INDEX, intent: intentOff });
    expect(vm.envOverrideNote.length).toBeGreaterThan(0);
  });

  test("UI_MODELS is exactly the one exposed model (nomic)", () => {
    expect(UI_MODELS.map((m) => m.key)).toEqual(["nomic"]);
  });

  test("clamps selectedModel to UI_MODELS when oracle reports hidden collection as primary", () => {
    const c = cfg(true, "qwen3", { "qwen3": { ready: true }, nomic: { ready: true } });
    const vm = reconcile({ online: true, config: c, health: { vectorMode: "embedded" }, docs: 0, index: IDLE_INDEX, intent: intentOff });
    expect(vm.selectedModel).toBe("nomic");
    expect(vm.models.filter((m) => m.primary).map((m) => m.key)).toEqual(["nomic"]);
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  applyBackendIntent,
  indexedDocCount,
  readVectorFile,
  vectorConfigPath,
  writeBackendIntent,
  type VectorFileConfig,
} from "./vectorConfigFile";

let tmp: string;
const prevDataDir = process.env.ORACLE_DATA_DIR;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vcf-"));
  process.env.ORACLE_DATA_DIR = tmp;
});
afterEach(() => {
  if (prevDataDir === undefined) delete process.env.ORACLE_DATA_DIR;
  else process.env.ORACLE_DATA_DIR = prevDataDir;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function seed(cfg: Partial<VectorFileConfig>): void {
  fs.writeFileSync(vectorConfigPath(), JSON.stringify({ version: "1.0", enabled: false, host: "0.0.0.0", port: 8081, collections: {}, dataPath: "x", embeddingEndpoint: "y", ...cfg }));
}

describe("vectorConfigPath", () => {
  test("honors ORACLE_DATA_DIR and appends vector-server.json", () => {
    expect(vectorConfigPath()).toBe(path.join(tmp, "vector-server.json"));
  });
});

describe("writeBackendIntent — no file yet", () => {
  test("creates a valid default config with enabled applied", () => {
    const fp = writeBackendIntent({ enabled: true });
    expect(fp).toBe(path.join(tmp, "vector-server.json"));
    const cfg = readVectorFile()!;
    expect(cfg.enabled).toBe(true);
    // default shape the oracle can boot from
    expect(cfg.collections["bge-m3"].primary).toBe(true);
    expect(cfg.version).toBe("1.0");
  });
});

describe("writeBackendIntent — existing file", () => {
  test("flips enabled but preserves other fields", () => {
    seed({ enabled: false, dataPath: "/keep/me", collections: { "bge-m3": { primary: true, collection: "c" } } });
    writeBackendIntent({ enabled: true });
    const cfg = readVectorFile()!;
    expect(cfg.enabled).toBe(true);
    expect(cfg.dataPath).toBe("/keep/me");
    expect(cfg.collections["bge-m3"].collection).toBe("c");
  });
});

describe("indexedDocCount", () => {
  test("counts docs in embed-state-<model>.json", () => {
    fs.writeFileSync(
      path.join(tmp, "embed-state-nomic.json"),
      JSON.stringify({ version: 1, collection: "oracle_knowledge", docs: { a: "h1", b: "h2", c: "h3" } }),
    );
    expect(indexedDocCount("nomic")).toBe(3);
  });

  test("0 when the model was never indexed (file absent)", () => {
    expect(indexedDocCount("bge-m3")).toBe(0);
  });

  test("0 on an unparseable / shapeless file (no throw)", () => {
    fs.writeFileSync(path.join(tmp, "embed-state-x.json"), "{ not json");
    expect(indexedDocCount("x")).toBe(0);
  });
});

describe("applyBackendIntent — primary model", () => {
  const base: VectorFileConfig = {
    version: "1.0", host: "0.0.0.0", port: 8081, dataPath: "x", embeddingEndpoint: "y",
    collections: { "bge-m3": { primary: true }, nomic: { primary: false } },
  };

  test("switching to nomic unsets bge-m3 (single primary survives)", () => {
    const out = applyBackendIntent(base, { primaryModel: "nomic" });
    expect(out.collections["bge-m3"].primary).toBe(false);
    expect(out.collections.nomic.primary).toBe(true);
  });

  test("does not mutate the input", () => {
    applyBackendIntent(base, { primaryModel: "nomic" });
    expect(base.collections["bge-m3"].primary).toBe(true);
  });

  test("collapses accidental multi-primary to the first", () => {
    const multi: VectorFileConfig = { ...base, collections: { "bge-m3": { primary: true }, nomic: { primary: true } } };
    const out = applyBackendIntent(multi, {});
    const primaries = Object.keys(out.collections).filter((k) => out.collections[k].primary);
    expect(primaries).toEqual(["bge-m3"]);
  });
});

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Offline path to the oracle's vector-server.json. The oracle server (arra-
// oracle-v3) owns this file and normally we PATCH it via :47778 — but the file
// IS the source of truth the server reads on boot, so when the server is down
// we write it directly. Path mirrors the oracle's own resolution exactly:
//   ORACLE_DATA_DIR = process.env.ORACLE_DATA_DIR || ~/.oracle  (const.ts)
// so a direct write lands where the server will read it next start.

const VECTOR_CONFIG_FILE = "vector-server.json";

/** Models the UI can pick, first = default/primary — mirrors searchOps.UI_MODELS. */
const UI_MODEL_KEYS = ["bge-m3", "nomic"] as const;

export type VectorFileConfig = {
  version: string;
  enabled?: boolean;
  host: string;
  port: number;
  collections: Record<string, { primary?: boolean; [k: string]: unknown }>;
  dataPath: string;
  embeddingEndpoint: string;
  [k: string]: unknown;
};

/** The oracle's ORACLE_DATA_DIR (~/.oracle unless overridden), matching const.ts. */
function oracleDataDir(): string {
  return (
    process.env.ORACLE_DATA_DIR ||
    path.join(process.env.HOME || process.env.USERPROFILE || os.homedir(), ".oracle")
  );
}

/** Absolute path to vector-server.json, matching the oracle's ORACLE_DATA_DIR. */
export function vectorConfigPath(): string {
  return path.join(oracleDataDir(), VECTOR_CONFIG_FILE);
}

/** How many docs are embedded for `model`, read from the incremental indexer's
 *  own state file (~/.oracle/embed-state-<model>.json, docs = {docId: hash}).
 *  Offline + cheap — no server, no LanceDB query. 0 if the model was never
 *  indexed (file absent) or the file is unreadable. */
export function indexedDocCount(model: string): number {
  const fp = path.join(oracleDataDir(), `embed-state-${model}.json`);
  try {
    const s = JSON.parse(fs.readFileSync(fp, "utf8")) as { docs?: Record<string, unknown> };
    return s && s.docs && typeof s.docs === "object" ? Object.keys(s.docs).length : 0;
  } catch {
    return 0;
  }
}

/** Read + parse vector-server.json, or null if absent/unparseable. */
export function readVectorFile(): VectorFileConfig | null {
  const fp = vectorConfigPath();
  if (!fs.existsSync(fp)) return null;
  try {
    return JSON.parse(fs.readFileSync(fp, "utf8")) as VectorFileConfig;
  } catch {
    return null;
  }
}

/** Factory default matching the oracle's generateDefaultConfig() shape, used
 *  only when no file exists yet so the server can still boot from our write. */
function defaultConfig(): VectorFileConfig {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  return {
    version: "1.0",
    enabled: false,
    host: "0.0.0.0",
    port: 8081,
    collections: {
      "bge-m3": { adapter: "lancedb", collection: "oracle_knowledge_bge_m3", model: "bge-m3", provider: "ollama", primary: true },
      nomic: { adapter: "lancedb", collection: "oracle_knowledge", model: "nomic-embed-text", provider: "ollama" },
      qwen3: { adapter: "lancedb", collection: "oracle_knowledge_qwen3", model: "qwen3-embedding", provider: "ollama" },
    },
    dataPath: path.join(home, ".oracle", "lancedb"),
    embeddingEndpoint: "http://localhost:11434",
  };
}

/** Apply the same backend levers the PATCH endpoint accepts (enabled + which
 *  model is primary), preserving every other field. Mirrors the oracle's
 *  applyVectorConfigUpdate for this subset: exactly one primary survives. */
export function applyBackendIntent(
  base: VectorFileConfig,
  patch: { enabled?: boolean; primaryModel?: string },
): VectorFileConfig {
  const next: VectorFileConfig = JSON.parse(JSON.stringify(base));
  if (patch.enabled !== undefined) next.enabled = patch.enabled;

  if (patch.primaryModel !== undefined) {
    for (const key of UI_MODEL_KEYS) {
      const col = next.collections[key] || (next.collections[key] = { collection: key, model: key, provider: "ollama", adapter: "lancedb" });
      col.primary = key === patch.primaryModel;
    }
  }

  // Guarantee a single primary, matching the oracle's reconciliation.
  const primaries = Object.keys(next.collections).filter((k) => next.collections[k].primary);
  if (primaries.length === 0 && next.collections["bge-m3"]) next.collections["bge-m3"].primary = true;
  else if (primaries.length > 1) {
    const keep = primaries[0];
    for (const k of Object.keys(next.collections)) next.collections[k].primary = k === keep;
  }
  return next;
}

/** Read-or-default, apply the backend intent, and write vector-server.json
 *  directly. Returns the file path. Offline-safe — no network. */
export function writeBackendIntent(patch: { enabled?: boolean; primaryModel?: string }): string {
  const base = readVectorFile() ?? defaultConfig();
  const next = applyBackendIntent(base, patch);
  const fp = vectorConfigPath();
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(next, null, 2) + "\n", "utf8");
  return fp;
}

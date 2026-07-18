import * as fs from "node:fs";
import * as path from "node:path";

import { configPath, readConfig } from "./settingsOps";

// Node-only search settings logic. No vscode, no network — unit-testable via
// MC_CONFIG_PATH. Holds the user's INTENT (what they picked in the UI) in the
// same ~/.mission-control/config.json as the other settings, under dotted keys.
// The backend enabled flag is DERIVED from intent (see deriveEnabled); it is not
// stored here — the oracle owns it.

export type SearchMode = "vector" | "graph";

export type SearchIntent = {
  hybridEnabled: boolean;
  mode: SearchMode;
  modelPath: string;
};

const K_ENABLED = "search.hybrid_enabled";
const K_MODE = "search.mode";
const K_PATH = "search.model_path";

/** Read the three intent keys from config.json, applying defaults. */
export function readIntent(): SearchIntent {
  const raw = readConfig();
  const mode = raw[K_MODE] === "graph" ? "graph" : "vector";
  return {
    hybridEnabled: raw[K_ENABLED] === true,
    mode,
    modelPath: typeof raw[K_PATH] === "string" ? (raw[K_PATH] as string) : "",
  };
}

/** Merge a partial intent into config.json (preserving all other keys) and
 *  return the merged intent. Booleans stay booleans on disk. */
export function writeIntent(patch: Partial<SearchIntent>): SearchIntent {
  const raw = readConfig();
  const cur = readIntent();
  const next: SearchIntent = { ...cur, ...patch };
  raw[K_ENABLED] = next.hybridEnabled;
  raw[K_MODE] = next.mode;
  raw[K_PATH] = next.modelPath;
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(raw, null, 2) + "\n", "utf8");
  return next;
}

/** The single backend lever: vector search runs only when hybrid is ON and the
 *  sub-mode is Vector. Graph (not built yet) and OFF both mean FTS5-only. */
export function deriveEnabled(intent: SearchIntent): boolean {
  return intent.hybridEnabled && intent.mode === "vector";
}

export type ModelStatus = "ready" | "not-installed" | "not-indexed" | "unknown";

export type SearchModelView = {
  key: string;
  label: string;
  status: ModelStatus;
  reason: string;
  primary: boolean;
};

export type SearchViewModel = {
  oracleOnline: boolean;
  hybridEnabled: boolean;
  mode: SearchMode;
  models: SearchModelView[];
  selectedModel: string;
  readiness: { ready: boolean; reason: string; action: string };
  docs: number;
  index: { status: string; current: number; total: number; eta: number };
  envOverrideNote: string;
  modelPath: string;
};

// Loose shapes for the oracle payloads (we read defensively).
export type OracleColState = { key?: string; ready?: boolean; reason?: string };
export type OracleConfigPayload = {
  enabled?: boolean;
  state?: { ready?: boolean; primary?: string; reason?: string; recommendedAction?: string | null; collections?: Record<string, OracleColState> };
  config?: { collections?: Record<string, { primary?: boolean }> };
};
export type OracleHealthPayload = { vectorMode?: string; vectorDisabledReason?: string };

/** The embedding model(s) the UI picker exposes. nomic is the only supported/
 *  default model — bge-m3 was removed (it needs a separate index and isn't used
 *  on this deployment). */
export const UI_MODELS: { key: string; label: string }[] = [
  { key: "nomic", label: "nomic" },
];

/** The primary model key from an on-disk config (the one search actually uses),
 *  defaulting to nomic. Drives which embed-state-<model>.json we count. */
export function primaryModelOf(
  file: { collections?: Record<string, { primary?: boolean }> } | null,
): string {
  const cols = file?.collections || {};
  return Object.keys(cols).find((k) => cols[k]?.primary === true) || "nomic";
}

/** Synthesize an OracleConfigPayload purely from on-disk files — vector-server
 *  .json for the config plus the indexed-doc count from the embed-state file —
 *  so the section renders (and stays editable) without touching the server.
 *  Readiness is derived: vector is "ready" when enabled and something is indexed.
 *  Per-model install status is unknown from files alone; the server enriches it
 *  when it happens to be up. */
export function fileToPayload(
  file: { enabled?: boolean; collections?: Record<string, { primary?: boolean }> } | null,
  docs = 0,
): OracleConfigPayload | null {
  if (!file) return null;
  const cols = file.collections || {};
  const enabled = file.enabled === true;
  const ready = enabled && docs > 0;
  return {
    enabled,
    state: {
      ready,
      primary: primaryModelOf(file),
      reason: enabled ? (ready ? "" : "ยังไม่ได้ index") : "vector section disabled",
      collections: {},
    },
    config: { collections: cols },
  };
}

function statusFromCol(col: OracleColState | undefined): ModelStatus {
  if (!col) return "unknown";
  if (col.ready === true) return "ready";
  const r = (col.reason || "").toLowerCase();
  if (r.includes("install") || r.includes("model") || r.includes("pull")) return "not-installed";
  if (r.includes("index")) return "not-indexed";
  return "unknown";
}

export function reconcile(input: {
  online: boolean;
  config: OracleConfigPayload | null;
  health: OracleHealthPayload | null;
  docs: number;
  index: SearchViewModel["index"];
  intent: SearchIntent;
}): SearchViewModel {
  const { online, config, health, docs, index, intent } = input;
  const enabled = config?.enabled === true;
  const state = config?.state || {};
  const cols = state.collections || {};
  const primary = state.primary || "nomic";
  const uiKeys = UI_MODELS.map((m) => m.key);
  const selected = uiKeys.includes(primary) ? primary : "nomic";

  // Display hybrid/mode: enabled=true is authoritative (ON+Vector). enabled=false
  // is ambiguous (OFF vs ON+Graph) → disambiguate from stored intent.
  let hybridEnabled: boolean;
  let mode: SearchMode;
  if (enabled) {
    hybridEnabled = true;
    mode = "vector";
  } else if (intent.hybridEnabled && intent.mode === "graph") {
    hybridEnabled = true;
    mode = "graph";
  } else {
    hybridEnabled = false;
    mode = intent.mode;
  }

  const models: SearchModelView[] = UI_MODELS.map((m) => ({
    key: m.key,
    label: m.label,
    status: statusFromCol(cols[m.key]),
    reason: cols[m.key]?.reason || "",
    primary: m.key === selected,
  }));

  const runtimeOn = !!health && health.vectorMode !== "disabled" && !!health.vectorMode;
  const envOverrideNote =
    online && !enabled && runtimeOn
      ? "หมายเหตุ: runtime ของ oracle เปิด vector อยู่ (อาจตั้ง ORACLE_VECTOR_ENABLED) — ต่างจากสวิตช์ที่เห็น"
      : "";

  return {
    oracleOnline: online,
    hybridEnabled,
    mode,
    models,
    selectedModel: selected,
    readiness: {
      ready: state.ready === true,
      reason: state.reason || "",
      action: state.recommendedAction || "",
    },
    docs,
    index,
    envOverrideNote,
    modelPath: intent.modelPath,
  };
}

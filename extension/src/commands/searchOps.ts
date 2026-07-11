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

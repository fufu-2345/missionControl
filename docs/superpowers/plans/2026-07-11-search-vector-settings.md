# Search & Vector Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Search / Oracle" section to the Mission Control extension's Settings page that lets the user turn hybrid search on/off, pick Vector/Graph sub-mode, choose/install/locate an embedding model, and run indexing — driving the oracle backend's real config over HTTP.

**Architecture:** Three new node-only modules do the testable work — `oracleVectorClient.ts` (HTTP to oracle `:47778`), `searchOps.ts` (config.json intent I/O + pure `deriveEnabled`/`reconcile` logic), `searchSection.ts` (webview asset strings + host message handlers). `settings.ts` gets a small change: inject the search section's style/body/script into its HTML string and route `search*` messages. The single backend lever is oracle `enabled = hybridEnabled && mode === "vector"`; Graph and OFF both set `enabled=false` (FTS5 only). Nothing in the oracle repo changes.

**Tech Stack:** TypeScript, VSCode extension API, Node `fetch`/`child_process`, `bun test` (bun 1.3.14), oracle HTTP API (Elysia, `:47778`).

## Global Constraints

- **Test runner:** `bun test <path>` (there is no npm `test` script; bun runs `.ts` directly). Compile check: `bun run compile` (runs `tsc -p ./`).
- **No `vscode` import** in `oracleVectorClient.ts` or `searchOps.ts` — they must stay unit-testable. Only `searchSection.ts` and `settings.ts` may import `vscode`.
- **Config path** is `configPath()` from `settingsOps.ts` (honors `process.env.MC_CONFIG_PATH`); tests point it at a temp file. Reuse it — never hardcode `~/.mission-control/config.json`.
- **Oracle base URL:** `http://127.0.0.1:47778`. Use global `fetch` with an `AbortController` timeout of 4000 ms (mirrors `usage.ts:68-80`).
- **Webview foot-gun:** any string that becomes client-side `<script>` text must contain **no backtick and no backslash** (they corrupt when the literal is evaluated). Build HTML by string concatenation; write no regex containing `\`. This applies to every string in `searchSection.ts`.
- **Models exposed in UI:** exactly two — `bge-m3` (default / primary) and `nomic`. Other collections (e.g. `qwen3`) stay in the oracle config but are hidden.
- **Backend mapping:** `enabled = hybridEnabled && mode === "vector"`. Selecting a model = `PATCH /api/vector/config { collections: { <key>: { primary: true } } }`.
- **Safety:** Index and Install run only on explicit button press, each behind a confirm dialog; never auto-triggered by toggling. Oracle offline → show banner, disable controls, send no PATCH.
- **Theme:** style with `var(--vscode-*)` variables only (the page already sets `color-scheme: light dark`).
- **Do not touch** `package.json` (reuse the existing `missioncontrol.settings` command) or the `arra-oracle-v3` repo.
- **Commit trailer:** every commit message ends with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

### Task 1: `searchOps.ts` — intent I/O + `deriveEnabled`

**Files:**
- Create: `extension/src/commands/searchOps.ts`
- Test: `extension/src/commands/searchOps.test.ts`

**Interfaces:**
- Consumes: `configPath` and `readConfig` from `extension/src/commands/settingsOps.ts` (existing exports).
- Produces:
  - `type SearchMode = "vector" | "graph"`
  - `type SearchIntent = { hybridEnabled: boolean; mode: SearchMode; modelPath: string }`
  - `function readIntent(): SearchIntent`
  - `function writeIntent(patch: Partial<SearchIntent>): SearchIntent` (merges, persists, returns the merged intent)
  - `function deriveEnabled(intent: SearchIntent): boolean`

- [ ] **Step 1: Write the failing test**

Create `extension/src/commands/searchOps.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/commands/searchOps.test.ts` (from `extension/`)
Expected: FAIL — `Cannot find module "./searchOps"`.

- [ ] **Step 3: Write minimal implementation**

Create `extension/src/commands/searchOps.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/commands/searchOps.test.ts`
Expected: PASS (7 assertions across the describe blocks).

- [ ] **Step 5: Commit**

```bash
git add extension/src/commands/searchOps.ts extension/src/commands/searchOps.test.ts
git commit -m "feat(search): intent I/O + deriveEnabled for search settings

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `searchOps.ts` — `reconcile()` + view model

**Files:**
- Modify: `extension/src/commands/searchOps.ts`
- Test: `extension/src/commands/searchOps.test.ts`

**Interfaces:**
- Consumes: `SearchIntent` (Task 1); raw oracle payloads (typed loosely as the client returns them — Task 3 produces the same shapes).
- Produces:
  - `type ModelStatus = "ready" | "not-installed" | "not-indexed" | "unknown"`
  - `type SearchModelView = { key: string; label: string; status: ModelStatus; reason: string; primary: boolean }`
  - `type SearchViewModel = { oracleOnline: boolean; hybridEnabled: boolean; mode: SearchMode; models: SearchModelView[]; selectedModel: string; readiness: { ready: boolean; reason: string; action: string }; docs: number; index: { status: string; current: number; total: number; eta: number }; envOverrideNote: string; modelPath: string }`
  - `type OracleConfigPayload` and `type OracleHealthPayload` (loose shapes, see code)
  - `function reconcile(input: { online: boolean; config: OracleConfigPayload | null; health: OracleHealthPayload | null; docs: number; index: SearchViewModel["index"]; intent: SearchIntent }): SearchViewModel`
  - `const UI_MODELS: { key: string; label: string }[]` (the two exposed models)

- [ ] **Step 1: Write the failing test**

Append to `extension/src/commands/searchOps.test.ts`:

```ts
import { reconcile, UI_MODELS } from "./searchOps";

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

  test("enabled=true → shows ON + Vector regardless of stored mode", () => {
    const c = cfg(true, "bge-m3", { "bge-m3": { ready: true }, nomic: { ready: true } });
    const vm = reconcile({ online: true, config: c, health: { vectorMode: "embedded" }, docs: 482, index: IDLE_INDEX, intent: intentGraph });
    expect(vm.hybridEnabled).toBe(true);
    expect(vm.mode).toBe("vector");
    expect(vm.docs).toBe(482);
    expect(vm.selectedModel).toBe("bge-m3");
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

  test("exposes only bge-m3 + nomic, maps status from reason", () => {
    const c = cfg(true, "bge-m3", { "bge-m3": { ready: false, reason: "bge-m3 not installed in ollama" }, nomic: { ready: true } });
    const vm = reconcile({ online: true, config: c, health: { vectorMode: "embedded" }, docs: 0, index: IDLE_INDEX, intent: intentOff });
    expect(vm.models.map((m) => m.key).sort()).toEqual(["bge-m3", "nomic"]);
    expect(vm.models.find((m) => m.key === "bge-m3")?.status).toBe("not-installed");
    expect(vm.models.find((m) => m.key === "nomic")?.status).toBe("ready");
  });

  test("env override note when runtime enabled but config disabled", () => {
    const c = cfg(false, "bge-m3", { "bge-m3": { ready: true }, nomic: { ready: true } });
    const vm = reconcile({ online: true, config: c, health: { vectorMode: "embedded" }, docs: 0, index: IDLE_INDEX, intent: intentOff });
    expect(vm.envOverrideNote.length).toBeGreaterThan(0);
  });

  test("UI_MODELS is exactly the two exposed models", () => {
    expect(UI_MODELS.map((m) => m.key)).toEqual(["bge-m3", "nomic"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/commands/searchOps.test.ts`
Expected: FAIL — `reconcile`/`UI_MODELS` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `extension/src/commands/searchOps.ts`:

```ts
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

/** The two embedding models the UI exposes. bge-m3 first = default/primary. */
export const UI_MODELS: { key: string; label: string }[] = [
  { key: "bge-m3", label: "BGE-M3" },
  { key: "nomic", label: "nomic" },
];

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
  const primary = state.primary || "bge-m3";

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
    primary: m.key === primary,
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
    selectedModel: primary,
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/commands/searchOps.test.ts`
Expected: PASS (all Task 1 + Task 2 tests).

- [ ] **Step 5: Commit**

```bash
git add extension/src/commands/searchOps.ts extension/src/commands/searchOps.test.ts
git commit -m "feat(search): reconcile oracle state + intent into a view model

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `oracleVectorClient.ts` — HTTP client to the oracle

**Files:**
- Create: `extension/src/commands/oracleVectorClient.ts`
- Test: `extension/src/commands/oracleVectorClient.test.ts`

**Interfaces:**
- Consumes: nothing internal (uses global `fetch`).
- Produces:
  - `type PatchBody = { enabled?: boolean; collections?: Record<string, { primary?: boolean }> }`
  - `async function getConfig(): Promise<{ online: boolean; config: any | null }>`
  - `async function getHealth(): Promise<any | null>`
  - `async function getStats(): Promise<any | null>`
  - `async function patchConfig(body: PatchBody): Promise<any>` (throws on non-2xx)
  - `async function startIndex(model?: string): Promise<any>`
  - `async function indexStatus(): Promise<any | null>`
  - `async function stopIndex(): Promise<any>`
  - `const ORACLE_BASE = "http://127.0.0.1:47778"`
  - Internals are injectable for tests via a module-level `__setFetch(fn)` hook.

- [ ] **Step 1: Write the failing test**

Create `extension/src/commands/oracleVectorClient.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { __setFetch, getConfig, patchConfig, startIndex } from "./oracleVectorClient";

afterEach(() => __setFetch(undefined));

function jsonResponse(obj: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => obj } as unknown as Response;
}

describe("getConfig", () => {
  test("maps a 200 JSON body into { online:true, config }", async () => {
    __setFetch(async () => jsonResponse({ enabled: true }));
    const r = await getConfig();
    expect(r.online).toBe(true);
    expect(r.config.enabled).toBe(true);
  });

  test("connection failure → { online:false, config:null }", async () => {
    __setFetch(async () => {
      throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    });
    const r = await getConfig();
    expect(r.online).toBe(false);
    expect(r.config).toBe(null);
  });
});

describe("patchConfig", () => {
  test("sends PATCH with JSON body and returns parsed payload", async () => {
    let seenMethod = "";
    let seenBody = "";
    __setFetch(async (_url: string, init: RequestInit) => {
      seenMethod = String(init.method);
      seenBody = String(init.body);
      return jsonResponse({ path: "/x", enabled: false });
    });
    const out = await patchConfig({ enabled: false });
    expect(seenMethod).toBe("PATCH");
    expect(JSON.parse(seenBody)).toEqual({ enabled: false });
    expect(out.path).toBe("/x");
  });

  test("non-2xx throws", async () => {
    __setFetch(async () => jsonResponse({ error: "bad" }, false, 400));
    await expect(patchConfig({ enabled: true })).rejects.toThrow();
  });
});

describe("startIndex", () => {
  test("posts model in the body", async () => {
    let seenBody = "";
    __setFetch(async (_url: string, init: RequestInit) => {
      seenBody = String(init.body);
      return jsonResponse({ jobId: "j1", status: "started" });
    });
    const out = await startIndex("nomic");
    expect(JSON.parse(seenBody).model).toBe("nomic");
    expect(out.status).toBe("started");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/commands/oracleVectorClient.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `extension/src/commands/oracleVectorClient.ts`:

```ts
// HTTP client for the oracle vector API (arra-oracle-v3, http://127.0.0.1:47778).
// Node-only, uses global fetch with an AbortController timeout (mirrors usage.ts).
// getConfig/getHealth/getStats/indexStatus swallow connection failures into a
// null/offline result so the UI can show "oracle offline" instead of crashing;
// the mutating calls (patchConfig/startIndex/stopIndex) throw on failure so the
// host can surface an error toast.

export const ORACLE_BASE = "http://127.0.0.1:47778";
const TIMEOUT_MS = 4000;

// Injectable fetch for tests. undefined → real global fetch.
type FetchFn = (url: string, init: RequestInit) => Promise<Response>;
let _fetch: FetchFn | undefined;
/** Test hook — override the fetch used by this module (undefined resets). */
export function __setFetch(fn: FetchFn | undefined): void {
  _fetch = fn;
}
function doFetch(url: string, init: RequestInit): Promise<Response> {
  return (_fetch || (globalThis.fetch as unknown as FetchFn))(url, init);
}

async function req(path: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await doFetch(ORACLE_BASE + path, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init.headers || {}) },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** GET that returns null on any network/parse failure (offline-tolerant). */
async function getSafe(path: string): Promise<any | null> {
  try {
    const res = await req(path, { method: "GET" });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function getConfig(): Promise<{ online: boolean; config: any | null }> {
  const config = await getSafe("/api/vector/config");
  return { online: config !== null, config };
}

export function getHealth(): Promise<any | null> {
  return getSafe("/api/health");
}

export function getStats(): Promise<any | null> {
  return getSafe("/api/vector/stats");
}

export function indexStatus(): Promise<any | null> {
  return getSafe("/api/vector/index/status");
}

export type PatchBody = { enabled?: boolean; collections?: Record<string, { primary?: boolean }> };

/** Mutating calls throw on non-2xx so the host can toast the error. */
async function mutate(path: string, method: string, body?: unknown): Promise<any> {
  const res = await req(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const m = (json && (json as any).error) || ("HTTP " + res.status);
    throw new Error(String(m));
  }
  return json;
}

export function patchConfig(body: PatchBody): Promise<any> {
  return mutate("/api/vector/config", "PATCH", body);
}

export function startIndex(model?: string): Promise<any> {
  return mutate("/api/vector/index/start", "POST", model ? { model } : {});
}

export function stopIndex(): Promise<any> {
  return mutate("/api/vector/index/stop", "POST", {});
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/commands/oracleVectorClient.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add extension/src/commands/oracleVectorClient.ts extension/src/commands/oracleVectorClient.test.ts
git commit -m "feat(search): offline-tolerant HTTP client for the oracle vector API

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `searchSection.ts` — webview assets + state builder

**Files:**
- Create: `extension/src/webview/searchSection.ts`
- Test: `extension/src/webview/searchSection.test.ts`

**Interfaces:**
- Consumes: `reconcile`, `readIntent`, `SearchViewModel` (searchOps); `getConfig`, `getHealth`, `getStats`, `indexStatus` (oracleVectorClient).
- Produces:
  - `function searchSectionStyle(): string` — CSS `<style>` inner text (no tags)
  - `function searchSectionBody(): string` — the `<section id="search-oracle">` placeholder HTML
  - `function searchSectionScript(): string` — the client `<script>` inner text (no tags), foot-gun-safe
  - `async function buildSearchState(): Promise<SearchViewModel>` — fetches oracle GET/health/stats/index-status, reads intent, returns `reconcile(...)`
  - `function docsFromStats(stats: any): number` — pure helper (tested)
  - `function indexFromStatus(s: any): SearchViewModel["index"]` — pure helper (tested)

- [ ] **Step 1: Write the failing test**

Create `extension/src/webview/searchSection.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  docsFromStats,
  indexFromStatus,
  searchSectionBody,
  searchSectionScript,
  searchSectionStyle,
} from "./searchSection";

describe("asset strings", () => {
  test("body has the container the script renders into", () => {
    expect(searchSectionBody()).toContain('id="search-oracle"');
  });

  test("style is non-empty CSS", () => {
    expect(searchSectionStyle()).toContain(".so-");
  });

  test("client script is FREE of backtick and backslash (webview foot-gun)", () => {
    const s = searchSectionScript();
    expect(s.includes("`")).toBe(false);
    expect(s.includes("\\")).toBe(false);
    expect(s).toContain("searchState"); // listens for the host push
  });
});

describe("docsFromStats", () => {
  test("sums count fields defensively", () => {
    expect(docsFromStats({ "bge-m3": { count: 300 }, nomic: { count: 182 } })).toBe(482);
    expect(docsFromStats(null)).toBe(0);
    expect(docsFromStats({ models: [{ count: 5 }, { count: 7 }] })).toBe(12);
  });
});

describe("indexFromStatus", () => {
  test("defaults to idle on null", () => {
    expect(indexFromStatus(null).status).toBe("idle");
  });
  test("passes through indexing fields", () => {
    const i = indexFromStatus({ status: "indexing", current: 10, total: 100, eta: 42 });
    expect(i.status).toBe("indexing");
    expect(i.current).toBe(10);
    expect(i.total).toBe(100);
    expect(i.eta).toBe(42);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/webview/searchSection.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `extension/src/webview/searchSection.ts`. The `_script` constant is a plain string — keep it free of backticks and backslashes.

```ts
import {
  getConfig,
  getHealth,
  getStats,
  indexStatus,
} from "../commands/oracleVectorClient";
import { readIntent, reconcile, type SearchViewModel } from "../commands/searchOps";

// Host-side of the "Search / Oracle" section. Owns the section's CSS/HTML/JS
// (returned as strings that settings.ts injects into its page) and the async
// state builder. The client script is a plain string with NO backtick / NO
// backslash — it is injected verbatim into the webview and would corrupt if it
// contained either (see the note in settings.ts).

/** Sum indexed-doc counts from /api/vector/stats, defensively across shapes. */
export function docsFromStats(stats: any): number {
  if (!stats || typeof stats !== "object") return 0;
  let total = 0;
  const add = (v: any) => {
    if (v && typeof v.count === "number") total += v.count;
  };
  if (Array.isArray(stats.models)) stats.models.forEach(add);
  else for (const k of Object.keys(stats)) add(stats[k]);
  return total;
}

/** Normalize /api/vector/index/status into the view-model index block. */
export function indexFromStatus(s: any): SearchViewModel["index"] {
  if (!s || typeof s !== "object") return { status: "idle", current: 0, total: 0, eta: 0 };
  return {
    status: typeof s.status === "string" ? s.status : "idle",
    current: Number(s.current) || 0,
    total: Number(s.total) || 0,
    eta: Number(s.eta) || 0,
  };
}

/** Fetch everything the section needs and reconcile into a view model. */
export async function buildSearchState(): Promise<SearchViewModel> {
  const { online, config } = await getConfig();
  if (!online) {
    return reconcile({ online: false, config: null, health: null, docs: 0, index: { status: "idle", current: 0, total: 0, eta: 0 }, intent: readIntent() });
  }
  const [health, stats, idx] = await Promise.all([getHealth(), getStats(), indexStatus()]);
  return reconcile({
    online: true,
    config,
    health,
    docs: docsFromStats(stats),
    index: indexFromStatus(idx),
    intent: readIntent(),
  });
}

export function searchSectionStyle(): string {
  return [
    ".so-wrap{max-width:820px;margin-bottom:26px}",
    ".so-wrap h2{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;opacity:.6;margin:0 0 10px}",
    ".so-hd{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}",
    ".so-dot{font-size:11.5px;opacity:.75}",
    ".so-row{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:12px 14px;border:1px solid var(--vscode-panel-border,rgba(128,128,128,.25));border-radius:8px;margin-bottom:8px;background:var(--vscode-list-hoverBackground,rgba(128,128,128,.06))}",
    ".so-rl{font-size:14px;font-weight:600}",
    ".so-rh{font-size:11.5px;opacity:.66;margin-top:3px}",
    ".so-sub{margin-left:14px;padding-left:14px;border-left:2px solid var(--vscode-panel-border,rgba(128,128,128,.25))}",
    ".so-disabled{opacity:.4;pointer-events:none}",
    // sliding on/off switch
    ".so-switch{position:relative;width:64px;height:26px;border-radius:999px;border:1px solid var(--vscode-panel-border,rgba(128,128,128,.4));background:var(--vscode-input-background);cursor:pointer}",
    ".so-switch .kn{position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;background:var(--vscode-foreground);opacity:.7;transition:left .16s ease}",
    ".so-switch.on{border-color:#3fb950;background:rgba(63,185,80,.18)}",
    ".so-switch.on .kn{left:40px;background:#3fb950;opacity:1}",
    // segmented slide (2 cells)
    ".so-seg{display:inline-flex;border:1px solid var(--vscode-panel-border,rgba(128,128,128,.4));border-radius:8px;overflow:hidden}",
    ".so-seg button{background:transparent;color:var(--vscode-foreground);border:0;padding:6px 16px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit}",
    ".so-seg button.sel{background:var(--vscode-focusBorder);color:#fff}",
    ".so-model{display:flex;justify-content:space-between;align-items:center;padding:8px 0;font-size:12.5px}",
    ".so-badge{font-size:9.5px;font-weight:700;padding:1px 6px;border-radius:4px;margin-left:8px}",
    ".so-badge.ok{background:rgba(63,185,80,.18);color:#3fb950}",
    ".so-badge.warn{background:var(--vscode-charts-orange,#d18616);color:#1a1a1a}",
    ".so-btn{background:transparent;color:var(--vscode-foreground);border:1px solid var(--vscode-panel-border,rgba(128,128,128,.4));border-radius:6px;padding:5px 12px;font-size:12px;cursor:pointer;font-weight:600;font-family:inherit;margin-left:6px}",
    ".so-btn:hover{border-color:var(--vscode-focusBorder)}",
    ".so-status{font-size:12px;opacity:.8;margin-top:8px}",
    ".so-note{font-size:11.5px;opacity:.7;margin-top:8px;color:var(--vscode-charts-orange,#d18616)}",
    ".so-off{font-size:12.5px;opacity:.7;padding:12px 0}",
  ].join("\n");
}

export function searchSectionBody(): string {
  return '<section class="so-wrap" id="search-oracle"><div class="so-off">กำลังโหลดสถานะ Search / Oracle…</div></section>';
}

// NOTE: plain string, NO backtick / NO backslash anywhere below.
const _script = [
  "(function(){",
  "  var vs = window.__mcVscode;",
  "  function esc(s){s=String(s==null?'':s);return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;');}",
  "  function post(t,extra){var m={type:t};if(extra){for(var k in extra){m[k]=extra[k];}}vs.postMessage(m);}",
  "  function modelRow(m){",
  "    var badge = m.status==='ready' ? '<span class=\"so-badge ok\">ready</span>' : '<span class=\"so-badge warn\">'+esc(m.status)+'</span>';",
  "    var btns = '<span><button class=\"so-btn\" data-so=\"install\" data-model=\"'+esc(m.key)+'\">Install</button>'",
  "      + '<button class=\"so-btn\" data-so=\"choose\" data-model=\"'+esc(m.key)+'\">Choose file</button></span>';",
  "    var pick = m.primary ? '<b>'+esc(m.label)+'</b>' : '<a href=\"#\" data-so=\"model\" data-model=\"'+esc(m.key)+'\">'+esc(m.label)+'</a>';",
  "    return '<div class=\"so-model\"><span>'+pick+' '+badge+(m.reason?' <span style=\"opacity:.6\">'+esc(m.reason)+'</span>':'')+'</span>'+(m.status==='ready'?'':btns)+'</div>';",
  "  }",
  "  function render(v){",
  "    var el = document.getElementById('search-oracle'); if(!el) return;",
  "    if(!v.oracleOnline){ el.innerHTML = '<h2>Search / Oracle</h2><div class=\"so-off\">Oracle offline (:47778) — เปิด oracle server ก่อนถึงจะตั้งค่าได้</div>'; return; }",
  "    var sw = '<div class=\"so-switch'+(v.hybridEnabled?' on':'')+'\" data-so=\"hybrid\" data-next=\"'+(v.hybridEnabled?'0':'1')+'\"><div class=\"kn\"></div></div>';",
  "    var seg = '<div class=\"so-seg\"><button data-so=\"mode\" data-mode=\"vector\" class=\"'+(v.mode==='vector'?'sel':'')+'\">Vector</button>'",
  "      + '<button data-so=\"mode\" data-mode=\"graph\" class=\"'+(v.mode==='graph'?'sel':'')+'\">Graph</button></div>';",
  "    var models = v.models.map(modelRow).join('');",
  "    var pct = v.index.total>0 ? Math.round(100*v.index.current/v.index.total) : 0;",
  "    var indexing = v.index.status==='indexing';",
  "    var statusLine = indexing ? ('Indexing… '+v.index.current+'/'+v.index.total+' ('+pct+'%)') : (v.readiness.ready ? ('พร้อม · '+v.docs+' docs') : ('ยังไม่พร้อม: '+esc(v.readiness.reason||'ยังไม่ได้ index')));",
  "    var idxBtn = indexing ? '<button class=\"so-btn\" data-so=\"stop\">Stop</button>' : '<button class=\"so-btn\" data-so=\"index\">Index now</button>';",
  "    var sub = '<div class=\"so-sub'+(v.hybridEnabled?'':' so-disabled')+'\">'",
  "      + '<div class=\"so-row\"><div><div class=\"so-rl\">Mode</div><div class=\"so-rh\">Vector: FTS5 + LanceDB vector · Graph: coming soon (=FTS5)</div></div>'+seg+'</div>'",
  "      + '<div class=\"so-row\"><div><div class=\"so-rl\">Embedding model</div><div class=\"so-rh\">BGE-M3 = default</div>'+models+'</div></div>'",
  "      + '<div class=\"so-status\">'+esc(statusLine)+' '+idxBtn+'</div>'"
  ,
  "      + (v.modelPath?'<div class=\"so-rh\">model path: '+esc(v.modelPath)+'</div>':'')",
  "      + '</div>';",
  "    var note = v.envOverrideNote ? '<div class=\"so-note\">'+esc(v.envOverrideNote)+'</div>' : '';",
  "    el.innerHTML = '<h2>Search / Oracle</h2>'",
  "      + '<div class=\"so-row\"><div><div class=\"so-rl\">Hybrid search</div><div class=\"so-rh\">ปิด = FTS5 อย่างเดียว · เปิด = ค้นแบบ hybrid</div></div>'+sw+'</div>'",
  "      + sub + note;",
  "  }",
  "  document.addEventListener('click', function(e){",
  "    var t = e.target; if(!t) return;",
  "    var host = t.closest ? t.closest('[data-so]') : null; if(!host) return;",
  "    var act = host.getAttribute('data-so');",
  "    if(act==='hybrid') post('searchSet',{field:'hybrid',value:host.getAttribute('data-next')==='1'});",
  "    else if(act==='mode') post('searchSet',{field:'mode',value:host.getAttribute('data-mode')});",
  "    else if(act==='model'){ e.preventDefault(); post('searchSet',{field:'model',value:host.getAttribute('data-model')}); }",
  "    else if(act==='index') post('indexStart',{});",
  "    else if(act==='stop') post('indexStop',{});",
  "    else if(act==='install') post('installModel',{model:host.getAttribute('data-model')});",
  "    else if(act==='choose') post('chooseModelFile',{model:host.getAttribute('data-model')});",
  "  });",
  "  window.addEventListener('message', function(ev){ var m=ev.data; if(m && m.type==='searchState'){ render(m.state); } });",
  "  post('reloadSearch');",
  "})();",
].join("\n");

export function searchSectionScript(): string {
  return _script;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/webview/searchSection.test.ts`
Expected: PASS (7 tests). If the foot-gun test fails, remove any backtick/backslash from `_script`.

- [ ] **Step 5: Commit**

```bash
git add extension/src/webview/searchSection.ts extension/src/webview/searchSection.test.ts
git commit -m "feat(search): search section assets + oracle state builder

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Integrate the section into `settings.ts` (render + toggle/mode/model wiring)

**Files:**
- Modify: `extension/src/webview/settings.ts`

**Interfaces:**
- Consumes: `searchSectionStyle/Body/Script`, `buildSearchState` (Task 4); `writeIntent`, `readIntent`, `deriveEnabled` (Task 1); `patchConfig` (Task 3).
- Produces: no new exports — extends the existing panel.

This task delivers the toggle, sub-mode, and model-pick behavior end to end (the section renders live oracle state and writes both intent + the oracle `enabled`/`primary`). Index/Install/Choose-file arrive in Tasks 6–7.

- [ ] **Step 1: Add imports** at the top of `settings.ts` (after the existing `settingsOps` import, line 8):

```ts
import { deriveEnabled, readIntent, writeIntent } from "../commands/searchOps";
import { patchConfig } from "../commands/oracleVectorClient";
import {
  buildSearchState,
  searchSectionBody,
  searchSectionScript,
  searchSectionStyle,
} from "./searchSection";
```

- [ ] **Step 2: Add a `pushSearch` helper** next to `pushList` (after line 41):

```ts
async function pushSearch(panel: vscode.WebviewPanel): Promise<void> {
  const state = await buildSearchState();
  panel.webview.postMessage({ type: "searchState", state });
}
```

- [ ] **Step 3: Add the search-message cases** to the `onDidReceiveMessage` switch. Insert these cases before the closing brace of the switch (after the existing `"set"` case block, line 80):

```ts
      case "reloadSearch":
        await pushSearch(panel);
        return;

      case "searchSet": {
        try {
          if (msg.field === "hybrid" || msg.field === "mode") {
            const intent = writeIntent(
              msg.field === "hybrid"
                ? { hybridEnabled: msg.value === true }
                : { mode: msg.value === "graph" ? "graph" : "vector" },
            );
            await patchConfig({ enabled: deriveEnabled(intent) });
          } else if (msg.field === "model" && typeof msg.value === "string") {
            await patchConfig({ collections: { [msg.value]: { primary: true } } });
          }
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`Search: ${m}`);
        }
        await pushSearch(panel);
        return;
      }
```

- [ ] **Step 4: Push search state on ready/reload.** Change the existing `"ready"`/`"reload"` case (lines 65-68) to also push search state:

```ts
      case "ready":
      case "reload":
        pushList(panel);
        void pushSearch(panel);
        return;
```

- [ ] **Step 5: Inject the section assets into `renderShell()`.**

5a. Add the style. In the `<style>` block, immediately before `</style>` (line 141), inject:

```ts
  ${searchSectionStyle()}
```

So the line reads:
```
  .note b { opacity: 0.95; }
  ${searchSectionStyle()}
</style>
```

5b. Add the body. Immediately after `<div id="groups"></div>` (line 147), insert:

```
  ${searchSectionBody()}
```

5c. Add the script. Immediately before the closing `</script>` that precedes `</body>` (line 246, right after `post("ready");`), inject the section script as a **separate** statement. Change:

```
  post("ready");
</script>
```
to:
```
  post("ready");
  window.__mcVscode = vscode;
</script>
<script>
  ${searchSectionScript()}
</script>
```

(The section script reads `window.__mcVscode` — the already-acquired VS Code API handle — because `acquireVsCodeApi()` may be called only once per webview.)

- [ ] **Step 6: Compile check**

Run: `bun run compile`
Expected: no TypeScript errors. (`msg` is untyped `any` in the existing handler, so `msg.field`/`msg.value` type-check fine.)

- [ ] **Step 7: Re-run the existing settings tests to confirm no regression**

Run: `bun test src/commands/settingsOps.test.ts`
Expected: PASS (unchanged — settingsOps was not modified).

- [ ] **Step 8: Manual verification** (no unit test for the webview)

Prereq: oracle server running — check `curl -s http://127.0.0.1:47778/api/health` returns JSON. If not, start it (`cd .../arra-oracle-v3 && bun run server`).

1. Launch the extension (VS Code `F5` / Extension Development Host) and run command **Mission Control: Settings**.
2. Confirm a "Search / Oracle" section appears below the other groups, with a sliding Hybrid switch, a Vector/Graph segmented control, and two models (BGE-M3, nomic).
3. Toggle Hybrid **ON**, pick **Vector**. Verify:
   `curl -s http://127.0.0.1:47778/api/vector/config | grep '"enabled"'` → `true`, and `cat ~/.oracle/vector-server.json` shows `"enabled": true`.
4. Toggle Hybrid **OFF** → `enabled` becomes `false`. Pick **Graph** (with Hybrid ON) → `enabled` is `false` again, but reopening the page still shows ON + Graph (intent remembered in `~/.mission-control/config.json`: `search.hybrid_enabled=true`, `search.mode="graph"`).
5. With Hybrid OFF, confirm the Mode/model sub-block is greyed and unclickable.
6. Click **nomic** → `curl .../api/vector/config` shows nomic as the primary collection.
7. Stop the oracle, reload the page → the section shows "Oracle offline"; toggling shows an error toast, not a crash.

- [ ] **Step 9: Commit**

```bash
git add extension/src/webview/settings.ts
git commit -m "feat(search): wire Search/Oracle section into the Settings page

- slide Hybrid toggle + Vector/Graph segmented control + model pick
- writes UI intent to config.json and drives oracle enabled/primary over HTTP

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Index now / Stop (host handlers + polling)

**Files:**
- Modify: `extension/src/webview/settings.ts`

**Interfaces:**
- Consumes: `startIndex`, `stopIndex`, `indexStatus` (Task 3); `pushSearch`, `buildSearchState` (Task 5).
- Produces: no new exports.

- [ ] **Step 1: Add imports** — extend the oracleVectorClient import in `settings.ts`:

```ts
import { patchConfig, startIndex, stopIndex } from "../commands/oracleVectorClient";
```

- [ ] **Step 2: Add a polling helper** after `pushSearch` (from Task 5). It re-pushes search state every 1500 ms while an index job is running, then stops:

```ts
let _indexPoll: ReturnType<typeof setInterval> | undefined;
function pollSearchWhileIndexing(panel: vscode.WebviewPanel): void {
  if (_indexPoll) return;
  _indexPoll = setInterval(async () => {
    const state = await buildSearchState();
    panel.webview.postMessage({ type: "searchState", state });
    if (state.index.status !== "indexing" && state.index.status !== "stopping") {
      clearInterval(_indexPoll);
      _indexPoll = undefined;
    }
  }, 1500);
  panel.onDidDispose(() => {
    if (_indexPoll) {
      clearInterval(_indexPoll);
      _indexPoll = undefined;
    }
  });
}
```

- [ ] **Step 3: Add the `indexStart` / `indexStop` cases** to the `onDidReceiveMessage` switch (after the `searchSet` case from Task 5):

```ts
      case "indexStart": {
        const ok = await vscode.window.showWarningMessage(
          "เริ่ม index embeddings ตอนนี้? งานนี้กิน CPU หนักและใช้เวลาสักพัก (หยุดได้ด้วยปุ่ม Stop).",
          { modal: true },
          "Index now",
        );
        if (ok !== "Index now") return;
        try {
          await startIndex(readIntent().mode === "vector" ? undefined : undefined);
          await pushSearch(panel);
          pollSearchWhileIndexing(panel);
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`Index: ${m}`);
        }
        return;
      }

      case "indexStop": {
        try {
          await stopIndex();
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`Index: ${m}`);
        }
        await pushSearch(panel);
        return;
      }
```

(Note: `startIndex()` with no arg indexes the primary collection; the oracle picks the primary from its config. The ternary is a no-op placeholder-free explicit `undefined` — indexing always targets the configured primary. Simplify to `await startIndex();` if preferred.)

- [ ] **Step 4: Simplify the startIndex call** — replace the ternary line with the plain call for clarity:

```ts
          await startIndex();
```

- [ ] **Step 5: Compile check**

Run: `bun run compile`
Expected: no TypeScript errors.

- [ ] **Step 6: Manual verification**

Prereq: oracle running; Hybrid ON + Vector; a model that exists (pick **nomic**, which is installed).
1. Open Settings → Search / Oracle. Click **Index now** → confirm the modal appears; accept.
2. The status line switches to "Indexing… X/Y (n%)" and updates roughly every 1.5 s.
3. Click **Stop** → status stops advancing; `curl -s http://127.0.0.1:47778/api/vector/index/status` shows `stopped`/`idle`.
4. Let one finish → status shows "พร้อม · N docs".

- [ ] **Step 7: Commit**

```bash
git add extension/src/webview/settings.ts
git commit -m "feat(search): Index now / Stop with live progress polling

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Install model (`ollama pull`) + Choose file

**Files:**
- Create: `extension/src/commands/ollamaPull.ts`
- Modify: `extension/src/webview/settings.ts`
- Test: `extension/src/commands/ollamaPull.test.ts`

**Interfaces:**
- Consumes: Node `child_process`; `vscode.window.showOpenDialog`, `showWarningMessage`, `withProgress`; `writeIntent` (Task 1); `pushSearch` (Task 5).
- Produces:
  - `function pullArgs(model: string): string[]` — pure, returns `["pull", <model>]` with the UI key mapped to the real ollama tag (tested).
  - `function pullModel(model: string, onLine: (s: string) => void): Promise<number>` — spawns `ollama pull`, streams stderr lines to `onLine`, resolves the exit code.

- [ ] **Step 1: Write the failing test**

Create `extension/src/commands/ollamaPull.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { pullArgs } from "./ollamaPull";

describe("pullArgs", () => {
  test("maps the bge-m3 UI key to the ollama model tag", () => {
    expect(pullArgs("bge-m3")).toEqual(["pull", "bge-m3"]);
  });
  test("maps nomic UI key to nomic-embed-text", () => {
    expect(pullArgs("nomic")).toEqual(["pull", "nomic-embed-text"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/commands/ollamaPull.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `extension/src/commands/ollamaPull.ts`:

```ts
import * as cp from "node:child_process";

// Spawns `ollama pull <tag>` locally (ollama lives at /usr/local/bin/ollama on
// this machine, on PATH). Maps the UI model key to the real ollama tag. No
// vscode import — the pure pullArgs() is unit-tested; pullModel() streams
// progress lines to a callback the webview host turns into postMessage updates.

const TAGS: Record<string, string> = {
  "bge-m3": "bge-m3",
  nomic: "nomic-embed-text",
};

/** UI key → ollama pull argv. */
export function pullArgs(model: string): string[] {
  return ["pull", TAGS[model] || model];
}

/** Spawn `ollama pull`, stream stderr (progress) lines, resolve exit code. */
export function pullModel(model: string, onLine: (s: string) => void): Promise<number> {
  return new Promise((resolve) => {
    const child = cp.spawn("ollama", pullArgs(model), { stdio: ["ignore", "pipe", "pipe"] });
    const feed = (buf: Buffer) => {
      const text = buf.toString();
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed) onLine(trimmed);
      }
    };
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code == null ? 1 : code));
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/commands/ollamaPull.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Add the `installModel` / `chooseModelFile` cases** to the `onDidReceiveMessage` switch in `settings.ts` (after the `indexStop` case). First add the import:

```ts
import { pullModel } from "../commands/ollamaPull";
```

Then the cases:

```ts
      case "installModel": {
        if (typeof msg.model !== "string") return;
        const model = msg.model;
        const ok = await vscode.window.showWarningMessage(
          `ดาวน์โหลดโมเดล ${model} ผ่าน ollama? ไฟล์อาจใหญ่หลาย GB.`,
          { modal: true },
          "Install",
        );
        if (ok !== "Install") return;
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `ollama pull ${model}`, cancellable: false },
          async (progress) => {
            const code = await pullModel(model, (line) => progress.report({ message: line }));
            if (code !== 0) vscode.window.showErrorMessage(`ollama pull ${model} ล้มเหลว (exit ${code})`);
          },
        );
        await pushSearch(panel);
        return;
      }

      case "chooseModelFile": {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: false,
          openLabel: "ใช้ไฟล์นี้เป็น model",
          title: "เลือกไฟล์ model (เผื่อโหลดไว้แล้วแต่ระบบไม่รู้ path)",
        });
        if (picked && picked[0]) {
          writeIntent({ modelPath: picked[0].fsPath });
        }
        await pushSearch(panel);
        return;
      }
```

- [ ] **Step 6: Compile check**

Run: `bun run compile`
Expected: no TypeScript errors.

- [ ] **Step 7: Manual verification**

1. Open Settings → Search / Oracle. Next to **BGE-M3** (shown "not-installed"), click **Install**. Confirm the modal, then a notification progress appears reporting `ollama pull` lines. On completion, the model row re-fetches and (if the pull succeeded and it gets indexed) status updates.
   - To avoid a multi-GB download during verification, you may instead click **Install** on **nomic** (already present → completes quickly) and confirm the progress + no error.
2. Click **Choose file** on a model, pick any local file → reopen the section and confirm "model path: <path>" is shown (persisted in `~/.mission-control/config.json` as `search.model_path`).

- [ ] **Step 8: Commit**

```bash
git add extension/src/commands/ollamaPull.ts extension/src/commands/ollamaPull.test.ts extension/src/webview/settings.ts
git commit -m "feat(search): Install (ollama pull) + Choose model file

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Full regression + verify pass

**Files:** none (verification only)

- [ ] **Step 1: Run all new unit tests**

Run (from `extension/`):
```bash
bun test src/commands/searchOps.test.ts src/commands/oracleVectorClient.test.ts src/webview/searchSection.test.ts src/commands/ollamaPull.test.ts src/commands/settingsOps.test.ts
```
Expected: all PASS.

- [ ] **Step 2: Compile the whole extension**

Run: `bun run compile`
Expected: no errors.

- [ ] **Step 3: End-to-end verify against a live oracle** (use the `verify` skill)

Confirm the full flow one more time with the oracle running: OFF→FTS5, ON+Vector→`enabled=true`, ON+Graph→`enabled=false` but remembered, model pick changes primary, Index now runs+stops, offline degrades gracefully. Watch `~/.oracle/vector-server.json` change in real time and confirm `GET /api/search?q=test&mode=hybrid` metadata reflects the toggle (`vectorAvailable` true only when ON+Vector).

- [ ] **Step 4: Final commit (if any doc/cleanup)** — otherwise nothing to commit.

---

## Self-Review

**1. Spec coverage** (checked against `2026-07-11-search-vector-settings-design.md`):
- §1 goal (toggle real, sub-mode, model, install, path, index) → Tasks 1–7.
- §3 state model & mapping (intent keys, deriveEnabled, truth table, reconcile) → Tasks 1–2, verified Task 5 step 8.
- §4 UI (slide toggle, segmented, grey-out, model picker, Install/Choose/Index) → Tasks 4–7.
- §5 message protocol (searchState push; searchSet/indexStart/indexStop/installModel/chooseModelFile/reloadSearch) → Task 4 (client) + Tasks 5–7 (host).
- §6 oracle API → Task 3.
- §7 modules → oracleVectorClient (T3), searchOps (T1–2), searchSection (T4), settings.ts change (T5–7). Note: spec listed a possible `GROUP_ORDER` edit — the plan instead renders a **bespoke section** (cleaner; no schema coupling). Documented in Task 5.
- §8 safety (manual index/install + confirm + Stop, offline banner, env note, bge-m3 not-installed banner) → Tasks 2, 5, 6, 7.
- §9 testing → unit Tasks 1–4, 7; manual/verify Tasks 5–8.
- §10 open items: (1) `/api/vector/config` auth — the client sends no auth header; verify during Task 5 step 8 (loopback is expected open; if 401, add a token header sourced from the oracle). (2) model-path oracle field — the plan stores `search.model_path` in config.json and displays it; wiring it into oracle model resolution is deferred (no oracle field confirmed) and flagged here. (3) poll interval 1500 ms — Task 6. (4) `ollama pull` progress — streamed as raw lines via `withProgress` (no fragile %-parse), matching the spec's fallback.

**2. Placeholder scan:** No "TBD"/"handle errors appropriately"/"similar to". Task 6 step 3 contained an explicit-`undefined` ternary that step 4 removes — real code, not a placeholder.

**3. Type consistency:** `SearchIntent`/`SearchMode`/`SearchViewModel` defined in Task 1–2 and consumed unchanged in Tasks 4–5. `patchConfig(PatchBody)` shape (`enabled?`, `collections?`) matches usage in Task 5 (`{enabled}`, `{collections:{[key]:{primary:true}}}`). `buildSearchState()`/`pushSearch()` names consistent across Tasks 5–7. `searchState` message type consistent between Task 4 (client listener) and Tasks 5–6 (host push).

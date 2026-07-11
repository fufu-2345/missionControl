import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Node-only settings I/O for the Settings page. Pure fs + a schema — no vscode,
// no backend — so it's unit-testable (see settingsOps.test.ts). The knobs live
// on disk at ~/.mission-control/config.json (same file the old QuickPick config
// command edited); this module reads/writes that file and pairs each key with
// display metadata so the webview can render a documented form instead of a
// bare key/value list.
//
// Tests point MC_CONFIG_PATH at a throwaway file so nothing touches the real
// config.

/** Resolve the config file path — overridable for tests. */
export function configPath(): string {
  return (
    process.env.MC_CONFIG_PATH ||
    path.join(os.homedir(), ".mission-control", "config.json")
  );
}

export type FieldType = "select" | "boolean" | "number" | "string";

export type FieldSchema = {
  key: string;
  label: string;
  group: string;
  type: FieldType;
  help: string;
  /** For select fields: {value, label} choices. */
  options?: { value: string; label: string }[];
  /** Default applied when the key is absent from the file. */
  default: string | number | boolean;
  /** Saved but no longer drives anything (backend/orchestrator removed). */
  legacy?: boolean;
};

// The known knobs, grouped for the page. Keys not listed here still show up
// under an "Other" group (read from the raw file) so nothing is ever hidden.
//
// merge_mode + push_mode are NEW keys surfaced here per the standing request to
// give the orchestrator's PR-vs-local merge behaviour a home in the Settings
// page. They default in even when the file predates them.
export const SETTINGS_SCHEMA: FieldSchema[] = [
  {
    key: "merge_mode",
    label: "Merge mode",
    group: "Orchestration",
    type: "select",
    default: "online",
    options: [
      { value: "online", label: "Online — open PR + gh merge (default)" },
      { value: "local", label: "Local — git merge --no-ff, no PR" },
    ],
    help:
      "How /orches-drive integrates a finished sprint. Online = push the agents/<role> branch, open a PR, and gh pr merge --delete-branch on GitHub, then pull --ff-only. Local = merge straight into main with no PR (offline fallback). Online needs the gh CLI logged in; if gh is missing it stops rather than silently downgrading.",
  },
  {
    key: "push_mode",
    label: "Push timing",
    group: "Orchestration",
    type: "select",
    default: "per-sprint",
    options: [
      { value: "per-sprint", label: "Per sprint — push after each sprint" },
      { value: "on-demand", label: "On demand — only when asked" },
      { value: "at-end", label: "At end — one push when the build closes" },
    ],
    help:
      "When the orchestrator pushes to the remote. Asked up-front at the start of a drive; this sets the default it offers.",
  },
  {
    key: "build_model",
    label: "Build model",
    group: "Build",
    type: "select",
    default: "claude-haiku-4-5",
    options: [
      { value: "claude-opus-4-8", label: "Opus 4.8 — strongest" },
      { value: "claude-sonnet-5", label: "Sonnet 5 — balanced" },
      { value: "claude-haiku-4-5", label: "Haiku 4.5 — fast + cheap" },
      { value: "claude-fable-5", label: "Fable 5" },
    ],
    help: "Model the worker agents run on during a build.",
  },
  {
    key: "agents",
    label: "Worker count",
    group: "Build",
    type: "number",
    default: 3,
    legacy: true,
    help: "Number of parallel worker agents.",
  },
  {
    key: "skills_hierarchical_threshold",
    label: "Skills hierarchical threshold",
    group: "Build",
    type: "number",
    default: 50,
    help:
      "Above this many skills, the loader switches to a hierarchical (grouped) index instead of a flat list.",
  },
  {
    key: "auto_loop",
    label: "Auto loop",
    group: "Orchestration",
    type: "boolean",
    default: false,
    legacy: true,
    help: "Keep driving sprints without pausing for review between them.",
  },
  {
    key: "decentralized_review",
    label: "Decentralized review",
    group: "Orchestration",
    type: "boolean",
    default: false,
    legacy: true,
    help: "Let workers review each other instead of a central review pass.",
  },
];

const SCHEMA_BY_KEY = new Map(SETTINGS_SCHEMA.map((f) => [f.key, f]));

export type SettingEntry = {
  key: string;
  label: string;
  group: string;
  type: FieldType;
  help: string;
  options?: { value: string; label: string }[];
  legacy: boolean;
  value: string | number | boolean;
  known: boolean; // false = extra key found in the file but not in the schema
};

/** Read the raw config object. Missing/corrupt file → {}. */
export function readConfig(): Record<string, unknown> {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Schema-driven view: every known field (file value or default) plus any
 *  unknown keys still on disk, so the page shows the whole file. */
export function listSettings(): SettingEntry[] {
  const raw = readConfig();
  const entries: SettingEntry[] = SETTINGS_SCHEMA.map((f) => ({
    key: f.key,
    label: f.label,
    group: f.group,
    type: f.type,
    help: f.help,
    options: f.options,
    legacy: !!f.legacy,
    value: f.key in raw ? (raw[f.key] as string | number | boolean) : f.default,
    known: true,
  }));
  for (const k of Object.keys(raw)) {
    if (SCHEMA_BY_KEY.has(k)) continue;
    if (k.startsWith("search.")) continue; // owned by the Search/Oracle section, not a generic knob
    const v = raw[k];
    entries.push({
      key: k,
      label: k,
      group: "Other",
      type:
        typeof v === "boolean"
          ? "boolean"
          : typeof v === "number"
            ? "number"
            : "string",
      help: "Extra key found in config.json (not part of the known schema).",
      legacy: false,
      value: v as string | number | boolean,
      known: false,
    });
  }
  return entries;
}

/** Coerce+validate an incoming value against the known type, then persist it.
 *  Preserves every other key. Throws on an invalid number or bad select value. */
export function setSetting(
  key: string,
  value: string | number | boolean,
): SettingEntry[] {
  const schema = SCHEMA_BY_KEY.get(key);
  const raw = readConfig();
  let next: string | number | boolean = value;

  if (schema) {
    if (schema.type === "boolean") {
      next = value === true || value === "true";
    } else if (schema.type === "number") {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error(`${key} must be a number`);
      next = n;
    } else if (schema.type === "select") {
      const ok = (schema.options ?? []).some((o) => o.value === value);
      if (!ok) throw new Error(`${key}: '${String(value)}' is not a valid option`);
      next = String(value);
    } else {
      next = String(value);
    }
  } else {
    // Unknown key already on disk — keep its existing JSON type.
    const cur = raw[key];
    if (typeof cur === "boolean") next = value === true || value === "true";
    else if (typeof cur === "number") {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error(`${key} must be a number`);
      next = n;
    } else next = String(value);
  }

  raw[key] = next;
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(raw, null, 2) + "\n", "utf8");
  return listSettings();
}

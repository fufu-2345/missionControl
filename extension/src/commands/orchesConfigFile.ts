import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Sidecar for /orches-drive knobs that the bash side reads directly. Right now
// the only knob is the verify-gate retry cap (how many times the orchestrator
// bounces a failing sprint back to the worker before it stops and asks the user
// how to proceed). The path mirrors orches-integrate.sh's own resolution EXACTLY:
//   ORCHES_SETTINGS = $ORCHES_SETTINGS || ~/.claude/orches/settings.json
// so a direct write here lands where cmd_test_cap reads it next run. Offline —
// no server, no network. Node-only + a schema → unit-testable (no vscode).
//
// On-disk shape — TWO keys so the count is remembered while "loop until pass"
// is toggled on/off (a slide switch in the UI, not a typed word):
//   { "testCap": <positive int>, "testCapNoLimit": true|false }
// noLimit=true means no cap (cmd_test_cap → 0). We still read the legacy single
// form (testCap = "unlimited"/"none"/0) as noLimit for back-compat.

const ORCHES_SETTINGS_FILE = "settings.json";
const DEFAULT_CAP = "10";

/** Absolute path to the orches settings sidecar (overridable via ORCHES_SETTINGS
 *  for tests / parity with the bash). */
export function orchesSettingsPath(): string {
  return (
    process.env.ORCHES_SETTINGS ||
    path.join(
      process.env.HOME || process.env.USERPROFILE || os.homedir(),
      ".claude",
      "orches",
      ORCHES_SETTINGS_FILE,
    )
  );
}

/** Read the raw sidecar object. Missing/corrupt → {}. */
function readRaw(): Record<string, unknown> {
  try {
    const o = JSON.parse(fs.readFileSync(orchesSettingsPath(), "utf8"));
    return o && typeof o === "object" ? (o as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function writeRaw(obj: Record<string, unknown>): void {
  const fp = orchesSettingsPath();
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

/** True when the legacy single-value form meant "no cap". */
function legacyNoLimit(tc: unknown): boolean {
  if (typeof tc === "number") return tc <= 0;
  if (typeof tc === "string") {
    const t = tc.trim().toLowerCase();
    return t === "unlimited" || t === "none" || t === "0";
  }
  return false;
}

/** The finite round count shown in the number field, always a positive-int
 *  string (default "10"). Independent of the no-limit toggle so the value the
 *  user typed survives toggling. */
export function readTestCapNumber(): string {
  const tc = readRaw()["testCap"];
  if (typeof tc === "number" && Number.isFinite(tc) && tc > 0) return String(Math.floor(tc));
  if (typeof tc === "string" && /^\d+$/.test(tc.trim()) && Number(tc) > 0) return String(Number(tc));
  return DEFAULT_CAP;
}

/** Whether "loop until pass" (no cap) is ON — the slide toggle. Reads the
 *  explicit boolean, or infers it from the legacy single-value form. */
export function readTestCapNoLimit(): boolean {
  const raw = readRaw();
  if (raw["testCapNoLimit"] === true) return true;
  if (raw["testCapNoLimit"] === false) return false;
  return legacyNoLimit(raw["testCap"]);
}

/** Validate + persist the finite round count (positive integer), preserving the
 *  no-limit toggle. Throws on anything that isn't a positive integer. */
export function writeTestCapNumber(raw: string | number): string {
  const s = String(raw).trim();
  if (!/^\d+$/.test(s) || Number(s) <= 0) {
    throw new Error("retry cap must be a positive integer");
  }
  const obj = readRaw();
  obj["testCap"] = Number(s);
  if (typeof obj["testCapNoLimit"] !== "boolean") obj["testCapNoLimit"] = legacyNoLimit(readRaw()["testCap"]);
  writeRaw(obj);
  return readTestCapNumber();
}

/** Set the "loop until pass" slide toggle, preserving the finite count (so
 *  turning it off restores the previously-typed number). */
export function writeTestCapNoLimit(on: boolean): boolean {
  const obj = readRaw();
  obj["testCapNoLimit"] = on;
  // Ensure a sane finite count is present regardless, so toggling off later
  // shows a real number rather than nothing.
  if (typeof obj["testCap"] !== "number" || !(Number(obj["testCap"]) > 0)) {
    obj["testCap"] = Number(readTestCapNumber());
  }
  writeRaw(obj);
  return readTestCapNoLimit();
}

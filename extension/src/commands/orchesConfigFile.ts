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
// On-disk shape: { "testCap": <positive int> | "unlimited" }.  The bash treats
// "unlimited" and 0 identically (= no cap); we store the word for readability.

const ORCHES_SETTINGS_FILE = "settings.json";

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

/** The retry cap as a display string the Settings UI shows/edits: a positive
 *  integer ("10") or "unlimited". Missing/blank/invalid → the default "10",
 *  matching cmd_test_cap's default. 0 (or "0") also reads back as "unlimited". */
export function readTestCap(): string {
  const v = readRaw()["testCap"];
  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    if (t === "unlimited" || t === "none" || t === "0") return "unlimited";
    if (/^\d+$/.test(t)) return t === "0" ? "unlimited" : t;
    return "10";
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    return v <= 0 ? "unlimited" : String(Math.floor(v));
  }
  return "10";
}

/** Validate a UI value (a positive integer, or "unlimited"/"none"/0) and write
 *  it to the sidecar, preserving every other key. Stores a number for a numeric
 *  cap and the word "unlimited" for no cap. Throws on anything else. */
export function writeTestCap(raw: string | number): string {
  const s = String(raw).trim().toLowerCase();
  let next: number | string;
  if (s === "unlimited" || s === "none" || s === "0") {
    next = "unlimited";
  } else if (/^\d+$/.test(s)) {
    next = Number(s); // > 0 here (0 handled above)
  } else {
    throw new Error("retry cap must be a positive integer or 'unlimited'");
  }
  const obj = readRaw();
  obj["testCap"] = next;
  const fp = orchesSettingsPath();
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  return readTestCap();
}

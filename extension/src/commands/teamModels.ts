import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Durable per-team model map: { "<oracle>": "<model>" }. Lives in a SIDECAR file
// separate from the maw tool-store config.json, because `maw team up` overwrites
// config.json's members[] with its own live-worker entries (model "claude"),
// destroying the picker's per-member model. This sidecar is owned solely by the
// Team Config picker; maw never touches it, so the picked model survives Team up
// and every launch path (Team up, orchestrator, worker dispatch) can read it.

export function teamModelsFile(team: string): string {
  return path.join(os.homedir(), ".claude", "teams", team, "models.json");
}

/** Parse a models.json body → { oracle: model }. Non-string/empty values and
 *  malformed JSON are dropped (returns {}), so a bad file never breaks a launch. */
export function parseTeamModels(raw: string): Record<string, string> {
  try {
    const obj = JSON.parse(raw) as unknown;
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        if (typeof v === "string" && v.trim()) out[k] = v;
      }
      return out;
    }
  } catch {
    /* malformed → no overrides */
  }
  return {};
}

/** Serialize a model map, pruning empty values so the file only holds real picks. */
export function serializeTeamModels(models: Record<string, string>): string {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(models)) if (v && v.trim()) clean[k] = v;
  return JSON.stringify(clean, null, 2) + "\n";
}

/** Read the sidecar for a team → { oracle: model }. Missing/unreadable → {}. */
export function readTeamModels(team: string): Record<string, string> {
  try {
    return parseTeamModels(fs.readFileSync(teamModelsFile(team), "utf8"));
  } catch {
    return {};
  }
}

/** Write the sidecar (creates the team dir if needed). Best-effort. */
export function writeTeamModels(team: string, models: Record<string, string>): void {
  const file = teamModelsFile(team);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, serializeTeamModels(models));
}

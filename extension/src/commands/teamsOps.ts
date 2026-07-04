import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { run, type RunResult } from "./gitOps";
import { parseOraclePath } from "./teams";
import {
  createArgs,
  deleteArgs,
  diffMembers,
  inviteArgs,
  mergeTeamStores,
  removeArgs,
  type TeamDetail,
  type TeamMember,
} from "./teamsModel";

// Extension-side team CRUD. Membership + roles persist through the maw CLI
// (oracle-invite / oracle-remove / create / delete — arg arrays, no shell).
// Two things have no CLI verb, so they are data-file writes into maw's OWN
// stores (allowed — data, not maw source): the team description and per-member
// run-config (model/color) live in ~/.claude/teams/<t>/config.json.

const MAW_TEAMS_DIR = path.join(os.homedir(), ".maw", "teams");
const TOOL_TEAMS_DIR = path.join(os.homedir(), ".claude", "teams");
const ORACLES_JSON = path.join(os.homedir(), ".maw", "oracles.json");
const MAW_TIMEOUT = 15000;

const runMaw = (args: string[]): Promise<RunResult> => run("maw", args, { timeout: MAW_TIMEOUT });

interface ToolConfig {
  name?: string;
  description?: string;
  createdAt?: string;
  members?: { name: string; model?: string; color?: string; [k: string]: unknown }[];
  [k: string]: unknown;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Every team name from the oracle store (the panel's source of truth), sorted. */
export function listTeamNames(): string[] {
  try {
    return fs
      .readdirSync(MAW_TEAMS_DIR)
      .filter((e) => fs.existsSync(path.join(MAW_TEAMS_DIR, e, "oracle-members.json")))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/** Summaries for the list screen (name + counts + role preview). */
export function listTeamSummaries(): { name: string; memberCount: number; roles: string[] }[] {
  return listTeamNames().map((name) => {
    const d = readTeamDetailSync(name);
    return {
      name,
      memberCount: d.members.length,
      roles: [...new Set(d.members.map((m) => m.role))],
    };
  });
}

/** Read + merge both stores for one team. Sync (small local JSON reads). */
export function readTeamDetailSync(name: string): TeamDetail {
  const oracle = readJson<{ members?: { oracle: string; role?: string }[] }>(
    path.join(MAW_TEAMS_DIR, name, "oracle-members.json"),
  );
  const tool = readJson<ToolConfig>(path.join(TOOL_TEAMS_DIR, name, "config.json"));
  const members = mergeTeamStores(oracle?.members ?? [], tool?.members ?? []);
  return { name, description: tool?.description ?? "", members };
}

/** Existing oracle names (add-member picker source), sorted, minus a team's
 *  current members if given. */
export function oracleCandidates(exclude: string[] = []): string[] {
  const data = readJson<{ oracles?: { name?: string }[] }>(ORACLES_JSON);
  const ex = new Set(exclude);
  const names = (data?.oracles ?? [])
    .map((o) => o?.name)
    .filter((n): n is string => typeof n === "string" && !ex.has(n));
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

/** Upsert the tool-store config.json — description and/or per-member run-config
 *  (model/color). Creates the dir/file if the team never ran. */
function writeToolConfig(
  name: string,
  patch: { description?: string; members?: TeamMember[] },
): void {
  const dir = path.join(TOOL_TEAMS_DIR, name);
  const file = path.join(dir, "config.json");
  const cfg: ToolConfig = readJson<ToolConfig>(file) ?? { name, members: [] };
  if (!Array.isArray(cfg.members)) cfg.members = [];
  if (patch.description !== undefined) cfg.description = patch.description;
  for (const m of patch.members ?? []) {
    let entry = cfg.members.find((x) => x.name === m.oracle);
    if (!entry) {
      entry = { name: m.oracle };
      cfg.members.push(entry);
    }
    if (m.model !== undefined) entry.model = m.model;
    if (m.color !== undefined) entry.color = m.color;
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
}

export interface SaveResult {
  ok: boolean;
  errors: string[];
}

/** Apply an edited roster + description to an EXISTING team (minimal commands). */
export async function saveTeam(
  name: string,
  description: string,
  edited: TeamMember[],
): Promise<SaveResult> {
  const original = readTeamDetailSync(name);
  const diff = diffMembers(original.members, edited);
  const errors: string[] = [];

  for (const oracle of diff.removed) {
    const r = await runMaw(removeArgs(oracle, name));
    if (!r.ok) errors.push(`remove ${oracle}: ${firstLine(r)}`);
  }
  for (const m of [...diff.added, ...diff.roleChanged]) {
    const r = await runMaw(inviteArgs(m.oracle, name, m.role));
    if (!r.ok) errors.push(`invite ${m.oracle}: ${firstLine(r)}`);
  }
  // Description + run-config (model/color) are data-file writes. Include the
  // added members' config too so a brand-new member's model/color persists.
  try {
    const cfgMembers = [...diff.added, ...diff.configChanged];
    writeToolConfig(name, {
      description: description !== original.description ? description : undefined,
      members: cfgMembers,
    });
  } catch (e) {
    errors.push(`config write: ${String(e)}`);
  }
  return { ok: errors.length === 0, errors };
}

/** Create a new team + invite its members. */
export async function createTeam(
  name: string,
  description: string,
  members: TeamMember[],
): Promise<SaveResult> {
  const errors: string[] = [];
  const created = await runMaw(createArgs(name, description));
  if (!created.ok) return { ok: false, errors: [`create: ${firstLine(created)}`] };
  for (const m of members) {
    const r = await runMaw(inviteArgs(m.oracle, name, m.role));
    if (!r.ok) errors.push(`invite ${m.oracle}: ${firstLine(r)}`);
  }
  if (members.some((m) => m.model || m.color) || description) {
    try {
      writeToolConfig(name, { description, members });
    } catch (e) {
      errors.push(`config write: ${String(e)}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Delete a team: maw delete (tool store) + rm the oracle store dir. The vault
 *  manifest (if any) may linger as a "vault-only" ghost — surfaced, not force-rm'd. */
export async function deleteTeam(name: string): Promise<SaveResult> {
  const errors: string[] = [];
  const del = await runMaw(deleteArgs(name));
  if (!del.ok && !/not found/i.test(del.stderr + del.stdout)) {
    errors.push(`delete: ${firstLine(del)}`);
  }
  try {
    fs.rmSync(path.join(MAW_TEAMS_DIR, name), { recursive: true, force: true });
  } catch (e) {
    errors.push(`rm oracle store: ${String(e)}`);
  }
  return { ok: errors.length === 0, errors };
}

function firstLine(r: RunResult): string {
  return (r.stderr || r.stdout || "failed").split("\n")[0];
}

// Re-export so the panel can resolve an oracle's repo (future: open its dir).
export { parseOraclePath };

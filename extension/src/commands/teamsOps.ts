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
  isSafeTeamName,
  mergeTeamStores,
  MODEL_ALIASES,
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
const BUD_TIMEOUT = 90000; // scaffolding an oracle (repo + ψ vault) is slower
// All local oracles live under this org (matches every entry in oracles.json).
const ORACLE_ORG = "fufu-2345";

const runMaw = (args: string[]): Promise<RunResult> => run("maw", args, { timeout: MAW_TIMEOUT });

/** Existing oracle names from the fleet registry (used to decide whether an
 *  added member is a brand-new oracle to scaffold, or one that already exists). */
function existingOracleNames(): Set<string> {
  const data = readJson<{ oracles?: { name?: string }[] }>(ORACLES_JSON);
  return new Set(
    (data?.oracles ?? [])
      .map((o) => o?.name)
      .filter((n): n is string => typeof n === "string" && n.length > 0),
  );
}

/** Create a NEW oracle's structure (repo + ψ vault + CLAUDE.md + fleet config)
 *  but STOP before commit/push/wake/awaken — it gets waked later, when the team
 *  is actually put to work. `--scaffold-only` is what makes it not wake. */
function scaffoldOracle(name: string): Promise<RunResult> {
  return run(
    "maw",
    ["bud", name, "--root", "--org", ORACLE_ORG, "--scaffold-only"],
    { timeout: BUD_TIMEOUT },
  );
}

/** For each member to add: scaffold the oracle first if it doesn't exist yet,
 *  then oracle-invite it (invite also upserts the role for existing members). */
async function ensureAndInvite(
  team: string,
  members: TeamMember[],
  errors: string[],
): Promise<void> {
  const existing = existingOracleNames();
  for (const m of members) {
    if (!existing.has(m.oracle)) {
      if (!isSafeTeamName(m.oracle)) {
        errors.push(`create ${m.oracle}: ชื่อไม่ถูกต้อง (A-Z a-z 0-9 . _ -)`);
        continue;
      }
      const c = await scaffoldOracle(m.oracle);
      if (!c.ok) {
        errors.push(`create ${m.oracle}: ${firstLine(c)}`);
        continue; // don't invite a phantom the scaffold failed to create
      }
      existing.add(m.oracle);
    }
    const r = await runMaw(inviteArgs(m.oracle, team, m.role));
    if (!r.ok) errors.push(`invite ${m.oracle}: ${firstLine(r)}`);
  }
}

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
  // Added members may be brand-new oracles (scaffold them first); roleChanged
  // are always existing, so ensureAndInvite just re-invites to upsert the role.
  await ensureAndInvite(name, [...diff.added, ...diff.roleChanged], errors);
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
  await ensureAndInvite(name, members, errors);
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

// ── Model options for the per-member dropdown (live, not hardcoded IDs) ───────

let _modelsCache: Promise<string[]> | null = null;

/** Options for the member "model" dropdown. Base = the version-proof provider
 *  aliases (opus/sonnet/haiku). If an Anthropic API key is in the environment,
 *  augment with the concrete model IDs the provider currently serves (GET
 *  /v1/models) so the list reflects reality even after the provider renames or
 *  adds models. Cached for the panel's lifetime; never throws. */
export function availableModels(): Promise<string[]> {
  if (!_modelsCache) _modelsCache = computeModels();
  return _modelsCache;
}

async function computeModels(): Promise<string[]> {
  const base: string[] = [...MODEL_ALIASES];
  const key = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || "";
  if (!key) return base; // no key → offer the aliases only (already version-proof)
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch("https://api.anthropic.com/v1/models?limit=100", {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return base;
    const data = (await res.json()) as { data?: { id?: string }[] };
    const ids = (data.data ?? [])
      .map((m) => m?.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    // Aliases first (recommended), then concrete IDs not already covered.
    return [...base, ...ids.filter((id) => !base.includes(id))];
  } catch {
    return base;
  }
}

// Re-export so the panel can resolve an oracle's repo (future: open its dir).
export { parseOraclePath };

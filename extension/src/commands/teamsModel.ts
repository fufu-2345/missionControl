// Pure model for the Teams panel: parse the two team stores, build the maw CLI
// arg-arrays that persist edits, and diff an edited roster against the original
// so Save runs the minimal set of commands. NO vscode/fs/cp import — every
// filesystem + exec side effect lives in teamsOps.ts, so this stays unit-tested
// with `bun test`.

/** Roles the maw oracle store uses in practice (free-text field, but these are
 *  the established vocabulary — offered as a dropdown). */
export const ROLE_OPTIONS = ["orchestrator", "member", "builder"] as const;

/** Member colors — EXACTLY maw's AgentColor palette (maw-js
 *  tmux/layout-manager.ts → AGENT_COLORS). This is the color maw paints the
 *  member's tmux pane border and the ● dot in `maw team status`/`list`; it is
 *  only visible while the team is live. Keep this list in sync with maw. */
export const COLOR_OPTIONS = [
  "blue",
  "green",
  "yellow",
  "cyan",
  "magenta",
  "red",
  "white",
  "orange",
] as const;

/** Model options for `claude --model` — pinned, versioned Claude model IDs so the
 *  dropdown shows an explicit version rather than a bare "opus"/"claude". Trade-off
 *  vs bare aliases (opus/sonnet/haiku, which auto-track the latest tier): these pin
 *  to a specific version and must be hand-bumped when a newer model ships.
 *  teamsOps.availableModels() still merges the real, currently-served model IDs on
 *  top of these when an Anthropic API key is present in the environment. */
export const MODEL_ALIASES = [
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-5",
  "claude-haiku-4-5",
] as const;

export const DEFAULT_ROLE = "member";
// The model a member defaults to when none is stored (or when maw wrote the bare
// engine name "claude" into the model field). Pinned to a versioned id so the
// dropdown pre-selects a concrete version and maw launches `claude --model claude-sonnet-5`.
export const DEFAULT_MODEL = "claude-sonnet-5";

export interface TeamMember {
  oracle: string;
  role: string;
  model?: string; // run-config (tool store); undefined if the team never ran
  color?: string; // run-config (tool store)
}

export interface TeamDetail {
  name: string;
  description: string;
  members: TeamMember[];
}

/** Names safe to pass to a maw CLI arg / use as a store dir. Whitelist only. */
export function isSafeTeamName(name: string): boolean {
  if (!name || name.length > 100) return false;
  return /^[A-Za-z0-9._-]+$/.test(name);
}

/** Merge the oracle store (roles, source of truth for membership) with the tool
 *  store (per-member model/color run-config) into the panel's member list. The
 *  oracle store drives which members exist; tool config only decorates. */
export function mergeTeamStores(
  oracleMembers: { oracle: string; role?: string }[],
  toolMembers: { name: string; model?: string; color?: string }[],
): TeamMember[] {
  const byName = new Map(toolMembers.map((m) => [m.name, m]));
  return oracleMembers.map((m) => {
    const tool = byName.get(m.oracle);
    return {
      oracle: m.oracle,
      role: (m.role && m.role.trim()) || DEFAULT_ROLE,
      model: tool?.model,
      color: tool?.color,
    };
  });
}

// ── maw CLI arg builders (return arg arrays for execFile — no shell) ──────────

export function inviteArgs(oracle: string, team: string, role: string): string[] {
  const a = ["team", "oracle-invite", oracle, "--team", team];
  if (role && role.trim()) a.push("--role", role.trim());
  return a;
}

export function removeArgs(oracle: string, team: string): string[] {
  return ["team", "oracle-remove", oracle, "--team", team];
}

export function createArgs(name: string, description: string): string[] {
  const a = ["team", "create", name];
  if (description && description.trim()) a.push("--description", description.trim());
  return a;
}

export function deleteArgs(name: string): string[] {
  return ["team", "delete", name];
}

// ── Save diff: original roster → edited roster → minimal command plan ─────────

export interface MemberDiff {
  added: TeamMember[]; // oracle-invite (with role)
  removed: string[]; // oracle-remove (oracle names)
  roleChanged: TeamMember[]; // oracle-invite (re-invite upserts role)
  configChanged: TeamMember[]; // write tool config (model/color differs)
}

/** Compute the minimal change set between the original and edited member lists.
 *  `added`/`roleChanged` reuse oracle-invite (idempotent upsert); `removed` uses
 *  oracle-remove; `configChanged` is a tool-store write (model/color). */
export function diffMembers(
  original: TeamMember[],
  edited: TeamMember[],
): MemberDiff {
  const origByName = new Map(original.map((m) => [m.oracle, m]));
  const editByName = new Map(edited.map((m) => [m.oracle, m]));
  const diff: MemberDiff = { added: [], removed: [], roleChanged: [], configChanged: [] };

  for (const m of edited) {
    const orig = origByName.get(m.oracle);
    if (!orig) {
      diff.added.push(m);
      continue;
    }
    if ((orig.role || DEFAULT_ROLE) !== (m.role || DEFAULT_ROLE)) diff.roleChanged.push(m);
    if ((orig.model ?? "") !== (m.model ?? "") || (orig.color ?? "") !== (m.color ?? "")) {
      diff.configChanged.push(m);
    }
  }
  for (const m of original) {
    if (!editByName.has(m.oracle)) diff.removed.push(m.oracle);
  }
  return diff;
}

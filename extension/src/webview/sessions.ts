// Pure helpers for the dashboard Sessions panel. NO vscode import here so the
// parsing + validation logic can be unit-tested standalone with `bun test`.

import type { OracleTeam } from "../commands/teams";

export interface TmuxSession {
  name: string;
  windows: number;
  attached: boolean;
  cmd: string; // active pane's current command (claude / maw / bash …)
  cwd: string; // active pane's current path
  orchesLabel?: string; // tmux user-option @orches_label (authoritative display label)
  label?: string; // computed display label (filled in the extension host, see dashboard.ts)
}

// `tmux list-sessions -F` format string. Tab-separated because a tab is far
// less likely than `|`/space to appear inside a session name or path. The
// @orches_label column sits BEFORE cwd so cwd stays the tab-safe slice tail.
export const TMUX_FMT =
  "#{session_name}\t#{session_windows}\t#{session_attached}\t#{pane_current_command}\t#{@orches_label}\t#{pane_current_path}";

/** Parse stdout of `tmux list-sessions -F TMUX_FMT`. Tolerant: blank input or a
 *  "no server running" message yields []; lines without 5 fields are skipped. */
export function parseTmuxSessions(raw: string): TmuxSession[] {
  const out: TmuxSession[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 5) continue;
    const name = parts[0];
    if (!name) continue;
    out.push({
      name,
      windows: Number.parseInt(parts[1], 10) || 0,
      // session_attached is a COUNT of clients (0, 1, 2, …) — attached when > 0.
      // (=== "1" was wrong: a 2nd client, e.g. dashboard + orchestrator tab, made it "2".)
      attached: !!parts[2] && parts[2] !== "0",
      cmd: parts[3] ?? "",
      orchesLabel: parts[4] || undefined,
      cwd: parts.slice(5).join("\t"),
    });
  }
  return out;
}

/** True when a name is safe to interpolate (single-quoted) into a shell
 *  `tmux attach -t '<name>'`. Whitelist only. */
export function isSafeSessionName(name: string): boolean {
  if (!name || name.length > 200) return false;
  // Whitelist: letters, digits, dot, underscore, hyphen. Anything else (spaces,
  // quotes, control chars, shell metacharacters) is rejected, so the name is
  // safe to single-quote into `tmux attach -t '<name>'`.
  return /^[A-Za-z0-9._-]+$/.test(name);
}

/** Shell command to attach to a session. Caller MUST validate with
 *  isSafeSessionName first; the name is single-quoted. The `=` prefix forces
 *  an EXACT session-name match — without it tmux falls back to prefix/fnmatch
 *  matching, so if the named session died you could silently attach to (or,
 *  in the kill path, destroy) a different session sharing the prefix. */
export function buildAttachCommand(name: string): string {
  return `tmux attach -t '=${name}'`;
}

/** Oracle names from ~/.maw/oracles.json content. Tolerant: junk → []. */
export function parseOraclesJson(raw: string): string[] {
  try {
    const d = JSON.parse(raw) as { oracles?: unknown };
    if (!Array.isArray(d?.oracles)) return [];
    return d.oracles
      .map((o) => (o as { name?: unknown })?.name)
      .filter((n): n is string => typeof n === "string");
  } catch {
    return [];
  }
}

/** First pane cwd sitting under a `.../projects/<name>` dir → that project's
 *  name + root path. Used to label a session by the project it is building. */
export function projectFromPaths(paths: string[]): { name: string; path: string } | null {
  for (const p of paths) {
    const m = p.match(/^(.*\/projects\/([^/]+))(?:\/|$)/);
    if (m) return { path: m[1], name: m[2] };
  }
  return null;
}

/** A session that is a single woken oracle → that oracle's name. Only when it
 *  has exactly one window and its name (`NN-<oracle>` / `claude-<oracle>` /
 *  bare) resolves to a known oracle. */
export function loneOracleName(session: TmuxSession, knownOracles: string[]): string | null {
  if (session.windows !== 1) return null;
  const stem = session.name.replace(/^\d+-/, "").replace(/^claude-/, "");
  return knownOracles.includes(stem) ? stem : null;
}

/** The team an oracle belongs to — first team by name (deterministic). null
 *  when the oracle is in no team. */
export function teamOfOracle(oracle: string, teams: OracleTeam[]): string | null {
  const hit = [...teams]
    .sort((a, b) => a.name.localeCompare(b.name))
    .find((t) => t.members.some((m) => m.oracle === oracle));
  return hit ? hit.name : null;
}

/** Priority-based display label: orches-label (authoritative) → project →
 *  lone-oracle → raw session name. Separator is " / ". */
export function computeSessionLabel(args: {
  orchesLabel?: string;
  project?: { name: string; team?: string };
  loneOracle?: { oracle: string; team?: string };
  rawName: string;
}): string {
  const lbl = args.orchesLabel?.trim();
  if (lbl) return lbl;
  if (args.project) {
    return args.project.team ? `${args.project.name} / ${args.project.team}` : args.project.name;
  }
  if (args.loneOracle) {
    return args.loneOracle.team ? `${args.loneOracle.team} / ${args.loneOracle.oracle}` : args.loneOracle.oracle;
  }
  return args.rawName;
}

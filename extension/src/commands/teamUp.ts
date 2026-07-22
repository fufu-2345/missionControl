import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

import { isSafeTeamName } from "./teamsModel";
import { readTeamDetailSync } from "./teamsOps";
import {
  buildTeamUpCommand,
  parseCharterSession,
  resolveInstanceSession,
  SAFE_SESSION,
} from "./teamUpModel";

// "Team up" — a CODE-ONLY bootstrap (no LLM / no skill): run `maw team up <team>`
// into a tmux session, then attach the user to it in an editor terminal (same
// spot as Open Claude). `maw team up` reads the team's charter (bob/jack/john
// for brew) and fresh-wakes each member into the target session.
//
// 1 session = 1 team instance (the /orches model): the base session is the
// team's charter.session (falls back to the team name — which is also what
// `maw team up` targets by default). If that base session is already live
// (this team was up'd before), we don't reconcile into it — we MINT a fresh
// instance `base-2`, `base-3`, … so a second click gives a separate run, exactly
// like startOrchestrator's twin-session logic.
const SOULBREW_DIR = path.join(os.homedir(), "Desktop", "soulbrew");

// One editor terminal per team-up SESSION (keyed by session name), so minting a
// second instance never closes the first — many team instances run side by side.
const _teamTerminals = new Map<string, vscode.Terminal>();

/** The base tmux session `maw team up <team>` targets by default: the team's
 *  charter.session if a charter yaml declares one, else the team name. Mirrors
 *  maw's resolveCharterPath (<root>/.maw/teams/<t>.yaml, then <root>/ψ/teams/…)
 *  so our "already up" check agrees with the session maw would actually use. */
function baseSessionForTeam(team: string): string {
  const candidates = [
    path.join(SOULBREW_DIR, ".maw", "teams", `${team}.yaml`),
    path.join(SOULBREW_DIR, "ψ", "teams", `${team}.yaml`),
  ];
  for (const file of candidates) {
    try {
      const session = parseCharterSession(fs.readFileSync(file, "utf8"));
      if (session) return session;
    } catch {
      /* try next / fall back to the team name */
    }
  }
  return team;
}

function tmuxHasSession(session: string): boolean {
  try {
    cp.execFileSync("tmux", ["has-session", "-t", `=${session}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Run a command in an editor terminal once shell integration is ready (or after
 *  a short fallback) so the long-running team-up + attach survives. Copied from
 *  startOrchestrator so both bootstraps behave identically. */
function runInTerminal(term: vscode.Terminal, command: string): void {
  let done = false;
  const go = () => {
    if (done || term.exitStatus !== undefined) return;
    done = true;
    if (term.shellIntegration) term.shellIntegration.executeCommand(command);
    else term.sendText(command);
  };
  if (term.shellIntegration) {
    go();
  } else {
    const sub = vscode.window.onDidChangeTerminalShellIntegration((e) => {
      if (e.terminal === term) {
        sub.dispose();
        go();
      }
    });
    setTimeout(() => {
      sub.dispose();
      go();
    }, 2500);
  }
}

export interface TeamUpResult {
  error?: string;
  session?: string;
  minted?: boolean;
}

/** Shared tail of teamUp/teamUpMember: resolve the target session, build the
 *  wake command for the given roster, and run it in a fresh editor terminal.
 *  One editor tab per SESSION (a minted instance gets its own) — never touch
 *  another instance's tab. */
function launchTeamSession(
  team: string,
  members: string[],
  models: Record<string, string>,
  label: string,
): TeamUpResult {
  const base = baseSessionForTeam(team);
  const { session, minted } = resolveInstanceSession(base, tmuxHasSession);
  // base = charter.session / team name (safe), + numeric -N suffix → always
  // matches SAFE_SESSION; guard anyway so a hand-edited charter can't inject.
  if (!SAFE_SESSION.test(session)) return { error: `ชื่อ session ไม่ปลอดภัย: ${session}` };

  const command = buildTeamUpCommand(team, session, SOULBREW_DIR, members, models);
  const prev = _teamTerminals.get(session);
  if (prev && prev.exitStatus === undefined) prev.dispose();
  const term = vscode.window.createTerminal({
    name: `team: ${label}${minted ? ` · ${session}` : ""}`,
    location: vscode.TerminalLocation.Editor,
    cwd: SOULBREW_DIR,
  });
  _teamTerminals.set(session, term);
  term.show(false);
  runInTerminal(term, command);
  return { session, minted };
}

/** `maw team up <team>` into a fresh editor terminal + attach. Mints a `-N`
 *  instance session when the team's base session is already live. */
export function teamUp(team: string): TeamUpResult {
  if (!isSafeTeamName(team)) return { error: `ชื่อทีมไม่ปลอดภัย: ${team}` };
  // Roster → sequential per-member `--only` wakes (see buildTeamUpCommand).
  // Only shell-safe oracle names; unsafe ones are dropped rather than injected.
  const detail = readTeamDetailSync(team);
  const members = detail.members.map((m) => m.oracle).filter((o) => isSafeTeamName(o));
  // Per-member model from the Team Config picker → applied via /model after wake
  // (maw team up can't carry it). Only safe names; buildTeamUpCommand re-guards the value.
  const models: Record<string, string> = {};
  for (const m of detail.members) if (m.oracle && m.model) models[m.oracle] = m.model;
  return launchTeamSession(team, members, models, team);
}

/** Wake a single member of the team, same session semantics as teamUp (base
 *  free → use it, base live → mint a fresh `-N` instance) but the roster is
 *  just this one oracle — the rest of the team is untouched. */
export function teamUpMember(team: string, oracle: string): TeamUpResult {
  if (!isSafeTeamName(team)) return { error: `ชื่อทีมไม่ปลอดภัย: ${team}` };
  if (!isSafeTeamName(oracle)) return { error: `ชื่อ oracle ไม่ปลอดภัย: ${oracle}` };
  const detail = readTeamDetailSync(team);
  const member = detail.members.find((m) => m.oracle === oracle);
  if (!member) return { error: `ไม่พบ '${oracle}' ในทีม '${team}'` };
  const models = member.model ? { [oracle]: member.model } : {};
  return launchTeamSession(team, [oracle], models, `${team} · ${oracle}`);
}

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

import {
  buildKickoffPrompt,
  buildTmuxLaunchCommand,
  isSafeOracleName,
  type OracleTeam,
  parseOraclePath,
  parseSessionPin,
  parseTeamRoster,
} from "./teams";

const ORACLES_JSON = path.join(os.homedir(), ".maw", "oracles.json");
const MAW_CONFIG_DIR = path.join(os.homedir(), ".config", "maw");

/** The oracle's pinned tmux session from the newest `maw.config*.json` (the
 *  filename carries a schema number, e.g. maw.config.50.json — don't hardcode
 *  it). null → no pin → the button falls back to `claude-<orch>`. */
function readSessionPin(oracle: string): string | null {
  try {
    const newest = fs
      .readdirSync(MAW_CONFIG_DIR)
      .filter((f) => /^maw\.config.*\.json$/.test(f))
      .map((f) => {
        const p = path.join(MAW_CONFIG_DIR, f);
        return { p, mtime: fs.statSync(p).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime)[0];
    return newest ? parseSessionPin(fs.readFileSync(newest.p, "utf8"), oracle) : null;
  } catch {
    return null;
  }
}

// "Start Orchestrator" — a CODE-ONLY bootstrap (no LLM / no skill): read the
// oracle-team rosters off disk, let the user pick a team + orchestrator, then
// open an editor terminal that wakes+attaches JUST the orchestrator oracle
// (`maw wake <orch> --attach`). Workers are left asleep — the orchestrator
// wakes them lazily when it dispatches a sprint. Instant, zero tokens.
const TEAMS_DIR = path.join(os.homedir(), ".maw", "teams");

/** Read every `~/.maw/teams/<name>/oracle-members.json` off disk (skips bad
 *  ones), sorted by name. Empty [] if the dir is missing. */
function readTeams(): OracleTeam[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(TEAMS_DIR);
  } catch {
    return [];
  }
  const out: OracleTeam[] = [];
  for (const entry of entries) {
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(TEAMS_DIR, entry, "oracle-members.json"), "utf8");
    } catch {
      continue; // no roster in this dir
    }
    const team = parseTeamRoster(entry, raw);
    if (team && team.members.length) out.push(team);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Reuse one editor terminal across clicks (fresh attach each start).
let _orchTerminal: vscode.Terminal | undefined;

export async function startOrchestratorCommand(_context: vscode.ExtensionContext) {
  const teams = readTeams();
  if (!teams.length) {
    vscode.window.showWarningMessage(
      "Mission Control: ไม่พบ oracle-team ใน ~/.maw/teams — สร้างก่อนด้วย `maw bud <ชื่อ>` + `maw team oracle-invite <ชื่อ> --team <t> --role orchestrator`",
    );
    return;
  }

  // 1) pick a team (clean list straight from disk — no analysis)
  const teamPick = await vscode.window.showQuickPick(
    teams.map((t) => ({
      label: t.name,
      description: `${t.members.length} members · orchestrator: ${
        t.orchestrators.join(", ") || "(none)"
      }`,
      team: t,
    })),
    { title: "Start Orchestrator — เลือกทีม", placeHolder: "เลือก oracle-team" },
  );
  if (!teamPick) return;
  const team = teamPick.team;

  // 2) resolve the orchestrator (1 → auto, >1 → pick, 0 → guide)
  let orch: string | undefined;
  if (team.orchestrators.length === 1) {
    orch = team.orchestrators[0];
  } else if (team.orchestrators.length > 1) {
    orch = await vscode.window.showQuickPick(team.orchestrators, {
      title: `${team.name} — เลือก orchestrator`,
      placeHolder: "ทีมนี้มี orchestrator หลายตัว",
    });
  } else {
    vscode.window.showWarningMessage(
      `Mission Control: ทีม '${team.name}' ไม่มี member role:orchestrator — tag ก่อน: ` +
        `maw team oracle-invite <ชื่อ> --team ${team.name} --role orchestrator`,
    );
    return;
  }
  if (!orch) return;
  if (!isSafeOracleName(orch)) {
    vscode.window.showErrorMessage(`Mission Control: ชื่อ orchestrator ไม่ปลอดภัย: ${orch}`);
    return;
  }

  // 3) resolve the orchestrator's repo path (launch claude in ITS dir so it
  //    loads its CLAUDE.md + ψ). Path comes from the oracles.json scan cache.
  let repoPath: string | null = null;
  try {
    repoPath = parseOraclePath(fs.readFileSync(ORACLES_JSON, "utf8"), orch);
  } catch {
    repoPath = null;
  }
  if (!repoPath) {
    vscode.window.showErrorMessage(
      `Mission Control: หา repo ของ '${orch}' ไม่เจอใน ~/.maw/oracles.json — ลองรัน \`maw oracle scan\` ก่อน`,
    );
    return;
  }

  // 4) build the launch: workers (non-orchestrator members) + a kickoff prompt so
  //    the orchestrator immediately runs /orches-drive with its team context.
  const workers = team.members
    .filter((m) => m.role !== "orchestrator")
    .map((m) => m.oracle);
  const sessionName = readSessionPin(orch) ?? undefined; // pinned (09-foreman) or claude-<orch>
  const command = buildTmuxLaunchCommand(
    orch,
    repoPath,
    buildKickoffPrompt(team.name, orch, workers),
    sessionName,
  );

  // 5) editor terminal attaches to the orchestrator's tmux session (created
  //    fresh with claude+kickoff on first click; -A reattaches on later clicks).
  //    Closing the tab only detaches — the orchestrator keeps running.
  if (_orchTerminal && _orchTerminal.exitStatus === undefined) {
    _orchTerminal.dispose(); // avoid stacking on repeated clicks
  }
  const term = vscode.window.createTerminal({
    name: `orchestrator: ${orch}`,
    location: vscode.TerminalLocation.Editor,
  });
  _orchTerminal = term;
  term.show(false);
  let launched = false;
  const launch = () => {
    if (launched || term.exitStatus !== undefined) return;
    launched = true;
    if (term.shellIntegration) term.shellIntegration.executeCommand(command);
    else term.sendText(command);
  };
  if (term.shellIntegration) {
    launch();
  } else {
    const sub = vscode.window.onDidChangeTerminalShellIntegration((e) => {
      if (e.terminal === term) {
        sub.dispose();
        launch();
      }
    });
    setTimeout(() => {
      sub.dispose();
      launch();
    }, 2500);
  }

  vscode.window.showInformationMessage(
    `Mission Control: ปลุก orchestrator '${orch}' (team ${team.name}) + เริ่ม /orches-drive — ` +
      `foreman จะถาม requirement ใน terminal เอง · worker ปลุกตอนแจกงาน`,
  );
}

import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

import {
  buildKickoffPrompt,
  buildResumeKickoff,
  buildTmuxLaunchCommand,
  isSafeOracleName,
  type OracleTeam,
  parseOraclePath,
  parseSessionPin,
  parseTeamRoster,
} from "./teams";
import {
  defaultTeamForProject,
  isResumable,
  parseOrchesMeta,
  parsePlan,
  type ResumableProject,
  serializeOrchesMeta,
  sortResumable,
} from "./orchestratorResume";

const ORACLES_JSON = path.join(os.homedir(), ".maw", "oracles.json");
const MAW_CONFIG_DIR = path.join(os.homedir(), ".config", "maw");

// Same rule as maw itself (src/config/load.ts CONFIG_FILE_REGEX): weighted
// numbered files, NOT newest-mtime — a touched legacy maw.config.json must not
// shadow the real weighted config, or the button and `maw wake` would resolve
// different sessions (the split-brain the pin exists to prevent).
const MAW_CONFIG_FILE_REGEX = /^maw\.config\.(\d+)(\.local)?\.json$/;

/** The oracle's pinned tmux session from maw's weighted config files, highest
 *  weight first (`.local` overlays its base). null → no pin → `claude-<orch>`. */
function readSessionPin(oracle: string): string | null {
  try {
    const ranked = fs
      .readdirSync(MAW_CONFIG_DIR)
      .map((f) => MAW_CONFIG_FILE_REGEX.exec(f))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => ({ f: m[0], num: parseInt(m[1], 10), local: m[2] ? 1 : 0 }))
      .sort((a, b) => b.num - a.num || b.local - a.local);
    for (const c of ranked) {
      const pin = parseSessionPin(
        fs.readFileSync(path.join(MAW_CONFIG_DIR, c.f), "utf8"),
        oracle,
      );
      if (pin) return pin;
    }
    return null;
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

/** Teams the dashboard "start/continue" screens list. Exported wrapper. */
export function listOrchestratorTeams(): OracleTeam[] {
  return readTeams();
}

/** The `.../github.com/<owner>` dir that holds `projects/` + tool repos,
 *  derived from any oracle's repo path in oracles.json (robust to where soulbrew
 *  lives / owner renames). null if it can't be resolved. */
function resolveOwnerRoot(): string | null {
  try {
    const data = JSON.parse(fs.readFileSync(ORACLES_JSON, "utf8")) as {
      oracles?: { local_path?: string }[];
    };
    for (const o of data?.oracles ?? []) {
      const p = o?.local_path;
      if (typeof p !== "string" || !p) continue;
      const m = p.replace(/\/+$/, "").match(/^(.*\/github\.com\/[^/]+)\/[^/]+$/);
      if (m) return m[1];
    }
  } catch {
    /* ignore */
  }
  return null;
}

function countSprintDocs(dir: string): number {
  try {
    return fs
      .readdirSync(path.join(dir, "docs"))
      .filter((f) => /^sprint-.*\.md$/.test(f)).length;
  } catch {
    return 0;
  }
}

/** Count open `agents/*` git worktrees (leftover in-progress sprint work). */
function countOpenAgentWorktrees(dir: string): number {
  try {
    const out = cp
      .execFileSync("git", ["-C", dir, "worktree", "list"], { timeout: 1500 })
      .toString();
    return out.split("\n").filter((l) => /\/agents\//.test(l)).length;
  } catch {
    return 0;
  }
}

function readMeta(dir: string) {
  try {
    return parseOrchesMeta(fs.readFileSync(path.join(dir, ".orches-meta.json"), "utf8"));
  } catch {
    return null;
  }
}

/** Read the planned/done sprint counts from docs/plan.md (null if no plan). */
function readPlan(dir: string): { total: number; done: number } | null {
  try {
    return parsePlan(fs.readFileSync(path.join(dir, "docs", "plan.md"), "utf8"));
  } catch {
    return null;
  }
}

/** Scan every repo under the owner root (projects/* + tool repos) for leftover
 *  work — a project is resumable if it has docs/sprint-*.md OR an open agents/*
 *  worktree. NOT filtered by team (user picks the team after). Sorted so the
 *  most-recently-driven is first. */
export function scanResumableProjects(): ResumableProject[] {
  const root = resolveOwnerRoot();
  if (!root) return [];
  const candidates: string[] = [];
  try {
    for (const n of fs.readdirSync(path.join(root, "projects"))) {
      if (n === "ψ" || n.startsWith(".")) continue;
      candidates.push(path.join(root, "projects", n));
    }
  } catch {
    /* no projects/ dir */
  }
  try {
    for (const n of fs.readdirSync(root)) {
      // skip projects/ (walked above), ψ vault, dotfiles, and oracle repos
      // (e.g. bob-oracle/foreman-oracle) — those are agents, not build targets.
      if (n === "projects" || n === "ψ" || n.startsWith(".") || /-oracle$/.test(n)) {
        continue;
      }
      const p = path.join(root, n);
      try {
        if (fs.statSync(p).isDirectory()) candidates.push(p);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  const out: ResumableProject[] = [];
  for (const p of candidates) {
    const sprintDocs = countSprintDocs(p);
    const openWorktrees = countOpenAgentWorktrees(p);
    const plan = readPlan(p);
    if (!isResumable({ sprintDocs, openWorktrees, plannedTotal: plan?.total, plannedDone: plan?.done }))
      continue;
    const meta = readMeta(p);
    out.push({
      name: path.basename(p),
      path: p,
      sprintDocs,
      openWorktrees,
      plannedTotal: plan?.total,
      plannedDone: plan?.done,
      metaTeam: meta?.team,
      lastRun: meta?.lastRun,
    });
  }
  return sortResumable(out);
}

/** Default team for a resumable project (whoever drove it last), given the
 *  currently-pickable teams. null → user picks with no default. */
export function defaultTeamFor(project: ResumableProject, teams: OracleTeam[]): string | null {
  return defaultTeamForProject(
    { team: project.metaTeam, lastRun: project.lastRun },
    teams.map((t) => t.name),
  );
}

// Reuse one editor terminal across clicks (fresh attach each start).
let _orchTerminal: vscode.Terminal | undefined;

/** Wake + attach the orchestrator with the right kickoff (fresh build vs
 *  resume). Shared by the command palette flow and the dashboard screens.
 *  On resume it also stamps `.orches-meta.json` so next time the team picker
 *  defaults to this team. Returns an error string (null = ok). */
export function launchOrchestrator(opts: {
  orch: string;
  team: OracleTeam;
  mode: "new" | "resume";
  project?: ResumableProject;
}): string | null {
  const { orch, team, mode, project } = opts;
  if (!isSafeOracleName(orch)) return `ชื่อ orchestrator ไม่ปลอดภัย: ${orch}`;
  if (mode === "resume" && !project) return "resume แต่ไม่มี project";

  let repoPath: string | null = null;
  try {
    repoPath = parseOraclePath(fs.readFileSync(ORACLES_JSON, "utf8"), orch);
  } catch {
    repoPath = null;
  }
  if (!repoPath) {
    return `หา repo ของ '${orch}' ไม่เจอใน ~/.maw/oracles.json — ลองรัน \`maw oracle scan\` ก่อน`;
  }

  const workers = team.members
    .filter((m) => m.role !== "orchestrator")
    .map((m) => m.oracle);
  const kickoff =
    mode === "resume" && project
      ? buildResumeKickoff(project.name, project.path, team.name, orch, workers)
      : buildKickoffPrompt(team.name, orch, workers);
  if (mode === "resume" && project) {
    try {
      fs.writeFileSync(
        path.join(project.path, ".orches-meta.json"),
        serializeOrchesMeta(team.name, Date.now()),
      );
    } catch {
      /* marker is best-effort */
    }
  }
  const sessionName = readSessionPin(orch) ?? undefined;
  const session = sessionName?.trim() || `claude-${orch}`;

  // Is the orchestrator already awake? `tmux new-session -A` only runs its
  // launch command when CREATING — on an existing session it just reattaches
  // and DROPS the kickoff. That silently loses a resume kickoff (the "opened
  // like it never did anything" bug). So when the session exists, deliver the
  // kickoff into the LIVE pane with send-keys instead (same as how orches-drive
  // dispatches to live workers — NOT `maw wake -p`, which spawns a twin).
  let alive = false;
  try {
    cp.execFileSync("tmux", ["has-session", "-t", `=${session}`], { stdio: "ignore" });
    alive = true;
  } catch {
    alive = false;
  }
  if (alive) {
    try {
      cp.execFileSync("tmux", ["send-keys", "-t", `=${session}`, kickoff, "Enter"]);
    } catch {
      /* best-effort — fall through to attach so the user still lands in it */
    }
  }
  // Safe: session is a maw pin (NN-oracle) or claude-<safe-orch> — both /^[\w.-]+$/.
  const command = alive
    ? `tmux attach -t '=${session}'`
    : buildTmuxLaunchCommand(orch, repoPath, kickoff, sessionName);

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
  return null;
}

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

  // 3) wake + attach (fresh build kickoff). Resume flow goes through the
  //    dashboard screens (launchOrchestrator with mode:"resume").
  const err = launchOrchestrator({ orch, team, mode: "new" });
  if (err) {
    vscode.window.showErrorMessage(`Mission Control: ${err}`);
    return;
  }
  vscode.window.showInformationMessage(
    `Mission Control: ปลุก orchestrator '${orch}' (team ${team.name}) + เริ่ม /orches-drive — ` +
      `foreman จะถาม requirement ใน terminal เอง · worker ปลุกตอนแจกงาน`,
  );
}

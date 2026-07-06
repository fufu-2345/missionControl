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
  isProjectLive,
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

/** Live tmux pane cwds across every session (empty if tmux is absent/errors).
 *  One cheap `tmux list-panes` — no LLM, no tokens. */
function listLiveAgentPanePaths(): string[] {
  try {
    return cp
      .execFileSync("tmux", ["list-panes", "-a", "-F", "#{pane_current_path}"], { timeout: 1500 })
      .toString()
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Refresh each project's `doing` flag from the CURRENT tmux pane set. Cheap
 *  (one `tmux list-panes`), so the "⠋ กำลังทำ" indicator re-evaluates on every
 *  screen refresh without re-walking the filesystem. Mutates in place. */
export function annotateLiveState(projects: ResumableProject[]): void {
  const live = listLiveAgentPanePaths();
  for (const p of projects) p.doing = isProjectLive(p.path, live);
}

/** Default team for a resumable project (whoever drove it last), given the
 *  currently-pickable teams. null → user picks with no default. */
export function defaultTeamFor(project: ResumableProject, teams: OracleTeam[]): string | null {
  return defaultTeamForProject(
    { team: project.metaTeam, lastRun: project.lastRun },
    teams.map((t) => t.name),
  );
}

// One editor terminal PER orchestrator (keyed by oracle name), so launching a
// second orchestrator never closes the first — many can run side by side. Only
// re-launching the SAME orch reuses/refreshes its own tab.
const _orchTerminals = new Map<string, vscode.Terminal>();

/** Run a command in an editor terminal once shell integration is ready (or after
 *  a short fallback) so long-running tmux-attach commands survive. */
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

/** If `project` is already being driven by a live orchestrator (its team's
 *  orchestrator tmux session is up), open/reveal THAT session's terminal —
 *  ATTACH ONLY, no new kickoff, no re-dispatch — and return true. Returns false
 *  when nothing live is found → caller runs the normal team → orchestrator →
 *  launch flow. This is what makes clicking a "doing" project re-enter its
 *  running session instead of spawning a conflicting one on top. */
export function attachToProject(project: ResumableProject): boolean {
  const meta = readMeta(project.path);
  if (!meta?.team) return false;
  const team = readTeams().find((t) => t.name === meta.team);
  const orch = team?.orchestrators[0];
  if (!orch || !isSafeOracleName(orch)) return false;
  // Prefer the exact session stamped when this project was driven (twin-aware);
  // fall back to the pin / default. Attach to the first one actually alive.
  const candidates = [
    ...(meta.session ? [meta.session] : []),
    readSessionPin(orch)?.trim() || `claude-${orch}`,
  ];
  const session = candidates.find((s) => /^[\w.-]+$/.test(s) && tmuxHasSession(s));
  if (!session) return false; // nothing awake → let the caller launch fresh
  const prev = _orchTerminals.get(session);
  if (prev && prev.exitStatus === undefined) {
    prev.show(false); // already have its tab open → just reveal it
    return true;
  }
  const term = vscode.window.createTerminal({
    name: `orchestrator: ${orch}`,
    location: vscode.TerminalLocation.Editor,
  });
  _orchTerminals.set(session, term);
  term.show(false);
  runInTerminal(term, `tmux attach -t '=${session}'`);
  return true;
}

function tmuxHasSession(session: string): boolean {
  try {
    cp.execFileSync("tmux", ["has-session", "-t", `=${session}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** First free twin session name: base-2, base-3, … (base itself is taken). */
function nextTwinSession(base: string): string {
  for (let i = 2; i <= 9; i++) {
    if (!tmuxHasSession(`${base}-${i}`)) return `${base}-${i}`;
  }
  return `${base}-${Date.now() % 1000}`; // 9 twins already?! — just don't collide
}

/** Extra kickoff block for a twin session — same oracle, second brain-thread.
 *  ψ + the oracle DB are ONE shared store per oracle, so the twin must tag its
 *  captures (provenance) and append-not-overwrite shared files; worker clashes
 *  are guarded by orches-drive but the twin is told to yield, not steal. */
function twinKickoffNote(session: string, base: string, orch: string): string {
  return (
    `\n\n[โหมด twin] คุณคือ session เสริม '${session}' ของ ${orch} — session หลัก '${base}' กำลังทำงานอื่นอยู่ งานนี้แยกขาดจากกัน:\n` +
    `- ψ/DB ของ ${orch} เป็นก้อนเดียวแชร์กัน → แท็กทุก memory capture (oracle_learn / oracle_trace / /rrr) ด้วย "[${session}]" ใน summary เพื่อไม่ปนกับ session หลัก\n` +
    `- ไฟล์ ψ ที่แชร์ (เช่น ψ/inbox/pending-rrr.md) → append เท่านั้น ห้ามเขียนทับทั้งไฟล์\n` +
    `- ก่อน dispatch: worker ที่ session หลักใช้อยู่ = อย่าแย่ง (guard เดิมจะเตือน) → เลือก worker ที่ว่าง หรือรายงาน user`
  );
}

/** Wake + attach the orchestrator with the right kickoff (fresh build vs
 *  resume). Shared by the command palette flow and the dashboard screens.
 *  If the orchestrator is ALREADY awake, asks the user: open a SECOND tmux
 *  session (twin — same oracle, separate job) or inject into the live one.
 *  On resume it also stamps `.orches-meta.json` (team + session) so the team
 *  picker defaults and attach-on-doing find the right session next time. */
export async function launchOrchestrator(opts: {
  orch: string;
  team: OracleTeam;
  mode: "new" | "resume";
  project?: ResumableProject;
}): Promise<{ error?: string; cancelled?: boolean }> {
  const { orch, team, mode, project } = opts;
  if (!isSafeOracleName(orch)) return { error: `ชื่อ orchestrator ไม่ปลอดภัย: ${orch}` };
  if (mode === "resume" && !project) return { error: "resume แต่ไม่มี project" };

  let repoPath: string | null = null;
  try {
    repoPath = parseOraclePath(fs.readFileSync(ORACLES_JSON, "utf8"), orch);
  } catch {
    repoPath = null;
  }
  if (!repoPath) {
    return {
      error: `หา repo ของ '${orch}' ไม่เจอใน ~/.maw/oracles.json — ลองรัน \`maw oracle scan\` ก่อน`,
    };
  }

  const workers = team.members
    .filter((m) => m.role !== "orchestrator")
    .map((m) => m.oracle);
  let kickoff =
    mode === "resume" && project
      ? buildResumeKickoff(project.name, project.path, team.name, orch, workers)
      : buildKickoffPrompt(team.name, orch, workers);

  const baseSession = readSessionPin(orch)?.trim() || `claude-${orch}`;
  let session = baseSession;
  let inject = false; // deliver kickoff into the live pane instead of creating

  if (tmuxHasSession(baseSession)) {
    // Same oracle can't think two jobs in one conversation. Ask: twin session
    // (separate job, same team config — nothing to re-create) or same session.
    const TWIN = "เปิด session ใหม่ (งานแยก)";
    const SAME = "ส่งเข้า session เดิม";
    const pick = await vscode.window.showWarningMessage(
      `'${orch}' ตื่นอยู่แล้ว (session '${baseSession}') — งานนี้จะให้ทำที่ไหน?`,
      {
        modal: true,
        detail:
          "session ใหม่ = ทีม/oracle เดิม แต่แยกบทสนทนา ทำ 2 งานคู่กันได้ (ระวัง: bob/jack/john มีตัวเดียว ถ้า 2 งานต้องใช้ worker ตัวเดียวกันพร้อมกัน งานหลังต้องรอ) · " +
          "session เดิม = ส่ง kickoff ต่อท้ายบทสนทนาที่กำลังทำอยู่",
      },
      TWIN,
      SAME,
    );
    if (pick === TWIN) {
      session = nextTwinSession(baseSession);
      kickoff += twinKickoffNote(session, baseSession, orch);
    } else if (pick === SAME) {
      inject = true;
    } else {
      return { cancelled: true };
    }
  }

  if (mode === "resume" && project) {
    try {
      fs.writeFileSync(
        path.join(project.path, ".orches-meta.json"),
        serializeOrchesMeta(team.name, Date.now(), session),
      );
    } catch {
      /* marker is best-effort */
    }
  }

  if (inject) {
    // `tmux new-session -A` on an existing session drops its command — deliver
    // the kickoff into the LIVE pane instead (send-keys; NOT `maw wake -p`
    // which spawns an uncontrolled twin).
    try {
      cp.execFileSync("tmux", ["send-keys", "-t", `=${session}`, kickoff, "Enter"]);
    } catch {
      /* best-effort — still attach so the user lands in the session */
    }
  }
  // Safe: session = maw pin (NN-oracle) / claude-<safe-orch> (+ "-N" twin suffix).
  const command = inject
    ? `tmux attach -t '=${session}'`
    : buildTmuxLaunchCommand(orch, repoPath, kickoff, session);

  // One editor tab per SESSION (twin gets its own) — never touch other tabs.
  const prevTerm = _orchTerminals.get(session);
  if (prevTerm && prevTerm.exitStatus === undefined) prevTerm.dispose();
  const term = vscode.window.createTerminal({
    name: `orchestrator: ${orch}${session === baseSession ? "" : ` · ${session}`}`,
    location: vscode.TerminalLocation.Editor,
  });
  _orchTerminals.set(session, term);
  term.show(false);
  runInTerminal(term, command);
  return {};
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
  const r = await launchOrchestrator({ orch, team, mode: "new" });
  if (r.cancelled) return;
  if (r.error) {
    vscode.window.showErrorMessage(`Mission Control: ${r.error}`);
    return;
  }
  vscode.window.showInformationMessage(
    `Mission Control: ปลุก orchestrator '${orch}' (team ${team.name}) + เริ่ม /orches-drive — ` +
      `foreman จะถาม requirement ใน terminal เอง · worker ปลุกตอนแจกงาน`,
  );
}

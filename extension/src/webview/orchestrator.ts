import * as vscode from "vscode";

import * as gitOps from "../commands/gitOps";
import { parseGitButtonState, type GitButtonState } from "../commands/gitStatus";
import {
  annotateLiveState,
  attachToProject,
  cancelContinueRun,
  defaultTeamFor,
  launchContinueRun,
  launchOrchestrator,
  listOrchestratorTeams,
  listTmuxSessionsSafe,
  projectDrivenState,
  reapSession,
  scanResumableProjects,
  sessionCreatedAt,
  tmuxHasSession,
} from "../commands/startOrchestrator";
import { partitionStarred, sortResumable, toggleStar, type ResumableProject } from "../commands/orchestratorResume";
import { removeProjectDir } from "../commands/deleteProject";
import { listProjectTree, resolveProjectFile, renderMarkdown } from "../commands/projectDocs";
import {
  isPreviewAvailable,
  isPreviewRunning,
  togglePreview,
  waitForPreviewUrl,
} from "../commands/previewOps";
import {
  clampSprintCount,
  finishedSessions,
  pendingSprints,
  readRunMarker,
  resolveButtonState,
  runSessionLiveForProject,
} from "../commands/continueRun";
import type { OracleTeam } from "../commands/teams";
import { ORG, checkProjectName, suggestDefaultName, sanitizeName, type NameCheck } from "../commands/projectName";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// Single "Projects" webview panel (its OWN editor tab, mirroring teams.ts) — the
// one entry point for both continuing a project and starting a new build:
//   resume: pick a project → team → orchestrator → launch (mode resume)
//   new:    "+ เริ่มโปรเจคใหม่" (no project) → team → orchestrator → launch (mode new)
// The distinction is purely whether a project was picked (_st.project). The
// project rows carry the per-repo git buttons (Commit/Push/Create&Push).
let _panel: vscode.WebviewPanel | undefined;

interface WizState {
  projects: ResumableProject[];
  project?: ResumableProject; // set → resume that project; unset → fresh build
  team?: OracleTeam;
  askMode?: boolean; // "โหมดถาม" toggle — grilling interview + scrutinize plan review
  newName?: string; // ชื่อ project ที่ user ตั้งใน name-popup (mode "new") → ส่งเข้า kickoff
}
let _st: WizState | undefined;
// Which screen is currently showing. The spin-poll only re-renders the projects list
// when it is the visible screen — otherwise a running project's 2.5s tick would clobber
// the Detail / teams / orch screen the user navigated to.
let _screen: "projects" | "detail" | "teams" | "orch" = "projects";

const STARRED_KEY = "missioncontrol.starredProjects";
let _ctx: vscode.ExtensionContext | undefined;

/** Starred project paths from per-user globalState (empty if context missing). */
function starredList(): string[] {
  return _ctx?.globalState.get<string[]>(STARRED_KEY, []) ?? [];
}
async function setStarred(list: string[]): Promise<void> {
  await _ctx?.globalState.update(STARRED_KEY, list);
}

async function computeGitStates(
  projects: ResumableProject[],
  fetch = false,
): Promise<Record<string, GitButtonState>> {
  const out: Record<string, GitButtonState> = {};
  await Promise.all(
    projects.map(async (p) => {
      if (fetch) await gitOps.fetchRepo(p.path);
      out[p.path] = parseGitButtonState(await gitOps.readGitStatus(p.path));
    }),
  );
  return out;
}

// ── name-popup: local + github availability probes (impure; pure logic = projectName.ts) ──
// รายชื่อโฟลเดอร์ทั้งหมดใต้ projects root (local-taken = ทุกโฟลเดอร์ ไม่ใช่แค่ resumable)
function localProjectNames(): string[] {
  const first = scanResumableProjects()[0];
  if (!first) return [];
  try {
    return fs
      .readdirSync(path.dirname(first.path), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return scanResumableProjects().map((p) => p.name);
  }
}
let _ghOk: boolean | undefined;
function ghAvailable(): boolean {
  if (_ghOk === undefined) {
    try {
      cp.execFileSync("gh", ["auth", "status"], { stdio: "ignore", timeout: 4000 });
      _ghOk = true;
    } catch {
      _ghOk = false;
    }
  }
  return _ghOk;
}
// true = repo exists (taken) · false = 404 (free) · null = gh ไม่พร้อม/ตรวจไม่ได้
function ghView(name: string): boolean | null {
  if (!ghAvailable()) return null;
  try {
    cp.execFileSync("gh", ["repo", "view", `${ORG}/${name}`, "--json", "name"], {
      stdio: "ignore",
      timeout: 6000,
    });
    return true;
  } catch {
    return false; // non-zero = 404 (free) · ensure-remote ยัง guard org ตอน push (safety net)
  }
}

async function pushProjectsScreen(panel: vscode.WebviewPanel, fetch: boolean | "spin" = false) {
  _screen = "projects";
  const projects = _st?.projects ?? [];
  annotateLiveState(projects); // refresh the live "doing" flag each render (cheap: one tmux call)
  const starred = new Set(starredList());
  const ordered = partitionStarred(projects, starred); // starred float to top; sub-order preserved
  const states = await computeGitStates(ordered, fetch === true);
  // Green-row detector: share ONE `tmux list-sessions` across all rows, computed
  // every render (incl. spin ticks) so an owner/label-driven project doesn't
  // flicker gray between full renders. `fetch==="spin"` only skips the git fetch.
  const sessions = listTmuxSessionsSafe();
  panel.webview.postMessage({
    type: "screen_projects",
    title: "⏮ ทำต่อ — เลือก project ค้าง",
    subtitle: projects.length
      ? "⠋ กำลังทำ = worker run อยู่ตอนนี้ · 🔨 ค้าง = sprint ที่ยังไม่เสร็จ (จากแผน หรือ worktree ที่เปิดค้าง) · 'ทำไปแล้ว X' = เสร็จกี่ sprint · ปุ่มขวา = git"
      : "ไม่พบงานค้าง — ต้องมี docs/plan.md, docs/*sprint-*.md หรือ worktree agents/* เปิดอยู่",
    items: ordered.map((p) => {
      // continue-button state derived purely (marker + tmux liveness) — the
      // zombie guard compares the live session's creation time to the recorded one.
      const marker = readRunMarker(p.path);
      // liveness scoped to THIS project by @orches_label (not bare session-name):
      // a cold-launch records the base pin as the session, so two projects can
      // share a session name — name-only match cross-lights both cards green.
      const aliveForThis = runSessionLiveForProject(marker, sessions, p.name);
      const live = marker?.session
        ? { alive: aliveForThis, createdAt: sessionCreatedAt(marker.session) }
        : { alive: false };
      const btn = resolveButtonState(pendingSprints(p), marker, live);
      // a run is live iff its session is up, labeled for this project, and not a
      // zombie (reused name, created ≠ recorded).
      const runAlive =
        aliveForThis &&
        !(marker?.sessionCreatedAt !== undefined && live.createdAt !== undefined && live.createdAt !== marker.sessionCreatedAt);
      return {
        path: p.path,
        name: p.name,
        sprints: p.sprintDocs,
        worktrees: p.openWorktrees,
        plannedTotal: p.plannedTotal,
        plannedDone: p.plannedDone,
        doing: p.doing,
        // green row: is a session driving this project right now? (shared list + reused runAlive)
        driven: projectDrivenState(p, { sessions, runAlive }).state !== "none",
        starred: starred.has(p.path),
        run: { state: btn.state, errorMsg: btn.errorMsg },
        git: { path: p.path, ...states[p.path] },
      };
    }),
  });
  // Keep polling while any run is live so the spinner + git panel stay fresh.
  if (ordered.some((p) => readRunMarker(p.path)?.status === "running")) startSpinPoll(panel);
}

// ── continue-run spin poll: re-render while any project's run is live ─────────
let _spinPoll: ReturnType<typeof setInterval> | undefined;
let _runningRuns = new Map<string, string>(); // path → session, for runs live on the previous tick
function startSpinPoll(panel: vscode.WebviewPanel) {
  if (_spinPoll) return;
  _spinPoll = setInterval(async () => {
    const projs = _st?.projects ?? [];
    // Capture each live run's session WHILE it is running — the done/error marker
    // is rewritten bare (drops .session), so this is the only chance to learn it.
    const nowRunning = new Map<string, string>();
    for (const p of projs) {
      const m = readRunMarker(p.path);
      // Only a marker whose session is ACTUALLY alive counts as running. A marker
      // stuck at "running" (session killed out-of-band, no done/error written)
      // would otherwise pin the poll forever — treat it as finished so the poll
      // stops and its (dead) session gets reaped once.
      if (m?.status === "running" && m.session && tmuxHasSession(m.session))
        nowRunning.set(p.path, m.session);
    }
    // A run live last tick but not this one JUST finished — `/orches-drive --once`
    // overwrote its marker with a bare done/error (or it vanished). The extension
    // gets no callback, so this transition is the only completion signal.
    const someFinished = [..._runningRuns.keys()].some((path) => !nowRunning.has(path));
    // Reap the finished headless run's tmux session — `--once` writes its marker
    // then exits WITHOUT the Step-6 teardown, so the session (dead orchestrator +
    // idle worker windows) lingers. This is what closes it when the run finishes.
    for (const s of finishedSessions(_runningRuns, new Set(nowRunning.keys()))) reapSession(s);
    // Re-scan so "ค้าง N sprint" drops, and render with fetch=true so the git panel
    // (Commit / up-to-date) reflects what landed — no manual "fetch" click needed.
    if (someFinished && _st) _st.projects = scanResumableProjects();
    _runningRuns = nowRunning;
    // finished → full render (fresh scan + git fetch + green re-probe); otherwise a
    // cheap spin tick (spinner only, skip the owner/label probe).
    // Only re-render when the projects list is the visible screen — otherwise the tick
    // would clobber the Detail / teams / orch screen the user navigated to. Reaping +
    // rescan above still run; the render resumes when they return to the list.
    if (_panel && _screen === "projects") await pushProjectsScreen(_panel, someFinished ? true : "spin");
    if (nowRunning.size === 0) stopSpinPoll();
  }, 2500);
}
function stopSpinPoll() {
  if (_spinPoll) {
    clearInterval(_spinPoll);
    _spinPoll = undefined;
  }
  _runningRuns = new Map();
}

/** โปรเจคนี้กำลัง run จริงไหม (marker running + session live + ไม่ zombie) —
 *  reuse resolveButtonState ให้ตรงกับปุ่ม ▶ ทำต่อ ที่ user เห็น (delete guard ชั้น extension). */
function isRunning(p: ResumableProject): boolean {
  const marker = readRunMarker(p.path);
  // label-gated liveness (see render): a base-name session-collision must not make
  // this project read as running off another project's live session.
  const aliveForThis = runSessionLiveForProject(marker, listTmuxSessionsSafe(), p.name);
  const live = marker?.session
    ? { alive: aliveForThis, createdAt: sessionCreatedAt(marker.session) }
    : { alive: false };
  return resolveButtonState(pendingSprints(p), marker, live).state === "spinning";
}

/** โปรเจคนี้ busy ไหม (headless run กำลัง spin หรือ session ไหนก็ตามขับอยู่) — ตรงกับ
 *  `busy` ฝั่ง webview (run.state==='spinning' || it.driven). ใช้ guard ปุ่ม git
 *  (commit/push/pull/create&push) เหมือนที่ deleteProjectFlow guard ปุ่มลบ. */
function isProjectBusy(p: ResumableProject): boolean {
  if (isRunning(p)) return true;
  annotateLiveState([p]);
  return projectDrivenState(p).state !== "none";
}

/** ลบโปรเจค: กัน running → confirm modal → พิมพ์ชื่อยืนยัน → ลบโฟลเดอร์ local.
 *  ⛔ ไม่แตะ GitHub. คืน {deleted:false} เงียบเมื่อ user ยกเลิก. */
function deleteProjectFlow(p: ResumableProject): { deleted: boolean; reason?: string } {
  // ยืนยัน + พิมพ์ชื่อ ทำใน webview modal แล้ว → host แค่ guard ซ้ำ (running + path) แล้วลบ.
  if (isRunning(p)) return { deleted: false, reason: `'${p.name}' กำลัง run อยู่ — กด stop ก่อนถึงจะลบได้` };
  // นอกจาก headless run: interactive session ที่ขับโปรเจคนี้อยู่ (การ์ดเขียว) ก็ห้ามลบ —
  // ลบโฟลเดอร์ทั้งที่ session ใช้อยู่ = พัง session นั้น. UI เทาปุ่มไว้แล้ว; นี่คือ guard ซ้ำ.
  annotateLiveState([p]);
  if (projectDrivenState(p).state !== "none")
    return { deleted: false, reason: `'${p.name}' กำลังถูกขับโดย session อยู่ — ปิด session ก่อนถึงจะลบได้` };
  const r = removeProjectDir(p.path);
  if (r.deleted) vscode.window.showInformationMessage(`ลบ '${p.name}' แล้ว`);
  return r;
}

/** guard ปุ่ม git ฝั่ง host: หา project จาก path แล้วเช็ค busy ซ้ำ (UI ซ่อนปุ่มไปแล้ว
 *  แต่ webview state อาจ stale) — คืน project ถ้าทำต่อได้, null ถ้าต้อง bail (แจ้ง warning แล้ว). */
function requireIdleProject(path: string): ResumableProject | null {
  const p = _st?.projects.find((x) => x.path === path);
  if (!p) return null;
  if (isProjectBusy(p)) {
    vscode.window.showWarningMessage(`'${p.name}' กำลังทำอยู่ — รอให้เสร็จก่อนถึงจะ commit/push/pull ได้`);
    return null;
  }
  return p;
}

async function pushTeamsScreen(panel: vscode.WebviewPanel) {
  _screen = "teams";
  const teams = listOrchestratorTeams();
  const def = _st?.project ? defaultTeamFor(_st.project, teams) : null;
  // Last-used team floats to the top; the rest keep their existing order.
  const ordered = def
    ? [...teams.filter((t) => t.name === def), ...teams.filter((t) => t.name !== def)]
    : teams;
  // "เปิดใน GitHub" link — only when resuming a project that has a github origin.
  const githubUrl = _st?.project ? await gitOps.getGithubWebUrl(_st.project.path) : null;
  panel.webview.postMessage({
    type: "screen_teams",
    title: (_st?.project ? "⏮ ทำต่อ" : "▶ เริ่มใหม่") + " — เลือกทีม",
    subtitle: _st?.project ? `project: ${_st.project.name}` : "เลือก oracle-team",
    canBack: true, // มาจากหน้า Projects เสมอ → กลับได้ตลอด
    githubUrl, // null → the client hides the GitHub button
    // โหมดถาม toggle เฉพาะ build ใหม่ (ยังไม่ได้เลือก project) — resume ยังไม่รองรับ
    askable: !_st?.project,
    items: ordered.map((t) => ({
      name: t.name,
      isDefault: t.name === def,
      sub: `${t.members.length} members · orchestrator: ${
        t.orchestrators.join(", ") || "(none)"
      }`,
    })),
  });
}

/** Project Detail screen — the hub for one project: a file-explorer of the project's
 *  markdown (folders + .md only; click a folder to drill in, click a file to open it as
 *  a full page over the explorer) + nav (back / close / localhost / ▶ ทำต่อ / GitHub).
 *  Reached by picking any project card; ▶ ทำต่อ carries the attach-or-team-picker logic. */
async function pushDetailScreen(panel: vscode.WebviewPanel) {
  const p = _st?.project;
  if (!p) return;
  _screen = "detail";
  const githubUrl = await gitOps.getGithubWebUrl(p.path);
  panel.webview.postMessage({
    type: "screen_detail",
    title: `📁 ${p.name}`,
    subtitle: `project: ${p.name}`,
    path: p.path,
    githubUrl, // null → client hides the GitHub button
    preview: { available: isPreviewAvailable(p.path), running: isPreviewRunning(p.path) },
    tree: listProjectTree(p.path),
  });
}

function pushOrchScreen(panel: vscode.WebviewPanel, team: OracleTeam) {
  _screen = "orch";
  panel.webview.postMessage({
    type: "screen_orch",
    title: `${team.name} — เลือก orchestrator`,
    subtitle: "ทีมนี้มี orchestrator หลายตัว",
    askable: !_st?.project,
    items: team.orchestrators.map((o) => ({ name: o })),
  });
}

/** Team chosen → 1 orchestrator auto-launches; >1 asks; 0 guides. */
function pickTeam(panel: vscode.WebviewPanel, name: string, askMode = false) {
  if (!_st) return;
  const team = listOrchestratorTeams().find((t) => t.name === name);
  if (!team) return;
  _st.team = team;
  _st.askMode = askMode; // remember for the orch-picker screen (its post re-sends too)
  if (!team.orchestrators.length) {
    vscode.window.showWarningMessage(
      `Orchestrator: ทีม '${team.name}' ไม่มี member role:orchestrator — เพิ่มก่อนในหน้า Teams`,
    );
    return;
  }
  if (team.orchestrators.length === 1) {
    void doLaunch(panel, team.orchestrators[0], askMode);
  } else {
    pushOrchScreen(panel, team);
  }
}

async function doLaunch(panel: vscode.WebviewPanel, orch: string, askMode = false) {
  if (!_st?.team) return;
  const r = await launchOrchestrator({
    orch,
    team: _st.team,
    // project picked → resume it; none → fresh build
    mode: _st.project ? "resume" : "new",
    project: _st.project,
    askMode,
    projectName: _st.newName,
  });
  if (r.cancelled) return; // user backed out of the twin/inject choice — keep the wizard
  if (r.error) {
    vscode.window.showErrorMessage(`Orchestrator: ${r.error}`);
    return;
  }
  vscode.window.showInformationMessage(
    `Orchestrator: ปลุก '${orch}' (team ${_st.team.name})` +
      (_st.project ? ` · resume ${_st.project.name}` : "") +
      " — เปิด terminal คุย requirement ได้เลย",
  );
  panel.dispose();
}

export function openOrchestratorPanel(context: vscode.ExtensionContext): vscode.WebviewPanel {
  _ctx = context;
  _st = { projects: scanResumableProjects() };
  if (_panel) {
    _panel.title = titleFor();
    _panel.reveal();
    void pushProjectsScreen(_panel); // always land on the Projects list
    return _panel;
  }
  const panel = vscode.window.createWebviewPanel(
    "missioncontrol.orchestrator",
    titleFor(),
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  _panel = panel;
  panel.onDidDispose(() => {
    stopSpinPoll();
    _panel = undefined;
    _st = undefined;
  });
  // ซ่อน panel / สลับไป tab อื่น = ยกเลิก auto-commit+push ที่ arm ค้าง — กัน grace-timer ยิง
  // commit+push ตอน user ไม่ได้มองหน้า projects อยู่ (เสี่ยงยิงผิดจังหวะ/ผิด repo)
  panel.onDidChangeViewState(() => {
    if (!panel.visible) panel.webview.postMessage({ type: "disarm_all" });
  });
  panel.webview.html = renderShell();

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (!msg || typeof msg.type !== "string" || !_st) return;
    switch (msg.type) {
      case "ready":
        await pushProjectsScreen(panel);
        return;
      case "start_new": {
        // "+ เริ่มโปรเจคใหม่" → เปิด name popup ก่อน (ตั้งชื่อ + เช็คว่าง local+github)
        // → ยืนยันแล้วค่อยไป team-picker (mode "new"). default ระบบคิดให้.
        _st.project = undefined;
        _st.team = undefined;
        _st.newName = undefined;
        const def = suggestDefaultName(
          sortResumable(scanResumableProjects()).map((p) => p.name),
          localProjectNames(),
          ghView,
        );
        panel.webview.postMessage({ type: "open_namemodal", default: def });
        return;
      }
      case "check_name": {
        const name = sanitizeName(typeof msg.name === "string" ? msg.name : "");
        const check: NameCheck = checkProjectName(name, localProjectNames(), ghView);
        panel.webview.postMessage({ type: "name_result", name, check });
        return;
      }
      case "name_confirmed": {
        const name = sanitizeName(typeof msg.name === "string" ? msg.name : "");
        if (!checkProjectName(name, localProjectNames(), ghView).valid) return;
        _st.newName = name;
        await pushTeamsScreen(panel);
        return;
      }
      case "pick_project": {
        const p = _st.projects.find((x) => x.path === msg.path);
        if (!p) return;
        _st.project = p;
        // New: every card (incl. green/live) opens the Detail page first. The old
        // attach-or-team logic now lives behind the ▶ ทำต่อ button (continue_to_team).
        await pushDetailScreen(panel);
        return;
      }
      case "continue_to_team": {
        // The OLD pick_project behavior: 1 project = 1 session. Already being driven
        // (worker / run / owner at a checkpoint / labeled) → ATTACH to THAT session,
        // never spawn on top. Falls through to the team picker only when nothing live.
        const p = _st.project;
        if (!p) return;
        annotateLiveState([p]);
        const driven = projectDrivenState(p);
        if (driven.state !== "none") {
          if (attachToProject(p, driven.session)) {
            vscode.window.showInformationMessage(
              `Orchestrator: attach เข้า session '${driven.session ?? ""}' ที่ขับ '${p.name}' อยู่ (ไม่สร้างใหม่)`,
            );
            panel.dispose();
            return;
          }
          vscode.window.showWarningMessage(
            `'${p.name}' กำลังถูกขับ (session ${driven.session ?? "?"}) แต่ attach ไม่ได้ — เปิด session นั้นเอง`,
          );
          return; // do NOT fall through to spawn a twin
        }
        await pushTeamsScreen(panel);
        return;
      }
      case "open_doc": {
        // Detail explorer opened a file → read + render markdown, send HTML back.
        const p = _st.project;
        const rel = typeof msg.rel === "string" ? msg.rel : "";
        if (!p || !rel) return;
        const abs = resolveProjectFile(p.path, rel); // guards traversal + .md-only, project-rooted
        if (!abs) {
          panel.webview.postMessage({ type: "doc_html", rel, error: "ไม่พบไฟล์" });
          return;
        }
        try {
          const html = renderMarkdown(fs.readFileSync(abs, "utf8"));
          panel.webview.postMessage({ type: "doc_html", rel, html });
        } catch {
          panel.webview.postMessage({ type: "doc_html", rel, error: "อ่านไฟล์ไม่ได้" });
        }
        return;
      }
      case "run_localhost": {
        // Toggle the project's dev server (background) + open the browser when it starts.
        const p = _st.project;
        if (!p) return;
        if (!isPreviewAvailable(p.path)) {
          vscode.window.showWarningMessage(
            `'${p.name}' ไม่มี .orches-preview.sh — เปิด localhost ไม่ได้`,
          );
          panel.webview.postMessage({ type: "preview_state", running: false });
          return;
        }
        const { started } = togglePreview(p.path);
        if (started) {
          const url = await waitForPreviewUrl(p.path);
          void vscode.env.openExternal(vscode.Uri.parse(url));
          panel.webview.postMessage({ type: "preview_state", running: true, url });
          vscode.window.setStatusBarMessage(`Orchestrator: localhost '${p.name}' → ${url}`, 5000);
        } else {
          panel.webview.postMessage({ type: "preview_state", running: false });
          vscode.window.setStatusBarMessage(`Orchestrator: หยุด localhost '${p.name}'`, 5000);
        }
        return;
      }
      case "to_projects": {
        // Detail → back to the Projects list.
        _st.project = undefined;
        _st.team = undefined;
        await pushProjectsScreen(panel);
        return;
      }
      case "close":
        panel.dispose();
        return;
      case "open_github": {
        // เปิด repo ของ project นี้ใน browser จริง. Re-resolve host-side (don't trust
        // the client URL) so we only ever open this project's github origin.
        if (!_st.project) return;
        const url = await gitOps.getGithubWebUrl(_st.project.path);
        if (url) void vscode.env.openExternal(vscode.Uri.parse(url));
        else vscode.window.showWarningMessage(`'${_st.project.name}' ไม่มี GitHub remote (origin)`);
        return;
      }
      case "toggle_star": {
        const p = typeof msg.path === "string" ? msg.path : "";
        if (!p || !_ctx) return;
        // await update: durable; Memento.get reflects it synchronously so the
        // re-partition below is already correct — no ordering bug elsewhere.
        await setStarred(toggleStar(starredList(), p));
        await pushProjectsScreen(panel);
        return;
      }
      case "pick_team":
        if (typeof msg.name === "string") pickTeam(panel, msg.name, msg.askMode === true);
        return;
      case "pick_orch":
        // Trust the CURRENT toggle when the client sends it — OR-ing with the
        // stale team-pick value made ON→OFF at this step impossible.
        if (typeof msg.name === "string")
          void doLaunch(
            panel,
            msg.name,
            typeof msg.askMode === "boolean" ? msg.askMode : _st.askMode === true,
          );
        return;
      case "back":
        // From the team picker: back to Detail when resuming a project (project set),
        // else back to the Projects list (a fresh build has no Detail page).
        _st.team = undefined;
        if (_st.project) await pushDetailScreen(panel);
        else await pushProjectsScreen(panel);
        return;
      case "git_refresh":
        // Full manual refresh: re-scan sprint state too (so "ค้าง N sprint"
        // reflects reality), not just git — the one-time open snapshot is stale.
        if (_st) _st.projects = scanResumableProjects();
        await pushProjectsScreen(panel, true);
        return;
      case "continue_run": {
        const p = _st.projects.find((x) => x.path === msg.path);
        if (!p) return;
        const r = launchContinueRun(p);
        if (r.error) vscode.window.showWarningMessage(`Continue: ${r.error}`);
        else if (r.attached)
          vscode.window.showInformationMessage(
            `Continue: '${p.name}' กำลังทำอยู่แล้ว — เปิด session เดิมให้ (ไม่ launch ซ้ำ)`,
          );
        await pushProjectsScreen(panel);
        startSpinPoll(panel);
        return;
      }
      case "continue_multi": {
        const p = _st.projects.find((x) => x.path === msg.path);
        if (!p) return;
        // Count comes from the in-webview modal; clamp defensively (never trust the
        // client value) against what's actually left.
        const remaining = pendingSprints(p);
        const n = clampSprintCount(String(msg.count ?? ""), remaining);
        if (remaining < 2 || n === null) {
          await pushProjectsScreen(panel);
          return;
        }
        const r = launchContinueRun(p, n);
        if (r.error) vscode.window.showWarningMessage(`Continue: ${r.error}`);
        else if (r.attached)
          vscode.window.showInformationMessage(
            `Continue: '${p.name}' กำลังทำอยู่แล้ว — เปิด session เดิมให้ (ไม่ launch ซ้ำ)`,
          );
        else
          vscode.window.showInformationMessage(
            `Continue: '${p.name}' เริ่มทำ ${n} sprint รวด (background)`,
          );
        await pushProjectsScreen(panel);
        startSpinPoll(panel);
        return;
      }
      case "cancel_run": {
        const p = _st.projects.find((x) => x.path === msg.path);
        if (!p) return;
        await cancelContinueRun(p);
        await pushProjectsScreen(panel);
        return;
      }
      case "delete_project": {
        const p = _st.projects.find((x) => x.path === msg.path);
        if (!p) return;
        const r = deleteProjectFlow(p);
        if (r.deleted) {
          _st.projects = scanResumableProjects(); // re-scan → การ์ดหลุดจาก list
          await pushProjectsScreen(panel);
        } else if (r.reason) {
          vscode.window.showWarningMessage(r.reason);
        }
        return;
      }
      case "git_auto": {
        const p = typeof msg.path === "string" ? msg.path : "";
        if (!p) return;
        // gen = client's per-project request generation. Echoed back verbatim so
        // the client can DROP results of cancelled/superseded runs (without it, a
        // cancelled run's stale message could get auto-committed by the next run).
        const gen = typeof msg.gen === "number" ? msg.gen : 0;
        panel.webview.postMessage({
          type: "git_auto_result",
          path: p,
          gen,
          message: await gitOps.autoCommitMessage(p),
        });
        return;
      }
      case "git_commit": {
        const p = typeof msg.path === "string" ? msg.path : "";
        const message = typeof msg.message === "string" ? msg.message.trim() : "";
        if (!p || !message || !requireIdleProject(p)) return;
        const r = await gitOps.commitAll(p, message);
        notify(r.ok, `commit ${short(p)}`, r);
        await pushProjectsScreen(panel);
        return;
      }
      case "git_push": {
        const p = typeof msg.path === "string" ? msg.path : "";
        if (!p || !requireIdleProject(p)) return;
        const st = await gitOps.readGitStatus(p);
        const r = await gitOps.pushRepo(p, st.hasUpstream);
        notify(r.ok, `push ${short(p)}`, r);
        await pushProjectsScreen(panel);
        return;
      }
      case "git_commit_push": {
        // Armed auto-commit+push (the glowing Commit+Push buttons). One case so
        // the push STRICTLY follows a successful commit — two separate posted
        // messages would race (both handlers start independently).
        const p = typeof msg.path === "string" ? msg.path : "";
        const message = typeof msg.message === "string" ? msg.message.trim() : "";
        if (!p || !message || !requireIdleProject(p)) return;
        const c = await gitOps.commitAll(p, message);
        notify(c.ok, `commit ${short(p)}`, c);
        if (c.ok) {
          const st = await gitOps.readGitStatus(p);
          const r = await gitOps.pushRepo(p, st.hasUpstream);
          notify(r.ok, `push ${short(p)}`, r);
        }
        await pushProjectsScreen(panel);
        return;
      }
      case "git_pull": {
        const p = typeof msg.path === "string" ? msg.path : "";
        if (!p || !requireIdleProject(p)) return;
        const r = await gitOps.pullRepo(p);
        notify(r.ok, `pull ${short(p)}`, r);
        await pushProjectsScreen(panel);
        return;
      }
      case "git_createpush": {
        const p = typeof msg.path === "string" ? msg.path : "";
        const repoName = typeof msg.repoName === "string" ? msg.repoName.trim() : "";
        const isPrivate = msg.isPrivate !== false;
        if (!p || !repoName || !requireIdleProject(p)) return;
        const pick = await vscode.window.showWarningMessage(
          `สร้าง GitHub repo ${isPrivate ? "(private)" : "(public)"} '${repoName}' จาก ${short(
            p,
          )} แล้ว push?`,
          { modal: true },
          "Create & Push",
        );
        if (pick !== "Create & Push") return;
        const r = await gitOps.createAndPush(p, repoName, isPrivate);
        notify(r.ok, `create+push '${repoName}'`, r);
        await pushProjectsScreen(panel);
        return;
      }
    }
  });
  return panel;
}

function titleFor(): string {
  return "Projects";
}
function short(p: string): string {
  return p.split("/").pop() || p;
}
function notify(ok: boolean, what: string, r: gitOps.RunResult): void {
  if (ok) {
    // สำเร็จ = แจ้งชั่วคราวใน status bar หายเองใน 5 วิ — ไม่ค้างเป็น toast ให้กดปิดเอง
    // (showInformationMessage ไม่การันตี auto-hide → ค้างเต็มจอตอน commit/push บ่อยๆ)
    vscode.window.setStatusBarMessage(`Orchestrator: ${what} สำเร็จ`, 5000);
    return;
  }
  // ล้มเหลว = toast ค้างไว้ให้เห็นชัด (ต้องรู้ว่า commit/push พัง)
  vscode.window.showErrorMessage(
    `Orchestrator: ${what} ล้มเหลว — ${(r.stderr || r.stdout).split("\n")[0]}`,
  );
}

function renderShell(): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  html, body { height: 100%; margin: 0; padding: 0; }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
    background: var(--vscode-editor-background); display: flex; flex-direction: column; overflow: hidden; }
  .topbar { display: flex; align-items: center; justify-content: space-between;
    padding: 10px 16px; border-bottom: 1px solid var(--vscode-panel-border); }
  .topbar h1 { font-size: 14px; margin: 0; font-weight: 600; }
  .topbar .sub { font-size: 11px; opacity: 0.6; margin-top: 3px; font-weight: 400; }
  .topbar .actions { display: flex; gap: 6px; }
  button { background: transparent; color: var(--vscode-foreground);
    border: 1px solid var(--vscode-panel-border); padding: 4px 10px; border-radius: 3px;
    font-size: 11px; cursor: pointer; }
  button:hover { background: var(--vscode-list-hoverBackground); }
  .content { flex: 1; overflow-y: auto; padding: 14px 18px 28px; box-sizing: border-box; }
  .empty { opacity: 0.6; font-size: 13px; padding: 24px 0; }
  .card { display: flex; align-items: center; gap: 10px; padding: 12px 14px; margin-bottom: 8px;
    border-radius: 8px; background: var(--vscode-editor-inactiveSelectionBackground);
    border: 1px solid var(--vscode-panel-border); cursor: pointer; }
  .card .pick { flex: 1; display: flex; flex-direction: column; cursor: pointer; background: none;
    border: none; text-align: left; color: inherit; padding: 0; }
  .card:hover { background: var(--vscode-list-hoverBackground); }
  /* project has a live session driving it right now → green (same palette as .chip.doing/.cont) */
  .card.live { border-color: #2ea043; background: rgba(63,185,80,0.10); }
  .card.live:hover { background: rgba(63,185,80,0.16); }
  .card .cname { font-size: 13px; font-weight: 600; }
  .card .csub { font-size: 11px; opacity: 0.65; margin-top: 2px; }
  /* team-picker cards are the main action here → bigger + button-like */
  .teamcard { padding: 16px 18px; }
  .teamcard .cname { font-size: 15px; }
  .teamcard .csub { font-size: 12px; margin-top: 4px; }
  .card.default { border-color: #3fb950; background: rgba(63,185,80,0.12); }
  .card.default:hover { background: rgba(63,185,80,0.18); }
  .card.default .cname { color: #56d364; }
  .del { display:none; background:none; border:1px solid #f85149; cursor:pointer; font-size:11px;
         font-weight:600; padding:3px 12px; border-radius:6px; color:#f85149; margin:0 6px; white-space:nowrap; }
  #content.edit .del { display:inline-flex; align-items:center; }
  .del:hover { background:rgba(248,81,73,0.15); }
  .del.disabled { color:#6e7681; border-color:#6e7681; cursor:not-allowed; }
  .del.disabled:hover { background:none; }
  #editBtn.on { background:rgba(248,81,73,0.15); color:#f85149; border-color:#f85149; }
  .modal-card .mbtn.danger { border-color:#f85149; color:#fff; background:#da3633; }
  .modal-card .mbtn.danger:hover { background:#f85149; }
  .modal-card .mbtn.danger:disabled { background:rgba(218,54,51,0.35); border-color:transparent; color:rgba(255,255,255,0.5); cursor:not-allowed; }
  .modal-card .merr.ok { color:#3fb950; }
  .modal-card .merr.bad { color:#f85149; }
  .modal-card .merr.warn { color:#e3a13a; }
  .badge-last { font-size: 10px; font-weight: 700; color: #0d1117; background: #3fb950;
    padding: 1px 8px; border-radius: 8px; margin-left: 8px; vertical-align: middle; }
  .star { flex: 0 0 auto; font-size: 19px; line-height: 1; cursor: pointer; user-select: none;
    opacity: 0.4; padding: 5px 7px; margin: -3px -1px; border-radius: 6px;
    display: inline-flex; align-items: center; justify-content: center; }
  .star:hover { opacity: 0.8; background: var(--vscode-list-hoverBackground); }
  .star.on { color: #e3b341; opacity: 1; }
  .chip { font-size: 10px; padding: 1px 7px; border-radius: 8px; margin-left: 8px;
    vertical-align: middle; font-weight: 600; }
  .chip.act { background: rgba(196,127,26,0.22); color: #e3a13a; }
  .chip.idle { background: rgba(125,133,144,0.18); color: #9aa4af; }
  /* "doing" = a worker is grinding right now → green + a live text spinner */
  .chip.doing { background: rgba(63,185,80,0.18); color: #56d364;
    display: inline-flex; align-items: center; gap: 4px; }
  .chip.doing .spin { font-family: var(--vscode-editor-font-family, monospace);
    font-weight: 700; width: 1ch; display: inline-block; text-align: center; }
  /* inline "▶ ทำต่อ" continue button — green idle, amber stale, spinning ⟳ */
  .cont { flex: 0 0 auto; align-self: center; margin: 0 6px; font-size: 11px; font-weight: 600;
    border: 1px solid #2ea043; color: #3fb950; background: rgba(63,185,80,0.12);
    border-radius: 6px; padding: 4px 10px; cursor: pointer; white-space: nowrap;
    display: inline-flex; align-items: center; gap: 5px; }
  .cont:hover { background: rgba(63,185,80,0.22); }
  .cont.spin, .cont.stale { border-color: #c47f1a; color: #e3a13a; background: rgba(196,127,26,0.14); }
  .cont.err { border-color: #f85149; color: #f85149; background: rgba(248,81,73,0.12); cursor: help; }
  /* driven by a live INTERACTIVE session → spinning "กำลังทำ"; click OPENS that
     session (no headless run to cancel), so green (not amber like .spin). */
  .cont.busy { border-color: #2ea043; color: #56d364; background: rgba(63,185,80,0.14); cursor: pointer; }
  .cont.busy:hover { background: rgba(63,185,80,0.24); }
  .cont.multi { border-color: #3f7bd0; color: #6ca6ff; background: rgba(63,123,208,0.12); }
  .cont.multi:hover { background: rgba(63,123,208,0.22); }
  .cont-rot { display: inline-block; animation: contspin 1.1s linear infinite; }
  @keyframes contspin { to { transform: rotate(360deg); } }
  .git-editor { margin-top: 6px; }
  .git-editor textarea, .git-editor input { background: var(--vscode-input-background);
    color: var(--vscode-input-foreground); border: 1px solid var(--vscode-panel-border);
    border-radius: 4px; padding: 5px 7px; font-size: 12px; box-sizing: border-box;
    font-family: var(--vscode-font-family); cursor: auto; }
  .barrow { display: flex; gap: 6px; margin-top: 4px; }
  .git-pushx { background: #1f6feb; color: #fff; border: none; border-radius: 5px;
    padding: 4px 12px; font-weight: 600; }
  /* แสงวิ่งรอบปุ่ม = arm แล้ว (auto คิดเสร็จจะยิงเองหลัง grace 3 วิ) — a light dot
     orbiting the button border via an animated conic ring on ::after */
  @property --gl { syntax: '<angle>'; inherits: false; initial-value: 0deg; }
  .glow { position: relative; }
  .glow::after { content: ''; position: absolute; inset: -2px; border-radius: 8px; padding: 1.5px;
    opacity: 0.66;
    background: conic-gradient(from var(--gl), transparent 0deg 284deg, #ecc94b 310deg,
      #f7e59a 332deg, #ecc94b 350deg, transparent 360deg);
    -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
    -webkit-mask-composite: xor;
    mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
    mask-composite: exclude;
    animation: glspin 1.2s linear infinite; pointer-events: none; }
  @keyframes glspin { to { --gl: 360deg; } }
  /* "ทำหลาย sprint" — centered floating modal (host showInputBox can't center). */
  .modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.55);
    display: flex; align-items: center; justify-content: center; z-index: 100; }
  .modal-card { background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border); border-radius: 8px;
    padding: 18px 20px; width: 320px; max-width: 86vw;
    box-shadow: 0 8px 30px rgba(0,0,0,0.5); }
  .modal-card .mt { font-size: 13px; font-weight: 600; margin-bottom: 6px; }
  .modal-card .mh { font-size: 11px; opacity: 0.65; margin-bottom: 12px; line-height: 1.4; }
  .modal-card input { width: 100%; box-sizing: border-box; font-size: 15px; padding: 7px 9px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 4px; }
  .modal-card .merr { font-size: 11px; color: #f85149; min-height: 14px; margin-top: 6px; }
  .modal-card .mact { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
  .modal-card .mbtn { font-size: 12px; padding: 5px 14px; border-radius: 5px; cursor: pointer;
    border: 1px solid var(--vscode-panel-border); background: transparent; color: var(--vscode-foreground); }
  .modal-card .mbtn.primary { border-color: #3f7bd0; color: #fff; background: #1f6feb; }
  .modal-card .mbtn.primary:hover { background: #388bfd; }
  /* ── Project Detail: markdown file-explorer ── */
  .fx { display: flex; flex-direction: column; gap: 2px; }
  .fx-row { display: flex; align-items: center; gap: 9px; padding: 8px 12px; border-radius: 6px;
    cursor: pointer; user-select: none; }
  .fx-row:hover { background: var(--vscode-list-hoverBackground); }
  .fx-ic { flex: 0 0 auto; font-size: 14px; line-height: 1; width: 1.3em; text-align: center; }
  .fx-name { flex: 1; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fx-dir .fx-name { font-weight: 600; }
  .fx-arrow { flex: 0 0 auto; opacity: 0.5; font-size: 15px; }
  /* ── Project Detail: a single doc opened as a full page ── */
  .doc-page { padding: 4px 2px 24px; }
  .doc-body { font-size: 13px; line-height: 1.55; }
  .doc-empty { opacity: 0.55; font-size: 12px; padding: 8px 2px; }
  .doc-body h1, .doc-body h2, .doc-body h3 { margin: 12px 0 6px; line-height: 1.3; }
  .doc-body h1 { font-size: 18px; } .doc-body h2 { font-size: 16px; } .doc-body h3 { font-size: 14px; }
  .doc-body p { margin: 6px 0; }
  .doc-body ul, .doc-body ol { margin: 6px 0; padding-left: 22px; }
  .doc-body code { background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.15));
    padding: 1px 5px; border-radius: 4px; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
  .doc-body pre { background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.12));
    padding: 10px 12px; border-radius: 6px; overflow-x: auto; }
  .doc-body pre code { background: none; padding: 0; }
  .doc-body blockquote { margin: 6px 0; padding: 2px 12px; border-left: 3px solid var(--vscode-panel-border); opacity: 0.85; }
  .doc-body table { border-collapse: collapse; margin: 8px 0; font-size: 12px; }
  .doc-body th, .doc-body td { border: 1px solid var(--vscode-panel-border); padding: 4px 8px; }
  .doc-body a { color: var(--vscode-textLink-foreground); }
  .doc-body hr { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 12px 0; }
  button.disabled, button:disabled { opacity: 0.45; cursor: not-allowed; }
  button.disabled:hover, button:disabled:hover { background: transparent; }
</style></head>
<body>
  <div class="topbar">
    <div><h1 id="title">Orchestrator</h1><div class="sub" id="subtitle"></div></div>
    <div class="actions" id="actions"></div>
  </div>
  <div class="content" id="content"><div class="empty">Loading…</div></div>
  <div id="multimodal" class="modal-backdrop" style="display:none">
    <div class="modal-card" role="dialog" aria-modal="true">
      <div class="mt" id="mm-title">ทำหลาย sprint</div>
      <div class="mh" id="mm-hint"></div>
      <input id="mm-input" type="number" min="1" step="1" />
      <div class="merr" id="mm-err"></div>
      <div class="mact">
        <button class="mbtn" id="mm-cancel">ยกเลิก</button>
        <button class="mbtn primary" id="mm-ok">ทำ</button>
      </div>
    </div>
  </div>
  <div id="delmodal" class="modal-backdrop" style="display:none">
    <div class="modal-card" role="dialog" aria-modal="true">
      <div class="mt" id="dm-title">ลบโปรเจค</div>
      <div class="mh" id="dm-hint"></div>
      <input id="dm-input" type="text" placeholder="พิมพ์ชื่อโปรเจค" />
      <div class="merr" id="dm-err"></div>
      <div class="mact">
        <button class="mbtn" id="dm-cancel">ยกเลิก</button>
        <button class="mbtn danger" id="dm-ok">ลบถาวร</button>
      </div>
    </div>
  </div>
  <div id="namemodal" class="modal-backdrop" style="display:none">
    <div class="modal-card" role="dialog" aria-modal="true">
      <div class="mt">ตั้งชื่อโปรเจคใหม่</div>
      <div class="mh">พิมพ์ชื่อ (เช็คว่างทั้งในเครื่องและ GitHub org) — แก้ได้</div>
      <input id="nm-input" type="text" placeholder="ชื่อโปรเจค" />
      <div class="merr" id="nm-status"></div>
      <div class="mact">
        <button class="mbtn" id="nm-cancel">ยกเลิก</button>
        <button class="mbtn primary" id="nm-ok">ถัดไป</button>
      </div>
    </div>
  </div>
<script>
  const vscode = acquireVsCodeApi();
  var COLOR = { commit:'#c47f1a', push:'#1f6feb', pull:'#1b9aaa', 'create-push':'#238636' };
  function esc(s){ return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
  function el(id){ return document.getElementById(id); }
  function post(t,x){ vscode.postMessage(Object.assign({type:t}, x||{})); }

  // "ทำหลาย sprint" centered modal (in-webview so it floats center, not the
  // top command-palette bar that host showInputBox is stuck in). Confirm posts
  // continue_multi{path,count}; host clamps + launches N sprints headless.
  var _mmPath=null, _mmMax=2;
  function openMultiModal(path, name, pending){
    _mmPath=path; _mmMax=Math.max(2, pending||2);
    el('mm-title').textContent='ทำหลาย sprint — '+(name||'');
    el('mm-hint').textContent='จะทำกี่ sprint รวดเดียว (headless, ไม่ attach)? เหลือ '+pending;
    el('mm-err').textContent='';
    var inp=el('mm-input'); inp.max=String(pending); inp.value=String(pending);
    el('multimodal').style.display='flex'; inp.focus(); inp.select();
  }
  function closeMultiModal(){ el('multimodal').style.display='none'; _mmPath=null; }
  function mmConfirm(){
    var v=parseInt(el('mm-input').value,10);
    if(!(v>=1)){ el('mm-err').textContent='ใส่ตัวเลข 1-'+_mmMax; return; }
    if(v>_mmMax){ el('mm-err').textContent='เหลือแค่ '+_mmMax+' sprint'; return; }
    var p=_mmPath; var c=cardOf(p); if(c) c.classList.add('live'); // optimistic: green now
    closeMultiModal(); post('continue_multi',{path:p, count:v});
  }
  el('mm-cancel').addEventListener('click', closeMultiModal);
  el('mm-ok').addEventListener('click', mmConfirm);
  el('multimodal').addEventListener('click', function(e){ if(e.target===el('multimodal')) closeMultiModal(); });
  el('mm-input').addEventListener('keydown', function(e){
    if(e.key==='Enter'){ e.preventDefault(); mmConfirm(); }
    else if(e.key==='Escape'){ e.preventDefault(); closeMultiModal(); } });

  // ── ลบโปรเจค modal (กลางจอ) — 2 รอบในกล่องเดียว: (1) ถามยืนยัน → (2) พิมพ์ชื่อ ──
  var _delPath=null, _delName='', _delPhase=1;
  function openDelModal(path, name){
    _delPath=path; _delName=name||''; _delPhase=1;
    el('dm-title').textContent='ลบโปรเจค '+(name||'')+'?';
    el('delmodal').style.display='flex';
    renderDelPhase();
  }
  function renderDelPhase(){
    var inp=el('dm-input'); el('dm-err').textContent='';
    if(_delPhase===1){
      // รอบ 1: แค่ถาม "แน่ใจไหม" (ยังไม่พิมพ์ชื่อ)
      el('dm-hint').textContent='ลบถาวรจากเครื่อง (รวม git + worktrees ข้างใน) · ไม่แตะ GitHub · แน่ใจไหม?';
      inp.style.display='none'; inp.value='';
      el('dm-ok').textContent='ใช่ ลบต่อ'; el('dm-ok').disabled=false; el('dm-ok').classList.remove('danger');
    } else {
      // รอบ 2: พิมพ์ชื่อให้ตรงถึงจะกด "ลบถาวร" ได้
      el('dm-hint').textContent='พิมพ์ชื่อให้ตรงเพื่อยืนยัน: '+_delName;
      inp.style.display=''; inp.value=''; inp.dataset.expect=_delName;
      el('dm-ok').textContent='ลบถาวร'; el('dm-ok').classList.add('danger');
      dmSync(); inp.focus();
    }
  }
  function closeDelModal(){ el('delmodal').style.display='none'; _delPath=null; _delPhase=1; }
  function dmSync(){ if(_delPhase===2) el('dm-ok').disabled = el('dm-input').value.trim()!==_delName; }
  function dmOk(){
    if(_delPhase===1){ _delPhase=2; renderDelPhase(); return; }      // รอบ 1 → ไปรอบ 2
    if(el('dm-input').value.trim()!==_delName){ el('dm-err').textContent='ชื่อไม่ตรง'; return; }
    var p=_delPath; closeDelModal(); post('delete_project',{path:p}); // รอบ 2 ผ่าน → ลบจริง
  }
  el('dm-cancel').addEventListener('click', closeDelModal);
  el('dm-ok').addEventListener('click', dmOk);
  el('dm-input').addEventListener('input', dmSync);
  el('delmodal').addEventListener('click', function(e){ if(e.target===el('delmodal')) closeDelModal(); });
  el('dm-input').addEventListener('keydown', function(e){
    if(e.key==='Enter'){ e.preventDefault(); dmOk(); }
    else if(e.key==='Escape'){ e.preventDefault(); closeDelModal(); } });

  // ── ตั้งชื่อโปรเจคใหม่ modal — พิมพ์ + เช็คว่าง (local+github) debounce 400ms ──
  var _nmTimer=null;
  function openNameModal(def){
    el('nm-input').value=def||''; el('nm-ok').disabled=true;
    el('nm-status').textContent=''; el('nm-status').className='merr';
    el('namemodal').style.display='flex'; el('nm-input').focus(); el('nm-input').select();
    nmSchedule();
  }
  function closeNameModal(){ el('namemodal').style.display='none'; if(_nmTimer) clearTimeout(_nmTimer); }
  function nmSchedule(){
    el('nm-ok').disabled=true; el('nm-status').textContent='กำลังเช็ค…'; el('nm-status').className='merr';
    if(_nmTimer) clearTimeout(_nmTimer);
    _nmTimer=setTimeout(function(){ post('check_name',{name:el('nm-input').value}); }, 400);
  }
  function nmResult(m){
    var c=m.check||{}, s=el('nm-status');
    if(!c.valid){ s.textContent='ชื่อไม่ถูกต้อง (ใช้ A-Z a-z 0-9 . _ - เท่านั้น)'; s.className='merr bad'; el('nm-ok').disabled=true; return; }
    var free = !c.localTaken && !(c.githubChecked && c.githubTaken);
    var used = (m.name && m.name!==el('nm-input').value) ? ' (จะใช้ชื่อ "'+m.name+'")' : '';
    if(c.localTaken){ s.textContent='ซ้ำ: มีในเครื่องแล้ว'+used; s.className='merr bad'; }
    else if(c.githubChecked && c.githubTaken){ s.textContent='ซ้ำ: มีบน GitHub org แล้ว'+used; s.className='merr bad'; }
    else if(!c.githubChecked){ s.textContent='ว่างในเครื่อง · เช็ค GitHub ไม่ได้ (gh ไม่พร้อม)'+used; s.className='merr warn'; }
    else { s.textContent='ว่าง ใช้ได้'+used; s.className='merr ok'; }
    el('nm-ok').disabled=!free;
  }
  function nmConfirm(){ if(el('nm-ok').disabled) return; var n=el('nm-input').value; closeNameModal(); post('name_confirmed',{name:n}); }
  el('nm-cancel').addEventListener('click', closeNameModal);
  el('nm-ok').addEventListener('click', nmConfirm);
  el('nm-input').addEventListener('input', nmSchedule);
  el('namemodal').addEventListener('click', function(e){ if(e.target===el('namemodal')) closeNameModal(); });
  el('nm-input').addEventListener('keydown', function(e){
    if(e.key==='Enter'){ e.preventDefault(); nmConfirm(); }
    else if(e.key==='Escape'){ e.preventDefault(); closeNameModal(); } });

  // "โหมดถาม" toggle — persists across screen re-renders (this script runs once).
  // On: the launch post carries askMode:true → kickoff gets the grilling+scrutinize trigger.
  var askMode=false;
  function askBtnStyle(){ return askMode
    ? 'background:rgba(63,185,80,0.18);color:#56d364;border-color:#3fb950;' : ''; }
  function askBtnLabel(){ return '🔎 โหมดถาม: '+(askMode?'เปิด ✓':'ปิด'); }

  // Text-animate the "doing" spinner(s): one shared ticker cycles a braille glyph
  // through every .spin on screen (re-queried each tick so it survives re-render).
  var _SPIN="⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏".split(""), _sp=0;
  setInterval(function(){ _sp=(_sp+1)%_SPIN.length; var f=_SPIN[_sp];
    var ns=document.querySelectorAll('.spin'); for(var i=0;i<ns.length;i++) ns[i].textContent=f;
  }, 90);

  function actionsHtml(canBack, showFetch, askable, showNew, showEdit, githubUrl){
    // showNew = the "+ เริ่มโปรเจคใหม่" button (Projects screen only) → runs the
    // same team→orchestrator→launch flow with no project = a fresh build.
    // fetch = git-refresh of the PROJECTS screen only (dead-end elsewhere).
    // askBtn only for a new build (askable) — resume ยังไม่รองรับโหมดถาม.
    // showEdit = "Edit" toggle (Projects screen only) → เผยปุ่มลบต่อการ์ด.
    // githubUrl (teams screen, resume only) → "เปิดใน GitHub" opens the repo in the browser.
    return (canBack ? '<button id="backBtn">← กลับ</button>' : '')
      + (githubUrl ? '<button id="ghBtn" title="เปิด repo นี้ใน GitHub (browser)">🔗 GitHub</button>' : '')
      + (showNew ? '<button id="newProjBtn" title="เริ่ม build โปรเจคใหม่" style="border-color:#2ea043;color:#3fb950;">+ เริ่มโปรเจคใหม่</button>' : '')
      + (askable ? '<button id="askBtn" title="เปิด = สัมภาษณ์ requirement ละเอียด (grilling) + รีวิวแผนก่อนลงมือ (scrutinize)" style="'+askBtnStyle()+'">'+askBtnLabel()+'</button>' : '')
      + (showFetch ? '<button id="reloadBtn">fetch</button>' : '')
      + (showEdit ? '<button id="editBtn" title="เปิดเพื่อลบโปรเจคที่ไม่ใช้">Edit</button>' : '');
  }
  function wireActions(canBack){
    if (canBack){ var b=el("backBtn"); if(b) b.addEventListener('click',function(){post('back');}); }
    var gh=el("ghBtn"); if(gh) gh.addEventListener('click',function(){post('open_github');});
    var nb=el("newProjBtn"); if(nb) nb.addEventListener('click',function(){post('start_new');});
    var ab=el("askBtn"); if(ab) ab.addEventListener('click',function(){
      askMode=!askMode; ab.textContent=askBtnLabel(); ab.style.cssText=askBtnStyle(); });
    var rb=el("reloadBtn"); if(rb) rb.addEventListener('click',function(){post('git_refresh');});
    var eb=el("editBtn"); if(eb) eb.addEventListener('click',function(){
      var c=el("content"); var on=c.classList.toggle('edit'); eb.classList.toggle('on', on); });
  }

  // ── git button (project rows) ────────────────────────────────────────────
  function gitCell(g){
    if (!g || g.kind==='none') return '';
    if (g.kind==='uptodate') return '<span style="color:#7d8590;font-size:11px;">'+esc(g.label)+'</span>';
    // diverged = local AND remote both moved → no safe auto-action. Show an info
    // chip (not a button); the user reconciles in a terminal (pull --rebase/merge).
    if (g.kind==='diverged') return '<span style="color:#e3a13a;font-size:11px;" title="local + remote ต่างมี commit ใหม่ — reconcile เองใน terminal (git pull --rebase หรือ merge)">'+esc(g.label)+'</span>';
    // commit / create-push open an inline form (message / repo name) — the caret
    // signals that, so the orange button doesn't read as "commit right now".
    var caret = (g.kind==='commit'||g.kind==='create-push') ? ' ▾' : '';
    return '<button class="git-act" data-kind="'+g.kind+'" style="background:'+(COLOR[g.kind]||'#555')
      +';color:#fff;border:none;border-radius:5px;padding:4px 10px;font-size:11px;">'+esc(g.label)+caret+'</button>';
  }
  function gitEditor(g){
    if (g.kind==='commit') return '<div class="git-editor" style="display:none">'
      +'<textarea class="git-msg" rows="2" style="width:100%" placeholder="commit message…"></textarea>'
      +'<div class="barrow"><button class="git-auto">✨ auto</button>'
      +'<button class="git-go" style="background:#238636;color:#fff;border:none;border-radius:5px;padding:4px 12px;font-weight:600;">✓ Commit</button>'
      +'<button class="git-pushx" style="display:none" title="auto เสร็จแล้ว commit + push ให้เลย · กดตอนแสงคู่ = ยกเลิกแสงทั้งหมด">⇧ Push ด้วย</button>'
      +'<button class="git-x">ยกเลิก</button></div></div>';
    if (g.kind==='create-push'){ var _p=String(g.path||'').split('/').filter(Boolean); var def=_p[_p.length-1]||'';
      return '<div class="git-editor" style="display:none">'
      +'<input class="git-repo" value="'+esc(def)+'" style="width:55%"> '
      +'<label style="font-size:11px"><input type="checkbox" class="git-priv" checked> private</label>'
      +'<div class="barrow"><button class="git-go2">Create & Push</button><button class="git-x">ยกเลิก</button></div></div>'; }
    return '';
  }

  // ── Project Detail screen (markdown file-explorer) ───────────────────────
  var _docCache = {};        // rel → rendered HTML (or error markup), cached per open
  var _previewRunning = false, _previewAvail = false;
  var _detail = {};          // {title, subtitle, githubUrl} — kept so we can re-render the explorer header
  var _tree = [];            // root TreeNode[] for this project (folders + .md only)
  var _navStack = [];        // folder names from root → current folder ([] = root)
  var _viewingDoc = null;    // rel of the .md open as a full page, or null while in the explorer

  function detailActionsHtml(githubUrl){
    var lh = _previewAvail
      ? '<button id="lhBtn" title="รัน dev server แล้วเปิด browser (กดซ้ำ = หยุด)">'
          + (_previewRunning ? '⏹ หยุด' : '🌐 localhost') + '</button>'
      : '<button id="lhBtn" class="disabled" disabled title="โปรเจคนี้ไม่มี .orches-preview.sh — เปิด localhost ไม่ได้">🌐 localhost</button>';
    return '<button id="backBtn">← กลับ</button>'
      + '<button id="closeBtn">✕ ปิด</button>'
      + lh
      + '<button id="contBtn" title="ไปเลือกทีม / เข้า session ที่ทำอยู่" style="border-color:#2ea043;color:#3fb950;">▶ ทำต่อ</button>'
      + (githubUrl ? '<button id="ghBtn" title="เปิด repo นี้ใน GitHub (browser)">🔗 GitHub</button>' : '');
  }
  function wireDetailActions(){
    // Explorer back: inside a subfolder → up one level; at the root → out to Projects.
    var b=el("backBtn"); if(b) b.addEventListener('click',function(){
      if(_navStack.length){ _navStack.pop(); renderExplorer(); } else { post('to_projects'); } });
    var c=el("closeBtn"); if(c) c.addEventListener('click',function(){post('close');});
    var lh=el("lhBtn"); if(lh && _previewAvail) lh.addEventListener('click',function(){
      lh.disabled=true; lh.textContent='⏳ …'; post('run_localhost'); });
    var ct=el("contBtn"); if(ct) ct.addEventListener('click',function(){post('continue_to_team');});
    var gh=el("ghBtn"); if(gh) gh.addEventListener('click',function(){post('open_github');});
  }
  function renderDetail(m){
    disarmAll();                       // leaving the projects screen → drop any armed git action
    _lastProjKey = null;               // invalidate skip-guard → a return to projects re-renders
    _detail = { title:m.title, subtitle:m.subtitle, githubUrl:m.githubUrl };
    _previewRunning = !!(m.preview && m.preview.running);
    _previewAvail   = !!(m.preview && m.preview.available);
    _docCache = {};                    // fresh project → fresh cache
    _tree = m.tree || [];
    _navStack = [];                    // always start at the project root
    _viewingDoc = null;
    renderExplorer();
  }
  // Walk _navStack into _tree → the child list of the folder we're currently in.
  // A stale path (folder vanished between renders) clamps back to where it still resolves.
  function currentFolder(){
    var nodes = _tree;
    for (var i=0;i<_navStack.length;i++){
      var found=null;
      for (var j=0;j<nodes.length;j++){ if(nodes[j].kind==='dir' && nodes[j].name===_navStack[i]){ found=nodes[j]; break; } }
      if(!found){ _navStack = _navStack.slice(0,i); break; }
      nodes = found.children||[];
    }
    return nodes;
  }
  function explorerRow(n){
    // Folder: 📁 + trailing "/" + chevron. File: 📄 + name. Name/"/" carry the
    // dir-vs-file distinction on their own so it survives terminals that drop emoji.
    var isDir = n.kind==='dir';
    return '<div class="fx-row'+(isDir?' fx-dir':'')+'" data-kind="'+n.kind+'"'
      +' data-name="'+esc(n.name)+'" data-rel="'+esc(n.rel)+'">'
      +'<span class="fx-ic">'+(isDir?'📁':'📄')+'</span>'
      +'<span class="fx-name">'+esc(n.name)+(isDir?'/':'')+'</span>'
      +(isDir?'<span class="fx-arrow">›</span>':'')+'</div>';
  }
  function renderExplorer(){
    _viewingDoc = null;
    el("title").textContent = _detail.title;
    el("subtitle").textContent = _navStack.length ? ('/' + _navStack.join('/')) : _detail.subtitle;
    el("actions").innerHTML = detailActionsHtml(_detail.githubUrl); wireDetailActions();
    var nodes = currentFolder();
    var rows = nodes.map(explorerRow).join('');
    var emptyMsg = _navStack.length ? 'โฟลเดอร์นี้ไม่มีไฟล์ .md' : 'โปรเจคนี้ไม่มีไฟล์ .md';
    el("content").innerHTML = '<div class="fx">'
      + (rows || '<div class="empty">'+emptyMsg+'</div>') + '</div>';
    el("content").querySelectorAll('.fx-row').forEach(function(row){
      row.addEventListener('click',function(){
        if(row.dataset.kind==='dir'){ _navStack.push(row.dataset.name); renderExplorer(); }
        else { openDocView(row.dataset.rel, row.dataset.name); }
      });
    });
  }
  // Open one .md as a full page over the explorer: its own header + back button.
  // Back returns to the explorer at the same folder (renderExplorer, wired here).
  function openDocView(rel, name){
    _viewingDoc = rel;
    el("title").textContent = '📄 ' + name;
    el("subtitle").textContent = rel;
    el("actions").innerHTML = '<button id="backBtn">← กลับ</button><button id="closeBtn">✕ ปิด</button>';
    el("backBtn").addEventListener('click',function(){ renderExplorer(); });
    el("closeBtn").addEventListener('click',function(){ post('close'); });
    var cached = _docCache[rel];
    el("content").innerHTML = '<div class="doc-page doc-body">'
      + (cached!==undefined ? cached : '<div class="doc-empty">กำลังโหลด…</div>') + '</div>';
    if(cached===undefined) post('open_doc',{rel:rel});
  }
  function handleDocHtml(rel, html, error){
    var out = error ? '<div class="doc-empty">'+esc(error)+'</div>' : (html||'');
    _docCache[rel]=out;
    if(_viewingDoc===rel){                 // still on this doc's page → paint it
      var page=el("content").querySelector('.doc-page');
      if(page) page.innerHTML=out;
    }
  }
  function handlePreviewState(running){
    _previewRunning=!!running;
    var lh=el("lhBtn"); if(lh){ lh.disabled=false; lh.textContent=_previewRunning?'⏹ หยุด':'🌐 localhost'; }
  }

  // Skip-guard for no-op re-renders. The spin poll (startSpinPoll, host side) resends
  // the ENTIRE card list every ~2.5s while a run is live; renderProjects rebuilds
  // content.innerHTML wholesale, which tears down + recreates the animated spinner
  // nodes (.cont-rot CSS rotation + .spin glyph) so their animation restarts from 0 →
  // the ⟳ "กำลังทำ" visibly หยุดหมุน/กระตุก every tick. When the payload is byte-identical
  // (the common case: a stable running sprint) there is nothing to redraw, so skip the
  // rebuild and let the spinner run continuously. A real change (git state, sprint done,
  // worker start/stop) differs and falls through to a normal render. Reset to null when
  // leaving the projects screen (renderDetail/Teams/Orch) so returning always re-renders.
  var _lastProjKey = null;
  function renderProjects(m){
    var _key = JSON.stringify([m.title, m.subtitle, m.items]);
    if (_lastProjKey !== null && _key === _lastProjKey) return;
    _lastProjKey = _key;
    el("title").textContent = m.title; el("subtitle").textContent = m.subtitle;
    askMode=false; // Projects list เอง ไม่มีโหมดถาม (ยกไปหน้าเลือกทีมตอนเริ่มใหม่)
    el("actions").innerHTML = actionsHtml(false, true, false, true, true); wireActions(false);
    var items = m.items||[];
    // การ์ด project ที่หลุดจาก list (เสร็จ/หาย) ระหว่างที่ยัง arm ค้าง → เลิก arm+timer ทิ้ง (กันยิงตอนการ์ดไม่อยู่แล้ว)
    var _live={}; items.forEach(function(it){ _live[it.path]=1; });
    for(var _k in AUTO){ if(Object.prototype.hasOwnProperty.call(AUTO,_k) && !_live[_k]) disarmHard(_k); }
    el("content").innerHTML = items.length ? items.map(function(it){
      var wt = it.worktrees||0, sp = it.sprints||0;
      var pt = it.plannedTotal||0, pd = it.plannedDone||0;
      // "ค้าง" = sprint ที่ยังไม่เสร็จ (งานค้างทั้งหมด) — ONE number. plan.md exists →
      // count from the plan (total - done); no plan → fall back to open agents/*
      // worktrees. A planned-but-not-started sprint IS pending work too (just with
      // 0 done), so it folds into "ค้าง" — no separate "เหลือ" chip.
      var pending = pt > 0 ? (pt - pd) : wt; if (pending < 0) pending = 0;
      // "doing" wins: a worker worktree is LIVE right now → animated green
      // spinner. Else pending>0 → static 🔨 ค้าง. Else nothing (clean/done).
      var chip = it.doing
        ? '<span class="chip doing"><span class="spin">⠋</span> กำลังทำ</span>'
        : (pending > 0 ? '<span class="chip act">🔨 ค้าง '+pending+' sprint</span>' : '');
      // Progress line: always "ทำไปแล้ว X sprint" — how many are DONE. With a plan
      // that's the [x] count (pd); without a plan, the sprint-doc count (sp). How
      // many remain is the "ค้าง" chip's job, not this line's.
      var done = pt > 0 ? pd : sp;
      // done>0 → "ทำไปแล้ว X sprint" · done===0 → ยังไม่ทำอะไรเลย = "พร้อมเริ่ม"
      var sub = done > 0 ? 'ทำไปแล้ว '+done+' sprint' : 'พร้อมเริ่ม';
      // continue button: run 1 sprint headless with the last-used team (state
      // resolved host-side). spinning = คลิกเพื่อยกเลิก · stale = run หลุด, คลิกเริ่มใหม่.
      var run = it.run || { state: 'hidden' };
      // "busy" = a session is driving this project right now (green card). The
      // .orches-run.json marker only exists for THIS dashboard's own headless runs,
      // so an INTERACTIVE orchestrator session (the ▶ เริ่มใหม่ / popup path) leaves
      // run.state at 'idle' even while a build is live. Gate every start-action on
      // !busy so a green card never shows ▶ ทำต่อ / ▶▶ ทำหลาย sprint / ลบ — it offers
      // an attach affordance instead. (spinning = own headless run; keeps cancel.)
      var busy = run.state === 'spinning' || !!it.driven;
      // การ์ดสีเขียว (มี session ขับอยู่/headless run) → สถานะคือ "กำลังทำ"
      // ไม่ใช่ "พร้อมเริ่ม" หรือ "ทำไปแล้ว X sprint" (ซึ่งสื่อว่ายังไม่ได้ทำ/หยุดแล้ว)
      if (busy) sub = 'กำลังทำ';
      var contBtn =
        run.state === 'spinning' ? '<button class="cont spin" title="กำลังทำต่อ — คลิกเพื่อยกเลิก"><span class="cont-rot">⟳</span> กำลังทำ</button>' :
        it.driven                ? '<button class="cont busy" title="กำลังทำอยู่ (มี session ขับโปรเจคนี้) — คลิกเพื่อเปิด/เข้า session"><span class="cont-rot">⟳</span> กำลังทำ</button>' :
        run.state === 'idle'     ? '<button class="cont" title="ทำต่อ 1 sprint ด้วยทีมล่าสุด (auto, background)">▶ ทำต่อ</button>' :
        run.state === 'stale'    ? '<button class="cont stale" title="run หลุด — คลิกเพื่อเริ่มใหม่">⚠ ทำต่อ</button>' :
        run.state === 'error'    ? '<button class="cont err" title="'+esc(run.errorMsg||'error')+'">⚠ error</button>' : '';
      // "ทำหลาย sprint": only when NOT busy, idle, AND ≥2 sprint left. Opens a "how
      // many?" input box; host runs N sprints headless in ONE detached run (no
      // attach, no checkpoint). Class 'cont' so the row-select guard skips it.
      var multiBtn = (!busy && run.state === 'idle' && pending >= 2)
        ? '<button class="cont multi" data-pending="'+pending+'" data-name="'+esc(it.name)+'" title="ทำหลาย sprint รวดเดียว (auto, background) — เลือกจำนวน">▶▶ ทำหลาย sprint</button>'
        : '';
      // ปุ่มลบ (โผล่เฉพาะ edit mode ผ่าน CSS) · busy (running/ถูกขับ) = กากบาทเทา กดไม่ได้
      // (กันลบโฟลเดอร์ที่ session กำลังใช้อยู่ — host ก็ guard ซ้ำอีกชั้น)
      var delBtn = busy
        ? '<button class="del disabled" title="กำลังทำอยู่ — กด stop / ปิด session ก่อนถึงจะลบได้">ลบ</button>'
        : '<button class="del" data-name="'+esc(it.name)+'" title="ลบโปรเจคออกจากเครื่อง">ลบ</button>';
      // busy = session กำลังขับโปรเจคนี้อยู่ → ซ่อนปุ่ม git ทั้งหมด (commit/push/pull/
      // create&push) กัน commit/push ชนกับสิ่งที่ worker กำลังทำอยู่ (เข้าคู่กับ delBtn
      // ที่ disable ไปแล้วด้านบน — host-side ก็ guard ซ้ำใน git_* handlers)
      return '<div class="card'+(it.driven?' live':'')+'" data-path="'+esc(it.path)+'">'
        +'<span class="star'+(it.starred?' on':'')+'" role="button" title="ปักดาว / เอาดาวออก">'+(it.starred?'★':'☆')+'</span>'
        +'<div style="flex:1"><button class="pick"><span class="cname">'+esc(it.name)+chip+'</span>'
        +'<span class="csub">'+sub+'</span></button>'+(busy ? '' : gitEditor(it.git))+'</div>'
        +contBtn+multiBtn+delBtn
        +'<span class="git-cell">'+(busy ? '' : gitCell(it.git))+'</span></div>';
    }).join('') : '<div class="empty">'+esc(m.subtitle)+'</div>';
    el("content").querySelectorAll('.card').forEach(function(card){
      var path=card.dataset.path;
      // Whole row selects the project — except clicks on the git button, its
      // inline form, or the star toggle (those do their own thing).
      card.addEventListener('click',function(e){
        if (e.target.closest('.git-act') || e.target.closest('.git-editor') || e.target.closest('.star') || e.target.closest('.cont') || e.target.closest('.del')) return;
        // เพิ่งมี editor หุบไป (commit/ยกเลิก) → layout เพิ่งขยับ คลิกที่ 2 ของ
        // double-click จะตกใส่แถวอื่น — เมินช่วงสั้นๆ กัน pick/attach ผิดโปรเจค
        if (Date.now() - _edCloseAt < 350) return;
        post('pick_project',{path:path});
      });
      var starEl=card.querySelector('.star');
      if(starEl) starEl.addEventListener('click',function(e){ e.stopPropagation(); post('toggle_star',{path:path}); });
      var contEl=card.querySelector('.cont:not(.multi)');
      if(contEl) contEl.addEventListener('click',function(e){ e.stopPropagation();
        // spinning → this click CANCELS the live run; any other state → start one.
        if(contEl.classList.contains('spin')) post('cancel_run',{path:path});
        else { card.classList.add('live'); post('continue_run',{path:path}); } }); // optimistic: green now
      var multiEl=card.querySelector('.cont.multi');
      if(multiEl) multiEl.addEventListener('click',function(e){ e.stopPropagation();
        openMultiModal(path, multiEl.dataset.name||'', Number(multiEl.dataset.pending)||2); });
      var delEl=card.querySelector('.del:not(.disabled)');
      if(delEl) delEl.addEventListener('click',function(e){ e.stopPropagation(); openDelModal(path, delEl.dataset.name||''); });
      wireGit(card, path);
    });
    // DOM เพิ่งถูกสร้างใหม่ทั้งจอ (host re-render หลังทุก git action) — สถานะ arm/แสง
    // อยู่ใน AUTO (script ตัวนี้รันครั้งเดียว) จึงต้อง apply กลับเข้าปุ่มทุกใบ
    items.forEach(function(it){ applyAutoUi(it.path); });
  }
  function wireGit(card, path){
    var ed=card.querySelector('.git-editor'), act=card.querySelector('.git-act');
    if(act) act.addEventListener('click',function(e){ e.stopPropagation();
      var k=act.dataset.kind;
      if(k==='push'){ post('git_push',{path:path}); return; }
      if(k==='pull'){ post('git_pull',{path:path}); return; }
      // commit / create-push: OPEN the form (never toggle-closed). Re-clicking the
      // orange button used to collapse it → looked like "nothing happened / stuck".
      if(ed){ ed.style.display='block'; ast(path).edOpen=true; var mb=ed.querySelector('.git-msg'); if(mb) mb.focus(); } });
    if(!ed) return;
    var mb0=ed.querySelector('.git-msg'); if(mb0) mb0.addEventListener('input',function(){
      var st=ast(path); st.draft=mb0.value; st.edOpen=true;});  // เก็บ draft กันหายตอนจอ re-render
    var x=ed.querySelector('.git-x'); if(x) x.addEventListener('click',function(){
      // ปิดฟอร์ม = ล้มเลิกทั้งหมด (หยุด auto + ปลดแสง + ทิ้ง draft) — กัน arm ค้างแบบมองไม่เห็น
      var st=ast(path); st.thinking=false; st.gen++; disarm(path); st.draft=null; st.edOpen=false;
      applyAutoUi(path); _edCloseAt=Date.now(); ed.style.display='none';});
    var au=ed.querySelector('.git-auto'); if(au) au.addEventListener('click',function(){
      var st=ast(path);
      st.gen++;  // ทุกการกด = ตัดผลของ request เก่าที่ยังลอยอยู่ทิ้งเสมอ
      // หยุดทุกกรณีที่ระบบกำลังทำงาน: กำลังคิด "หรือ" แสงวิ่งอยู่ (รวมช่วง grace ที่คิดเสร็จแล้ว)
      if(st.thinking || st.armed>0){ st.thinking=false; disarm(path); applyAutoUi(path); return; }
      st.thinking=true; st.msg=null; applyAutoUi(path); post('git_auto',{path:path,gen:st.gen});});
    var go=ed.querySelector('.git-go'); if(go) go.addEventListener('click',function(){
      var st=ast(path);
      if(st.armed>0){ disarmToBox(path, ed); return; }        // กดตอนแสงวิ่ง = ยกเลิก auto-commit (auto ยังคิดต่อ)
      if(st.thinking){ st.armed=1; st.armedAt=Date.now(); applyAutoUi(path); return; } // arm: คิดเสร็จ = commit เอง (grace 3 วิ)
      var v=(ed.querySelector('.git-msg').value||'').trim(); if(!v)return;
      st.draft=null; st.edOpen=false; _edCloseAt=Date.now();
      post('git_commit',{path:path,message:v}); ed.style.display='none';});
    var px=ed.querySelector('.git-pushx'); if(px) px.addEventListener('click',function(){
      var st=ast(path);
      if(st.armed===1){ st.armed=2; st.armedAt=Date.now(); if(st.msg) scheduleExec(path); applyAutoUi(path); return; } // arm push + reset 3 วิ
      if(st.armed===2){ disarmToBox(path, ed); return; }      // กดตอนแสงคู่ = แสงหายทั้งคู่ (auto ยังคิดต่อ)
    });
    var go2=ed.querySelector('.git-go2'); if(go2) go2.addEventListener('click',function(){
      var n=(ed.querySelector('.git-repo').value||'').trim(); if(!n)return;
      ast(path).edOpen=false; _edCloseAt=Date.now();
      post('git_createpush',{path:path,repoName:n,isPrivate:ed.querySelector('.git-priv').checked}); ed.style.display='none';});
  }
  function fillAuto(path,message){
    var card=cardOf(path);
    if(!card)return; var au=card.querySelector('.git-auto'); if(au){au.textContent='✨ auto';au.disabled=false;}
    var st=ast(path); st.edOpen=true; if(message) st.draft=message;  // เก็บเป็น draft — รอด re-render
    var ed=card.querySelector('.git-editor'); if(ed) ed.style.display='block';
    var box=card.querySelector('.git-msg'); if(box&&message) box.value=message;
  }

  // ── auto-commit arming — สถานะแยกต่อ project, ตัวจับเวลาอิสระต่อกัน ─────────
  // st = { thinking: auto กำลังคิด, armed: 0 ไม่ arm / 1 commit / 2 commit+push,
  //        armedAt: เวลา click ล่าสุดที่เพิ่ม/ขยับ arm (จุดเริ่ม grace 3 วิ),
  //        msg: ข้อความที่ auto คิดเสร็จ (รอ grace), execTimer: setTimeout id }
  var AUTO = {};
  var GRACE_MS = 3000;
  // กัน double-click: คลิกที่ 2 ตกบน layout ที่เพิ่งขยับ (editor เพิ่งหุบ) แล้วกลายเป็น
  // pick_project ของแถวอื่น — จำเวลาหุบล่าสุดไว้แล้วเมิน card-click ช่วงสั้นๆ หลังจากนั้น
  var _edCloseAt = 0;
  function ast(p){ return AUTO[p] || (AUTO[p] = {thinking:false, armed:0, armedAt:0, msg:null,
    execTimer:null, gen:0, draft:null, edOpen:false}); }
  function cardOf(p){ return el("content").querySelector('.card[data-path="'+(window.CSS&&CSS.escape?CSS.escape(p):p)+'"]'); }
  function disarm(p){ var st=ast(p); st.armed=0; st.armedAt=0;
    if(st.execTimer){ clearTimeout(st.execTimer); st.execTimer=null; }
    var m=st.msg; st.msg=null; return m; }  // soft: ปลด arm + เคลียร์ timer เท่านั้น — auto ที่ยังคิดอยู่ปล่อยคิดต่อ (disarmToBox พึ่งพฤติกรรมนี้)
  // hard: soft + ทิ้งผล auto ที่ยัง in-flight ด้วย (thinking=false + gen++ → git_auto_result เก่าถูก drop)
  // ใช้เฉพาะตอนละทิ้งงานทั้งหมดจริงๆ (ออกจากหน้า / ซ่อน panel / การ์ดหลุด) — ไม่ใช่ตอน user แค่ยกเลิก arm
  function disarmHard(p){ var st=ast(p); st.thinking=false; st.gen++; return disarm(p); }
  // ยกเลิก arm/timer ของทุก project พร้อมกัน (hard) + รีเฟรช UI (ลบไฟเรือง/คืนปุ่ม ✨auto/ซ่อน push)
  // ถ้าไม่เรียก applyAutoUi คลาส .glow จะค้างบนปุ่ม → ไฟเรืองหมุนไม่หยุดตอนกลับมาหน้าเดิม (state ปลดแล้วก็จริง)
  function disarmAll(){ for(var k in AUTO){ if(Object.prototype.hasOwnProperty.call(AUTO,k)){ disarmHard(k); applyAutoUi(k); } } }
  function scheduleExec(p){ var st=ast(p);
    if(st.execTimer) clearTimeout(st.execTimer);
    var wait=Math.max(0, GRACE_MS-(Date.now()-st.armedAt));
    st.execTimer=setTimeout(function(){ execArmed(p); }, wait); }
  function execArmed(p){ var st=ast(p); st.execTimer=null;
    if(!st.armed || !st.msg) return;
    var withPush=(st.armed===2), msg=st.msg;
    st.armed=0; st.armedAt=0; st.msg=null;
    // ปิดฟอร์มทันทีที่ยิง commit — ไม่รอ host re-render กลับมา กัน user มือเร็วกด auto/commit/push
    // ในเสี้ยววิระหว่าง commit→push (ตอนนั้นงานยิงไปแล้ว กดซ้ำ = commit/แกล้งซ้อน)
    st.edOpen=false; st.draft=null; _edCloseAt=Date.now();
    applyAutoUi(p);
    var card=cardOf(p), ed=card&&card.querySelector('.git-editor'); if(ed) ed.style.display='none';
    post(withPush?'git_commit_push':'git_commit',{path:p,message:msg}); }
  function applyAutoUi(p){ var card=cardOf(p); if(!card) return;
    var st=ast(p), ed=card.querySelector('.git-editor');
    var au=card.querySelector('.git-auto'), go=card.querySelector('.git-go'), px=card.querySelector('.git-pushx');
    if(!go) return;
    // ปุ่ม auto = ปุ่มหยุดตลอดช่วงที่ระบบทำงาน (กำลังคิด "หรือ" แสงวิ่งช่วง grace)
    if(au){ au.textContent = (st.thinking || st.armed>0) ? '⏹ หยุด' : '✨ auto'; au.disabled=false; }
    if(ed && (st.thinking || st.armed>0 || st.edOpen)) ed.style.display='block';
    // ฟื้น message ที่พิมพ์ค้าง/auto เติมไว้ หลังจอถูก re-render (host refresh ทุก git action)
    var bx=card.querySelector('.git-msg'); if(bx && st.draft && !bx.value) bx.value=st.draft;
    go.classList.toggle('glow', st.armed>0);
    if(px){ px.style.display = st.armed>0 ? '' : 'none';
      // sync: ตอนแสง push เพิ่งติด ให้ restart แสง commit ในเฟรมเดียวกัน → จุดวิ่งออกจาก 0° พร้อมกัน (เฟสตรงกันตลอด grace)
      var pxOn = st.armed===2, pxWas = px.classList.contains('glow');
      if(pxOn && !pxWas){ go.classList.remove('glow'); void go.offsetWidth; go.classList.add('glow'); }
      px.classList.toggle('glow', pxOn); } }
  // คืน msg ที่ค้างเข้า textarea ตอนปลด arm ระหว่าง grace — จะได้ไม่หายไปเฉยๆ
  function disarmToBox(p, ed){ var m=disarm(p); applyAutoUi(p);
    if(m){ var st=ast(p); st.draft=m; st.edOpen=true;
      var b=ed.querySelector('.git-msg'); if(b && !b.value.trim()) b.value=m; } }
  function handleAutoResult(p, message, gen){ var st=ast(p);
    if(typeof gen==='number' && gen!==st.gen) return;  // ผลของ request ที่ถูกยกเลิก/แทนที่ — ทิ้ง (กัน commit ด้วย message เก่า)
    if(!st.thinking) return;                       // ถูกยกเลิกไปแล้ว — ทิ้งผลเงียบๆ
    st.thinking=false;
    if(st.armed>0){
      st.msg=String(message||'').trim();
      if(!st.msg){ disarm(p); applyAutoUi(p); fillAuto(p,''); return; }   // auto คิดไม่ออก → ปลด arm ให้พิมพ์เอง
      st.armedAt=Date.now(); scheduleExec(p); applyAutoUi(p); return;  // grace นับจากตอน "ผลมาถึง" (user เพิ่งเห็น msg) — ไม่ใช่จาก click ก่อน gen (ไม่งั้น gen>3วิ = ยิงทันทีไม่มีช่อง cancel)
    }
    applyAutoUi(p); fillAuto(p, message); }

  function renderTeams(m){ disarmAll(); _lastProjKey=null;  // ออกจากหน้า projects → เลิก arm/timer ที่ค้างทั้งหมด (+invalidate skip-guard)
    el("title").textContent=m.title; el("subtitle").textContent=m.subtitle;
    var askable=m.askable===true; if(!askable) askMode=false;
    el("actions").innerHTML=actionsHtml(m.canBack, false, askable, false, false, m.githubUrl); wireActions(m.canBack);
    var items=m.items||[];
    el("content").innerHTML = items.length ? items.map(function(it){
      return '<div class="card teamcard'+(it.isDefault?' default':'')+'" data-name="'+esc(it.name)+'"><button class="pick">'
        +'<span class="cname">'+esc(it.name)+(it.isDefault?'<span class="badge-last">⭐ ทำล่าสุด</span>':'')+'</span>'
        +'<span class="csub">'+esc(it.sub)+'</span></button></div>';
    }).join('') : '<div class="empty">ยังไม่มีทีม — สร้างในหน้า Teams ก่อน</div>';
    el("content").querySelectorAll('.card').forEach(function(c){
      c.addEventListener('click',function(){post('pick_team',{name:c.dataset.name, askMode:askMode});});});
  }
  function renderOrch(m){ disarmAll(); _lastProjKey=null;  // ออกจากหน้า projects → เลิก arm/timer ที่ค้างทั้งหมด (+invalidate skip-guard)
    el("title").textContent=m.title; el("subtitle").textContent=m.subtitle;
    var askable=m.askable===true; if(!askable) askMode=false;
    el("actions").innerHTML=actionsHtml(false, false, askable); wireActions(false);
    el("content").innerHTML=(m.items||[]).map(function(it){
      return '<div class="card" data-name="'+esc(it.name)+'"><button class="pick">'
        +'<span class="cname">'+esc(it.name)+'</span><span class="csub">orchestrator</span></button></div>';
    }).join('');
    el("content").querySelectorAll('.card').forEach(function(c){
      c.addEventListener('click',function(){post('pick_orch',{name:c.dataset.name, askMode:askMode});});});
  }

  window.addEventListener("message",function(e){
    var m=e.data; if(!m||!m.type) return;
    if(m.type==="screen_projects") renderProjects(m);
    else if(m.type==="screen_teams") renderTeams(m);
    else if(m.type==="screen_orch") renderOrch(m);
    else if(m.type==="screen_detail") renderDetail(m);
    else if(m.type==="doc_html") handleDocHtml(m.rel, m.html, m.error);
    else if(m.type==="preview_state") handlePreviewState(m.running);
    else if(m.type==="disarm_all") disarmAll();  // panel ถูกซ่อน/สลับ tab (backend แจ้งมา) → เลิก arm ค้าง
    else if(m.type==="git_auto_result") handleAutoResult(m.path,m.message,m.gen);
    else if(m.type==="open_namemodal") openNameModal(m.default);
    else if(m.type==="name_result") nmResult(m);
  });
  post("ready");
</script></body></html>`;
}

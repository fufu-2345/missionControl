import * as cp from "node:child_process";

import * as vscode from "vscode";

import { ApiError, BACKEND_DISABLED, SERVER_URL, api, notifyBackendDisabled } from "../api";
import { isPortUp } from "../commands/mawServe";
import {
  PROJECT_STATE_KEY,
  getCurrentProjectId,
  onProjectChange,
  setCurrentProjectId,
} from "../projectState";
import { MONTHLY_CAP_KEY, computeUsage, localMonthKey, sumByPrefix } from "../usage";
import {
  TMUX_FMT,
  type TmuxSession,
  buildAttachCommand,
  isSafeSessionName,
  parseTmuxSessions,
} from "./sessions";
import { listSkills } from "./skills";

type Project = {
  id: string;
  name: string;
  created_at?: string;
  archived_at?: string | null;
};

// Singleton — only one Mission Control dashboard makes sense at a time.
// Cleared on onDidDispose so the next openDashboardPanel call creates a
// fresh one. Module-level so pushDashboardEvent (called from ws.on in
// extension.ts) can reach it without threading the reference through.
let _panel: vscode.WebviewPanel | undefined;
let _unsubProjectChange: (() => void) | undefined;
let _statusPollTimer: NodeJS.Timeout | undefined;

// Sessions panel state. _sessionTerminals reuses one editor terminal per tmux
// session (Task: click→attach); _lastSessionNames is the set we last showed the
// webview, used to validate attach requests.
const _sessionTerminals = new Map<string, vscode.Terminal>();
let _lastSessionNames = new Set<string>();
let _termCleanupRegistered = false;

const STATUS_POLL_MS = 10_000;

/**
 * Open (or reveal) the Mission Control dashboard — a full editor-area
 * webview that takes the place of the legacy cramped sidebar buttons.
 *
 * Sidebar is now a slim nav with status + project name + "Open Dashboard"
 * + a few links. The dashboard owns project picker, workflow actions,
 * sprint control, resources, and a live Recent Activity feed driven by
 * WS events mirrored via `pushDashboardEvent`.
 *
 * `projectId` is the active project at open time; the dashboard updates
 * it via `setCurrentProjectId` when the user changes the dropdown, which
 * propagates to api.ts (X-Project-Id header) + ws.ts (subscription).
 */
export function openDashboardPanel(
  context: vscode.ExtensionContext,
  projectId: string | null = null,
): vscode.WebviewPanel {
  if (_panel) {
    _panel.reveal();
    return _panel;
  }
  const panel = vscode.window.createWebviewPanel(
    "missioncontrol.dashboard",
    "Mission Control",
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  _panel = panel;

  // Belt-and-suspenders: if caller passed null, re-read at this exact moment.
  // Plan note: `if (!projectId) projectId = getCurrentProjectId();`
  const initialPid = projectId ?? getCurrentProjectId();

  // Offline→online self-heal state (bug-audit fix #1). At boot the dashboard
  // auto-opens while the backend is still loading BGE-M3, so /healthz answers
  // before /projects is ready → the project list + budget + skill cards fail
  // and stay stale forever because the 10s poll only refreshed /healthz.
  // We now re-fetch the data cards on the offline→online edge (or while the
  // project list hasn't loaded yet), mirroring sidebar.ts's self-heal.
  let lastOnline = false;
  let projectsLoaded = false;

  // Live cards can go stale from sources the dashboard never sees an event
  // for — budget from sprint spend, skill count from a toggle in the separate
  // Skills panel, memory_share from a curl. Refresh them every poll tick
  // (cheap GETs) so they self-heal within STATUS_POLL_MS (bug-audit #4/#5).
  const refreshLiveCards = async () => {
    await Promise.all([
      pushBudget(panel, context),
      pushSkillCount(panel),
      pushMemoryShare(panel),
    ]);
  };

  const refreshDataCards = async () => {
    projectsLoaded = await pushProjects(panel);
    await refreshLiveCards();
  };

  const pollTick = async () => {
    const online = await pushStatus(panel);
    await pushSessions(panel); // tmux is local — refresh regardless of maw/oracle
    if (online) {
      if (!lastOnline || !projectsLoaded) {
        await refreshDataCards(); // edge: also re-fetch the project list
      } else {
        await refreshLiveCards(); // steady: keep budget/skill/memshare fresh
      }
    }
    lastOnline = online;
  };

  panel.webview.html = renderHtml();

  // Cross-surface project sync — if the sidebar or some other code path
  // changes the project, push the new selection into the dashboard so its
  // dropdown stays in sync without a full /projects re-fetch.
  _unsubProjectChange = onProjectChange((pid) => {
    panel.webview.postMessage({ type: "current_project", current: pid });
  });

  panel.onDidDispose(() => {
    _panel = undefined;
    if (_unsubProjectChange) {
      _unsubProjectChange();
      _unsubProjectChange = undefined;
    }
    if (_statusPollTimer) {
      clearInterval(_statusPollTimer);
      _statusPollTimer = undefined;
    }
  });

  // One global listener: when a session's terminal closes, drop it from the
  // reuse map so the next click opens a fresh attached terminal.
  if (!_termCleanupRegistered) {
    _termCleanupRegistered = true;
    context.subscriptions.push(
      vscode.window.onDidCloseTerminal((t) => {
        for (const [k, v] of _sessionTerminals) {
          if (v === t) _sessionTerminals.delete(k);
        }
      }),
    );
  }

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (!msg || typeof msg.type !== "string") return;
    switch (msg.type) {
      case "ready": {
        // First load — push everything we have.
        lastOnline = await pushStatus(panel);
        await refreshDataCards();
        await pushSessions(panel);
        // Start the poller (one per panel lifetime). pollTick self-heals the
        // data cards if the backend was still booting when "ready" fired.
        if (!_statusPollTimer) {
          _statusPollTimer = setInterval(() => {
            void pollTick();
          }, STATUS_POLL_MS);
        }
        return;
      }
      case "refresh": {
        const online = await pushStatus(panel);
        lastOnline = online;
        await refreshDataCards();
        await pushSessions(panel);
        return;
      }
      case "attach_session": {
        const name = typeof msg.name === "string" ? msg.name : "";
        // Defense in depth: only attach to a name we actually listed, and that
        // passes the shell-safety whitelist.
        if (!_lastSessionNames.has(name) || !isSafeSessionName(name)) return;

        const existing = _sessionTerminals.get(name);
        if (existing && existing.exitStatus === undefined) {
          existing.show(false); // reuse — focus the already-open terminal
          return;
        }

        const term = vscode.window.createTerminal({
          name: "tmux: " + name,
          location: vscode.TerminalLocation.Editor,
        });
        _sessionTerminals.set(name, term);
        term.show(false);

        const command = buildAttachCommand(name);
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
        return;
      }
      case "kill_session": {
        const name = typeof msg.name === "string" ? msg.name : "";
        // Defense in depth: only kill a name we actually listed + whitelisted.
        if (!_lastSessionNames.has(name) || !isSafeSessionName(name)) return;
        const pick = await vscode.window.showWarningMessage(
          `Kill tmux session '${name}'? This closes all its windows.`,
          { modal: true },
          "Kill",
        );
        if (pick !== "Kill") return;
        await new Promise<void>((resolve) => {
          // execFile (no shell) — args passed as array, name already whitelisted.
          cp.execFile("tmux", ["kill-session", "-t", name], { timeout: 2000 }, () => resolve());
        });
        // Drop any reused attach-terminal for the now-dead session.
        const term = _sessionTerminals.get(name);
        if (term) {
          term.dispose();
          _sessionTerminals.delete(name);
        }
        await pushSessions(panel); // refresh the list (session is gone now)
        return;
      }
      case "run": {
        if (typeof msg.command === "string") {
          void vscode.commands.executeCommand(msg.command);
        }
        return;
      }
      case "select_project": {
        const pid = typeof msg.projectId === "string" ? msg.projectId : "";
        setCurrentProjectId(pid || null);
        await context.globalState.update(PROJECT_STATE_KEY, pid || null);
        // Budget + memory_share are per-project → re-fetch for the new pid.
        await Promise.all([pushBudget(panel, context), pushMemoryShare(panel)]);
        return;
      }
      case "toggle_memory_share": {
        const pid = getCurrentProjectId();
        if (!pid) {
          return;
        }
        try {
          await api<{ enabled: boolean }>(
            `/project/${encodeURIComponent(pid)}/memory_share`,
            { method: "POST", body: JSON.stringify({ enabled: !!msg.enabled }) },
          );
        } catch {
          // frontend-only build — backend disabled; swallow silently.
        }
        await pushMemoryShare(panel); // reflect server-of-truth
        return;
      }
      case "new_project": {
        await promptNewProject(panel, context);
        return;
      }
      case "close": {
        panel.dispose();
        return;
      }
    }
  });

  // Capture initial pid → push when webview signals "ready".
  // Set the project state so api.ts/ws.ts use it for the first /projects.
  if (initialPid) {
    setCurrentProjectId(initialPid);
  }

  return panel;
}

/**
 * Mirror a WS event into the dashboard's Recent Activity feed.
 * No-op when the dashboard isn't open — keeps the sidebar's status-bar
 * toasts + auto-opened panels working independently.
 */
export function pushDashboardEvent(event: string, data: unknown): void {
  _panel?.webview.postMessage({
    type: "ws_event",
    event,
    data,
    ts: Date.now(),
  });
}

function listTmuxSessions(): Promise<TmuxSession[]> {
  return new Promise((resolve) => {
    cp.execFile("tmux", ["list-sessions", "-F", TMUX_FMT], { timeout: 700 }, (err, stdout) => {
      // No server / error → treat as zero sessions (not a failure).
      resolve(err ? [] : parseTmuxSessions(stdout.toString()));
    });
  });
}

async function pushSessions(panel: vscode.WebviewPanel): Promise<void> {
  const sessions = await listTmuxSessions();
  _lastSessionNames = new Set(sessions.map((s) => s.name));
  panel.webview.postMessage({ type: "sessions", sessions });
}

async function pushStatus(panel: vscode.WebviewPanel): Promise<boolean> {
  // frontend-only build — no Mission Control backend. "online" now reflects the
  // local oracle/maw stack: green when maw (:3456) or oracle (:47778) answers.
  // The pollTick self-heal also keys off this, so the live cards refresh once
  // either server comes up.
  const [maw, oracle] = await Promise.all([isPortUp(3456), isPortUp(47778)]);
  const online = maw || oracle;
  panel.webview.postMessage({ type: "status", online });
  return online;
}

/** Returns true when the project list loaded successfully (used by the
 *  offline→online self-heal poll so a boot-time fetch failure recovers). */
async function pushProjects(panel: vscode.WebviewPanel): Promise<boolean> {
  // Frontend-only build: there is no /projects endpoint. Render the offline
  // placeholder ONCE and report "loaded" so the 10s poll settles into
  // refreshLiveCards() instead of re-posting an empty list every tick.
  if (BACKEND_DISABLED) {
    panel.webview.postMessage({
      type: "projects",
      projects: [],
      current: getCurrentProjectId(),
      error: "frontend-only build",
    });
    return true;
  }
  try {
    const resp = await api<{ active_id: string | null; projects: Project[] }>(
      "/projects",
    );
    const list = Array.isArray(resp?.projects) ? resp.projects : [];
    const live = list.filter((p) => !p.archived_at);
    // Self-heal a stale selection: if the active pid was archived/deleted out
    // of band it won't be in `live`, so drop it to null (in-memory). The
    // sidebar poll clears the persisted globalState value — null here just
    // stops the dropdown from highlighting a project that's no longer listed.
    const cur = getCurrentProjectId();
    if (cur && !live.some((p) => p.id === cur)) {
      setCurrentProjectId(null);
    }
    panel.webview.postMessage({
      type: "projects",
      projects: live,
      current: getCurrentProjectId(),
    });
    return true;
  } catch (err) {
    const message = err instanceof ApiError ? err.message : String(err);
    panel.webview.postMessage({
      type: "projects",
      projects: [],
      current: getCurrentProjectId(),
      error: message,
    });
    return false;
  }
}

async function pushBudget(
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext,
): Promise<void> {
  try {
    // Real Claude Code spend this calendar month, computed from local
    // transcripts (no backend). Cap is a user-set monthly target in globalState.
    const u = await computeUsage();
    const month = sumByPrefix(u, localMonthKey());
    const cap = context.globalState.get<number>(MONTHLY_CAP_KEY) ?? null;
    panel.webview.postMessage({
      type: "budget",
      spent_usd: month,
      cap_usd: cap,
      over_cap: cap != null && month > cap,
    });
  } catch {
    panel.webview.postMessage({
      type: "budget",
      spent_usd: 0,
      cap_usd: null,
      over_cap: false,
    });
  }
}

/** Push the per-project memory_share flag. The toggle requires an explicit
 *  project selection (the endpoint is /project/{pid}/...) — when no pid is
 *  selected we report hasProject:false so the UI disables the control. */
async function pushMemoryShare(panel: vscode.WebviewPanel): Promise<void> {
  const pid = getCurrentProjectId();
  if (!pid) {
    panel.webview.postMessage({
      type: "memory_share",
      hasProject: false,
      enabled: false,
    });
    return;
  }
  try {
    const r = await api<{ enabled: boolean }>(
      `/project/${encodeURIComponent(pid)}/memory_share`,
    );
    panel.webview.postMessage({
      type: "memory_share",
      hasProject: true,
      enabled: !!r.enabled,
    });
  } catch {
    panel.webview.postMessage({
      type: "memory_share",
      hasProject: false,
      enabled: false,
    });
  }
}

async function pushSkillCount(panel: vscode.WebviewPanel): Promise<void> {
  try {
    // Local: count ~/.claude/skills/*/SKILL.md off disk (same source the Skills
    // panel uses). They're all "active" on disk, so enabled == total.
    const n = listSkills().length;
    panel.webview.postMessage({ type: "skill_count", total: n, enabled: n });
  } catch {
    panel.webview.postMessage({ type: "skill_count", total: 0, enabled: 0 });
  }
}

async function promptNewProject(
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext,
): Promise<void> {
  const name = await vscode.window.showInputBox({
    title: "Mission Control — New Project",
    prompt: "ตั้งชื่อโปรเจกต์ใหม่",
    validateInput: (v) => (v.trim().length === 0 ? "name cannot be empty" : null),
  });
  if (!name) return;
  try {
    const project = await api<Project>("/project/new", {
      method: "POST",
      body: JSON.stringify({ name: name.trim() }),
    });
    setCurrentProjectId(project.id);
    await context.globalState.update(PROJECT_STATE_KEY, project.id);
    await pushProjects(panel);
  } catch {
    // frontend-only build — backend disabled; swallow silently.
    notifyBackendDisabled();
  }
}

function renderHtml(): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { height: 100%; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 24px;
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  .brand { display: flex; align-items: center; gap: 10px; }
  .brand .zap { font-size: 18px; }
  .brand h1 { font-size: 16px; margin: 0; font-weight: 600; }
  .topbar .actions { display: flex; align-items: center; gap: 10px; }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    border-radius: 11px;
    font-size: 11px;
    background: var(--vscode-editor-inactiveSelectionBackground);
  }
  .pill .dot { width: 8px; height: 8px; border-radius: 50%; background: #888; }
  .pill .dot.on { background: #3fb950; }
  .pill .dot.off { background: #f85149; }
  .icon-btn {
    background: transparent;
    color: var(--vscode-foreground);
    border: 1px solid var(--vscode-panel-border);
    padding: 4px 10px;
    border-radius: 3px;
    cursor: pointer;
    font-size: 11px;
  }
  .icon-btn:hover { background: var(--vscode-list-hoverBackground); }
  .container {
    flex: 1;
    overflow-y: auto;
    padding: 20px 28px 32px;
    max-width: 1100px;
    margin: 0 auto;
    width: 100%;
    box-sizing: border-box;
  }
  .group-label {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    opacity: 0.6;
    margin: 22px 0 10px;
  }
  .group-label.first { margin-top: 4px; }
  .card {
    background: var(--vscode-editor-inactiveSelectionBackground);
    border-radius: 6px;
    padding: 16px 18px;
  }
  .project-card { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .project-card select {
    flex: 1;
    min-width: 220px;
    padding: 8px 10px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: 3px;
    font-size: 13px;
  }
  .project-card .pid {
    font-family: var(--vscode-editor-font-family);
    font-size: 11px;
    opacity: 0.6;
    width: 100%;
    margin-top: 4px;
  }
  /* memory_share row inside the project card */
  .memshare {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid var(--vscode-panel-border);
    font-size: 12px;
  }
  .memshare .label { font-weight: 600; }
  .memshare .hint { opacity: 0.7; }
  .memshare.disabled { opacity: 0.5; }
  .toggle {
    position: relative; display: inline-block; width: 34px; height: 19px;
    flex-shrink: 0; cursor: pointer;
  }
  .toggle input { opacity: 0; width: 0; height: 0; }
  .toggle .slider {
    position: absolute; inset: 0; border-radius: 10px;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-panel-border); transition: background 0.15s;
  }
  .toggle .slider::before {
    content: ""; position: absolute; top: 1px; left: 1px;
    width: 15px; height: 15px; border-radius: 50%;
    background: var(--vscode-foreground); opacity: 0.5;
    transition: transform 0.15s, opacity 0.15s;
  }
  .toggle input:checked + .slider {
    background: var(--vscode-button-background);
    border-color: var(--vscode-button-background);
  }
  .toggle input:checked + .slider::before {
    transform: translateX(15px); background: var(--vscode-button-foreground); opacity: 1;
  }
  .toggle input:disabled + .slider { cursor: not-allowed; }
  .grid { display: grid; gap: 12px; }
  .grid.cols-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .grid.cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .grid.cols-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  @media (max-width: 760px) {
    .grid.cols-3, .grid.cols-4 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
  .tile {
    background: var(--vscode-editor-inactiveSelectionBackground);
    border: 1px solid transparent;
    border-radius: 6px;
    padding: 14px 16px;
    cursor: pointer;
    text-align: left;
    color: var(--vscode-foreground);
    font: inherit;
    transition: background 0.12s, border-color 0.12s;
  }
  .tile:hover {
    background: var(--vscode-list-hoverBackground);
    border-color: var(--vscode-focusBorder);
  }
  .tile.primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  .tile.primary:hover { background: var(--vscode-button-hoverBackground); }
  .tile .title { font-size: 13px; font-weight: 600; margin-bottom: 4px; }
  .tile .sub { font-size: 11px; opacity: 0.75; line-height: 1.4; }
  .tile.primary .sub { opacity: 0.9; }
  /* Non-functional in the frontend-only build (the backend was removed).
     Marked red + badged so it's obvious at a glance these controls do nothing
     here. They stay clickable only to surface the "disabled" explanation toast. */
  .dead {
    border-left: 3px solid var(--vscode-errorForeground, #f85149) !important;
    opacity: 0.6;
  }
  .tile.dead:hover {
    background: var(--vscode-editor-inactiveSelectionBackground);
    border-color: transparent;
    border-left-color: var(--vscode-errorForeground, #f85149);
    cursor: not-allowed;
  }
  .dead .title { color: var(--vscode-errorForeground, #f85149); }
  .badge-dead {
    display: inline-block;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--vscode-errorForeground, #f85149);
    border: 1px solid var(--vscode-errorForeground, #f85149);
    border-radius: 3px;
    padding: 0 5px;
    margin-left: 6px;
    vertical-align: middle;
  }
  .btn-row { display: flex; gap: 6px; }
  .feed {
    background: var(--vscode-textCodeBlock-background, rgba(0,0,0,.2));
    border-radius: 6px;
    padding: 10px 12px;
    max-height: 280px;
    overflow-y: auto;
    font-family: var(--vscode-editor-font-family);
    font-size: 12px;
    line-height: 1.5;
  }
  .feed .row { display: flex; gap: 10px; padding: 2px 0; }
  .feed .ts { opacity: 0.55; min-width: 64px; }
  .feed .ev {
    min-width: 160px;
    color: var(--vscode-textLink-foreground);
  }
  .feed .payload { opacity: 0.85; flex: 1; word-break: break-word; }
  .feed .empty { opacity: 0.55; }
  .feed-header { display: flex; align-items: center; justify-content: space-between; }
  .error-chip {
    color: var(--vscode-errorForeground, #f85149);
    font-size: 11px;
    margin-left: 8px;
  }
  .session-row { display: flex; align-items: center; gap: 10px; padding: 8px 6px; border-radius: 4px; cursor: pointer; }
  .session-row:hover { background: var(--vscode-list-hoverBackground); }
  .session-row .sdot { width: 8px; height: 8px; border-radius: 50%; background: #888; flex-shrink: 0; }
  .session-row .sdot.on { background: #3fb950; }
  .session-row .smeta { display: flex; flex-direction: column; min-width: 0; }
  .session-row .sname { font-size: 13px; font-weight: 600; }
  .session-row .ssub { font-size: 11px; opacity: 0.7; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .session-row .session-kill { margin-left: auto; flex-shrink: 0; background: transparent; border: none; color: var(--vscode-foreground); opacity: 0.35; cursor: pointer; font-size: 13px; line-height: 1; padding: 3px 7px; border-radius: 3px; }
  .session-row .session-kill:hover { opacity: 1; background: var(--vscode-inputValidation-errorBackground, #5a1d1d); color: #fff; }
  .sessions-empty { opacity: 0.6; font-size: 12px; padding: 6px; }
</style>
</head>
<body>
  <div class="topbar">
    <div class="brand">
      <span class="zap">⚡</span>
      <h1>Mission Control</h1>
    </div>
    <div class="actions">
      <span class="pill" id="statusPill"><span class="dot" id="dot"></span><span id="statusText">checking…</span></span>
      <button class="icon-btn" type="button" onclick="refresh()">Refresh</button>
    </div>
  </div>

  <div class="container">
    <div class="group-label first">Active Project <span class="badge-dead">ใช้ไม่ได้</span></div>
    <div class="card project-card dead">
      <select id="projectSelect"></select>
      <button class="icon-btn" type="button" onclick="newProject()">+ New project</button>
      <div class="pid" id="projectPid"></div>
      <div class="memshare disabled" id="memshare">
        <label class="toggle" title="Share agent memory across projects">
          <input type="checkbox" id="memshareInput" disabled onchange="toggleMemShare(this.checked)">
          <span class="slider"></span>
        </label>
        <span class="label">Share memory cross-project</span>
        <span class="hint" id="memshareHint">— recall lessons from all projects (default: isolated)</span>
      </div>
    </div>

    <div class="group-label">Sessions</div>
    <div class="card">
      <div id="sessionsList" class="sessions-empty">(loading…)</div>
    </div>

    <div class="group-label">Workflow</div>
    <div class="grid cols-3">
      <button class="tile primary" type="button" onclick="run('missioncontrol.claude')">
        <div class="title">Open Claude</div>
        <div class="sub">เลือก project → เปิด Claude ใน tmux (ปิด tab ไม่ตาย)</div>
      </button>
      <button class="tile" type="button" onclick="run('missioncontrol.terminal')">
        <div class="title">Open Terminal</div>
        <div class="sub">เปิด CLI (bash) ที่ soulbrew root — รัน maw/git</div>
      </button>
      <button class="tile primary" type="button" onclick="run('missioncontrol.startOrchestrator')">
        <div class="title">Start Orchestrator</div>
        <div class="sub">เลือกทีม → ปลุก orchestrator + attach (code ล้วน ไม่ผ่าน LLM, ทันที)</div>
      </button>
      <button class="tile" type="button" onclick="run('missioncontrol.status')">
        <div class="title">View Status</div>
        <div class="sub" id="statusSub">maw · oracle · git — เช็คสถานะ local</div>
      </button>
      <button class="tile" type="button" onclick="run('missioncontrol.budget')">
        <div class="title">Budget</div>
        <div class="sub" id="budgetSub">$0.00 spent</div>
      </button>
    </div>

    <div class="group-label">Sprint Control · disabled (needs backend)</div>
    <div class="grid cols-2">
      <button class="tile dead" type="button" onclick="run('missioncontrol.approve')">
        <div class="title">Approve ideas <span class="badge-dead">ใช้ไม่ได้</span></div>
        <div class="sub" id="approveSub">ปิดใช้งานใน frontend-only build</div>
      </button>
      <button class="tile dead" type="button" onclick="run('missioncontrol.pause')">
        <div class="title">Pause / Resume <span class="badge-dead">ใช้ไม่ได้</span></div>
        <div class="sub">ปิดใช้งานใน frontend-only build</div>
      </button>
    </div>

    <div class="group-label">Resources</div>
    <div class="grid cols-4">
      <button class="tile" type="button" onclick="run('missioncontrol.skills')">
        <div class="title">Skills</div>
        <div class="sub" id="skillsSub">view</div>
      </button>
      <button class="tile" type="button" onclick="run('missioncontrol.config')">
        <div class="title">Config</div>
        <div class="sub">แก้ ~/.mission-control/config.json</div>
      </button>
      <button class="tile dead" type="button" onclick="run('missioncontrol.setup')">
        <div class="title">Setup <span class="badge-dead">ใช้ไม่ได้</span></div>
        <div class="sub">ปิดใช้งาน (frontend-only)</div>
      </button>
      <button class="tile dead" type="button" onclick="run('missioncontrol.reset')">
        <div class="title">Reset <span class="badge-dead">ใช้ไม่ได้</span></div>
        <div class="sub">ปิดใช้งาน (frontend-only)</div>
      </button>
    </div>

    <div class="group-label feed-header">
      <span>Recent Activity <span class="badge-dead">ไม่มี live events</span></span>
      <button class="icon-btn" type="button" onclick="clearFeed()">Clear</button>
    </div>
    <div class="feed" id="feed">
      <div class="empty">(ไม่มี live events — ต้องมี backend/WebSocket)</div>
    </div>
  </div>

<script>
  const vscode = acquireVsCodeApi();
  const FEED_CAP = 50;
  const feedRows = [];

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function fmtTime(ts) {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, "0");
    return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
  }
  function fmtPayload(event, data) {
    if (!data || typeof data !== "object") return String(data ?? "");
    try {
      // Trim noisy events to a 1-line summary.
      if (event === "agent_progress") {
        return (data.agent ?? "?") + " — " + (data.status ?? "");
      }
      if (event === "sprint_a_heartbeat" || event === "build_heartbeat") {
        const elapsed = Math.floor(data.elapsed_s ?? 0);
        const mins = Math.floor(elapsed / 60);
        const secs = elapsed % 60;
        return (data.agent ?? data.title ?? data.task_id ?? "?") + " — " + mins + ":" + String(secs).padStart(2, "0");
      }
      if (event === "ideas_ready") {
        return (data.ideas?.length ?? 0) + " ideas";
      }
      if (event === "pr_ready") {
        return (data.title ?? data.task_id ?? "?") + " — " + (data.verdict?.verdict ?? "?");
      }
      if (event === "sprint_done") {
        return "type=" + (data.type ?? "?") + ", prs=" + (data.prs?.length ?? 0);
      }
      if (event === "budget_exceeded") {
        return "$" + (data.spent_usd?.toFixed?.(4) ?? "?") + " / $" + (data.cap_usd?.toFixed?.(2) ?? "?");
      }
      // Default: small JSON snippet.
      const s = JSON.stringify(data);
      return s.length > 180 ? s.slice(0, 180) + "…" : s;
    } catch {
      return "";
    }
  }
  function renderFeed() {
    const root = document.getElementById("feed");
    if (!feedRows.length) {
      root.innerHTML = '<div class="empty">(ไม่มี live events — ต้องมี backend/WebSocket)</div>';
      return;
    }
    root.innerHTML = feedRows.map((r) =>
      '<div class="row">'
      + '<span class="ts">' + escapeHtml(fmtTime(r.ts)) + '</span>'
      + '<span class="ev">' + escapeHtml(r.event) + '</span>'
      + '<span class="payload">' + escapeHtml(fmtPayload(r.event, r.data)) + '</span>'
      + '</div>'
    ).join('');
    // Keep scroll pinned to the top (newest is row 0).
    root.scrollTop = 0;
  }
  function pushFeed(event, data, ts) {
    // Collapse consecutive same-event heartbeats from the same agent — replace top row in place.
    if (feedRows.length > 0) {
      const top = feedRows[0];
      const sameHeartbeat =
        (event === "sprint_a_heartbeat" || event === "build_heartbeat" || event === "agent_progress") &&
        top.event === event &&
        ((data && top.data && (data.agent ?? data.task_id) === (top.data.agent ?? top.data.task_id)));
      if (sameHeartbeat) {
        feedRows[0] = { event, data, ts };
        renderFeed();
        return;
      }
    }
    feedRows.unshift({ event, data, ts });
    if (feedRows.length > FEED_CAP) feedRows.length = FEED_CAP;
    renderFeed();
  }

  function setSelectedProject(pid) {
    const sel = document.getElementById("projectSelect");
    sel.value = pid || "";
    document.getElementById("projectPid").textContent = pid ? "pid: " + pid : "";
  }

  function renderSessions(sessions) {
    const root = document.getElementById("sessionsList");
    if (!sessions || !sessions.length) {
      root.className = "sessions-empty";
      root.textContent = "(no tmux sessions running)";
      return;
    }
    root.className = "";
    root.innerHTML = sessions.map((s) =>
      '<div class="session-row" data-name="' + escapeHtml(s.name) + '">'
      + '<span class="sdot ' + (s.attached ? 'on' : '') + '"></span>'
      + '<span class="smeta">'
      + '<span class="sname">' + escapeHtml(s.name) + '</span>'
      + '<span class="ssub">' + escapeHtml(s.windows + ' win · ' + s.cmd + '  ' + s.cwd) + '</span>'
      + '</span>'
      + '<button class="session-kill" title="Kill session" data-kill="' + escapeHtml(s.name) + '">✕</button>'
      + '</div>'
    ).join('');
    root.querySelectorAll('.session-row').forEach((el) => {
      el.addEventListener('click', () => {
        vscode.postMessage({ type: 'attach_session', name: el.dataset.name });
      });
    });
    root.querySelectorAll('.session-kill').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation(); // don't trigger the row's attach click
        vscode.postMessage({ type: 'kill_session', name: btn.dataset.kill });
      });
    });
  }

  function renderProjects(projects, current, error) {
    const sel = document.getElementById("projectSelect");
    const opts = ['<option value="">(active project)</option>']
      .concat(projects.map((p) =>
        '<option value="' + escapeHtml(p.id) + '">' + escapeHtml(p.name || p.id) + '</option>'
      ));
    if (error) {
      sel.innerHTML = '<option value="">(backend offline)</option>' + opts.join("");
    } else {
      sel.innerHTML = opts.join("");
    }
    setSelectedProject(current);
  }

  function run(command) { vscode.postMessage({ type: "run", command }); }
  function refresh() { vscode.postMessage({ type: "refresh" }); }
  function newProject() { vscode.postMessage({ type: "new_project" }); }
  function toggleMemShare(enabled) {
    vscode.postMessage({ type: "toggle_memory_share", enabled });
  }
  function clearFeed() {
    feedRows.length = 0;
    renderFeed();
  }

  function renderMemShare(m) {
    const row = document.getElementById("memshare");
    const input = document.getElementById("memshareInput");
    const hint = document.getElementById("memshareHint");
    if (!m.hasProject) {
      row.className = "memshare disabled";
      input.disabled = true;
      input.checked = false;
      hint.textContent = "— select a project to toggle";
      return;
    }
    row.className = "memshare";
    input.disabled = false;
    input.checked = !!m.enabled;
    hint.textContent = m.enabled
      ? "ON — recall sees ALL projects' lessons"
      : "OFF — recall isolated to this project (default)";
  }

  document.getElementById("projectSelect").addEventListener("change", (e) => {
    const projectId = e.target.value || "";
    vscode.postMessage({ type: "select_project", projectId });
    document.getElementById("projectPid").textContent = projectId ? "pid: " + projectId : "";
  });

  window.addEventListener("message", (event) => {
    const m = event.data;
    if (!m || typeof m.type !== "string") return;
    if (m.type === "status") {
      document.getElementById("dot").className = "dot " + (m.online ? "on" : "off");
      document.getElementById("statusText").textContent = m.online ? "Running" : "Stopped";
    } else if (m.type === "projects") {
      renderProjects(m.projects || [], m.current, m.error);
    } else if (m.type === "current_project") {
      setSelectedProject(m.current);
    } else if (m.type === "budget") {
      const sub = document.getElementById("budgetSub");
      const spent = (m.spent_usd ?? 0).toFixed(2);
      const cap = m.cap_usd ? " / $" + m.cap_usd.toFixed(2) : "";
      sub.textContent = "$" + spent + cap + (m.over_cap ? " (over)" : "");
    } else if (m.type === "skill_count") {
      const sub = document.getElementById("skillsSub");
      sub.textContent = (m.enabled ?? 0) + " active / " + (m.total ?? 0) + " total";
    } else if (m.type === "memory_share") {
      renderMemShare(m);
    } else if (m.type === "sessions") {
      renderSessions(m.sessions || []);
    } else if (m.type === "ws_event") {
      pushFeed(m.event, m.data, m.ts);
    }
  });

  // Tell host we're ready for initial data.
  vscode.postMessage({ type: "ready" });
</script>
</body>
</html>`;
}

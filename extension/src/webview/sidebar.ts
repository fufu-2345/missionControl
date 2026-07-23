import * as vscode from "vscode";

import { ApiError, SERVER_URL, api } from "../api";
import {
  PROJECT_STATE_KEY,
  getCurrentProjectId,
  onProjectChange,
  setCurrentProjectId,
} from "../projectState";
import { isMawUp } from "../commands/mawServe";
import { scanLocalhosts, type ProjectGroup } from "../commands/localhostScan";
import { stopProjectLocalhosts } from "../commands/localhostStop";
import { openDashboardPanel } from "./dashboard";

const POLL_MS = 10_000;
const VIEW_ID = "missioncontrol.panel";

type Project = {
  id: string;
  name: string;
  created_at?: string;
  archived_at?: string | null;
};

// Module-level — resets on every extension reload. We auto-open the
// dashboard once per session AFTER setup completes (or right away if
// setup was already done). NOT persisted in globalState — re-opening
// VS Code should land the user back on the dashboard. The singleton
// guard inside openDashboardPanel makes accidental double-calls a no-op
// anyway, so this is just to avoid stealing focus from the editor on
// every render() pass.
let dashboardAutoOpened = false;

/**
 * Activity-bar sidebar for Mission Control. Two states:
 *
 *   first run  → only a Setup button (no other controls), until setup is done.
 *   ready      → the normal Run/Control panel + live backend status; no Setup.
 *
 * "Setup done" is remembered via SecretStorage `github_token` (set by a
 * successful /setup), so it persists across reloads and machines stay set up.
 * The provider owns the healthz poll and swaps the HTML when the state flips.
 *
 * Project picker: in the ready state, a dropdown at the top lets the user
 * switch between projects. Selection persists in `context.globalState` and
 * propagates through `projectState` to api.ts (X-Project-Id header) and ws.ts
 * (per-project WS subscription).
 */
export class SidebarProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private timer?: NodeJS.Timeout;
  private mawTimer?: NodeJS.Timeout; // polls :3456 to keep the maw-ui toggle live
  private lhTimer?: NodeJS.Timeout; // polls localhost servers for the Localhosts section
  private renderedSetup?: boolean; // last-rendered "needs setup" flag
  private lastOnline?: boolean; // for offline→online transition detection
  private projectsLoaded = false; // true once /projects fetched at least once
  private unsubProjectChange?: () => void;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };

    view.webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type === "run" && typeof msg.command === "string") {
        await vscode.commands.executeCommand(msg.command);
        // A command may have just completed setup → re-evaluate which screen
        // to show (first-run Setup vs the full panel).
        await this.render();
        // The maw-ui toggle just flipped state → refresh the button label.
        await this.pushMaw();
      } else if (msg?.type === "ready") {
        await this.tick();
        await this.pushProjectList();
        await this.pushMaw();
        await this.pushLocalhosts();
      } else if (msg?.type === "open_dashboard") {
        openDashboardPanel(this.context, getCurrentProjectId());
      } else if (msg?.type === "refreshProjects") {
        await this.pushProjectList();
      } else if (msg?.type === "refreshLocalhosts") {
        await this.pushLocalhosts();
      } else if (msg?.type === "openLocalhost" && typeof msg.port === "number") {
        void vscode.env.openExternal(
          vscode.Uri.parse(`http://localhost:${msg.port}`),
        );
      } else if (msg?.type === "stopProject" && typeof msg.project === "string") {
        await stopProjectLocalhosts(msg.project);
        await this.pushLocalhosts();
      }
    });

    // Re-sync whenever the active pid changes (e.g. a sibling component called
    // setCurrentProjectId, or a fresh /project/new returned a new id). We
    // re-fetch the full list (not just the selection) because a *new* project
    // won't be in the webview's cached list yet — without the refetch the
    // label would show the raw pid until the next 10s tick (bug-audit: label
    // lag). pushProjectList swallows its own errors, so this is safe to fire
    // on every change.
    this.unsubProjectChange = onProjectChange(() => {
      void this.pushProjectList();
    });

    void this.render();
    // Frontend-only build: no backend health poll. The only recurring probe is
    // a cheap local TCP check of :3456 so the maw-ui toggle stays in sync even
    // when maw serve is started/stopped outside the extension.
    this.mawTimer = setInterval(() => void this.pushMaw(), 5000);
    this.lhTimer = setInterval(() => void this.pushLocalhosts(), POLL_MS);
    view.onDidDispose(() => {
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      if (this.mawTimer) clearInterval(this.mawTimer);
      this.mawTimer = undefined;
      if (this.lhTimer) clearInterval(this.lhTimer);
      this.lhTimer = undefined;
      this.unsubProjectChange?.();
      this.unsubProjectChange = undefined;
    });
  }

  /** Setup is complete once EITHER a GitHub token has been stored by /setup
   *  OR the user explicitly clicked "Skip for now" (globalState flag).
   *  The flag lets users use Mission Control without a GitHub token (local
   *  build + review still work; PR open/merge will fail until they re-run
   *  /setup and provide one).
   */
  private async needsSetup(): Promise<boolean> {
    if (await this.context.secrets.get("github_token")) return false;
    if (this.context.globalState.get<boolean>("missioncontrol.setupCompleted")) return false;
    return true;
  }

  /** Rebuild the webview HTML only when the first-run/ready state flips. */
  private async render(): Promise<void> {
    if (!this.view) return;
    const needsSetup = await this.needsSetup();
    if (needsSetup !== this.renderedSetup) {
      this.renderedSetup = needsSetup;
      this.view.webview.html = needsSetup ? this.setupHtml() : this.panelHtml();
    }
    await this.tick();
    if (!needsSetup) {
      await this.pushProjectList();
      // Auto-open the dashboard ONCE per session once setup is done.
      // This is what makes the page-mode UX feel right — user lands on
      // the full editor-area dashboard instead of having to remember to
      // run a command. dashboardAutoOpened is module-level so it resets
      // on extension reload (which is what we want).
      if (!dashboardAutoOpened) {
        dashboardAutoOpened = true;
        openDashboardPanel(this.context, getCurrentProjectId());
      }
    }
  }

  private async tick(): Promise<void> {
    if (this.renderedSetup) return; // first-run screen has no status dot
    // Frontend-only build: there is no backend to poll. Render the "off"
    // status immediately and never attempt a /healthz fetch or reconnect.
    const online = false;
    this.view?.webview.postMessage({ type: "status", online });
    this.lastOnline = online;
  }

  /** Probe :3456 and tell the webview whether maw ui is up, so the toggle
   *  button can label itself Start vs Stop. Panel (ready) state only. */
  private async pushMaw(): Promise<void> {
    if (!this.view || this.renderedSetup !== false) return;
    const up = await isMawUp();
    this.view.webview.postMessage({ type: "maw", up });
  }

  /** Scan localhost servers grouped by project and push them to the webview.
   *  Ready (panel) state only. Never throws — an empty list renders "none". */
  private async pushLocalhosts(): Promise<void> {
    if (!this.view || this.renderedSetup !== false) return;
    let groups: ProjectGroup[] = [];
    try {
      groups = scanLocalhosts();
    } catch {
      groups = [];
    }
    this.view.webview.postMessage({ type: "localhosts", groups });
  }

  // ── Project picker plumbing ──────────────────────────────────────────────

  /** Fetch /projects and push the list (+ current selection) to the webview. */
  private async pushProjectList(): Promise<void> {
    if (!this.view || this.renderedSetup) return;
    try {
      // Backend shape: {active_id: str|null, projects: ProjectResponse[]}.
      // Unwrap .projects — destructuring the array directly would call
      // .filter on the wrapper object → TypeError → catch branch → dropdown
      // stuck at "(backend offline)" even when backend is up. That's the
      // exact bug that hid newly-created projects from the picker.
      const resp = await api<{ active_id: string | null; projects: Project[] }>(
        "/projects",
      );
      const list = Array.isArray(resp?.projects) ? resp.projects : [];
      this.projectsLoaded = true;
      const live = list.filter((p) => !p.archived_at);
      await this.healStaleSelection(live);
      this.view.webview.postMessage({
        type: "projects",
        projects: live,
        current: getCurrentProjectId(),
      });
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      // Backend down → empty list. The dropdown shows "(backend offline)"
      // and the user just gets the legacy single-project behavior. tick()
      // retries this fetch once the next /healthz succeeds, so the dropdown
      // self-heals when the backend finishes its BGE-M3 startup.
      this.view.webview.postMessage({
        type: "projects",
        projects: [],
        current: getCurrentProjectId(),
        error: msg,
      });
    }
  }

  /** If the active pid points at a project that no longer exists in the live
   *  (non-archived) list — archived or hard-deleted out of band via the API —
   *  drop the stale selection so the dropdown + header label don't desync.
   *  null = fall back to the backend's global active project (legacy).
   *
   *  In-memory state and the persisted globalState value are checked
   *  independently so this self-heals regardless of which surface (sidebar
   *  poll vs dashboard) reset the in-memory value first — otherwise a stale
   *  pid could linger in globalState and resurrect on the next reload. */
  private async healStaleSelection(live: Project[]): Promise<void> {
    const isStale = (id: string | null): boolean =>
      !!id && !live.some((p) => p.id === id);
    if (isStale(getCurrentProjectId())) setCurrentProjectId(null);
    const persisted = this.context.globalState.get<string | null>(
      PROJECT_STATE_KEY,
      null,
    );
    if (isStale(persisted)) {
      await this.context.globalState.update(PROJECT_STATE_KEY, null);
    }
  }

  private head(): string {
    return `<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  html, body { height: 100%; }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 10px; box-sizing: border-box; }
  .status { display: flex; align-items: center; gap: 6px; font-size: 12px; padding: 2px 4px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--vscode-descriptionForeground); }
  .dot.on { background: #3fb950; }
  .dot.off { background: #f85149; }
  .project-label { font-size: 12px; padding: 4px 4px 10px; opacity: 0.85; border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 10px; word-break: break-all; }
  .project-label .name { font-weight: 600; }
  .nav-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; opacity: 0.6; margin: 14px 0 4px 2px; }
  .btn { display: block; width: 100%; text-align: left; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 6px 10px; border-radius: 3px; cursor: pointer; margin-bottom: 4px; font-size: 13px; }
  .btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .btn.on { background: rgba(63,185,80,0.16); color: #3fb950; }
  .btn.on:hover { background: rgba(63,185,80,0.24); }
  .btn.primary { text-align: center; background: var(--vscode-button-background); color: var(--vscode-button-foreground); font-weight: 600; padding: 9px 14px; font-size: 13px; margin: 6px 0 4px; }
  .btn.primary:hover { background: var(--vscode-button-hoverBackground); }
  /* First-run hero — fills the panel, centered like the Claude Code welcome. */
  .hero { box-sizing: border-box; min-height: calc(100vh - 20px); display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 24px 18px; }
  .hero .logo { font-size: 44px; line-height: 1; margin-bottom: 20px; }
  .hero h2 { margin: 0 0 10px; font-size: 18px; font-weight: 600; }
  .hero p { margin: 0 0 26px; font-size: 13px; opacity: 0.7; line-height: 1.6; max-width: 260px; }
  .hero .btn.primary { width: auto; min-width: 200px; padding: 9px 16px; font-size: 14px; }
  .lh-head { display: flex; justify-content: space-between; align-items: center; }
  .lh-refresh { cursor: pointer; opacity: 0.6; text-transform: none; letter-spacing: 0; }
  .lh-refresh:hover { opacity: 1; }
  .lh-empty { font-size: 12px; opacity: 0.55; padding: 4px 2px; }
  .lh-group { margin-bottom: 8px; }
  .lh-group-head { display: flex; justify-content: space-between; align-items: center; font-size: 12px; font-weight: 600; padding: 2px; }
  .lh-stop { cursor: pointer; color: #f85149; font-size: 11px; opacity: 0.85; }
  .lh-stop:hover { opacity: 1; }
  .lh-row { display: flex; justify-content: space-between; align-items: center; font-size: 12px; padding: 2px 2px 2px 8px; opacity: 0.9; }
  .lh-open { cursor: pointer; color: var(--vscode-textLink-foreground); }
  .lh-open:hover { text-decoration: underline; }
</style>`;
  }

  /** First-run: a single Setup button, nothing else. */
  private setupHtml(): string {
    return `<!DOCTYPE html><html><head>${this.head()}</head><body>
  <div class="hero">
    <div class="logo">⚡</div>
    <h2>Mission Control</h2>
    <p>Frontend-only build<br>เปิด Claude Code chat ในจอหลัก</p>
    <button class="btn primary" data-cmd="missioncontrol.claude">Open Claude</button>
    <button class="btn primary" data-cmd="missioncontrol.setup">Setup</button>
  </div>
<script>
  const vscode = acquireVsCodeApi();
  document.querySelectorAll('.btn[data-cmd]').forEach((b) =>
    b.addEventListener('click', () =>
      vscode.postMessage({ type: 'run', command: b.dataset.cmd })));
  vscode.postMessage({ type: 'ready' });
</script>
</body></html>`;
  }

  /** Ready: slim nav — status dot + project name label + Open Dashboard
   *  + 4 nav links. All heavy actions (Start/Status/Budget/Approve/Pause)
   *  live on the dashboard now; sidebar is just navigation + state badge. */
  private panelHtml(): string {
    return `<!DOCTYPE html><html><head>${this.head()}</head><body>
  <button class="btn primary" id="openDashboard">Open Dashboard</button>
  <button class="btn primary" data-cmd="missioncontrol.claude">Open Claude</button>
  <button class="btn primary" data-cmd="missioncontrol.terminal">Open Terminal</button>
  <button class="btn primary" data-cmd="missioncontrol.orchestratorContinue">📁 Projects</button>
  <button class="btn" id="mawToggle" data-cmd="missioncontrol.mawToggle">maw ui…</button>
  <button class="btn" data-cmd="missioncontrol.skills">Skills</button>
  <button class="btn" data-cmd="missioncontrol.accounts">Accounts</button>
  <button class="btn" data-cmd="missioncontrol.settings">Settings</button>

  <div class="nav-label lh-head">
    <span>Localhosts</span>
    <span id="lhRefresh" class="lh-refresh">refresh</span>
  </div>
  <div id="localhosts"><div class="lh-empty">scanning…</div></div>

<script>
  const vscode = acquireVsCodeApi();

  document.querySelectorAll('.btn[data-cmd]').forEach((b) => {
    b.addEventListener('click', () =>
      vscode.postMessage({ type: 'run', command: b.dataset.cmd }));
  });
  document.getElementById('openDashboard').addEventListener('click', () => {
    vscode.postMessage({ type: 'open_dashboard' });
  });
  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function renderLocalhosts(groups) {
    const box = document.getElementById('localhosts');
    if (!box) return;
    if (!groups || !groups.length) {
      box.innerHTML = '<div class="lh-empty">no servers running</div>';
      return;
    }
    box.innerHTML = groups.map((g) => {
      const rows = g.entries.map((e) =>
        '<div class="lh-row"><span class="lh-open" data-port="' + e.port + '">:' +
        e.port + '  ' + esc(e.role) + '</span></div>').join('');
      return '<div class="lh-group"><div class="lh-group-head"><span>' +
        esc(g.project) + '</span><span class="lh-stop" data-project="' +
        esc(g.project) + '">Stop all</span></div>' + rows + '</div>';
    }).join('');
  }
  document.getElementById('localhosts').addEventListener('click', (ev) => {
    const open = ev.target.closest('.lh-open');
    if (open) {
      vscode.postMessage({ type: 'openLocalhost', port: Number(open.dataset.port) });
      return;
    }
    const stop = ev.target.closest('.lh-stop');
    if (stop) {
      vscode.postMessage({ type: 'stopProject', project: stop.dataset.project });
    }
  });
  document.getElementById('lhRefresh').addEventListener('click', () => {
    vscode.postMessage({ type: 'refreshLocalhosts' });
  });

  // Live state pushes from the extension: maw-ui toggle + Localhosts list.
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m) return;
    if (m.type === 'maw') {
      const b = document.getElementById('mawToggle');
      if (!b) return;
      b.textContent = m.up ? 'Stop maw ui' : 'Start maw ui';
      b.classList.toggle('on', !!m.up);
    } else if (m.type === 'localhosts') {
      renderLocalhosts(m.groups);
    }
  });
  vscode.postMessage({ type: 'ready' });
</script>
</body></html>`;
  }
}

export function registerSidebar(context: vscode.ExtensionContext): void {
  const provider = new SidebarProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider),
  );
}

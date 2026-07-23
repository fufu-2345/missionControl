import * as vscode from "vscode";

import { scanLocalhosts, type ProjectGroup } from "../commands/localhostScan";
import { stopProjectLocalhosts } from "../commands/localhostStop";

// Full editor-area panel that lists running localhost dev servers grouped by
// project. Mirrors the singleton-panel pattern of webview/accounts.ts: one
// _panel at a time, a display-ready postMessage, a message switch, and a 10s
// poll so the list self-heals as servers start/stop. Detection + kill logic is
// reused from commands/localhostScan.ts + commands/localhostStop.ts.

let _panel: vscode.WebviewPanel | undefined;
let _pollTimer: NodeJS.Timeout | undefined;

const POLL_MS = 10_000;

function pushGroups(panel: vscode.WebviewPanel): void {
  let groups: ProjectGroup[] = [];
  try {
    groups = scanLocalhosts();
  } catch {
    groups = [];
  }
  void panel.webview.postMessage({ type: "localhosts", groups });
}

export function openLocalhostsPanel(): vscode.WebviewPanel {
  if (_panel) {
    _panel.reveal();
    return _panel;
  }
  const panel = vscode.window.createWebviewPanel(
    "missioncontrol.localhosts",
    "Localhosts",
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  _panel = panel;

  panel.onDidDispose(() => {
    _panel = undefined;
    if (_pollTimer) clearInterval(_pollTimer);
    _pollTimer = undefined;
  });

  panel.webview.html = renderShell();

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (!msg || typeof msg.type !== "string") return;
    switch (msg.type) {
      case "ready":
      case "refresh":
        pushGroups(panel);
        return;
      case "open":
        if (typeof msg.port === "number") {
          void vscode.env.openExternal(
            vscode.Uri.parse(`http://localhost:${msg.port}`),
          );
        }
        return;
      case "stop":
        if (typeof msg.project === "string") {
          await stopProjectLocalhosts(msg.project);
          pushGroups(panel);
        }
        return;
    }
  });

  _pollTimer = setInterval(() => {
    if (_panel) pushGroups(_panel);
  }, POLL_MS);

  return panel;
}

function renderShell(): string {
  return `<!DOCTYPE html><html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 20px 24px; box-sizing: border-box; }
  .head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 18px; }
  .head h1 { font-size: 20px; font-weight: 600; margin: 0; }
  .btn { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; }
  .btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .btn.stop { color: #f85149; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 14px; }
  .card { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 14px 16px; }
  .card-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
  .card-head .name { font-size: 15px; font-weight: 600; word-break: break-all; }
  .row { display: flex; align-items: center; gap: 10px; padding: 7px 0; border-top: 1px solid var(--vscode-panel-border); }
  .row:first-of-type { border-top: none; }
  .port { font-variant-numeric: tabular-nums; font-weight: 600; min-width: 58px; }
  .role { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.6; min-width: 34px; }
  .url { color: var(--vscode-textLink-foreground); cursor: pointer; font-size: 13px; }
  .url:hover { text-decoration: underline; }
  .empty { opacity: 0.55; font-size: 14px; padding: 40px 0; text-align: center; }
</style></head><body>
  <div class="head">
    <h1>Localhosts</h1>
    <button class="btn" id="refresh">Refresh</button>
  </div>
  <div id="content"><div class="empty">scanning…</div></div>
<script>
  const vscode = acquireVsCodeApi();
  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function render(groups) {
    const box = document.getElementById('content');
    if (!groups || !groups.length) {
      box.innerHTML = '<div class="empty">No servers running</div>';
      return;
    }
    box.className = 'grid';
    box.innerHTML = groups.map((g) => {
      const rows = g.entries.map((e) =>
        '<div class="row"><span class="port">:' + e.port + '</span>' +
        '<span class="role">' + esc(e.role) + '</span>' +
        '<span class="url" data-port="' + e.port + '">localhost:' + e.port + '</span></div>').join('');
      return '<div class="card"><div class="card-head">' +
        '<span class="name">' + esc(g.project) + '</span>' +
        '<button class="btn stop" data-project="' + esc(g.project) + '">Stop all</button>' +
        '</div>' + rows + '</div>';
    }).join('');
  }
  document.getElementById('content').addEventListener('click', (ev) => {
    const url = ev.target.closest('.url');
    if (url) { vscode.postMessage({ type: 'open', port: Number(url.dataset.port) }); return; }
    const stop = ev.target.closest('.btn.stop');
    if (stop) { vscode.postMessage({ type: 'stop', project: stop.dataset.project }); }
  });
  document.getElementById('refresh').addEventListener('click', () =>
    vscode.postMessage({ type: 'refresh' }));
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m && m.type === 'localhosts') render(m.groups);
  });
  vscode.postMessage({ type: 'ready' });
</script>
</body></html>`;
}

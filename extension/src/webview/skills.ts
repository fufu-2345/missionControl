import * as vscode from "vscode";

import { api, notifyBackendDisabled } from "../api";

export type SkillSummary = {
  name: string;
  description: string;
  path: string;
  agents: string[];
  category: string | null;
  enabled: boolean;
};

export type SkillDetail = SkillSummary & { body: string };

export type PendingSkill = {
  pending_id: string;
  name: string;
  description: string;
  agents: string[];
  category: string | null;
  source: string | null;
  body?: string | null;
};

// Singleton — only one Skills panel makes sense at a time. Cleared on
// onDidDispose so the next openSkillsPanel call creates a fresh one.
// On dev hot-reload the module unloads and this resets to undefined.
let _panel: vscode.WebviewPanel | undefined;

/**
 * Open (or reveal) the Skills viewer panel.
 *
 * `projectId` is captured at open time and sent as `X-Project-Id` on every
 * /skills GET so a mid-panel project switch doesn't misroute fetches.
 * Skills are global on the backend, but we preserve the header for parity
 * with other webviews.
 */
export function openSkillsPanel(
  projectId: string | null = null,
): vscode.WebviewPanel {
  if (_panel) {
    _panel.reveal();
    return _panel;
  }
  const panel = vscode.window.createWebviewPanel(
    "missioncontrol.skills",
    "Mission Control — Skills",
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  _panel = panel;
  panel.onDidDispose(() => {
    _panel = undefined;
  });

  const pidHeaders: Record<string, string> = projectId
    ? { "X-Project-Id": projectId }
    : {};

  panel.webview.html = renderShell();
  void loadList(panel, pidHeaders);
  void loadPending(panel, pidHeaders);

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg?.type === "close") {
      panel.dispose();
      return;
    }
    if (msg?.type === "reload") {
      await loadList(panel, pidHeaders);
      await loadPending(panel, pidHeaders);
      return;
    }
    if (msg?.type === "approve_pending" && typeof msg.pendingId === "string") {
      try {
        const r = await api<{ ok: boolean; name?: string; reason?: string }>(
          `/skills/pending/${encodeURIComponent(msg.pendingId)}/approve`,
          { method: "POST", headers: pidHeaders },
        );
        if (r.ok) {
          vscode.window.showInformationMessage(
            `Mission Control: approved skill '${r.name ?? msg.pendingId}'`,
          );
        } else {
          vscode.window.showWarningMessage(
            `Mission Control: skill not written — ${r.reason ?? "may already exist"}`,
          );
        }
        // Refresh both — approved proposal leaves pending + enters active list.
        await loadPending(panel, pidHeaders);
        await loadList(panel, pidHeaders);
      } catch {
        // Frontend-only build — backend disabled. Stay silent (no error popup);
        // surface the one debounced friendly notice for this user-initiated action.
        notifyBackendDisabled();
      }
      return;
    }
    if (msg?.type === "reject_pending" && typeof msg.pendingId === "string") {
      try {
        await api(`/skills/pending/${encodeURIComponent(msg.pendingId)}/reject`, {
          method: "POST",
          headers: pidHeaders,
        });
        await loadPending(panel, pidHeaders);
      } catch {
        // Frontend-only build — backend disabled. Silent no-op (no error popup).
      }
      return;
    }
    if (msg?.type === "select_skill" && typeof msg.name === "string") {
      try {
        const detail = await api<SkillDetail>(
          `/skills/${encodeURIComponent(msg.name)}`,
          { headers: pidHeaders },
        );
        panel.webview.postMessage({ type: "render_body", detail });
      } catch {
        // Frontend-only build — backend disabled. Silent no-op (no error popup,
        // no in-panel error banner); the viewer simply stays as-is / empty.
      }
      return;
    }
    if (
      msg?.type === "toggle_skill" &&
      typeof msg.name === "string" &&
      typeof msg.enabled === "boolean"
    ) {
      try {
        await api<{ name: string; enabled: boolean }>(
          `/skills/${encodeURIComponent(msg.name)}/enabled`,
          {
            method: "POST",
            body: JSON.stringify({ enabled: msg.enabled }),
            headers: pidHeaders,
          },
        );
        // Re-fetch list so disabled-state across all rows stays consistent;
        // also re-pushes the selected body if still visible (server-of-truth).
        await loadList(panel, pidHeaders);
      } catch {
        // Frontend-only build — backend disabled. Silent no-op (no error popup,
        // no in-panel error banner). The toggle simply has no effect.
      }
      return;
    }
  });

  return panel;
}

async function loadList(
  panel: vscode.WebviewPanel,
  pidHeaders: Record<string, string>,
): Promise<void> {
  try {
    const resp = await api<{ skills: SkillSummary[] }>("/skills", {
      headers: pidHeaders,
    });
    panel.webview.postMessage({
      type: "render_list",
      skills: resp.skills ?? [],
    });
  } catch {
    // Frontend-only build — backend disabled. Render an empty list silently
    // (no error popup, no in-panel error banner).
    panel.webview.postMessage({ type: "render_list", skills: [] });
  }
}

/** Fetch staged skill proposals (24h TTL). Renders a banner above the
 *  active-skills list so a proposal whose WS toast was missed/dismissed can
 *  still be approved or rejected before it expires (bug-audit unfinished #3).
 *  Silent on failure — pending review is a convenience, not critical path. */
async function loadPending(
  panel: vscode.WebviewPanel,
  pidHeaders: Record<string, string>,
): Promise<void> {
  try {
    const resp = await api<{ pending: PendingSkill[] }>("/skills/pending", {
      headers: pidHeaders,
    });
    panel.webview.postMessage({
      type: "render_pending",
      pending: resp.pending ?? [],
    });
  } catch {
    panel.webview.postMessage({ type: "render_pending", pending: [] });
  }
}

function escape(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderShell(): string {
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
    padding: 10px 16px;
    border-bottom: 1px solid var(--vscode-panel-border);
    background: var(--vscode-editor-background);
  }
  .topbar h1 { font-size: 14px; margin: 0; font-weight: 600; }
  .topbar .actions { display: flex; gap: 6px; }
  .topbar button {
    background: transparent;
    color: var(--vscode-foreground);
    border: 1px solid var(--vscode-panel-border);
    padding: 4px 10px;
    border-radius: 3px;
    font-size: 11px;
    cursor: pointer;
  }
  .topbar button:hover { background: var(--vscode-list-hoverBackground); }
  .split { display: flex; flex: 1; overflow: hidden; }
  .list {
    width: 280px;
    overflow-y: auto;
    border-right: 1px solid var(--vscode-panel-border);
    padding: 8px;
    box-sizing: border-box;
  }
  .item {
    padding: 10px;
    border-radius: 6px;
    cursor: pointer;
    margin-bottom: 6px;
    background: var(--vscode-editor-inactiveSelectionBackground);
    border: 1px solid transparent;
  }
  .item:hover { background: var(--vscode-list-hoverBackground); }
  .item.active { border-color: var(--vscode-focusBorder); }
  .item .row { display: flex; align-items: flex-start; gap: 8px; }
  .item .row > .meta { flex: 1; min-width: 0; }
  .item .name { font-weight: 600; font-size: 13px; }
  .item.disabled .name,
  .item.disabled .desc { text-decoration: line-through; opacity: 0.55; }
  .item .desc {
    font-size: 11px;
    opacity: 0.75;
    line-height: 1.4;
    margin-top: 4px;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  /* Toggle switch — pure CSS, no extra deps. ~32px wide. */
  .toggle {
    position: relative;
    display: inline-block;
    width: 32px;
    height: 18px;
    flex-shrink: 0;
    cursor: pointer;
  }
  .toggle input { opacity: 0; width: 0; height: 0; }
  .toggle .slider {
    position: absolute;
    inset: 0;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 9px;
    transition: background 0.15s;
  }
  .toggle .slider::before {
    content: "";
    position: absolute;
    top: 1px; left: 1px;
    width: 14px; height: 14px;
    background: var(--vscode-foreground);
    border-radius: 50%;
    opacity: 0.5;
    transition: transform 0.15s, opacity 0.15s;
  }
  .toggle input:checked + .slider {
    background: var(--vscode-button-background);
    border-color: var(--vscode-button-background);
  }
  .toggle input:checked + .slider::before {
    transform: translateX(14px);
    background: var(--vscode-button-foreground);
    opacity: 1;
  }
  .body-toggle { display: flex; align-items: center; gap: 8px; font-size: 11px; opacity: 0.85; }
  .chips { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 4px; }
  .chip {
    display: inline-block;
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 8px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
  }
  .chip.cat { background: var(--vscode-statusBarItem-prominentBackground, var(--vscode-badge-background)); }
  .viewer { flex: 1; overflow-y: auto; padding: 16px 20px; box-sizing: border-box; }
  .viewer h2 { font-size: 16px; margin: 0 0 6px; }
  .viewer .meta {
    font-size: 11px;
    opacity: 0.75;
    margin-bottom: 14px;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
  }
  .viewer .path {
    opacity: 0.6;
    font-family: var(--vscode-editor-font-family);
    font-size: 11px;
    margin-left: auto;
  }
  pre.body {
    background: var(--vscode-textCodeBlock-background, rgba(0,0,0,.2));
    padding: 12px;
    border-radius: 4px;
    font-family: var(--vscode-editor-font-family);
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0;
  }
  .empty { opacity: 0.6; font-size: 13px; padding: 12px 0; }
  .error {
    color: var(--vscode-errorForeground, #f85149);
    font-size: 12px;
    padding: 8px;
    border: 1px solid var(--vscode-errorForeground, #f85149);
    border-radius: 4px;
    margin: 8px;
  }
  /* Pending proposals banner — sits above the split when non-empty. */
  #pending { display: none; border-bottom: 1px solid var(--vscode-panel-border); }
  #pending.show { display: block; }
  #pending .phead {
    font-size: 11px; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.06em; opacity: 0.7; padding: 10px 16px 4px;
  }
  .pcard {
    margin: 6px 16px;
    padding: 10px 12px;
    border-radius: 6px;
    background: var(--vscode-inputValidation-warningBackground, var(--vscode-editor-inactiveSelectionBackground));
    border: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-panel-border));
  }
  .pcard .pname { font-weight: 600; font-size: 13px; }
  .pcard .pdesc { font-size: 11px; opacity: 0.8; line-height: 1.4; margin: 4px 0 8px; }
  .pcard .pmeta { font-size: 10px; opacity: 0.6; margin-bottom: 8px; }
  .pcard .pactions { display: flex; gap: 6px; }
  .pcard button {
    border: none; border-radius: 3px; padding: 4px 12px; font-size: 11px; cursor: pointer;
  }
  .pcard .approve { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .pcard .approve:hover { background: var(--vscode-button-hoverBackground); }
  .pcard .reject {
    background: transparent; color: var(--vscode-foreground);
    border: 1px solid var(--vscode-panel-border);
  }
  .pcard .reject:hover { background: var(--vscode-list-hoverBackground); }
</style>
</head>
<body>
  <div class="topbar">
    <h1>Mission Control — Skills</h1>
    <div class="actions">
      <button onclick="reload()">Reload</button>
      <button onclick="close_()">Close</button>
    </div>
  </div>
  <div id="pending"></div>
  <div class="split">
    <div class="list" id="list">
      <div class="empty">Loading…</div>
    </div>
    <div class="viewer" id="viewer">
      <div class="empty">Pick a skill on the left to view its body.</div>
    </div>
  </div>
<script>
  const vscode = acquireVsCodeApi();
  let currentName = null;
  let lastSkills = [];

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderList(skills) {
    lastSkills = skills;
    const root = document.getElementById('list');
    if (!skills.length) {
      root.innerHTML = '<div class="empty">No skills found. Add files to ~/.mission-control/skills/.</div>';
      return;
    }
    root.innerHTML = skills.map(s => {
      const agents = (s.agents && s.agents.length)
        ? s.agents.map(a => '<span class="chip">' + escapeHtml(a) + '</span>').join('')
        : '<span class="chip">all agents</span>';
      const cat = s.category
        ? '<span class="chip cat">' + escapeHtml(s.category) + '</span>'
        : '';
      const active = (s.name === currentName) ? ' active' : '';
      const disabled = (s.enabled === false) ? ' disabled' : '';
      const checked = (s.enabled === false) ? '' : ' checked';
      const name = escapeHtml(s.name);
      return '<div class="item' + active + disabled + '" data-name="' + name + '">'
        + '<div class="row">'
        +   '<div class="meta" onclick="select(\'' + name + '\')">'
        +     '<div class="name">' + name + '</div>'
        +     '<div class="desc">' + escapeHtml(s.description) + '</div>'
        +     '<div class="chips">' + agents + cat + '</div>'
        +   '</div>'
        +   '<label class="toggle" title="' + (s.enabled === false ? 'Enable' : 'Disable') + ' skill" onclick="event.stopPropagation()">'
        +     '<input type="checkbox"' + checked + ' onchange="toggle(\'' + name + '\', this.checked)">'
        +     '<span class="slider"></span>'
        +   '</label>'
        + '</div>'
        + '</div>';
    }).join('');
  }

  function renderBody(detail) {
    currentName = detail.name;
    // Refresh list to move .active highlight + reflect any enabled change.
    renderList(lastSkills);
    const agents = (detail.agents && detail.agents.length)
      ? detail.agents.map(a => '<span class="chip">' + escapeHtml(a) + '</span>').join('')
      : '<span class="chip">all agents</span>';
    const cat = detail.category
      ? '<span class="chip cat">' + escapeHtml(detail.category) + '</span>'
      : '';
    const checked = (detail.enabled === false) ? '' : ' checked';
    const stateLabel = (detail.enabled === false) ? 'Disabled' : 'Enabled';
    const name = escapeHtml(detail.name);
    document.getElementById('viewer').innerHTML =
      '<h2>' + name + '</h2>'
      + '<div class="meta">' + agents + cat
        + '<span class="path">' + escapeHtml(detail.path) + '</span></div>'
      + '<div class="body-toggle">'
      +   '<label class="toggle">'
      +     '<input type="checkbox"' + checked + ' onchange="toggle(\'' + name + '\', this.checked)">'
      +     '<span class="slider"></span>'
      +   '</label>'
      +   '<span>' + stateLabel + ' — agents ' + (detail.enabled === false ? 'will NOT' : 'will') + ' load this skill</span>'
      + '</div>'
      + '<pre class="body">' + escapeHtml(detail.body) + '</pre>';
    document.getElementById('viewer').scrollTop = 0;
  }

  function renderError(message) {
    document.getElementById('list').innerHTML =
      '<div class="error">' + escapeHtml(message) + '</div>';
  }

  function renderPending(pending) {
    const root = document.getElementById('pending');
    if (!pending || !pending.length) {
      root.className = '';
      root.innerHTML = '';
      return;
    }
    root.className = 'show';
    const cards = pending.map(p => {
      const agents = (p.agents && p.agents.length)
        ? p.agents.map(a => '<span class="chip">' + escapeHtml(a) + '</span>').join('')
        : '<span class="chip">all agents</span>';
      const cat = p.category ? '<span class="chip cat">' + escapeHtml(p.category) + '</span>' : '';
      const src = p.source ? ('proposed by ' + escapeHtml(p.source)) : 'proposed';
      const id = escapeHtml(p.pending_id);
      return '<div class="pcard">'
        + '<div class="pname">' + escapeHtml(p.name) + '</div>'
        + '<div class="pdesc">' + escapeHtml(p.description) + '</div>'
        + '<div class="chips">' + agents + cat + '</div>'
        + '<div class="pmeta">' + src + '</div>'
        + '<div class="pactions">'
        +   '<button class="approve" onclick="approvePending(\'' + id + '\')">Approve</button>'
        +   '<button class="reject" onclick="rejectPending(\'' + id + '\')">Reject</button>'
        + '</div>'
        + '</div>';
    }).join('');
    root.innerHTML = '<div class="phead">Pending proposals (' + pending.length + ')</div>' + cards;
  }

  function select(name) {
    vscode.postMessage({ type: 'select_skill', name });
  }
  function toggle(name, enabled) {
    vscode.postMessage({ type: 'toggle_skill', name, enabled });
  }
  function approvePending(pendingId) {
    vscode.postMessage({ type: 'approve_pending', pendingId });
  }
  function rejectPending(pendingId) {
    vscode.postMessage({ type: 'reject_pending', pendingId });
  }
  function reload() {
    currentName = null;
    document.getElementById('list').innerHTML = '<div class="empty">Loading…</div>';
    document.getElementById('viewer').innerHTML =
      '<div class="empty">Pick a skill on the left to view its body.</div>';
    vscode.postMessage({ type: 'reload' });
  }
  function close_() {
    vscode.postMessage({ type: 'close' });
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'render_list') renderList(msg.skills || []);
    else if (msg.type === 'render_body') renderBody(msg.detail);
    else if (msg.type === 'render_pending') renderPending(msg.pending || []);
    else if (msg.type === 'error') renderError(msg.message || 'unknown error');
  });
</script>
</body>
</html>`;
}

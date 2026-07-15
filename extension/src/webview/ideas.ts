import * as vscode from "vscode";

import { ApiError, api, notifyBackendDisabled } from "../api";

export type Idea = {
  id: string;
  title: string;
  description: string;
  impact: number;
  feasibility: number;
  rationale?: string;
};

/**
 * Open the Sprint A ideas-approval panel.
 *
 * `projectId` is captured by closure at open time — every API call this panel
 * makes (approve, sprint/b) sends that pid as `X-Project-Id`, regardless of
 * what the user has since selected in the sidebar. Critical because:
 *   - `retainContextWhenHidden: true` keeps the panel alive across project
 *     switches, so click-time getCurrentProjectId() would return the WRONG
 *     pid if the user switched projects after the panel opened.
 *   - The api() helper merges caller-supplied `headers` AFTER its default
 *     X-Project-Id, so this override wins.
 *
 * Pass `null` when there's no specific project context (legacy single-project
 * flow) — api() will then fall back to the global active project.
 */
export function openIdeasPanel(
  ideas: Idea[],
  projectId: string | null = null,
): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel(
    "missioncontrol.ideas",
    `Approve ${ideas.length} Ideas`,
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  panel.webview.html = renderHtml(ideas);
  const pidHeaders: Record<string, string> = projectId
    ? { "X-Project-Id": projectId }
    : {};
  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg?.type !== "approve") return;
    const ids: string[] = Array.isArray(msg.ids) ? msg.ids : [];
    try {
      await api<{ ok: boolean; count: number }>("/ideas/approve", {
        method: "POST",
        body: JSON.stringify({ approved_ids: ids }),
        headers: pidHeaders,
      });
      panel.dispose();
    } catch (err) {
      // frontend-only build: backend disabled. Stay silent (no error popup);
      // surface ONE friendly info toast for this user-initiated submit.
      const detail = err instanceof ApiError ? err.message : String(err);
      void detail;
      notifyBackendDisabled();
      return;
    }

    if (ids.length === 0) {
      vscode.window.showInformationMessage(
        "Mission Control: 0 ideas approved — nothing to build.",
      );
      return;
    }

    // Auto-trigger Sprint B if the `auto_sprint_b` config flag is set,
    // otherwise prompt with a NON-MODAL info message (the previous modal
    // froze the entire IDE while the user walked away).
    let autoSprintB = false;
    try {
      const cfg = await api<{ config: Record<string, unknown> }>("/config");
      autoSprintB = Boolean(cfg.config?.auto_sprint_b);
    } catch {
      // Fall through — treat as false.
    }

    const startSprintB = async () => {
      try {
        await api("/sprint/b", { method: "POST", headers: pidHeaders });
        vscode.window.showInformationMessage("Mission Control: Sprint B started");
      } catch (err) {
        // frontend-only build: backend disabled. Silent no-op, no error popup.
        const detail = err instanceof ApiError ? err.message : String(err);
        void detail;
      }
    };

    if (autoSprintB) {
      void startSprintB();
      return;
    }
    // Non-modal: stays in the notification area, doesn't block the IDE.
    vscode.window
      .showInformationMessage(
        `Approved ${ids.length} idea(s). Start the build phase (Sprint B) now?`,
        "Start build",
        "Later",
      )
      .then((pick) => {
        if (pick === "Start build") void startSprintB();
      });
  });
  return panel;
}

function escape(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderHtml(ideas: Idea[]): string {
  const cards = ideas
    .map((i) => {
      const impactPct = Math.min(100, Math.max(0, (i.impact ?? 0) * 10));
      const feasPct = Math.min(100, Math.max(0, (i.feasibility ?? 0) * 10));
      return `
      <div class="card">
        <div class="title">${escape(i.title)}</div>
        <div class="desc">${escape(i.description)}</div>
        ${i.rationale ? `<div class="rationale">↳ ${escape(i.rationale)}</div>` : ""}
        <div class="bars">
          <div class="bar">
            <span class="label">Impact ${escape(i.impact)}/10</span>
            <div class="track"><div class="fill impact" style="width:${impactPct}%"></div></div>
          </div>
          <div class="bar">
            <span class="label">Feasibility ${escape(i.feasibility)}/10</span>
            <div class="track"><div class="fill feas" style="width:${feasPct}%"></div></div>
          </div>
        </div>
        <div class="choices">
          <label class="yes"><input type="radio" name="${escape(i.id)}" value="yes"> Yes</label>
          <label class="pass"><input type="radio" name="${escape(i.id)}" value="pass" checked> Pass</label>
          <label class="maybe"><input type="radio" name="${escape(i.id)}" value="maybe"> Maybe</label>
        </div>
      </div>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px; }
  h1 { font-size: 18px; margin: 0 0 12px; }
  .summary { font-size: 12px; opacity: 0.7; margin-bottom: 16px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }
  .card { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 12px; background: var(--vscode-editor-inactiveSelectionBackground); }
  .title { font-weight: 600; margin-bottom: 6px; }
  .desc { font-size: 13px; line-height: 1.45; margin-bottom: 8px; }
  .rationale { font-size: 11px; opacity: 0.7; margin-bottom: 10px; font-style: italic; }
  .bars { display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; }
  .bar { display: flex; flex-direction: column; gap: 2px; }
  .bar .label { font-size: 11px; opacity: 0.75; }
  .track { height: 4px; background: var(--vscode-progressBar-background); border-radius: 2px; overflow: hidden; }
  .fill { height: 100%; }
  .fill.impact { background: #3fb950; }
  .fill.feas { background: #58a6ff; }
  .choices { display: flex; gap: 12px; font-size: 12px; }
  .choices label { cursor: pointer; }
  .toolbar { position: sticky; bottom: 0; padding: 12px 0; background: var(--vscode-editor-background); display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; border-top: 1px solid var(--vscode-panel-border); }
  .approve-btn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 8px 16px; border-radius: 3px; cursor: pointer; font-weight: 500; }
  .approve-btn:hover { background: var(--vscode-button-hoverBackground); }
  .count { font-size: 12px; align-self: center; opacity: 0.75; }
</style>
</head>
<body>
  <h1>Approve ideas from Sprint A</h1>
  <div class="summary">Mark each idea Yes / Pass / Maybe — only Yes is sent to /ideas/approve.</div>
  <div class="grid">
    ${cards}
  </div>
  <div class="toolbar">
    <span class="count" id="count">0 marked Yes</span>
    <button class="approve-btn" onclick="submit()">Send approvals</button>
  </div>
<script>
  const vscode = acquireVsCodeApi();
  function yesIds() {
    return [...document.querySelectorAll('input[type=radio]:checked')]
      .filter(r => r.value === 'yes')
      .map(r => r.name);
  }
  function refresh() {
    document.getElementById('count').textContent = yesIds().length + ' marked Yes';
  }
  document.addEventListener('change', refresh);
  function submit() { vscode.postMessage({ type: 'approve', ids: yesIds() }); }
</script>
</body>
</html>`;
}

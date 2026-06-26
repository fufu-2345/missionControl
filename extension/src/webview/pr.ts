import * as vscode from "vscode";

import { ApiError, api, notifyBackendDisabled } from "../api";

export type PRInfo = {
  task_id: string;
  sprint_id?: string;
  title: string;
  branch: string;
  verdict: { verdict: string; reason: string; concerns?: string[] };
  diff_summary?: string;
  build_summary?: string;
  pr_number?: number;
  pr_url?: string;
  pr_error?: string;
  push?: { ok: boolean; message: string };
  merged?: boolean;
  project_id?: string;
};

/**
 * Open the PR review/merge panel.
 *
 * `projectId` is captured at open time and sent as `X-Project-Id` on /pr/approve.
 * Without this, a user switching projects after the panel opens would silently
 * merge the wrong project's PR — the panel has `retainContextWhenHidden: true`
 * and api() reads getCurrentProjectId() at request time, which would point at
 * the newly-selected project. Pass `null` for legacy single-project usage.
 */
// Module-level cache of open panels keyed by task_id (Phase B audit fix #5).
// Without dedup, agents=4 finishing concurrently would stack 4 webviews in
// ViewColumn.One — and a backend restart that re-fires pr_ready would
// duplicate every open panel.
const _panels = new Map<string, vscode.WebviewPanel>();

export function openPRPanel(
  pr: PRInfo,
  projectId: string | null = null,
): vscode.WebviewPanel {
  const existing = _panels.get(pr.task_id);
  if (existing) {
    existing.webview.html = renderHtml(pr); // refresh in case verdict changed
    existing.reveal();
    return existing;
  }
  const panel = vscode.window.createWebviewPanel(
    "missioncontrol.pr",
    `PR — ${pr.title}`,
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  _panels.set(pr.task_id, panel);
  panel.onDidDispose(() => _panels.delete(pr.task_id));
  panel.webview.html = renderHtml(pr);
  const pidHeaders: Record<string, string> = projectId
    ? { "X-Project-Id": projectId }
    : {};
  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg?.type === "close") {
      panel.dispose();
      return;
    }
    if (msg?.type !== "approve") return;
    try {
      // Phase B audit fix #4: branch on result.merge.merged so a conflict
      // response doesn't show "merged" to the user. The previous code
      // disposed the panel on ANY 200, which silently misled when the
      // backend returned {merge: {merged: false, conflict: true}}.
      const r = await api<{
        task_id: string;
        merge: {
          merged: boolean;
          conflict?: boolean;
          info?: string;
          already?: boolean;
        };
      }>("/pr/approve", {
        method: "POST",
        body: JSON.stringify({ task_id: pr.task_id }),
        headers: pidHeaders,
      });
      const m = r.merge ?? { merged: false };
      if (m.merged) {
        vscode.window.showInformationMessage(
          m.already
            ? `Mission Control: ${pr.title} (already merged)`
            : `Mission Control: merged ${pr.title}`,
        );
        panel.dispose();
        return;
      }
      if (m.conflict) {
        vscode.window.showWarningMessage(
          `Mission Control: ${pr.title} — merge blocked by conflict (${m.info ?? "rebase the branch manually"})`,
        );
        // Keep the panel open so the user can re-try after resolving.
        return;
      }
      vscode.window.showWarningMessage(
        `Mission Control: ${pr.title} — merge did not complete (no pr_number?)`,
      );
    } catch {
      // Frontend-only build: backend is disabled, so /pr/approve always
      // rejects. Surface a single debounced friendly info toast for this
      // user-initiated action instead of an error popup, then no-op (the
      // panel stays open so the user can simply Close it).
      notifyBackendDisabled();
    }
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

function renderHtml(pr: PRInfo): string {
  const verdictColor = pr.verdict.verdict === "ok" ? "#3fb950" : "#f85149";
  const concerns = (pr.verdict.concerns ?? [])
    .map((c) => `<li>${escape(c)}</li>`)
    .join("");
  const prLink = pr.pr_url
    ? `<a href="${escape(pr.pr_url)}">${escape(pr.pr_url)}</a>`
    : pr.pr_error
      ? `<span class="warn">PR not created: ${escape(pr.pr_error)}</span>`
      : "<span class=\"warn\">No remote PR — local only</span>";

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 16px; max-width: 1100px; margin: 0 auto; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .meta { font-size: 12px; opacity: 0.7; margin-bottom: 16px; }
  .verdict { display: inline-block; padding: 3px 9px; border-radius: 10px; color: white; font-size: 11px; font-weight: 600; }
  .section { margin: 16px 0; padding: 12px; background: var(--vscode-editor-inactiveSelectionBackground); border-radius: 6px; }
  .section h2 { font-size: 13px; margin: 0 0 8px; text-transform: uppercase; opacity: 0.75; letter-spacing: 0.5px; }
  pre { background: var(--vscode-textCodeBlock-background, rgba(0,0,0,.2)); padding: 10px; border-radius: 4px; overflow-x: auto; font-family: var(--vscode-editor-font-family); font-size: 12px; line-height: 1.5; max-height: 500px; }
  .warn { color: #d29922; font-size: 12px; }
  .toolbar { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
  .btn { padding: 8px 16px; border: none; border-radius: 3px; cursor: pointer; font-weight: 500; }
  .btn-approve { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .btn-approve:hover { background: var(--vscode-button-hoverBackground); }
  .btn-cancel { background: transparent; color: var(--vscode-foreground); border: 1px solid var(--vscode-panel-border); }
  ul { padding-left: 20px; }
</style>
</head>
<body>
  <h1>${escape(pr.title)}</h1>
  <div class="meta">
    <span class="verdict" style="background:${verdictColor}">${escape(pr.verdict.verdict)}</span>
    &nbsp; branch <code>${escape(pr.branch)}</code> &nbsp; ${prLink}
  </div>

  <div class="section">
    <h2>Verdict</h2>
    <div>${escape(pr.verdict.reason)}</div>
    ${concerns ? `<ul>${concerns}</ul>` : ""}
  </div>

  <div class="section">
    <h2>Build summary</h2>
    <div>${escape(pr.build_summary ?? "(none)")}</div>
  </div>

  <div class="section">
    <h2>Diff (first 2000 chars)</h2>
    <pre>${escape(pr.diff_summary ?? "(empty diff)")}</pre>
  </div>

  <div class="toolbar">
    ${
      // Phase B audit fix #10: hide "Approve & merge" when verdict isn't ok
      // OR when PR creation failed — clicking it then would 503 ("no
      // pr_number to merge"). Replace with informational state + Close.
      pr.verdict.verdict !== "ok" || pr.pr_error
        ? `<button class="btn btn-cancel" onclick="vscode.postMessage({type:'close'})">Close</button>`
        : `<button class="btn btn-cancel" onclick="vscode.postMessage({type:'close'})">Close</button>
           <button class="btn btn-approve" onclick="approve()">Approve & merge</button>`
    }
  </div>
<script>
  const vscode = acquireVsCodeApi();
  function approve() { vscode.postMessage({ type: 'approve' }); }
</script>
</body>
</html>`;
}

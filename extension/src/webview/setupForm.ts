import * as vscode from "vscode";

import { ApiError, api, notifyBackendDisabled } from "../api";

type SetupResponse = { ok: boolean; claude: string; github: string };

const GITHUB_TOKEN_URL =
  "https://github.com/settings/tokens/new?scopes=repo,workflow&description=Mission%20Control";

export type SetupFormResult = "saved" | "skipped" | "cancelled";

/**
 * Open a webview form to collect + validate the GitHub PAT.
 *
 * Resolves with:
 *   "saved"     → user typed a token and validation passed (stored in
 *                 context.secrets + backend secrets.json)
 *   "skipped"   → user clicked "Skip for now" — setup considered done but
 *                 no GitHub features (PR open/merge will fail until they
 *                 re-run /setup and enter a token)
 *   "cancelled" → user closed the panel via the title-bar X without taking
 *                 either action — setup command treats this as "try again
 *                 later", does NOT mark setup complete
 *
 * Replaces the previous `vscode.window.showInputBox` step in setup.ts so
 * the user can: (1) see required scopes, (2) jump to GitHub to create a
 * token without leaving the editor, (3) see inline validation status,
 * (4) explicitly skip if they don't have a token yet.
 */
export function openSetupForm(
  context: vscode.ExtensionContext,
): Promise<SetupFormResult> {
  return new Promise((resolve) => {
    const panel = vscode.window.createWebviewPanel(
      "missioncontrol.setupForm",
      "Setup",
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: false },
    );

    // Default outcome is "cancelled" — only overwritten on explicit Skip
    // or successful Save. Title-bar X close = stays cancelled.
    let result: SetupFormResult = "cancelled";

    panel.webview.html = renderHtml();
    panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type === "open_github") {
        await vscode.env.openExternal(vscode.Uri.parse(GITHUB_TOKEN_URL));
        return;
      }
      if (msg?.type === "skip") {
        result = "skipped";
        panel.dispose();
        return;
      }
      if (msg?.type === "validate" && typeof msg.token === "string") {
        const token = msg.token.trim();
        if (!token) {
          panel.webview.postMessage({
            type: "status",
            state: "error",
            message: "Token cannot be empty. Click 'Skip for now' to continue without a token.",
          });
          return;
        }
        panel.webview.postMessage({ type: "status", state: "validating" });
        try {
          const resp = await api<SetupResponse>("/setup", {
            method: "POST",
            body: JSON.stringify({ github_token: token }),
          });
          await context.secrets.store("github_token", token);
          result = "saved";
          panel.webview.postMessage({
            type: "status",
            state: "success",
            message: `${resp.claude} · ${resp.github}`,
          });
          // Auto-close after a short pause so the user reads the green tick.
          setTimeout(() => panel.dispose(), 1800);
        } catch (err) {
          // Frontend-only build: the backend is disabled, so validation can
          // never succeed. Do NOT surface an error in the panel — show the
          // single friendly session notice for this user-initiated submit and
          // reset the form to an idle/empty state silently.
          void err;
          notifyBackendDisabled();
          panel.webview.postMessage({
            type: "status",
            state: "idle",
            message: "",
          });
        }
      }
    });

    panel.onDidDispose(() => resolve(result));
  });
}

function renderHtml(): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 28px;
    max-width: 560px;
    margin: 0 auto;
    line-height: 1.5;
  }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { font-size: 12px; opacity: 0.7; margin-bottom: 24px; }
  label { display: block; font-size: 12px; font-weight: 600; margin-bottom: 6px; }
  .input-row { display: flex; align-items: center; gap: 6px; }
  input[type="text"], input[type="password"] {
    flex: 1;
    padding: 8px 10px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: 3px;
    font-family: var(--vscode-editor-font-family);
    font-size: 13px;
  }
  input:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .eye {
    padding: 6px 10px;
    background: transparent;
    color: var(--vscode-foreground);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 3px;
    cursor: pointer;
    font-size: 11px;
  }
  .eye:hover { background: var(--vscode-list-hoverBackground); }
  .hint {
    margin: 12px 0 20px;
    padding: 10px 12px;
    background: var(--vscode-editor-inactiveSelectionBackground);
    border-radius: 4px;
    font-size: 12px;
    line-height: 1.6;
  }
  .hint a, .link-btn {
    color: var(--vscode-textLink-foreground);
    cursor: pointer;
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    text-decoration: underline;
  }
  .scopes { font-family: var(--vscode-editor-font-family); opacity: 0.85; }
  .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
  .btn {
    padding: 8px 18px;
    border: none;
    border-radius: 3px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
  }
  .btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-cancel { background: transparent; color: var(--vscode-foreground); border: 1px solid var(--vscode-panel-border); }
  .btn-cancel:hover { background: var(--vscode-list-hoverBackground); }
  .status {
    margin-top: 16px;
    padding: 10px 12px;
    border-radius: 4px;
    font-size: 12px;
    line-height: 1.5;
    display: none;
  }
  .status.show { display: block; }
  .status.idle { background: var(--vscode-editor-inactiveSelectionBackground); }
  .status.validating { background: var(--vscode-editor-inactiveSelectionBackground); }
  .status.success {
    background: rgba(63, 185, 80, 0.12);
    border-left: 3px solid #3fb950;
    color: var(--vscode-foreground);
  }
  .status.error {
    background: rgba(248, 81, 73, 0.10);
    border-left: 3px solid #f85149;
    color: var(--vscode-errorForeground, #f85149);
  }
  .spinner {
    display: inline-block;
    width: 10px;
    height: 10px;
    border: 2px solid var(--vscode-foreground);
    border-right-color: transparent;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
    vertical-align: middle;
    margin-right: 6px;
    opacity: 0.6;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
  <h1>Mission Control — Setup</h1>
  <div class="sub">Connect GitHub so the build agent can open PRs on your behalf. Claude auth ใช้ของ Claude Code อยู่แล้ว (Max quota) — ไม่ต้องกรอกแยก.</div>

  <label for="token">GitHub Personal Access Token</label>
  <div class="input-row">
    <input id="token" type="password" placeholder="ghp_xxxxxxxxxxxxxxxxxxxx" autocomplete="off" spellcheck="false" autofocus>
    <button class="eye" type="button" onclick="toggleEye()" id="eye-btn">Show</button>
  </div>

  <div class="hint">
    ไม่มี token? <button class="link-btn" type="button" onclick="openGithub()">สร้างใหม่บน GitHub →</button><br>
    Required scopes: <span class="scopes">repo</span>, <span class="scopes">workflow</span><br>
    เก็บที่ <span class="scopes">~/.mission-control/secrets.json</span> (mode 0600) + VSCode SecretStorage.
  </div>

  <div id="status" class="status"></div>

  <div class="actions">
    <button class="btn btn-cancel" type="button" onclick="skip()" title="Save setup without GitHub features. You can re-run /setup later to add a token.">Skip for now</button>
    <button class="btn btn-primary" id="submit-btn" type="button" onclick="validate()">Validate &amp; Save</button>
  </div>

<script>
  const vscode = acquireVsCodeApi();
  const tokenInput = document.getElementById('token');
  const eyeBtn = document.getElementById('eye-btn');
  const statusEl = document.getElementById('status');
  const submitBtn = document.getElementById('submit-btn');

  function toggleEye() {
    if (tokenInput.type === 'password') {
      tokenInput.type = 'text';
      eyeBtn.textContent = 'Hide';
    } else {
      tokenInput.type = 'password';
      eyeBtn.textContent = 'Show';
    }
  }
  function openGithub() {
    vscode.postMessage({ type: 'open_github' });
  }
  function validate() {
    const token = tokenInput.value;
    vscode.postMessage({ type: 'validate', token });
  }
  function skip() {
    vscode.postMessage({ type: 'skip' });
  }
  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  tokenInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') validate();
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || msg.type !== 'status') return;
    statusEl.className = 'status show ' + msg.state;
    if (msg.state === 'validating') {
      submitBtn.disabled = true;
      statusEl.innerHTML = '<span class="spinner"></span>Validating GitHub token + checking Claude CLI…';
    } else if (msg.state === 'success') {
      submitBtn.disabled = true;
      statusEl.textContent = 'Saved. ' + (msg.message || '');
    } else if (msg.state === 'error') {
      submitBtn.disabled = false;
      statusEl.textContent = msg.message || 'Setup failed.';
    } else {
      submitBtn.disabled = false;
      statusEl.textContent = msg.message || '';
    }
  });
</script>
</body>
</html>`;
}

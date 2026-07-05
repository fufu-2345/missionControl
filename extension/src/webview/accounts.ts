import * as vscode from "vscode";

import {
  accountExists,
  captureCurrent,
  deleteAccount,
  isProvider,
  isSafeLabel,
  listAccounts,
  liveClaudeToken,
  savedClaudeToken,
  switchTo,
  type Provider,
} from "../commands/accountsOps";
import { fetchClaudeUsage } from "../commands/usage";

// Editor-area panel for managing multiple subscription logins across AI CLIs.
// Singleton _panel, a display-ready postMessage + a message switch — mirrors
// teams.ts. All credential I/O lives in accountsOps (node-only, tested); this
// file only bridges it to the webview + native prompts and does the display
// formatting. NEVER post a token to the webview — the view carries provider
// metadata (subscription type / date) only.
let _panel: vscode.WebviewPanel | undefined;

function providerTitle(p: Provider): string {
  return p === "claude" ? "Claude" : "OpenAI · Codex";
}

/** Build a fully display-ready view so the client script stays dumb. */
function buildView(): Record<string, unknown> {
  const raw = listAccounts();
  const providers = raw.providers.map((ps) => {
    const savedActive = ps.accounts.some((a) => a.label === ps.active);
    let liveText: string;
    if (ps.live.present) {
      const tier = ps.live.secondary ? " · " + ps.live.secondary : "";
      const primary = ps.live.primary ? ps.live.primary : "login อยู่";
      const acct = savedActive ? (ps.active as string) : "ยังไม่ได้บันทึก";
      liveText = "กำลังใช้: " + primary + tier + " · account: " + acct;
    } else {
      liveText = ps.loginHint;
    }
    const accounts = ps.accounts.map((a) => {
      const when = a.capturedAt ? " · บันทึก " + a.capturedAt.slice(0, 10) : "";
      const head = a.primary ? a.primary + (a.secondary ? " · " + a.secondary : "") : "subscription";
      return { label: a.label, active: a.label === ps.active, sub: head + when, unsaved: false };
    });
    // Surface the CURRENTLY-LIVE login even before it is captured, so the account
    // in use is never invisible — but only when it isn't already a saved active row.
    if (ps.live.present && !savedActive) {
      const head = ps.live.primary
        ? ps.live.primary + (ps.live.secondary ? " · " + ps.live.secondary : "")
        : "login อยู่";
      accounts.unshift({ label: "กำลังใช้อยู่", active: true, sub: head + " · ยังไม่ได้บันทึก", unsaved: true });
    }
    return {
      provider: ps.provider,
      title: providerTitle(ps.provider),
      liveText,
      active: ps.active,
      usage: ps.provider === "claude", // only Claude has a usage endpoint
      accounts,
    };
  });
  return { type: "accounts", providers };
}

function pushList(panel: vscode.WebviewPanel): void {
  panel.webview.postMessage(buildView());
}

/** Fetch remaining usage for every Claude account whose token is still valid and
 *  post it to the webview keyed by the SAME row label buildView uses. Tokens
 *  never leave the host. Best-effort — each account degrades to a status string
 *  on expiry / rate-limit / error. */
async function pushUsage(panel: vscode.WebviewPanel): Promise<void> {
  const claude = listAccounts().providers.find((p) => p.provider === "claude");
  if (!claude) return;
  const now = Date.now();
  const activeLabel = claude.active;
  const savedActive = claude.accounts.some((a) => a.label === activeLabel);

  const targets: { label: string; token: { accessToken: string; expiresAt: number } | null }[] = [];
  const live = liveClaudeToken();
  if (claude.live.present && live) {
    // The active account's fresh token lives in .credentials.json (its vault copy
    // is stale) — key it to whichever row represents "active" (synthetic or saved).
    targets.push({ label: savedActive ? (activeLabel as string) : "กำลังใช้อยู่", token: live });
  }
  for (const a of claude.accounts) {
    if (a.label === activeLabel) continue; // handled via the live token above
    targets.push({ label: a.label, token: savedClaudeToken(a.label) });
  }

  const results: Record<string, unknown> = {};
  await Promise.all(
    targets.map(async (t) => {
      if (!t.token) {
        results[t.label] = { status: "error" };
        return;
      }
      if (t.token.expiresAt && t.token.expiresAt <= now) {
        results[t.label] = { status: "expired" };
        return;
      }
      try {
        results[t.label] = { status: "ok", usage: await fetchClaudeUsage(t.token.accessToken) };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        results[t.label] = { status: msg.includes("429") ? "ratelimited" : "error" };
      }
    }),
  );
  panel.webview.postMessage({ type: "usage", results });
}
function notify(r: { ok: boolean; error?: string }, okMsg: string): void {
  vscode.window[r.ok ? "showInformationMessage" : "showErrorMessage"](
    r.ok ? `Accounts: ${okMsg}` : `Accounts: ${r.error}`,
  );
}

async function promptLabel(provider: Provider): Promise<string> {
  const raw = await vscode.window.showInputBox({
    title: `ตั้งชื่อ label (${providerTitle(provider)})`,
    prompt: "ชื่อสั้นๆ ไว้แยก account — A-Z a-z 0-9 . _ -",
    placeHolder: "เช่น main, work, personal2",
    ignoreFocusOut: true,
    validateInput: (v) =>
      isSafeLabel((v ?? "").trim()) ? null : "ใช้ได้เฉพาะ A-Z a-z 0-9 . _ - (1-60 ตัว)",
  });
  const label = (raw ?? "").trim();
  return isSafeLabel(label) ? label : "";
}

export function openAccountsPanel(): vscode.WebviewPanel {
  if (_panel) {
    _panel.reveal();
    return _panel;
  }
  const panel = vscode.window.createWebviewPanel(
    "missioncontrol.accounts",
    "Mission Control — Accounts",
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  _panel = panel;
  panel.onDidDispose(() => {
    _panel = undefined;
  });

  panel.webview.html = renderShell();

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (!msg || typeof msg.type !== "string") return;
    const provider = isProvider(msg.provider) ? (msg.provider as Provider) : null;

    switch (msg.type) {
      case "ready":
      case "reload":
        pushList(panel);
        void pushUsage(panel);
        return;

      case "refresh_usage":
        void pushUsage(panel);
        return;

      case "add": {
        if (!provider) return;
        const label = await promptLabel(provider);
        if (!label) return;
        if (accountExists(provider, label)) {
          const pick = await vscode.window.showWarningMessage(
            `มี '${label}' (${providerTitle(provider)}) อยู่แล้ว — เขียนทับด้วย login ปัจจุบัน?`,
            { modal: true },
            "เขียนทับ",
          );
          if (pick !== "เขียนทับ") return;
        }
        const r = captureCurrent(provider, label, new Date().toISOString());
        notify(r, `บันทึก '${label}' แล้ว (= account ที่ login อยู่ตอนนี้)`);
        pushList(panel);
        void pushUsage(panel);
        return;
      }

      case "switch": {
        if (!provider || !isSafeLabel(msg.label)) return;
        const label = msg.label as string;
        const r = switchTo(provider, label);
        if (r.ok) {
          vscode.window.showInformationMessage(
            `Accounts: สลับไป '${label}' แล้ว — process ที่เปิด "ใหม่" จะใช้ account นี้ (ตัวที่เปิดค้างอยู่ต้อง restart)`,
          );
        } else {
          vscode.window.showErrorMessage(`Accounts: ${r.error}`);
        }
        pushList(panel);
        void pushUsage(panel);
        return;
      }

      case "recapture": {
        if (!provider || !isSafeLabel(msg.label)) return;
        const label = msg.label as string;
        const pick = await vscode.window.showWarningMessage(
          `อัปเดต '${label}' ด้วย session ที่ login อยู่ตอนนี้?\n\nใช้เมื่อ token เดิมหมุน/หมดอายุ — ต้องมั่นใจว่าตอนนี้ login เป็น account เดียวกันกับ '${label}'`,
          { modal: true },
          "อัปเดต",
        );
        if (pick !== "อัปเดต") return;
        const r = captureCurrent(provider, label, new Date().toISOString());
        notify(r, `อัปเดต '${label}' แล้ว`);
        pushList(panel);
        void pushUsage(panel);
        return;
      }

      case "delete": {
        if (!provider || !isSafeLabel(msg.label)) return;
        const label = msg.label as string;
        const pick = await vscode.window.showWarningMessage(
          `ลบ '${label}' (${providerTitle(provider)}) ออกจาก vault? (ลบแค่ค่าที่เก็บในเครื่อง ไม่กระทบ account จริง)`,
          { modal: true },
          "ลบ",
        );
        if (pick !== "ลบ") return;
        const r = deleteAccount(provider, label);
        notify(r, `ลบ '${label}' แล้ว`);
        pushList(panel);
        void pushUsage(panel);
        return;
      }
    }
  });

  return panel;
}

// NOTE: the inline <script> below lives inside this template literal. Keep it
// FREE of backslashes and backticks — both are processed when the literal is
// evaluated and would silently corrupt the client script (a known foot-gun in
// this codebase). Regexes used here (/&/g etc.) contain no backslashes.
function renderShell(): string {
  return `<!DOCTYPE html><html lang="th"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 20px 22px; margin: 0;
  }
  h1 { font-size: 19px; font-weight: 700; margin: 0 0 4px; }
  .lead { font-size: 12px; opacity: 0.7; margin-bottom: 20px; }
  .prov { margin-bottom: 26px; max-width: 780px; }
  .ph { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 10px; }
  .ph h2 { font-size: 15px; font-weight: 700; margin: 0 0 3px; }
  .live { font-size: 11.5px; opacity: 0.72; }
  .ph-btns { display: flex; gap: 6px; align-items: center; flex-shrink: 0; }
  .usage-btn { white-space: nowrap; }
  .primary {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; border-radius: 6px; padding: 8px 13px; font-size: 12.5px; font-weight: 600;
    cursor: pointer; white-space: nowrap;
  }
  .primary:hover { background: var(--vscode-button-hoverBackground); }
  .rows { display: flex; flex-direction: column; gap: 8px; }
  .row {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25)); border-radius: 8px;
    padding: 10px 14px; background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.06));
  }
  .row.active { border-color: var(--vscode-focusBorder); background: var(--vscode-list-activeSelectionBackground, rgba(120,160,255,0.12)); }
  .rl { font-size: 14px; font-weight: 600; }
  .rs { font-size: 11px; opacity: 0.65; margin-top: 3px; }
  .badge {
    font-size: 10px; font-weight: 700; letter-spacing: 0.5px; padding: 1px 6px; border-radius: 4px;
    background: var(--vscode-focusBorder); color: var(--vscode-button-foreground); margin-left: 6px; vertical-align: middle;
  }
  .badge.warn { background: var(--vscode-charts-orange, #d18616); color: #1a1a1a; }
  .b.save { border-color: var(--vscode-focusBorder); color: var(--vscode-button-foreground); background: var(--vscode-button-background); font-weight: 600; }
  .b.save:hover { background: var(--vscode-button-hoverBackground); }
  .ra { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
  .cur { font-size: 11px; opacity: 0.6; font-style: italic; margin-right: 4px; }
  .b {
    background: transparent; color: var(--vscode-foreground);
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35)); border-radius: 5px;
    padding: 5px 10px; font-size: 12px; cursor: pointer;
  }
  .b:hover { border-color: var(--vscode-focusBorder); background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.15)); }
  .b.sw { border-color: var(--vscode-focusBorder); font-weight: 600; }
  .b.del:hover { border-color: var(--vscode-inputValidation-errorBorder, #d1242f); color: var(--vscode-inputValidation-errorBorder, #d1242f); }
  .empty { opacity: 0.55; font-size: 12.5px; padding: 12px 4px; }
  .note {
    margin-top: 8px; max-width: 780px; font-size: 12px; line-height: 1.6; opacity: 0.72;
    border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2)); padding-top: 14px;
  }
  .note b { opacity: 0.95; }
</style>
</head>
<body>
  <h1>AI Accounts</h1>
  <div class="lead">เก็บ + สลับ subscription login หลาย provider — usage หมดสลับได้ทันที</div>
  <div id="providers"></div>
  <div class="note">
    <b>ใช้ยังไง:</b> login แต่ละ account ผ่าน CLI ของ provider นั้น (Claude = <b>claude /login</b>, OpenAI = <b>codex login</b>) แล้วกด "บันทึก account ปัจจุบัน" — ทำซ้ำได้หลาย account · กด <b>สลับ</b> เพื่อเปลี่ยนตัว active<br />
    <b>ข้อควรรู้:</b> สลับ = เขียนทับไฟล์ credentials ของ CLI → มีผลกับ process ที่เปิด <b>ใหม่</b> เท่านั้น ตัวที่เปิดค้างต้อง restart · ทุก session อ่าน credentials ไฟล์เดียวกันต่อ provider จึงใช้ account เดียวพร้อมกัน · token หมุนจนสลับกลับไม่ได้ → login ใหม่แล้วกด "อัปเดต"<br />
    <b>usage คงเหลือ (Claude):</b> ดึงจาก endpoint <b>/api/oauth/usage</b> ของ account เอง (ไม่กิน quota) — โชว์ 5ชม/7วัน ที่เหลือ + เวลารีเซ็ต · account ที่ active ดึงได้เสมอ (token สด) · ตัวที่ save ไว้นานจน token หมดอายุจะขึ้น "สลับไปเช็ค" · endpoint นี้ private อาจเปลี่ยนได้ กด "⟳ usage" รีเฟรช (ห่าง ≥180 วิ)<br />
    <b>ความปลอดภัย:</b> token เก็บใน ~/.claude/.mc-accounts/ (เครื่องนี้เท่านั้น, สิทธิ์ 0600) ไม่ push git ไม่แสดงค่า token
  </div>

<script>
  const vscode = acquireVsCodeApi();

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function post(type, extra) {
    const m = { type: type };
    if (extra) { for (const k in extra) { m[k] = extra[k]; } }
    vscode.postMessage(m);
  }

  let lastView = null;
  let usageMap = {};

  function fmtTime(iso) {
    try {
      return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch (e) {
      return "";
    }
  }
  function usageText(show, u) {
    if (!show) return "";
    if (!u) return " · usage: กำลังเช็ค…";
    if (u.status === "expired") return " · usage: token หมดอายุ (สลับไปเช็ค)";
    if (u.status === "ratelimited") return " · usage: เพิ่งเช็ค รอสักครู่";
    if (u.status !== "ok" || !u.usage) return " · usage: ดึงไม่ได้";
    const g = u.usage;
    const parts = [];
    if (g.fiveHour) parts.push("5ชม เหลือ " + g.fiveHour.remaining + "%" + (g.fiveHour.resetsAt ? " (รีเซ็ต " + fmtTime(g.fiveHour.resetsAt) + ")" : ""));
    if (g.sevenDay) parts.push("7วัน เหลือ " + g.sevenDay.remaining + "%");
    return parts.length ? " · " + parts.join(" · ") : " · usage: —";
  }

  function render() {
    const v = lastView;
    if (!v) return;
    const root = document.getElementById("providers");
    const provs = v.providers || [];
    let html = "";
    for (let i = 0; i < provs.length; i++) {
      const ps = provs[i];
      const pAttr = esc(ps.provider);
      const usageBtn = ps.usage ? '<button class="b usage-btn" data-p="' + pAttr + '">⟳ usage</button>' : "";
      html += '<section class="prov">';
      html +=
        '<div class="ph"><div><h2>' + esc(ps.title) + "</h2>" +
        '<div class="live">' + esc(ps.liveText) + "</div></div>" +
        '<div class="ph-btns">' + usageBtn +
        '<button class="primary add" data-p="' + pAttr + '">+ บันทึก account ปัจจุบัน</button></div></div>';
      const list = ps.accounts || [];
      if (!list.length) {
        html += '<div class="empty">ยังไม่มี account ที่บันทึกไว้</div>';
      } else {
        html += '<div class="rows">';
        for (let j = 0; j < list.length; j++) {
          const a = list[j];
          const lAttr = esc(a.label);
          const badge = a.unsaved
            ? ' <span class="badge warn">ใช้อยู่ · ยังไม่บันทึก</span>'
            : a.active
            ? ' <span class="badge">ACTIVE</span>'
            : "";
          const actions = a.unsaved
            ? '<button class="b save" data-p="' + pAttr + '">บันทึก account นี้</button>'
            : (a.active
                ? '<span class="cur">ใช้อยู่</span>'
                : '<button class="b sw" data-p="' + pAttr + '" data-l="' + lAttr + '">สลับ</button>') +
              '<button class="b up" data-p="' + pAttr + '" data-l="' + lAttr + '">อัปเดต</button>' +
              '<button class="b del" data-p="' + pAttr + '" data-l="' + lAttr + '">ลบ</button>';
          html +=
            '<div class="row' + (a.active ? " active" : "") + '">' +
              '<div class="ri">' +
                '<div class="rl">' + esc(a.label) + badge + "</div>" +
                '<div class="rs">' + esc(a.sub || "") + esc(usageText(ps.usage, usageMap[a.label])) + "</div>" +
              "</div>" +
              '<div class="ra">' + actions + "</div>" +
            "</div>";
        }
        html += "</div>";
      }
      html += "</section>";
    }
    root.innerHTML = html;
  }

  document.addEventListener("click", function (e) {
    const t = e.target;
    if (!t || !t.classList || !t.getAttribute) return;
    const p = t.getAttribute("data-p");
    const l = t.getAttribute("data-l");
    if (t.classList.contains("usage-btn")) { post("refresh_usage"); return; }
    if (t.classList.contains("add")) { post("add", { provider: p }); return; }
    if (t.classList.contains("save")) { post("add", { provider: p }); return; }
    if (t.classList.contains("sw")) { post("switch", { provider: p, label: l }); return; }
    if (t.classList.contains("up")) { post("recapture", { provider: p, label: l }); return; }
    if (t.classList.contains("del")) { post("delete", { provider: p, label: l }); return; }
  });

  window.addEventListener("message", function (ev) {
    const m = ev.data;
    if (!m) return;
    if (m.type === "accounts") { lastView = m; render(); }
    else if (m.type === "usage") { usageMap = m.results || {}; render(); }
  });

  post("ready");
</script>
</body></html>`;
}

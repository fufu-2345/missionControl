import * as cp from "node:child_process";

import * as vscode from "vscode";

import { buildCompactSendKeysArgs } from "./claudeSessions";
import { focusedClaudeSession } from "./claudeTerminals";
import { focusedClaudeContext } from "./focusedContext";
import { contextBucket } from "../webview/contextMeter";
import { isSafeSessionName } from "../webview/sessions";

// The clickable context pill in VS Code's status bar. It follows whichever claude
// REPL terminal is focused, shows "% until auto-compact" (colored by severity),
// and on click runs /compact in that session. The in-pane statusLine bar
// (scripts/statusline-context.mjs) stays as the in-REPL glance; this is the
// clickable, always-visible twin — because a terminal can't host a clickable
// widget of its own.

const REFRESH_MS = 4000; // context grows mid-turn; refresh while a REPL is focused
let _item: vscode.StatusBarItem | undefined;
let _timer: ReturnType<typeof setInterval> | undefined;
let _pillSession: string | null = null; // the session the pill currently reflects

function fmtK(n: number): string {
  return n >= 1000 ? Math.round(n / 1000) + "k" : String(n);
}

export function initClaudeContextStatusBar(context: vscode.ExtensionContext): void {
  _item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  _item.command = "missioncontrol.compactFocusedClaude";
  context.subscriptions.push(_item);
  context.subscriptions.push(vscode.window.onDidChangeActiveTerminal(() => void refreshContextPill()));
  _timer = setInterval(() => void refreshContextPill(), REFRESH_MS);
  context.subscriptions.push({ dispose: () => _timer && clearInterval(_timer) });
  void refreshContextPill();
}

/** Recompute + repaint the pill for the focused claude REPL (hide otherwise). */
export async function refreshContextPill(): Promise<void> {
  if (!_item) return;
  const session = focusedClaudeSession();
  if (!session) {
    _pillSession = null;
    _item.hide();
    return;
  }
  const ctx = await focusedClaudeContext(session);
  if (!ctx) {
    _pillSession = null;
    _item.hide();
    return;
  }
  _pillSession = session;
  const bucket = contextBucket(ctx.pct);
  _item.text = `$(dashboard) ctx ${ctx.pct}%`;
  _item.tooltip = new vscode.MarkdownString(
    `**Claude context** — \`${session}\`\n\n` +
      `${ctx.pct}% ของ auto-compact window (${fmtK(ctx.tokens)} / ${fmtK(ctx.limit)} tokens)\n\n` +
      `คลิก = ส่ง \`/compact\` ให้ session นี้`,
  );
  _item.backgroundColor =
    bucket === "crit"
      ? new vscode.ThemeColor("statusBarItem.errorBackground")
      : bucket === "warn"
        ? new vscode.ThemeColor("statusBarItem.warningBackground")
        : undefined;
  _item.show();
}

/** Command (the pill's click / palette): run /compact in the focused claude REPL. */
export async function compactFocusedClaudeCommand(): Promise<void> {
  const session = _pillSession ?? focusedClaudeSession();
  if (!session || !isSafeSessionName(session)) {
    vscode.window.showWarningMessage(
      "ไม่พบ Claude REPL ที่ focus อยู่ — คลิกให้แท็บ Claude เป็น active ก่อน แล้วลองใหม่",
    );
    return;
  }
  // bare session target = active pane; send-keys (no -l) types /compact then Enter.
  const err = await new Promise<Error | null>((resolve) => {
    cp.execFile("tmux", buildCompactSendKeysArgs(session), { timeout: 2000 }, (e) => resolve(e ?? null));
  });
  if (err) {
    vscode.window.showErrorMessage(`ส่ง /compact ไม่สำเร็จ (${session}): ${err.message}`);
    return;
  }
  vscode.window.setStatusBarMessage(`ส่ง /compact ให้ ${session} แล้ว`, 4000);
  // let the compact run, then repaint the (now-smaller) context.
  setTimeout(() => void refreshContextPill(), 1500);
}

import * as vscode from "vscode";

import { injectPathsIntoSession } from "./attachToClaude";
import { focusedClaudeSession } from "./claudeTerminals";
import { isSafeSessionName } from "../webview/sessions";

// A clickable paperclip in VS Code's status bar that follows whichever Claude
// REPL terminal is focused — the terminal itself can't host a clickable widget,
// so this lives in the status bar. Clicking picks a file/image via the native
// dialog and types its absolute path into that session's ACTIVE pane (no Enter —
// the user adds their prompt and submits).
//
// (Context fullness is shown in each REPL's own in-pane statusLine bar rendered
// by scripts/statusline-context.mjs — there is deliberately no VS Code context
// pill, which was confusing across many panes.)

let _item: vscode.StatusBarItem | undefined;
// The session the button currently reflects (captured at refresh time, so a
// click still targets the right REPL even if focus shifts to the status bar).
let _session: string | null = null;

export function initAttachStatusBar(context: vscode.ExtensionContext): void {
  _item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
  _item.text = "$(paperclip)";
  _item.tooltip = new vscode.MarkdownString(
    "**แนบไฟล์เข้า Claude REPL** ที่ focus อยู่\n\n" +
      "เลือกไฟล์/รูป → ใส่ absolute path ให้ในช่อง prompt (ไม่กด Enter — เติม prompt เองแล้วกด)",
  );
  _item.command = "missioncontrol.attachToFocusedClaude";
  context.subscriptions.push(_item);
  context.subscriptions.push(vscode.window.onDidChangeActiveTerminal(() => refreshAttachButton()));
  refreshAttachButton();
}

/** Show the button (and remember the session) when a Claude REPL is focused;
 *  hide it otherwise. Mirrors the context pill's follow-focus behavior. */
export function refreshAttachButton(): void {
  if (!_item) return;
  const session = focusedClaudeSession();
  _session = session;
  if (session) _item.show();
  else _item.hide();
}

/** Command (the button's click / palette): pick file(s) and inject their path(s)
 *  into the focused Claude REPL's active pane. */
export async function attachToFocusedClaudeCommand(): Promise<void> {
  const session = _session ?? focusedClaudeSession();
  if (!session || !isSafeSessionName(session)) {
    vscode.window.showWarningMessage(
      "ไม่พบ Claude REPL ที่ focus อยู่ — คลิกให้แท็บ Claude เป็น active ก่อน แล้วลองใหม่",
    );
    return;
  }
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: true,
    openLabel: "แนบเข้า Claude",
    title: `เลือกไฟล์/รูปเพื่อแนบเข้า ${session}`,
    filters: { รูปภาพ: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"], ทุกไฟล์: ["*"] },
  });
  if (!picked || picked.length === 0) return; // cancelled
  const paths = picked.map((u) => u.fsPath);
  const err = injectPathsIntoSession(session, paths);
  if (err) {
    vscode.window.showErrorMessage(`แนบเข้า Claude ล้มเหลว: ${err}`);
    return;
  }
  vscode.window.setStatusBarMessage(
    `แนบ ${paths.length} ไฟล์เข้า ${session} แล้ว — พิมพ์ prompt ต่อในหน้าต่าง Claude แล้วกด Enter`,
    6000,
  );
}

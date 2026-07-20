import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";

import * as vscode from "vscode";

import { isSafeSessionName } from "../webview/sessions";
import {
  buildAttachText,
  buildClaudeSendKeysArgs,
  clipboardImagePath,
  clipboardImageReadCommand,
  isClaudeReplSession,
  looksLikePng,
  sessionFromTerminalName,
} from "./claudeSessions";

// Attach a file/image to the Claude REPL (the real `claude` CLI in a tmux pane,
// see claude.ts). A raw terminal on this Linux/xrdp box can't accept drag-drop or
// a pasted image, so we get the file from VS Code and TYPE its absolute path into
// the pane via `tmux send-keys -l`; Claude Code's Read tool then ingests it (image
// or text) from that path. Two entry points share the plumbing:
//   • attachToClaudeCommand   — pick a file/image via the native dialog
//   • pasteImageToClaudeCommand — grab an image off the OS clipboard
// The path is inserted WITHOUT pressing Enter: the user adds their own prompt
// around it and submits, which also sidesteps the tmux paste-then-Enter-swallow
// race. Verified live: Claude reads a bare injected path and describes the image.

interface ReplCandidate {
  session: string;
  terminal: vscode.Terminal;
}

/** Open editor terminals that host a single-pane Open-Claude REPL, keyed by tmux
 *  session. Exited terminals and non-claude sessions are skipped; a session seen
 *  twice keeps its first (front-most) terminal. */
function liveReplCandidates(): ReplCandidate[] {
  const out: ReplCandidate[] = [];
  const seen = new Set<string>();
  for (const t of vscode.window.terminals) {
    if (t.exitStatus !== undefined) continue;
    const session = sessionFromTerminalName(t.name);
    if (!session || !isClaudeReplSession(session) || !isSafeSessionName(session)) continue;
    if (seen.has(session)) continue;
    seen.add(session);
    out.push({ session, terminal: t });
  }
  return out;
}

/** Pick which Claude REPL to target: the focused claude tab if any, else the sole
 *  candidate, else a quick-pick. Returns null when there are none (shows a hint)
 *  or the user cancels the pick (silent). */
async function resolveClaudeReplTarget(): Promise<ReplCandidate | null> {
  const candidates = liveReplCandidates();
  if (candidates.length === 0) {
    vscode.window.showInformationMessage(
      'ไม่พบ Claude REPL ที่เปิดอยู่ — เปิดด้วย "Mission Control: Open Claude" ก่อน แล้วลองอีกครั้ง',
    );
    return null;
  }

  const active = vscode.window.activeTerminal;
  const chosenByFocus = candidates.find((c) => c.terminal === active);
  if (chosenByFocus) return chosenByFocus;
  if (candidates.length === 1) return candidates[0];

  const pick = await vscode.window.showQuickPick(
    candidates.map((c) => ({ label: c.session, description: c.terminal.name, cand: c })),
    { placeHolder: "แนบเข้า Claude REPL ตัวไหน?" },
  );
  return pick ? pick.cand : null;
}

/** Insert the given absolute path(s) into the target REPL's prompt (literal, no
 *  Enter), reveal the tab, and flash a status message. `label` names what was
 *  attached. Returns false on a bad session or a tmux failure (already messaged). */
function injectPathsIntoClaude(chosen: ReplCandidate, paths: string[], label: string): boolean {
  const { session, terminal } = chosen;
  // Defensive re-guard: candidates are whitelist-checked, but never let an
  // unvalidated name reach the tmux target.
  if (!isSafeSessionName(session)) {
    vscode.window.showErrorMessage(`Attach: ชื่อ session ไม่ปลอดภัย (${session})`);
    return false;
  }
  const text = buildAttachText(paths);
  if (!text) return false; // nothing usable

  try {
    // argv (no shell) — an arbitrary path is passed as one literal arg.
    cp.execFileSync("tmux", buildClaudeSendKeysArgs(session, text));
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`แนบเข้า Claude ล้มเหลว: ${m}`);
    return false;
  }

  terminal.show(false); // reveal + focus the REPL so the user can type + Enter
  vscode.window.setStatusBarMessage(
    `แนบ ${label} เข้า ${session} แล้ว — พิมพ์คำสั่งต่อในหน้าต่าง Claude แล้วกด Enter`,
    6000,
  );
  return true;
}

/** Command: pick a file/image and inject its path into the Claude REPL. */
export async function attachToClaudeCommand() {
  const chosen = await resolveClaudeReplTarget();
  if (!chosen) return;

  const picked = await vscode.window.showOpenDialog({
    canSelectMany: true,
    openLabel: "แนบเข้า Claude",
    title: "เลือกไฟล์/รูปเพื่อแนบเข้า Claude REPL",
    filters: {
      รูปภาพ: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"],
      ทุกไฟล์: ["*"],
    },
  });
  if (!picked || picked.length === 0) return; // cancelled

  const paths = picked.map((u) => u.fsPath);
  const label = paths.map((p) => p.split("/").pop() || p).join(", ");
  injectPathsIntoClaude(chosen, paths, label);
}

/** Command: grab an image off the OS clipboard, save it to a temp file, and
 *  inject that path into the Claude REPL. */
export async function pasteImageToClaudeCommand() {
  const chosen = await resolveClaudeReplTarget();
  if (!chosen) return;

  const readCmd = clipboardImageReadCommand(process.env);
  if (!readCmd) {
    vscode.window.showErrorMessage(
      "วางรูปจาก clipboard ไม่ได้: ไม่พบ display server (ต้องมี DISPLAY สำหรับ X11 หรือ WAYLAND_DISPLAY)",
    );
    return;
  }

  let bytes: Buffer;
  try {
    bytes = cp.execFileSync(readCmd.tool, readCmd.args, { maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code === "ENOENT") {
      vscode.window.showErrorMessage(
        `วางรูปจาก clipboard ต้องติดตั้ง ${readCmd.tool} ก่อน (เช่น: sudo apt install ${readCmd.tool})`,
      );
    } else {
      // xclip/wl-paste exit non-zero when the clipboard has no image/png target.
      vscode.window.showInformationMessage(
        "ไม่พบรูปใน clipboard — copy รูปก่อน (เช่น screenshot) แล้วลองใหม่",
      );
    }
    return;
  }

  if (!bytes || bytes.length === 0 || !looksLikePng(bytes)) {
    vscode.window.showInformationMessage(
      "ไม่พบรูปใน clipboard — copy รูปก่อน (เช่น screenshot) แล้วลองใหม่",
    );
    return;
  }

  const tmpPath = clipboardImagePath(os.tmpdir(), Date.now());
  try {
    fs.writeFileSync(tmpPath, bytes);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`บันทึกรูปจาก clipboard ล้มเหลว: ${m}`);
    return;
  }

  injectPathsIntoClaude(chosen, [tmpPath], "รูปจาก clipboard");
}

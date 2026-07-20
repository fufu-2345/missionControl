import * as vscode from "vscode";

import { sessionFromTerminalName } from "./claudeSessions";

// Registry mapping each VS Code terminal to the tmux session it hosts, so the
// context status-bar pill + "compact focused Claude" command know which claude
// session the user is looking at — even when the tab's title is a project name
// (dashboard re-attach) or "orchestrator: <x>" rather than "tmux: <session>".
// Every place that opens a tmux-attached terminal calls trackClaudeTerminal.

const _reg = new Map<vscode.Terminal, string>();

/** Register cleanup once (drop closed terminals). Call from activate(). */
export function initClaudeTerminalRegistry(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.window.onDidCloseTerminal((t) => _reg.delete(t)));
}

/** Record that `terminal` hosts tmux `session`. Called at each creation site. */
export function trackClaudeTerminal(terminal: vscode.Terminal, session: string): void {
  _reg.set(terminal, session);
}

/** tmux session of the currently-focused terminal: the registry first, then a
 *  "tmux: <name>" title fallback. null when no tmux/claude terminal is focused. */
export function focusedClaudeSession(): string | null {
  const t = vscode.window.activeTerminal;
  if (!t || t.exitStatus !== undefined) return null;
  return _reg.get(t) ?? sessionFromTerminalName(t.name);
}

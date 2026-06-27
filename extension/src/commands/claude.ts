import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

// "Open Claude" runs the Claude Code CLI exactly like typing `claude` in
// ~/Desktop/soulbrew: same environment, and Claude Code picks up the project
// config at ~/Desktop/soulbrew/.claude because that IS the cwd. The terminal is
// opened in the EDITOR area (main screen, big) instead of the bottom panel.
//
// (The official Claude Code extension's native chat can't be used here: it
// follows the open VSCode workspace folder, so it can't be pinned to
// soulbrew/.claude unless soulbrew itself is the workspace.)
const SOULBREW_DIR = path.join(os.homedir(), "Desktop", "soulbrew");

let terminal: vscode.Terminal | undefined;

export async function claudeCommand(_context: vscode.ExtensionContext) {
  // Reuse a still-open session instead of stacking new editor terminals.
  if (terminal && terminal.exitStatus === undefined) {
    terminal.show(false);
    return;
  }
  const term = vscode.window.createTerminal({
    name: "Claude (soulbrew)",
    cwd: SOULBREW_DIR,
    location: vscode.TerminalLocation.Editor, // main editor area, not the panel
  });
  terminal = term;
  term.show(false);

  // Run `claude` exactly once, cleanly. Sending text into a freshly-created
  // terminal races the shell's first prompt and gets echoed TWICE; shell
  // integration waits until the shell is ready and runs the command once.
  // Fall back to a delayed sendText if shell integration never initializes.
  let launched = false;
  const launch = () => {
    if (launched || term.exitStatus !== undefined) return;
    launched = true;
    if (term.shellIntegration) term.shellIntegration.executeCommand("claude");
    else term.sendText("claude");
  };

  if (term.shellIntegration) {
    launch();
    return;
  }
  const sub = vscode.window.onDidChangeTerminalShellIntegration((e) => {
    if (e.terminal === term) {
      sub.dispose();
      launch();
    }
  });
  // Shell integration disabled/unavailable → send after the prompt has had
  // time to render (the delay is what avoids the double-echo race).
  setTimeout(() => {
    sub.dispose();
    launch();
  }, 2500);
}

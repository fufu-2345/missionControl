import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

// Claude Code reads its PROJECT config from the `.claude/` directory in its
// working directory. Launching `claude` with cwd = the soulbrew project root
// therefore makes it use ~/Desktop/soulbrew/.claude (as requested).
const SOULBREW_DIR = path.join(os.homedir(), "Desktop", "soulbrew");

// Reused across invocations so repeated clicks don't stack new terminals.
let terminal: vscode.Terminal | undefined;

/**
 * Open a Claude Code session in an integrated terminal, rooted at the soulbrew
 * project so it picks up ~/Desktop/soulbrew/.claude. Reveals the existing
 * terminal if one is still open instead of spawning another.
 */
export async function claudeCommand(_context: vscode.ExtensionContext) {
  if (terminal && terminal.exitStatus === undefined) {
    terminal.show(false);
    return;
  }
  terminal = vscode.window.createTerminal({
    name: "Claude (soulbrew)",
    cwd: SOULBREW_DIR,
  });
  terminal.show(false);
  // `claude` resolves via the interactive shell's PATH (nvm). cwd above is what
  // ties this session to soulbrew/.claude.
  terminal.sendText("claude");
}

import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

// "Open Terminal" — opens a plain shell (CLI) in the EDITOR area at the soulbrew
// workbench root, exactly like "Open Claude" opens claude (same click → same
// spot). Type maw / git / anything here. Reuses one terminal instead of
// stacking new ones on repeated clicks.
const SOULBREW_DIR = path.join(os.homedir(), "Desktop", "soulbrew");

let terminal: vscode.Terminal | undefined;

export async function terminalCommand(_context: vscode.ExtensionContext) {
  // Reuse a still-open CLI terminal instead of opening another.
  if (terminal && terminal.exitStatus === undefined) {
    terminal.show(false);
    return;
  }
  const term = vscode.window.createTerminal({
    name: "CLI (soulbrew)",
    cwd: SOULBREW_DIR,
    location: vscode.TerminalLocation.Editor, // main editor area, like Open Claude
  });
  terminal = term;
  term.show(false);
}

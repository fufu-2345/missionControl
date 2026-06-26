import * as vscode from "vscode";

import { getCurrentProjectId } from "../projectState";
import { openSkillsPanel } from "../webview/skills";

export async function skillsCommand(
  _context: vscode.ExtensionContext,
): Promise<void> {
  try {
    const pid = getCurrentProjectId();
    openSkillsPanel(pid);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(
      `Mission Control: View Skills failed — ${msg}`,
    );
  }
}

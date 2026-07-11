import * as vscode from "vscode";

import { openSettingsPanel } from "../webview/settings";

/** Open the Settings page (edit ~/.mission-control/config.json). Thin wrapper
 *  mirroring accountsCommand — the real work lives in webview/settings.ts +
 *  commands/settingsOps.ts. */
export async function settingsCommand(_context: vscode.ExtensionContext): Promise<void> {
  try {
    openSettingsPanel();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Mission Control: Settings failed — ${msg}`);
  }
}

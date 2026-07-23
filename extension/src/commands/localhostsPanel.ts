import * as vscode from "vscode";

import { openLocalhostsPanel } from "../webview/localhosts";

/** Open the Localhosts panel — a full editor-area tab listing running dev
 *  servers grouped by project. Thin wrapper mirroring accountsCommand; the real
 *  work lives in webview/localhosts.ts + commands/localhostScan.ts. */
export async function localhostsCommand(_context: vscode.ExtensionContext): Promise<void> {
  try {
    openLocalhostsPanel();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Mission Control: Localhosts failed — ${msg}`);
  }
}

import * as vscode from "vscode";

import { openAccountsPanel } from "../webview/accounts";

/** Open the Accounts panel (save + switch between Claude subscription logins).
 *  Thin wrapper mirroring teamsCommand — the real work lives in
 *  webview/accounts.ts + commands/accountsOps.ts. */
export async function accountsCommand(_context: vscode.ExtensionContext): Promise<void> {
  try {
    openAccountsPanel();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Mission Control: Accounts failed — ${msg}`);
  }
}

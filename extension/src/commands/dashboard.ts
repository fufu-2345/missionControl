import * as vscode from "vscode";

import { getCurrentProjectId } from "../projectState";
import { openDashboardPanel } from "../webview/dashboard";

export async function dashboardCommand(
  context: vscode.ExtensionContext,
): Promise<void> {
  try {
    openDashboardPanel(context, getCurrentProjectId());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(
      `Mission Control: Open Dashboard failed — ${msg}`,
    );
  }
}

import * as vscode from "vscode";

import { notifyBackendDisabled } from "./api";

export function registerStatusBar(context: vscode.ExtensionContext): void {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.command = "missioncontrol.togglePm2";
  item.tooltip = "Mission Control (frontend-only build)";
  item.text = "Mission Control";
  item.show();

  const toggle = vscode.commands.registerCommand("missioncontrol.togglePm2", () => {
    notifyBackendDisabled();
  });

  context.subscriptions.push(item, toggle);
}

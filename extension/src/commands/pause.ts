import * as vscode from "vscode";

import { notifyBackendDisabled } from "../api";

// Frontend-only build: pause/resume drove the backend sprint, which has been
// removed. This command now only shows the friendly "backend disabled" notice.
export async function pauseCommand(_context: vscode.ExtensionContext) {
  notifyBackendDisabled();
}

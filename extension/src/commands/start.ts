import * as vscode from "vscode";

import { notifyBackendDisabled } from "../api";

// Frontend-only build: Start drove a backend planning session (/session/*),
// which has been removed. This command now only shows the disabled notice.
export async function startCommand(_context: vscode.ExtensionContext) {
  notifyBackendDisabled();
}

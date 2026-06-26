import * as vscode from "vscode";

import { notifyBackendDisabled } from "../api";

// Frontend-only build: budget figures came from the backend /budget endpoint,
// which has been removed. This command now only shows the disabled notice.
export async function budgetCommand(_context: vscode.ExtensionContext) {
  notifyBackendDisabled();
}

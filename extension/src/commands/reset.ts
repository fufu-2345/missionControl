import * as vscode from "vscode";

import { notifyBackendDisabled } from "../api";

// Frontend-only build: reset wiped backend runtime state (Redis / workspace /
// Qdrant) via the /reset endpoint, which has been removed. There is nothing to
// reset client-side, so this command now only shows the disabled notice.
export async function resetCommand(_context: vscode.ExtensionContext) {
  notifyBackendDisabled();
}

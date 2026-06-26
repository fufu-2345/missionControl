import * as vscode from "vscode";

import { notifyBackendDisabled } from "../api";

// Frontend-only build: status came from the backend /status endpoint, which
// has been removed. This command now only shows the "backend disabled" notice.
export async function statusCommand(_context: vscode.ExtensionContext) {
  notifyBackendDisabled();
}

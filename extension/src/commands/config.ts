import * as vscode from "vscode";

import { notifyBackendDisabled } from "../api";

// Frontend-only build: config get/set went through the backend /config
// endpoint, which has been removed. Now only shows the disabled notice.
export async function configCommand(_context: vscode.ExtensionContext) {
  notifyBackendDisabled();
}

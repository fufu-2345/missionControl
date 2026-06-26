import * as vscode from "vscode";

import { notifyBackendDisabled } from "../api";

// Frontend-only build: Setup installed/started the backend and stored a GitHub
// PAT for it (scripts/install.sh, pm2, POST /setup). The backend is gone, so
// this command now only shows the disabled notice.
export async function setupCommand(_context: vscode.ExtensionContext) {
  notifyBackendDisabled();
}

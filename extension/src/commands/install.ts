import * as vscode from "vscode";

import { notifyBackendDisabled } from "../api";

// Frontend-only build: Install ran the backend's scripts/install.sh (Redis,
// Qdrant, BGE-M3, PM2). The backend is gone, so this command now only shows
// the disabled notice instead of spawning an installer.
export async function installCommand(_context: vscode.ExtensionContext) {
  notifyBackendDisabled();
}

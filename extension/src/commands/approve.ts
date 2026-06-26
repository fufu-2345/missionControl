import * as vscode from "vscode";

import { notifyBackendDisabled } from "../api";

// Frontend-only build: approving ideas fetched the queue from the backend
// /ideas endpoint, which has been removed. Now only shows the disabled notice.
export async function approveCommand(_context: vscode.ExtensionContext) {
  notifyBackendDisabled();
}

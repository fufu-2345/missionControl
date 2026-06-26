import * as vscode from "vscode";

// ─── Frontend-only build ────────────────────────────────────────────────────
// The backend (REST :7000 / WS :7001) has been removed from this build. `api()`
// performs NO network I/O — it rejects so every existing call site falls
// through to its empty / disabled state instead of trying to connect. Commands
// that the user explicitly triggers should call `notifyBackendDisabled()` first
// so they show a friendly notice instead of an error. SERVER_URL is retained
// only for import compatibility; nothing ever contacts it.
export const BACKEND_DISABLED = true;
export const SERVER_URL = "http://127.0.0.1:7000"; // never contacted in this build

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

let _noticeShown = false;
/**
 * Show a single, gentle "backend disabled" info toast (debounced for the whole
 * session). Call from any user-triggered command that used to hit the backend,
 * so the user learns WHY nothing happens — without an error popup.
 */
export function notifyBackendDisabled(): void {
  if (_noticeShown) return;
  _noticeShown = true;
  void vscode.window.showInformationMessage(
    "Mission Control: frontend-only build — backend features are disabled.",
  );
}

/**
 * No-op API shim. Always rejects with a benign ApiError(0, …) WITHOUT touching
 * the network. Background callers already swallow failures (→ empty state).
 */
export async function api<T>(_path: string, _init?: RequestInit): Promise<T> {
  throw new ApiError(0, "frontend-only build — backend disabled");
}

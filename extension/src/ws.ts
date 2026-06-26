import * as vscode from "vscode";

// ─── Frontend-only build ────────────────────────────────────────────────────
// The realtime WS backend (:7001) has been removed. WSClient is kept as a
// no-op stub so the rest of the extension compiles and runs unchanged — it
// never opens a socket, never reconnects, and never emits events. Any handler
// registered via `on()` simply never fires.
export type WSEvent = { event: string; data: unknown };
export type WSHandler = (ev: WSEvent) => void;

export class WSClient implements vscode.Disposable {
  on(_handler: WSHandler): void {
    // no-op: no backend to receive events from in this build
  }

  start(): void {
    // no-op: frontend-only build, nothing to connect to
  }

  dispose(): void {
    // no-op
  }
}

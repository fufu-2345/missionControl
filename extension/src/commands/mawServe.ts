import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

// Toggle the maw UI server (`maw serve`, http://localhost:3456) on/off — all in
// the background, NO terminal. Click when down → start it (detached child via a
// login shell so ~/.bun/bin is on PATH; output → log file; survives VS Code).
// Click when up → stop whatever is listening on :3456 (SIGTERM, then SIGKILL).
const MAW_PORT = 3456;
const LOG_FILE = path.join(os.homedir(), ".maw", "maw-serve.vscode.log");

/** Quick TCP liveness probe — is something listening on `port`? Used to reflect
 *  live up/down state for maw (:3456) and oracle (:47778) without a backend. */
export function isPortUp(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const finish = (v: boolean) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(700);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
  });
}

/** Is the maw UI server up on :3456? Exported so the sidebar can reflect live
 *  on/off state on the toggle button. */
export function isMawUp(): Promise<boolean> {
  return isPortUp(MAW_PORT);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Kill whatever holds :3456. `signal` "9" forces it. Resolves regardless. */
function killMaw(signal: "" | "-9" = ""): Promise<void> {
  return new Promise((resolve) => {
    cp.exec(
      `bash -lc "ss -ltnp 'sport = :${MAW_PORT}' 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u | xargs -r kill ${signal}"`,
      () => resolve(),
    );
  });
}

async function startMaw(): Promise<void> {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  const out = fs.openSync(LOG_FILE, "a");
  const child = cp.spawn("bash", ["-lc", "maw serve"], {
    cwd: os.homedir(),
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
}

export async function mawToggleCommand(_context: vscode.ExtensionContext) {
  if (await isMawUp()) {
    // ── STOP ──────────────────────────────────────────────────────────────
    await killMaw();
    for (let i = 0; i < 8; i++) {
      await sleep(400);
      if (!(await isMawUp())) {
        void vscode.window.showInformationMessage("Mission Control: maw ui stopped ⏹");
        return;
      }
    }
    await killMaw("-9"); // graceful stop didn't take — force it
    for (let i = 0; i < 6; i++) {
      await sleep(400);
      if (!(await isMawUp())) {
        void vscode.window.showInformationMessage("Mission Control: maw ui stopped ⏹");
        return;
      }
    }
    void vscode.window.showWarningMessage(
      `Mission Control: maw ui is still responding on :${MAW_PORT} after stop.`,
    );
    return;
  }

  // ── START ─────────────────────────────────────────────────────────────────
  try {
    await startMaw();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    void vscode.window.showErrorMessage(
      `Mission Control: failed to start maw ui — ${msg}`,
    );
    return;
  }
  for (let i = 0; i < 16; i++) {
    await sleep(500);
    if (await isMawUp()) {
      void vscode.window.showInformationMessage(
        `Mission Control: maw ui is up 🟢 http://localhost:${MAW_PORT}`,
      );
      return;
    }
  }
  void vscode.window.showInformationMessage(
    `Mission Control: maw ui starting in background… (logs → ${LOG_FILE})`,
  );
}

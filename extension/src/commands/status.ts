import * as cp from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

import { isPortUp } from "./mawServe";

// Frontend-only build: there is no sprint to report on, so "status" reports what
// is actually running in this oracle/maw/claude setup — maw (:3456) and oracle
// (:47778) liveness + the soulbrew git state. All local, no backend.
const SOULBREW = path.join(os.homedir(), "Desktop", "soulbrew");

function gitState(): Promise<string> {
  return new Promise((resolve) => {
    cp.exec(
      `git -C ${JSON.stringify(SOULBREW)} status --porcelain --branch`,
      { timeout: 4000 },
      (err, stdout) => {
        if (err) {
          resolve("unavailable");
          return;
        }
        const lines = stdout.split("\n").filter(Boolean);
        const branch = (lines[0] ?? "## ?").replace(/^## /, "").split("...")[0];
        const dirty = lines.length - 1;
        resolve(`${branch} ${dirty > 0 ? `(${dirty} changed)` : "(clean)"}`);
      },
    );
  });
}

export async function statusCommand(_context: vscode.ExtensionContext) {
  const [maw, oracle, git] = await Promise.all([
    isPortUp(3456),
    isPortUp(47778),
    gitState(),
  ]);
  const detail =
    `maw ui  (:3456):   ${maw ? "🟢 up" : "⚪ down"}\n` +
    `oracle  (:47778):  ${oracle ? "🟢 up" : "⚪ down"}\n` +
    `soulbrew git:      ${git}`;
  const buttons = maw ? ["Open maw ui"] : [];
  const choice = await vscode.window.showInformationMessage(
    "local status",
    { modal: true, detail },
    ...buttons,
  );
  if (choice === "Open maw ui") {
    void vscode.env.openExternal(vscode.Uri.parse("http://localhost:3456"));
  }
}

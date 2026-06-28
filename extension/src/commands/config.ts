import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

// Frontend-only build: the backend /config endpoint is gone, but the knobs still
// live on disk at ~/.mission-control/config.json. This edits that file directly
// via quick-pick + input — pure local fs, no backend. Several keys only drove the
// removed orchestrator, so we flag them as legacy (saved, but inert).
const CONFIG_PATH = path.join(os.homedir(), ".mission-control", "config.json");
const LEGACY = new Set(["agents", "decentralized_review", "auto_loop"]);

export async function configCommand(_context: vscode.ExtensionContext) {
  let cfg: Record<string, unknown>;
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as Record<string, unknown>;
  } catch {
    void vscode.window.showErrorMessage(`Mission Control: can't read ${CONFIG_PATH}`);
    return;
  }

  const items: vscode.QuickPickItem[] = Object.keys(cfg).map((k) => ({
    label: k,
    description: String(cfg[k]),
    detail: LEGACY.has(k)
      ? "legacy — saved but no longer drives anything (backend removed)"
      : undefined,
  }));
  const pick = await vscode.window.showQuickPick(items, {
    title: "Mission Control config — pick a key to edit",
    matchOnDescription: true,
  });
  if (!pick) return;

  const key = pick.label;
  const cur = cfg[key];
  let next: unknown;
  if (typeof cur === "boolean") {
    const b = await vscode.window.showQuickPick(["true", "false"], {
      title: `${key}  (current: ${cur})`,
    });
    if (b === undefined) return;
    next = b === "true";
  } else if (typeof cur === "number") {
    const v = await vscode.window.showInputBox({
      title: `${key}  (number)`,
      value: String(cur),
      validateInput: (s) =>
        s.trim() !== "" && Number.isFinite(Number(s)) ? null : "must be a number",
    });
    if (v === undefined) return;
    next = Number(v);
  } else {
    const v = await vscode.window.showInputBox({ title: key, value: String(cur ?? "") });
    if (v === undefined) return;
    next = v;
  }

  cfg[key] = next;
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  } catch {
    void vscode.window.showErrorMessage(`Mission Control: failed to write ${CONFIG_PATH}`);
    return;
  }
  void vscode.window.showInformationMessage(
    `Mission Control: set ${key} = ${String(next)}` +
      (LEGACY.has(key) ? " (legacy key — no runtime effect)" : ""),
  );
}

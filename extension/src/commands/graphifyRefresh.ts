// [graphify-temp] TEMPORARY / isolated feature — remove this whole file + the
// 4 `[graphify-temp]` blocks in webview/settings.ts to fully uninstall.
//
// Refresh a graphify code-graph from the Settings page: pick a repo that already
// has a graph in ~/.oracle/graphify/, then rebuild graph.json + the force-directed
// graph.html (algorithmic clustering, NO LLM), copy the HTML to ~/graphify-view/,
// and leave the source repo pristine. Mirrors the spawn+notify pattern in
// mawServe.ts (login shell so ~/.local/bin/graphify is on PATH).
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

const GRAPH_DIR = path.join(os.homedir(), ".oracle", "graphify");
const VIEW_DIR = path.join(os.homedir(), "graphify-view");
// Temporary hardcode — matches the existing soulbrew root used elsewhere in MC.
const WS = path.join(os.homedir(), "Desktop", "soulbrew", "github.com");

/** Repos that already have a built graph (dirs under ~/.oracle/graphify with a graph.json). */
function graphedRepos(): string[] {
  try {
    return fs
      .readdirSync(GRAPH_DIR)
      .filter((n) => fs.existsSync(path.join(GRAPH_DIR, n, "graph.json")))
      .sort();
  } catch {
    return [];
  }
}

/** Rebuild graph.json + force-directed graph.html for one repo. No LLM, repo left pristine. */
function runRefresh(name: string): Promise<void> {
  const script =
    `export PATH="$HOME/.local/bin:$PATH"; set -e; ` +
    `NAME=${JSON.stringify(name)}; ` +
    `REPO=$(find ${JSON.stringify(WS)} -maxdepth 2 -type d -name "$NAME" | head -1); ` +
    `if [ -z "$REPO" ]; then echo "source repo not found for $NAME under ${WS}" >&2; exit 3; fi; ` +
    `graphify update "$REPO" >/dev/null 2>&1; ` +
    `graphify cluster-only "$REPO" --no-label >/dev/null 2>&1; ` +
    `mkdir -p ${JSON.stringify(GRAPH_DIR)}/"$NAME" ${JSON.stringify(VIEW_DIR)}; ` +
    `cp "$REPO/graphify-out/graph.json" ${JSON.stringify(GRAPH_DIR)}/"$NAME"/graph.json; ` +
    `cp "$REPO/graphify-out/graph.html" ${JSON.stringify(VIEW_DIR)}/"$NAME"-graph.html; ` +
    `rm -rf "$REPO/graphify-out"`;
  return new Promise((resolve) => {
    let stderr = "";
    const child = cp.spawn("bash", ["-lc", script], { cwd: os.homedir() });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (e) => {
      vscode.window.showErrorMessage(`Graphify refresh failed to start: ${e.message}`);
      resolve();
    });
    child.on("close", (code) => {
      if (code === 0) {
        void vscode.window.showInformationMessage(
          `Graphify: ${name} refreshed 🟢  (graph.json + ~/graphify-view/${name}-graph.html)`,
        );
      } else {
        void vscode.window.showErrorMessage(
          `Graphify refresh failed for ${name} (exit ${code}): ${(stderr || "").trim().slice(0, 240)}`,
        );
      }
      resolve();
    });
  });
}

/** Settings-page entry point: pick a repo, then rebuild its graph with a progress toast. */
export async function graphifyRefreshCommand(): Promise<void> {
  const repos = graphedRepos();
  if (!repos.length) {
    void vscode.window.showWarningMessage(
      "Graphify: no graphs found in ~/.oracle/graphify — nothing to refresh.",
    );
    return;
  }
  const pick = await vscode.window.showQuickPick(repos, {
    title: "Refresh Graphify — เลือก repo",
    placeHolder: "rebuild graph.json + force-directed graph.html (no LLM)",
  });
  if (!pick) return;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Graphify: refreshing ${pick}…`,
      cancellable: false,
    },
    () => runRefresh(pick),
  );
}

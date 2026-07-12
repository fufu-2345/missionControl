import * as vscode from "vscode";

import {
  findGraphHtml,
  graphifyBaseDir,
  type GraphEntry,
} from "./graphDiscovery";

// vscode glue for the "Open code graph" tile / command. Discovery logic is in
// graphDiscovery.ts (unit-tested). graph.html loads vis-network from a CDN, so
// it CANNOT render in a webview (CSP blocks it) — we open it in the external
// browser, which also needs internet for that CDN.

interface GraphPick extends vscode.QuickPickItem {
  entry: GraphEntry;
}

/** Find graphify graph.html(s) under ~/.oracle/graphify and open one in the
 *  default browser. 0 → info message; 1 → open; many → QuickPick then open. */
export async function openCodeGraphCommand(): Promise<void> {
  const graphs = findGraphHtml(graphifyBaseDir());

  if (graphs.length === 0) {
    void vscode.window.showInformationMessage(
      "ยังไม่มี code graph — รัน `graphify update .` ใน repo ก่อน " +
        "(เก็บที่ ~/.oracle/graphify/<repo>/graph.html)",
    );
    return;
  }

  let chosen: GraphEntry = graphs[0];
  if (graphs.length > 1) {
    const pick = await vscode.window.showQuickPick<GraphPick>(
      graphs.map((g) => ({
        label: g.repo,
        description: g.htmlPath,
        entry: g,
      })),
      { placeHolder: "เลือก repo ที่จะเปิด code graph" },
    );
    if (!pick) return; // cancelled
    chosen = pick.entry;
  }

  // openExternal on a file:// URI hands off to the OS → default browser.
  await vscode.env.openExternal(vscode.Uri.file(chosen.htmlPath));
}

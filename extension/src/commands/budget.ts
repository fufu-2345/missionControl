import * as vscode from "vscode";

import { MONTHLY_CAP_KEY, computeUsage, getInstantUsage } from "../usage";
import { buildBudgetView, openBudgetPanel } from "../webview/budget";

// Real Claude Code spend, computed locally from ~/.claude/projects transcripts —
// no backend. Primary UI is a floating QuickPick popup (no editor tab); the
// "ดูแบบละเอียด" item opens the themed webview panel for the full view.
// Compute + cap logic are shared with the panel via buildBudgetView.

interface Row extends vscode.QuickPickItem {
  action?: "setCap" | "clearCap" | "detail";
}

async function setCap(context: vscode.ExtensionContext): Promise<void> {
  const cap = context.globalState.get<number>(MONTHLY_CAP_KEY);
  const input = await vscode.window.showInputBox({
    title: "Monthly budget cap (USD)",
    value: cap ? String(cap) : "100",
    prompt: "เทียบกับยอดใช้จ่าย Claude Code ที่คำนวณของเดือนปฏิทินนี้",
    validateInput: (v) =>
      Number.isFinite(parseFloat(v)) && parseFloat(v) > 0 ? null : "ต้องเป็นตัวเลขบวก",
  });
  if (input === undefined) return;
  await context.globalState.update(MONTHLY_CAP_KEY, parseFloat(input));
}

async function clearCap(context: vscode.ExtensionContext): Promise<void> {
  const pick = await vscode.window.showWarningMessage(
    "ล้างเพดานงบรายเดือน?",
    { modal: true },
    "ล้าง",
  );
  if (pick === "ล้าง") await context.globalState.update(MONTHLY_CAP_KEY, undefined);
}

/** Show the budget as a floating QuickPick. Re-shows itself after a cap edit
 *  so the numbers stay live without leaving the popup. */
async function showBudgetPopup(context: vscode.ExtensionContext): Promise<void> {
  // Instant: use the cached snapshot (kicks a background refresh for next time);
  // only the very first run ever awaits a scan. The QuickPick is one-shot so it
  // shows the cached numbers — a budget glance doesn't need sub-15s freshness.
  const u = (await getInstantUsage()) ?? (await computeUsage());
  const v = buildBudgetView(context, u);

  const items: Row[] = [
    { label: "$(calendar) " + v.monthFmt, description: "เดือนนี้" },
    { label: "$(clock) " + v.todayFmt, description: "วันนี้" },
    { label: "$(history) " + v.last7Fmt, description: "7 วันล่าสุด" },
    { label: "$(graph) " + v.allTimeFmt, description: "ทั้งหมด" },
  ];
  if (v.providerNote) {
    items.push({ label: "$(warning) " + v.providerNote });
  }
  items.push(
    { label: "เพดานงบ", kind: vscode.QuickPickItemKind.Separator },
    {
      label: "$(gear) " + (v.hasCap ? "แก้เพดานงบรายเดือน" : "ตั้งเพดานงบรายเดือน"),
      description: v.capNote,
      action: "setCap",
    },
  );
  if (v.hasCap) {
    items.push({ label: "$(trash) ล้างเพดานงบ", action: "clearCap" });
  }

  const tokFmt = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
  items.push({ label: "Top projects", kind: vscode.QuickPickItemKind.Separator });
  for (const p of [...v.projects].sort((a, b) => b.cost - a.cost).slice(0, 5)) {
    items.push({ label: p.name, description: p.costFmt + " · " + tokFmt.format(p.tokens) + " tok" });
  }

  items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
  items.push({
    label: "$(list-tree) ดูแบบละเอียด",
    description: "เปิดหน้ารายละเอียดเต็ม (hero · tiles · progress bar)",
    action: "detail",
  });

  const qp = vscode.window.createQuickPick<Row>();
  qp.title = "Mission Control — Claude usage: " + v.monthFmt + " this month";
  qp.placeholder = v.sessions + " sessions · คำนวณจาก ~/.claude/projects · Anthropic list pricing";
  qp.items = items;
  qp.matchOnDescription = true;

  const picked = await new Promise<Row | undefined>((resolve) => {
    qp.onDidAccept(() => resolve(qp.selectedItems[0]));
    qp.onDidHide(() => resolve(undefined));
    qp.show();
  });
  qp.dispose();

  if (!picked?.action) return;
  if (picked.action === "detail") {
    openBudgetPanel(context);
  } else if (picked.action === "setCap") {
    await setCap(context);
    await showBudgetPopup(context);
  } else if (picked.action === "clearCap") {
    await clearCap(context);
    await showBudgetPopup(context);
  }
}

export async function budgetCommand(context: vscode.ExtensionContext): Promise<void> {
  try {
    await showBudgetPopup(context);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Mission Control: Budget failed — ${msg}`);
  }
}

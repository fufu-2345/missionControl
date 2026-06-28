import * as os from "node:os";

import * as vscode from "vscode";

import {
  MONTHLY_CAP_KEY,
  computeUsage,
  localMonthKey,
  localTodayKey,
  sumByPrefix,
} from "../usage";

// Real Claude Code spend, computed locally from ~/.claude/projects transcripts —
// no backend. Shows this-month / today / 7-day / all-time USD and lets the user
// set a monthly cap (stored in globalState; compared against this month's spend).
// All day buckets are LOCAL dates so "today"/"this month" match the user's clock.
const fmt = (n: number) => "$" + n.toFixed(2);

export async function budgetCommand(context: vscode.ExtensionContext) {
  const u = await computeUsage(true);
  const month = sumByPrefix(u, localMonthKey());
  const today = sumByPrefix(u, localTodayKey());

  // Last 7 local days (inclusive of today): from local midnight 6 days ago.
  let last7 = 0;
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - 6);
  for (const day of Object.keys(u.byDay)) {
    const t = new Date(day + "T00:00:00"); // no "Z" → local midnight
    if (!Number.isNaN(t.getTime()) && t.getTime() >= cutoff.getTime()) {
      last7 += u.byDay[day].cost;
    }
  }

  const cap = context.globalState.get<number>(MONTHLY_CAP_KEY);
  const capLine = cap
    ? `Monthly cap: ${fmt(cap)} — ${month > cap ? "⚠️ OVER by " + fmt(month - cap) : fmt(cap - month) + " left"}`
    : "Monthly cap: (not set)";

  const home = os.homedir();
  const topProjects = Object.keys(u.byProject)
    .map((p) => ({ p, cost: u.byProject[p].cost }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 5)
    .map((x) => `  ${fmt(x.cost)}  ${x.p.replace(home, "~")}`)
    .join("\n");

  const detail =
    `This month:   ${fmt(month)}\n` +
    `Today:        ${fmt(today)}\n` +
    `Last 7 days:  ${fmt(last7)}\n` +
    `All time:     ${fmt(u.total.cost)}\n\n` +
    `${capLine}\n\n` +
    `Top projects (all time):\n${topProjects}\n\n` +
    `(${u.fileCount} sessions · computed from ~/.claude/projects · Anthropic list pricing)`;

  const buttons = ["Set monthly cap"];
  if (cap) buttons.push("Clear cap");

  const choice = await vscode.window.showInformationMessage(
    `Mission Control — Claude usage: ${fmt(month)} this month`,
    { modal: true, detail },
    ...buttons,
  );

  if (choice === "Set monthly cap") {
    const input = await vscode.window.showInputBox({
      title: "Monthly budget cap (USD)",
      value: cap ? String(cap) : "100",
      prompt: "Compared against this calendar month's computed Claude Code spend.",
      validateInput: (v) =>
        Number.isFinite(parseFloat(v)) && parseFloat(v) > 0 ? null : "must be a positive number",
    });
    if (input === undefined) return;
    const v = parseFloat(input);
    await context.globalState.update(MONTHLY_CAP_KEY, v);
    void vscode.window.showInformationMessage(`Mission Control: monthly cap set to ${fmt(v)}`);
  } else if (choice === "Clear cap") {
    await context.globalState.update(MONTHLY_CAP_KEY, undefined);
    void vscode.window.showInformationMessage("Mission Control: monthly cap cleared");
  }
}

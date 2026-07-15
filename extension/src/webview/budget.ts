import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

import { type ProjectDetail, buildDetail } from "../budget-detail";
import {
  MONTHLY_CAP_KEY,
  type Breakdown,
  type UsageSummary,
  addBreakdown,
  computeUsage,
  emptyBreakdown,
  getInstantUsage,
  localMonthKey,
  localTodayKey,
  refreshUsage,
  sumByPrefix,
  unwiredProviders,
} from "../usage";

// Editor-area panel for real Claude Code spend, computed locally from
// ~/.claude/projects transcripts (no backend). Replaces the old native
// showInformationMessage modal — same data + cap logic, themed webview
// so it matches the Accounts/Teams panels. Singleton _panel mirrors
// accounts.ts; the client script stays dumb (host sends display-ready
// strings), and cap edits round-trip through native input/confirm prompts.
let _panel: vscode.WebviewPanel | undefined;

const fmt = (n: number) => "$" + n.toFixed(2);

/** A "project" is any directory that lives under a `projects/` folder — that's
 *  where the /orches build projects go (github.com/…/projects/<name>). Given a
 *  recorded cwd, resolve it to that project (root = `…/projects/<name>`, so all
 *  the sub-dir cwds Claude Code logs — <name>/src, <name>/src/cmds, … — collapse
 *  onto one entry). Returns null for anything not under a projects/ folder
 *  (oracles, tools, home) or that is transient / gone. */
function resolveProject(cwd: string): { root: string; name: string } | null {
  const segs = cwd.split(path.sep);
  // last "projects" segment that still has a child (the project name)
  let idx = -1;
  for (let i = 0; i < segs.length; i++) {
    if (segs[i] === "projects" && i + 1 < segs.length) idx = i;
  }
  if (idx < 0) return null;
  const root = segs.slice(0, idx + 2).join(path.sep);
  // Drop Claude Code's own session store (~/.claude/projects/*) and temp dirs —
  // they contain a "projects" segment too but aren't user projects.
  const home = os.homedir();
  const rel = root.startsWith(home) ? root.slice(home.length) : root;
  if (rel.split(path.sep).some((s) => s.startsWith("."))) return null;
  if (root === "/tmp" || root.startsWith("/tmp/")) return null;
  try {
    if (!fs.statSync(root).isDirectory()) return null;
  } catch {
    return null; // deleted / gone
  }
  return { root, name: segs[idx + 1] };
}

export interface BudgetView {
  monthFmt: string;
  todayFmt: string;
  last7Fmt: string;
  allTimeFmt: string;
  capState: "none" | "under" | "over";
  capNote: string;
  capPct: number;
  hasCap: boolean;
  projects: ProjectRow[]; // every project under projects/ — client sorts + pages
  monthStartMs: number; // local start-of-month (ms) — client's "this month" filter
  providerNote: string; // reminder when a provider on disk isn't summed in yet ("" = none)
  sessions: number;
}

export interface ProjectRow {
  name: string;
  path: string;
  costFmt: string;
  cost: number; // numeric $ — for the bar + QuickPick top-5
  tokens: number; // total tokens — client sorts by "token ที่ใช้"
  lastMs: number; // last activity (ms) — client sorts by recency + month filter
  detail: ProjectDetail; // per-category token/$ split — powers the click-to-open pie popup
}

/** Build the full display view from a usage snapshot `u`: this-month / today /
 *  7-day / all-time USD, cap status, and the projects — all pre-formatted.
 *  Pure (no scanning) so callers decide instant-cached vs freshly-scanned. */
export function buildBudgetView(context: vscode.ExtensionContext, u: UsageSummary): BudgetView {
  const month = sumByPrefix(u, localMonthKey());
  const today = sumByPrefix(u, localTodayKey());

  // Last 7 local days (inclusive of today): from local midnight 6 days ago.
  let last7 = 0;
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - 6);
  for (const day of Object.keys(u.byDay)) {
    const t = new Date(day + "T00:00:00"); // no "Z" -> local midnight
    if (!Number.isNaN(t.getTime()) && t.getTime() >= cutoff.getTime()) {
      last7 += u.byDay[day].cost;
    }
  }

  const cap = context.globalState.get<number>(MONTHLY_CAP_KEY);
  let capState: "none" | "under" | "over" = "none";
  let capNote = "ยังไม่ได้ตั้งเพดานรายเดือน";
  let capPct = 0;
  if (cap && cap > 0) {
    capPct = Math.min(100, Math.round((month / cap) * 100));
    if (month > cap) {
      capState = "over";
      capNote = "เกินงบ " + fmt(month - cap) + " (เพดาน " + fmt(cap) + ")";
    } else {
      capState = "under";
      capNote = "เหลืออีก " + fmt(cap - month) + " จากเพดาน " + fmt(cap);
    }
  }

  const home = os.homedir();

  // Collapse every recorded cwd onto its project under projects/, summing cost
  // and keeping the newest activity. cwds not under a projects/ folder (oracles,
  // tools, home) are skipped.
  const byKey = new Map<
    string,
    { cost: number; tokens: number; lastMs: number; name: string; det: Breakdown }
  >();
  for (const cwd of Object.keys(u.byProject)) {
    const proj = resolveProject(cwd);
    if (!proj) continue;
    const cur =
      byKey.get(proj.root) ?? { cost: 0, tokens: 0, lastMs: 0, name: proj.name, det: emptyBreakdown() };
    cur.cost += u.byProject[cwd].cost;
    cur.tokens += u.byProject[cwd].tokens;
    cur.lastMs = Math.max(cur.lastMs, u.projectLastMs[cwd] ?? 0);
    cur.det = addBreakdown(cur.det, u.byProjectDetail[cwd] ?? emptyBreakdown());
    byKey.set(proj.root, cur);
  }
  const projects: ProjectRow[] = [...byKey.entries()]
    .map(([key, b]) => ({
      name: b.name,
      path: key.startsWith(home) ? "~" + key.slice(home.length) : key,
      costFmt: fmt(b.cost),
      cost: b.cost,
      tokens: b.tokens,
      lastMs: b.lastMs,
      detail: buildDetail(b.det),
    }))
    .sort((a, b) => b.lastMs - a.lastMs); // default order; client re-sorts

  // Local start-of-month for the client's "this month" filter.
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  // Reminder: a provider CLI is present on disk but its spend isn't wired into
  // this total yet (e.g. the user just added Gemini). Nudge them to include it.
  const unwired = unwiredProviders();
  const providerNote = unwired.length
    ? "พบ " + unwired.join(", ") + " บนเครื่อง — ยอดนี้ยังนับเฉพาะ Claude Code (ยังไม่รวม provider เหล่านี้)"
    : "";

  return {
    monthFmt: fmt(month),
    todayFmt: fmt(today),
    last7Fmt: fmt(last7),
    allTimeFmt: fmt(u.total.cost),
    capState,
    capNote,
    capPct,
    hasCap: !!(cap && cap > 0),
    projects,
    monthStartMs: monthStart.getTime(),
    providerNote,
    sessions: u.fileCount,
  };
}

function postView(
  context: vscode.ExtensionContext,
  panel: vscode.WebviewPanel,
  u: UsageSummary,
): void {
  panel.webview.postMessage({ type: "budget", ...buildBudgetView(context, u) });
}

/** Paint instantly from the cached snapshot, then repaint when a fresh scan
 *  lands (stale-while-revalidate) — the panel never blocks on the ~5s cold
 *  parse. Only the very first run (no snapshot at all) awaits one scan. */
function pushInstant(context: vscode.ExtensionContext, panel: vscode.WebviewPanel): void {
  void (async () => {
    const cached = await getInstantUsage();
    if (cached) {
      postView(context, panel, cached);
      void refreshUsage()
        .then((fresh) => postView(context, panel, fresh))
        .catch(() => {});
    } else {
      postView(context, panel, await computeUsage());
    }
  })();
}

/** Explicit refresh button — recompute from disk, then repaint. */
function pushFresh(context: vscode.ExtensionContext, panel: vscode.WebviewPanel): void {
  void refreshUsage()
    .then((u) => postView(context, panel, u))
    .catch(() => {});
}

/** Repaint after a cap edit — cap doesn't change spend, so use the cached
 *  snapshot (no scan needed). */
function pushCap(context: vscode.ExtensionContext, panel: vscode.WebviewPanel): void {
  void (async () => {
    const u = (await getInstantUsage()) ?? (await computeUsage());
    postView(context, panel, u);
  })();
}

export function openBudgetPanel(context: vscode.ExtensionContext): vscode.WebviewPanel {
  if (_panel) {
    _panel.reveal();
    pushInstant(context, _panel);
    return _panel;
  }
  const panel = vscode.window.createWebviewPanel(
    "missioncontrol.budget",
    "Budget",
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  _panel = panel;
  panel.onDidDispose(() => {
    _panel = undefined;
  });

  panel.webview.html = renderShell();

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (!msg || typeof msg.type !== "string") return;

    switch (msg.type) {
      case "ready": // initial open — instant cached paint + background refresh
        pushInstant(context, panel);
        return;
      case "reload": // explicit ⟳ refresh button — recompute from disk
        pushFresh(context, panel);
        return;

      case "setCap": {
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
        pushCap(context, panel);
        return;
      }

      case "clearCap": {
        const pick = await vscode.window.showWarningMessage(
          "ล้างเพดานงบรายเดือน?",
          { modal: true },
          "ล้าง",
        );
        if (pick !== "ล้าง") return;
        await context.globalState.update(MONTHLY_CAP_KEY, undefined);
        pushCap(context, panel);
        return;
      }
    }
  });

  return panel;
}

// NOTE: the inline <script> below lives inside this template literal. Keep it
// FREE of backslashes and backticks — both are processed when the literal is
// evaluated and would silently corrupt the client script (a known foot-gun in
// this codebase). Regexes used here (/&/g etc.) contain no backslashes.
function renderShell(): string {
  return `<!DOCTYPE html><html lang="th"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 22px 24px; margin: 0;
  }
  .wrap { max-width: 760px; margin: 0 auto; }
  .head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin-bottom: 22px; }
  .title { font-size: 13px; font-weight: 600; letter-spacing: 0.4px; text-transform: uppercase; opacity: 0.6; margin: 0 0 6px; }
  .hero { font-size: 40px; font-weight: 800; line-height: 1; letter-spacing: -1px; }
  .hero .cur { font-size: 22px; font-weight: 700; opacity: 0.55; vertical-align: 6px; margin-right: 2px; }
  .hero-sub { font-size: 12px; opacity: 0.6; margin-top: 6px; }
  .refresh {
    background: transparent; color: var(--vscode-foreground);
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35)); border-radius: 6px;
    padding: 6px 12px; font-size: 12px; cursor: pointer; flex-shrink: 0; white-space: nowrap;
  }
  .refresh:hover { border-color: var(--vscode-focusBorder); background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.15)); }

  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-bottom: 22px; }
  .tile {
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25)); border-radius: 10px;
    padding: 14px 16px; background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.05));
  }
  .tile .k { font-size: 11px; font-weight: 600; letter-spacing: 0.4px; text-transform: uppercase; opacity: 0.6; }
  .tile .v { font-size: 22px; font-weight: 700; margin-top: 7px; letter-spacing: -0.5px; }

  .section-k { font-size: 11px; font-weight: 600; letter-spacing: 0.4px; text-transform: uppercase; opacity: 0.6; margin: 0 0 10px; }

  .cap {
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25)); border-radius: 10px;
    padding: 15px 17px; margin-bottom: 24px;
  }
  .cap-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
  .cap-note { font-size: 13px; font-weight: 600; }
  .cap-note.over { color: var(--vscode-charts-red, #f14c4c); }
  .cap-note.none { opacity: 0.6; font-weight: 500; }
  .cap-btns { display: flex; gap: 6px; flex-shrink: 0; }
  .bar { height: 8px; border-radius: 6px; background: var(--vscode-panel-border, rgba(128,128,128,0.25)); overflow: hidden; }
  .bar > span { display: block; height: 100%; border-radius: 6px; background: var(--vscode-charts-green, #3fb950); transition: width 0.3s; }
  .bar > span.warn { background: var(--vscode-charts-yellow, #d18616); }
  .bar > span.over { background: var(--vscode-charts-red, #f14c4c); }
  .cap-pct { font-size: 11px; opacity: 0.6; margin-top: 7px; text-align: right; }

  .primary {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; border-radius: 6px; padding: 7px 13px; font-size: 12.5px; font-weight: 600;
    cursor: pointer; white-space: nowrap;
  }
  .primary:hover { background: var(--vscode-button-hoverBackground); }
  .b {
    background: transparent; color: var(--vscode-foreground);
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35)); border-radius: 6px;
    padding: 7px 12px; font-size: 12.5px; cursor: pointer; white-space: nowrap;
  }
  .b:hover { border-color: var(--vscode-focusBorder); background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.15)); }

  .rows { display: flex; flex-direction: column; gap: 8px; }
  .prow {
    display: grid; grid-template-columns: 22px 1fr auto; align-items: center; gap: 12px;
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.22)); border-radius: 8px;
    padding: 10px 14px; background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.04));
  }
  .prow .rank { font-size: 12px; opacity: 0.45; font-variant-numeric: tabular-nums; text-align: center; }
  .prow .pth { min-width: 0; }
  .prow .path { font-size: 13px; font-family: var(--vscode-editor-font-family, monospace); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .prow .pbar { height: 4px; border-radius: 4px; background: var(--vscode-panel-border, rgba(128,128,128,0.2)); margin-top: 7px; overflow: hidden; }
  .prow .pbar > span { display: block; height: 100%; background: var(--vscode-charts-blue, #4d9de0); opacity: 0.7; border-radius: 4px; }
  .prow .cost { font-size: 14px; font-weight: 700; font-variant-numeric: tabular-nums; text-align: right; }
  .prow .tok { font-size: 11px; font-weight: 500; opacity: 0.55; margin-top: 3px; font-variant-numeric: tabular-nums; }
  .empty { opacity: 0.55; font-size: 12.5px; padding: 12px 4px; }

  .pk-head { display: flex; align-items: center; justify-content: space-between; gap: 12px 10px; margin-bottom: 10px; flex-wrap: wrap; }
  .sortbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .search {
    background: var(--vscode-input-background, transparent); color: var(--vscode-input-foreground, inherit);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, rgba(128,128,128,0.35)));
    border-radius: 6px; padding: 6px 10px; font-size: 12px; width: 150px;
  }
  .search::placeholder { color: var(--vscode-input-placeholderForeground, currentColor); opacity: 0.6; }
  .search:focus { outline: none; border-color: var(--vscode-focusBorder); }
  .dir { padding: 6px 11px; font-size: 13px; line-height: 1; }
  /* fixed width so toggling "ล่าสุด" <-> "token ที่ใช้" doesn't resize the button */
  #sort-field { min-width: 96px; text-align: center; }
  #scope { min-width: 68px; text-align: center; }
  #metric { min-width: 56px; text-align: center; }
  .b.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; font-weight: 600; }
  .pager { display: flex; align-items: center; justify-content: center; gap: 14px; margin-top: 14px; font-size: 12px; }
  .pager .pinfo { opacity: 0.6; font-variant-numeric: tabular-nums; }
  .b[disabled] { opacity: 0.4; cursor: default; }

  .notice {
    margin-bottom: 18px; padding: 10px 14px; border-radius: 8px; font-size: 12px; line-height: 1.5;
    border: 1px solid var(--vscode-charts-yellow, #d18616);
    background: color-mix(in srgb, var(--vscode-charts-yellow, #d18616) 12%, transparent);
    color: var(--vscode-foreground);
  }

  .foot {
    margin-top: 22px; padding-top: 14px; font-size: 11.5px; line-height: 1.6; opacity: 0.6;
    border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
  }

  /* project row is clickable -> opens the token breakdown popup */
  .prow { cursor: pointer; transition: border-color 0.12s; }
  .prow:hover { border-color: var(--vscode-focusBorder); }

  #modal-bg {
    display: none; position: fixed; inset: 0; z-index: 50;
    background: rgba(0,0,0,0.5); align-items: center; justify-content: center; padding: 24px;
  }
  #modal {
    position: relative; width: 100%; max-width: 380px;
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
    border-radius: 12px; padding: 20px 22px; box-shadow: 0 8px 32px rgba(0,0,0,0.4);
  }
  #modal-x {
    position: absolute; top: 10px; right: 12px; background: transparent;
    color: var(--vscode-foreground); border: none; font-size: 15px; cursor: pointer; opacity: 0.6; line-height: 1;
  }
  #modal-x:hover { opacity: 1; }
  #modal-head { margin-bottom: 16px; padding-right: 20px; }
  .m-name { font-size: 15px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .m-total { font-size: 12px; opacity: 0.6; margin-top: 3px; font-variant-numeric: tabular-nums; }
  .m-chart { display: flex; justify-content: center; margin-bottom: 16px; }
  .pie { width: 170px; height: 170px; }
  .pie path, .pie circle { stroke: var(--vscode-editor-background); stroke-width: 1.5; transition: opacity 0.12s; }
  .pie path:hover, .pie circle:hover { opacity: 0.85; }
  .m-legend { display: flex; flex-direction: column; gap: 7px; }
  .lg { display: grid; grid-template-columns: 14px 1fr auto auto; align-items: center; gap: 9px; font-size: 12.5px; cursor: default; }
  .lg .sw { width: 12px; height: 12px; border-radius: 3px; display: inline-block; }
  .lg-label { opacity: 0.85; }
  .lg-text { font-variant-numeric: tabular-nums; opacity: 0.7; }
  .lg-pct { font-variant-numeric: tabular-nums; font-weight: 600; min-width: 42px; text-align: right; }
  .m-empty { opacity: 0.6; font-size: 13px; padding: 12px 0; text-align: center; }

  #tip {
    display: none; position: fixed; z-index: 60; pointer-events: none; max-width: 240px;
    padding: 7px 10px; border-radius: 6px; font-size: 11.5px; line-height: 1.45;
    background: var(--vscode-editorHoverWidget-background, #252526);
    color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground));
    border: 1px solid var(--vscode-editorHoverWidget-border, rgba(128,128,128,0.4));
    box-shadow: 0 2px 10px rgba(0,0,0,0.35);
  }
</style>
</head>
<body>
<div class="wrap">
  <div class="head">
    <div>
      <div class="title">Mission Control — Claude usage</div>
      <div class="hero"><span id="hero">—</span></div>
      <div class="hero-sub">ยอดใช้จ่ายเดือนนี้ (คำนวณจาก transcript ในเครื่อง)</div>
    </div>
    <button class="refresh" id="refresh">⟳ รีเฟรช</button>
  </div>

  <div class="tiles" id="tiles"></div>

  <div class="notice" id="provider-note" style="display:none"></div>

  <div class="section-k">เพดานงบรายเดือน</div>
  <div class="cap" id="cap"></div>

  <div class="pk-head">
    <div class="section-k" id="projects-k" style="margin:0">โปรเจกต์</div>
    <div class="sortbar">
      <input class="search" id="proj-search" type="text" placeholder="ค้นหาชื่อโปรเจค…" />
      <button class="b" id="sort-field" title="สลับเกณฑ์เรียง">ล่าสุด</button>
      <button class="b dir" id="sort-dir" title="สลับมากไปน้อย / น้อยไปมาก">↓</button>
      <button class="b" id="scope" title="สลับ เดือนนี้ / ทั้งหมด">เดือนนี้</button>
      <button class="b" id="metric" title="สลับหน่วยที่แสดง USD / token ที่ใช้">USD</button>
    </div>
  </div>
  <div class="rows" id="projects"></div>
  <div class="pager" id="pager"></div>

  <div class="foot" id="foot"></div>
</div>

<div id="modal-bg"><div id="modal">
  <button id="modal-x" title="ปิด">✕</button>
  <div id="modal-head"></div>
  <div id="modal-body"></div>
</div></div>
<div id="tip"></div>

<script>
  const vscode = acquireVsCodeApi();

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function money(fmt) {
    const s = esc(fmt);
    if (s.charAt(0) === "$") return '<span class="cur">$</span>' + s.slice(1);
    return s;
  }
  function post(type) { vscode.postMessage({ type: type }); }

  var TOKFMT = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
  function fmtTokens(n) { return TOKFMT.format(n || 0) + " tok"; }

  var PAGE_SIZE = 10;
  var STATE = { view: null, sortKey: "recent", sortDir: "desc", scope: "month", query: "", page: 0, maxCost: 0, metric: "usd" };

  function renderProjects() {
    var v = STATE.view;
    if (!v) return;
    var list = (v.projects || []).slice();
    // scope filter: this-month (touched since local month start) vs all
    if (STATE.scope === "month") {
      list = list.filter(function (p) { return p.lastMs >= v.monthStartMs; });
    }
    // name search
    var q = STATE.query.trim().toLowerCase();
    if (q) list = list.filter(function (p) { return p.name.toLowerCase().indexOf(q) !== -1; });
    // sort by chosen key + direction; break exact ties by name so the order is
    // stable (never depends on Map/insertion order).
    list.sort(function (a, b) {
      var d = STATE.sortKey === "tokens" ? a.tokens - b.tokens : a.lastMs - b.lastMs;
      if (d === 0) return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
      return STATE.sortDir === "desc" ? -d : d;
    });
    var total = list.length;
    var pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (STATE.page >= pages) STATE.page = pages - 1;
    if (STATE.page < 0) STATE.page = 0;
    var start = STATE.page * PAGE_SIZE;
    var slice = list.slice(start, start + PAGE_SIZE);

    document.getElementById("projects-k").textContent = "โปรเจกต์ (" + total + ")";
    document.getElementById("sort-field").textContent = STATE.sortKey === "tokens" ? "token ที่ใช้" : "ล่าสุด";
    document.getElementById("sort-dir").textContent = STATE.sortDir === "desc" ? "↓" : "↑";
    document.getElementById("metric").textContent = STATE.metric === "tokens" ? "token" : "USD";
    var scopeBtn = document.getElementById("scope");
    scopeBtn.textContent = STATE.scope === "all" ? "ทั้งหมด" : "เดือนนี้";
    scopeBtn.classList[STATE.scope === "all" ? "add" : "remove"]("active");

    var el = document.getElementById("projects");
    if (!total) {
      el.innerHTML = '<div class="empty">ยังไม่มีข้อมูลการใช้จ่าย</div>';
      document.getElementById("pager").innerHTML = "";
      return;
    }
    el.innerHTML = slice
      .map(function (p, i) {
        var pct = STATE.maxCost > 0 ? Math.max(3, Math.round((p.cost / STATE.maxCost) * 100)) : 0;
        var rank = start + i + 1;
        // metric toggle: "usd" → cost big, tokens small (default) · "tokens" → swapped
        var big = STATE.metric === "tokens" ? esc(fmtTokens(p.tokens)) : money(p.costFmt);
        var small = STATE.metric === "tokens" ? money(p.costFmt) : esc(fmtTokens(p.tokens));
        return (
          '<div class="prow" data-key="' + esc(p.path) + '"><div class="rank">' + rank + "</div>" +
          '<div class="pth"><div class="path" title="' + esc(p.path) + '">' + esc(p.name) + "</div>" +
          '<div class="pbar"><span style="width:' + pct + '%"></span></div></div>' +
          '<div class="cost">' + big +
          '<div class="tok">' + small + "</div></div></div>"
        );
      })
      .join("");

    var pg = document.getElementById("pager");
    if (pages <= 1) {
      pg.innerHTML = "";
    } else {
      pg.innerHTML =
        '<button class="b" id="pg-prev"' + (STATE.page === 0 ? " disabled" : "") + ">‹ ก่อนหน้า</button>" +
        '<span class="pinfo">หน้า ' + (STATE.page + 1) + "/" + pages + "</span>" +
        '<button class="b" id="pg-next"' + (STATE.page >= pages - 1 ? " disabled" : "") + ">ถัดไป ›</button>";
    }
  }

  function render(v) {
    STATE.view = v;
    STATE.maxCost = (v.projects || []).reduce(function (m, x) { return x.cost > m ? x.cost : m; }, 0);
    document.getElementById("hero").innerHTML = money(v.monthFmt);

    const tiles = [
      { k: "เดือนนี้", v: v.monthFmt },
      { k: "วันนี้", v: v.todayFmt },
      { k: "7 วันล่าสุด", v: v.last7Fmt },
      { k: "ทั้งหมด", v: v.allTimeFmt },
    ];
    document.getElementById("tiles").innerHTML = tiles
      .map(function (t) {
        return '<div class="tile"><div class="k">' + esc(t.k) + '</div><div class="v">' + money(t.v) + "</div></div>";
      })
      .join("");

    const barCls = v.capState === "over" ? "over" : v.capPct >= 80 ? "warn" : "";
    let capHtml = '<div class="cap-top">';
    capHtml += '<div class="cap-note ' + esc(v.capState) + '">' + esc(v.capNote) + "</div>";
    capHtml += '<div class="cap-btns"><button class="primary" id="setcap">' + (v.hasCap ? "แก้เพดาน" : "ตั้งเพดาน") + "</button>";
    if (v.hasCap) capHtml += '<button class="b" id="clearcap">ล้าง</button>';
    capHtml += "</div></div>";
    if (v.hasCap) {
      capHtml += '<div class="bar"><span class="' + barCls + '" style="width:' + v.capPct + '%"></span></div>';
      capHtml += '<div class="cap-pct">' + v.capPct + "% ของเพดาน</div>";
    }
    document.getElementById("cap").innerHTML = capHtml;

    var pn = document.getElementById("provider-note");
    if (v.providerNote) {
      pn.textContent = "⚠ " + v.providerNote;
      pn.style.display = "block";
    } else {
      pn.style.display = "none";
    }

    renderProjects();

    document.getElementById("foot").textContent =
      v.sessions + " sessions · คำนวณจาก ~/.claude/projects · Anthropic list pricing";
  }

  document.addEventListener("click", function (e) {
    var t = e.target;
    if (!t) return;
    // clicking anywhere on a project row opens its token breakdown popup
    // (row children have no id, so this must run before the id checks)
    var row = t.closest ? t.closest(".prow") : null;
    if (row && row.getAttribute("data-key")) { openModal(row.getAttribute("data-key")); return; }
    // close the popup: the X button, or a click on the dim backdrop itself
    if (t.id === "modal-x" || t.id === "modal-bg") { closeModal(); return; }
    if (!t.id) return;
    if (t.id === "refresh") post("reload");
    else if (t.id === "setcap") post("setCap");
    else if (t.id === "clearcap") post("clearCap");
    else if (t.id === "sort-field") { STATE.sortKey = STATE.sortKey === "recent" ? "tokens" : "recent"; STATE.page = 0; renderProjects(); }
    else if (t.id === "sort-dir") { STATE.sortDir = STATE.sortDir === "desc" ? "asc" : "desc"; STATE.page = 0; renderProjects(); }
    else if (t.id === "scope") { STATE.scope = STATE.scope === "month" ? "all" : "month"; STATE.page = 0; renderProjects(); }
    else if (t.id === "metric") { STATE.metric = STATE.metric === "usd" ? "tokens" : "usd"; renderProjects(); }
    else if (t.id === "pg-prev") { STATE.page -= 1; renderProjects(); }
    else if (t.id === "pg-next") { STATE.page += 1; renderProjects(); }
  });

  document.addEventListener("input", function (e) {
    const t = e.target;
    if (t && t.id === "proj-search") { STATE.query = t.value || ""; STATE.page = 0; renderProjects(); }
  });

  window.addEventListener("message", function (ev) {
    const m = ev.data;
    if (m && m.type === "budget") render(m);
  });

  // ── Per-project token breakdown popup (pie + legend + hover tooltip) ─────────
  var MODAL_SLICES = {}; // key -> slice, for tooltip lookup while a popup is open

  function openModal(key) {
    var v = STATE.view;
    if (!v) return;
    var list = v.projects || [];
    var p = null;
    for (var i = 0; i < list.length; i++) { if (list[i].path === key) { p = list[i]; break; } }
    if (!p) return;
    var d = p.detail || { slices: [], totalText: "", hasCost: false };
    MODAL_SLICES = {};
    for (var j = 0; j < d.slices.length; j++) MODAL_SLICES[d.slices[j].key] = d.slices[j];
    document.getElementById("modal-head").innerHTML =
      '<div class="m-name" title="' + esc(p.path) + '">' + esc(p.name) + "</div>" +
      '<div class="m-total">' + esc(d.totalText) + "</div>";
    var body = document.getElementById("modal-body");
    if (!d.hasCost) {
      body.innerHTML = '<div class="m-empty">ไม่มีค่าใช้จ่ายที่คิดเงินได้สำหรับโปรเจกต์นี้</div>';
    } else {
      body.innerHTML =
        '<div class="m-chart">' + pieSvg(d.slices) + "</div>" +
        '<div class="m-legend">' + legendHtml(d.slices) + "</div>";
    }
    document.getElementById("modal-bg").style.display = "flex";
  }

  function legendHtml(slices) {
    return slices
      .map(function (s) {
        return (
          '<div class="lg" data-k="' + esc(s.key) + '">' +
          '<span class="sw" style="background:' + esc(s.color) + '"></span>' +
          '<span class="lg-label">' + esc(s.label) + "</span>" +
          '<span class="lg-text">' + esc(s.text) + "</span>" +
          '<span class="lg-pct">' + esc(String(s.pct)) + "%</span></div>"
        );
      })
      .join("");
  }

  // Hand-drawn SVG pie (no external chart lib). Slices sized by cost; each path
  // carries data-k so hovering shows that category's meaning.
  function pieSvg(slices) {
    var draw = [];
    var sum = 0;
    for (var i = 0; i < slices.length; i++) {
      if (slices[i].cost > 0) { draw.push(slices[i]); sum += slices[i].cost; }
    }
    if (!draw.length || sum <= 0) return "";
    var svg = '<svg viewBox="0 0 200 200" class="pie">';
    if (draw.length === 1) {
      return (
        svg +
        '<circle cx="100" cy="100" r="92" fill="' + esc(draw[0].color) +
        '" data-k="' + esc(draw[0].key) + '"></circle></svg>'
      );
    }
    var ang = -90; // start at 12 o'clock
    for (var k = 0; k < draw.length; k++) {
      var a0 = ang;
      var a1 = ang + (draw[k].cost / sum) * 360;
      ang = a1;
      var large = a1 - a0 > 180 ? 1 : 0;
      var x0 = (100 + 92 * Math.cos((a0 * Math.PI) / 180)).toFixed(2);
      var y0 = (100 + 92 * Math.sin((a0 * Math.PI) / 180)).toFixed(2);
      var x1 = (100 + 92 * Math.cos((a1 * Math.PI) / 180)).toFixed(2);
      var y1 = (100 + 92 * Math.sin((a1 * Math.PI) / 180)).toFixed(2);
      svg +=
        '<path d="M100 100 L' + x0 + " " + y0 + " A92 92 0 " + large + " 1 " + x1 + " " + y1 +
        ' Z" fill="' + esc(draw[k].color) + '" data-k="' + esc(draw[k].key) + '"></path>';
    }
    return svg + "</svg>";
  }

  function closeModal() {
    document.getElementById("modal-bg").style.display = "none";
    hideTip();
  }

  function showTip(key, x, y) {
    var s = MODAL_SLICES[key];
    if (!s) { hideTip(); return; }
    var tip = document.getElementById("tip");
    tip.innerHTML = "<b>" + esc(s.label) + "</b><br>" + esc(s.meaning);
    tip.style.display = "block";
    tip.style.left = x + 14 + "px";
    tip.style.top = y + 14 + "px";
  }
  function hideTip() { document.getElementById("tip").style.display = "none"; }

  // One handler drives show/move/hide: only while a popup is open, and only when
  // the cursor is over a slice or legend row (both tagged data-k).
  document.addEventListener("mousemove", function (e) {
    if (document.getElementById("modal-bg").style.display !== "flex") return;
    var t = e.target;
    var el = t && t.closest ? t.closest("[data-k]") : null;
    if (el) showTip(el.getAttribute("data-k"), e.clientX, e.clientY);
    else hideTip();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeModal();
  });

  post("ready");
</script>
</body></html>`;
}

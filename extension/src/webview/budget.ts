import * as os from "node:os";

import * as vscode from "vscode";

import { type ProjectDetail, buildDetail } from "../budget-detail";
import { openBudgetDetailPanel } from "./budget-detail-page";
import {
  type ProjectAgg,
  type UsageSummary,
  computeUsage,
  getInstantUsage,
  getProjectLedger,
  groupByProjectRoot,
  localMonthKey,
  localTodayKey,
  refreshUsage,
  sumByPrefix,
  unwiredProviders,
} from "../usage";

// Editor-area panel for real Claude Code spend, computed locally from
// ~/.claude/projects transcripts (no backend). Replaces the old native
// showInformationMessage modal — themed webview so it matches the
// Accounts/Teams panels. Singleton _panel mirrors accounts.ts; the client
// script stays dumb (host sends display-ready strings).
let _panel: vscode.WebviewPanel | undefined;

const fmt = (n: number) => "$" + n.toFixed(2);

// resolveProject / groupByProjectRoot (cwd -> project root/name grouping) live in
// usage.ts so the detail page reuses the exact same grouping — imported above.

export interface BudgetView {
  monthFmt: string;
  todayFmt: string;
  last7Fmt: string;
  allTimeFmt: string;
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
  live: boolean; // false = folder/transcripts gone now; numbers come from the durable ledger
}

/** Build the full display view from a usage snapshot `u`: this-month / today /
 *  7-day / all-time USD and the projects — all pre-formatted. Reads the durable
 *  project ledger (a small cached file, not a rescan) so projects whose folder
 *  was since deleted locally still show their last-known spend instead of
 *  silently disappearing. */
export async function buildBudgetView(u: UsageSummary): Promise<BudgetView> {
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

  const home = os.homedir();

  // Live grouping: every recorded cwd collapsed onto its project under
  // projects/ (cwds not under a projects/ folder — oracles, tools, home — are
  // skipped). Then fold in any ledger-only root NOT seen in this live scan —
  // a project whose folder (or transcripts) are gone locally now, but whose
  // last-known totals are still worth showing.
  const byKey = new Map<string, ProjectAgg & { live: boolean }>();
  for (const [root, agg] of Object.entries(groupByProjectRoot(u))) {
    byKey.set(root, { ...agg, live: true });
  }
  const ledger = await getProjectLedger();
  for (const [root, entry] of Object.entries(ledger)) {
    if (byKey.has(root)) continue; // live data is at least as fresh — keep it
    byKey.set(root, {
      name: entry.name, cost: entry.cost, tokens: entry.tokens, lastMs: entry.lastMs,
      det: entry.detail, live: false,
    });
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
      live: b.live,
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
    projects,
    monthStartMs: monthStart.getTime(),
    providerNote,
    sessions: u.fileCount,
  };
}

async function postView(panel: vscode.WebviewPanel, u: UsageSummary): Promise<void> {
  panel.webview.postMessage({ type: "budget", ...(await buildBudgetView(u)) });
}

/** Paint instantly from the cached snapshot, then repaint when a fresh scan
 *  lands (stale-while-revalidate) — the panel never blocks on the ~5s cold
 *  parse. Only the very first run (no snapshot at all) awaits one scan. */
function pushInstant(panel: vscode.WebviewPanel): void {
  void (async () => {
    const cached = await getInstantUsage();
    if (cached) {
      void postView(panel, cached).catch(() => {});
      void refreshUsage()
        .then((fresh) => postView(panel, fresh))
        .catch(() => {});
    } else {
      void postView(panel, await computeUsage()).catch(() => {});
    }
  })();
}

/** Explicit refresh button — recompute from disk, then repaint. */
function pushFresh(panel: vscode.WebviewPanel): void {
  void refreshUsage()
    .then((u) => postView(panel, u))
    .catch(() => {});
}

export function openBudgetPanel(): vscode.WebviewPanel {
  if (_panel) {
    _panel.reveal();
    pushInstant(_panel);
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
        pushInstant(panel);
        return;
      case "reload": // explicit ⟳ refresh button — recompute from disk
        pushFresh(panel);
        return;

      case "openProjectDetail": {
        const { projectPath, projectName } = msg;
        if (typeof projectPath !== "string" || typeof projectName !== "string") return;
        // projectPath is the display path ("~/…") — expand ~ back to an absolute
        // root so collapseProjectHours can match it against the cwd keys.
        const absRoot = projectPath.startsWith("~")
          ? os.homedir() + projectPath.slice(1)
          : projectPath;
        const current = (await getInstantUsage()) ?? (await computeUsage());
        openBudgetDetailPanel(absRoot, projectName, current);
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

  /* ledger-only row: project's folder/transcripts are gone locally now — totals
     come from the durable ledger, not a live rescan */
  .prow.removed { opacity: 0.72; }
  .tag-removed { font-size: 11px; font-weight: 500; opacity: 0.65; }

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
  /* fixed width so cycling "ล่าสุด" / "USD" / "token ที่ใช้" doesn't resize the button */
  #sort-field { min-width: 96px; text-align: center; }
  #scope { min-width: 68px; text-align: center; }
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

  /* project row is clickable -> opens detail view; hovering shows the pie tip */
  .prow { cursor: pointer; transition: border-color 0.12s; }
  .prow:hover { border-color: var(--vscode-focusBorder); }

  /* floating token-breakdown pie, shown on row hover (pointer-events:none so it
     never eats the click that opens the detail view) */
  #tip {
    position: fixed; z-index: 50; pointer-events: none; display: none; max-width: 300px;
    background: var(--vscode-editorHoverWidget-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-panel-border, rgba(128,128,128,0.4)));
    border-radius: 10px; padding: 12px 14px; box-shadow: 0 6px 24px rgba(0,0,0,0.28); font-size: 12px;
  }
  #tip .t-name { font-weight: 700; font-size: 13px; margin-bottom: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #tip .t-total { opacity: 0.7; margin-bottom: 10px; font-variant-numeric: tabular-nums; }
  #tip .t-wrap { display: flex; gap: 13px; align-items: center; }
  #tip .pie { width: 88px; height: 88px; border-radius: 50%; flex-shrink: 0; }
  #tip .t-legend { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
  #tip .lg { display: flex; align-items: center; gap: 7px; font-size: 11px; white-space: nowrap; }
  #tip .sw { width: 10px; height: 10px; border-radius: 3px; flex-shrink: 0; }
  #tip .lg .lb { opacity: 0.72; }
  #tip .lg .vl { margin-left: auto; padding-left: 10px; font-variant-numeric: tabular-nums; opacity: 0.92; }
  #tip .t-empty { opacity: 0.6; }
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

  <div class="pk-head">
    <div class="section-k" id="projects-k" style="margin:0">โปรเจกต์</div>
    <div class="sortbar">
      <input class="search" id="proj-search" type="text" placeholder="ค้นหาชื่อโปรเจค…" />
      <button class="b" id="sort-field" title="สลับเกณฑ์เรียง: token ที่ใช้ → USD → ล่าสุด">ล่าสุด</button>
      <button class="b dir" id="sort-dir" title="สลับมากไปน้อย / น้อยไปมาก">↓</button>
      <button class="b" id="scope" title="สลับ เดือนนี้ / ทั้งหมด">เดือนนี้</button>
    </div>
  </div>
  <div class="rows" id="projects"></div>
  <div class="pager" id="pager"></div>

  <div class="foot" id="foot"></div>
</div>

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

  // ── Hover pie: the per-project token breakdown, shown as a floating tip while
  // the cursor is over a project row. Data rides on each project's .detail
  // (slices/totalText/hasCost from buildDetail). Click still opens the detail
  // view — the tip is pointer-events:none so it never intercepts the click.
  function pieBg(slices) {
    var total = 0, i;
    for (i = 0; i < slices.length; i++) total += slices[i].cost;
    if (total <= 0) return "transparent";
    // Floor each NONZERO slice to MIN_DEG so a tiny-but-real share (e.g. Input at
    // 0.0%) still shows a visible wedge instead of collapsing to a 0deg band. The
    // big slices then share whatever degrees remain, so the disc still sums to
    // 360; a genuinely zero slice (cost 0) gets no wedge at all.
    var MIN_DEG = 8, raw = [], smallDeg = 0, bigRaw = 0;
    for (i = 0; i < slices.length; i++) {
      raw[i] = (slices[i].cost / total) * 360;
      if (raw[i] <= 0) continue;
      if (raw[i] < MIN_DEG) smallDeg += MIN_DEG; else bigRaw += raw[i];
    }
    var room = 360 - smallDeg; // degrees left for the big (>= MIN_DEG) slices
    var acc = 0, stops = [], d;
    for (i = 0; i < slices.length; i++) {
      if (raw[i] <= 0) continue;
      else if (raw[i] < MIN_DEG) d = MIN_DEG;
      else d = (room > 0 && bigRaw > 0) ? (raw[i] / bigRaw) * room : raw[i];
      var start = acc;
      acc += d;
      stops.push(slices[i].color + " " + start.toFixed(2) + "deg " + acc.toFixed(2) + "deg");
    }
    return "conic-gradient(" + stops.join(", ") + ")";
  }
  function tipHtml(p) {
    var d = p.detail || {};
    var html = '<div class="t-name">' + esc(p.name) + "</div>";
    html += '<div class="t-total">' + esc(d.totalText || "") + "</div>";
    if (!d.hasCost) return html + '<div class="t-empty">ยังไม่มียอดใช้จ่ายที่คิดเงิน</div>';
    var slices = d.slices || [];
    html += '<div class="t-wrap"><div class="pie" style="background:' + pieBg(slices) + '"></div>';
    html += '<div class="t-legend">';
    for (var i = 0; i < slices.length; i++) {
      var s = slices[i];
      html += '<div class="lg" title="' + esc(s.meaning || "") + '">' +
        '<span class="sw" style="background:' + s.color + '"></span>' +
        '<span class="lb">' + esc(s.label) + "</span>" +
        '<span class="vl">' + esc(s.text) + "</span></div>";
    }
    return html + "</div></div>";
  }
  function projFromKey(key) {
    var v = STATE.view;
    if (!v) return null;
    var list = v.projects || [];
    for (var i = 0; i < list.length; i++) if (list[i].path === key) return list[i];
    return null;
  }
  function positionTip(x, y) {
    var tip = document.getElementById("tip");
    var w = tip.offsetWidth, h = tip.offsetHeight;
    var nx = x + 16, ny = y + 16;
    if (nx + w > window.innerWidth - 8) nx = x - w - 16;
    if (ny + h > window.innerHeight - 8) ny = window.innerHeight - h - 8;
    if (nx < 8) nx = 8;
    if (ny < 8) ny = 8;
    tip.style.left = nx + "px";
    tip.style.top = ny + "px";
  }
  var TIP_KEY = null;
  function hideTip() { document.getElementById("tip").style.display = "none"; TIP_KEY = null; }
  function updateTip(e) {
    var t = e.target;
    var row = t && t.closest ? t.closest(".prow") : null;
    var key = row ? row.getAttribute("data-key") : null;
    if (!key) { if (TIP_KEY) hideTip(); return; }
    var p = projFromKey(key);
    if (!p) { if (TIP_KEY) hideTip(); return; }
    var tip = document.getElementById("tip");
    if (TIP_KEY !== key) { tip.innerHTML = tipHtml(p); tip.style.display = "block"; TIP_KEY = key; }
    positionTip(e.clientX, e.clientY);
  }

  var PAGE_SIZE = 10;
  // sortKey cycles: "tokens" (token usage) → "usd" (USD cost) → "recent" (ล่าสุด).
  // It also drives what's shown big + the bar: "tokens" → tokens, otherwise USD cost.
  var STATE = { view: null, sortKey: "recent", sortDir: "desc", scope: "month", query: "", page: 0, maxCost: 0, maxTokens: 0 };

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
      var d;
      if (STATE.sortKey === "tokens") d = a.tokens - b.tokens;
      else if (STATE.sortKey === "usd") d = a.cost - b.cost;
      else d = a.lastMs - b.lastMs;
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
    document.getElementById("sort-field").textContent =
      STATE.sortKey === "tokens" ? "token ที่ใช้" : STATE.sortKey === "usd" ? "USD" : "ล่าสุด";
    document.getElementById("sort-dir").textContent = STATE.sortDir === "desc" ? "↓" : "↑";
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
        // display + bar follow the sort mode: token usage → tokens, otherwise USD cost
        var showTokens = STATE.sortKey === "tokens";
        var val = showTokens ? p.tokens : p.cost;
        var max = showTokens ? STATE.maxTokens : STATE.maxCost;
        var pct = max > 0 ? Math.max(3, Math.round((val / max) * 100)) : 0;
        var rank = start + i + 1;
        var big = showTokens ? esc(fmtTokens(p.tokens)) : money(p.costFmt);
        var small = showTokens ? money(p.costFmt) : esc(fmtTokens(p.tokens));
        var removedTag = p.live === false ? ' <span class="tag-removed">(ลบแล้วจากเครื่อง)</span>' : "";
        return (
          '<div class="prow' + (p.live === false ? " removed" : "") + '" data-key="' + esc(p.path) + '"><div class="rank">' + rank + "</div>" +
          '<div class="pth"><div class="path" title="' + esc(p.path) + '">' + esc(p.name) + removedTag + "</div>" +
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
    hideTip(); // a repaint replaces the row DOM; drop any tip anchored to it
    STATE.view = v;
    STATE.maxCost = (v.projects || []).reduce(function (m, x) { return x.cost > m ? x.cost : m; }, 0);
    STATE.maxTokens = (v.projects || []).reduce(function (m, x) { return x.tokens > m ? x.tokens : m; }, 0);
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
    // clicking anywhere on a project row opens detail view
    // (row children have no id, so this must run before the id checks)
    var row = t.closest ? t.closest(".prow") : null;
    if (row && row.getAttribute("data-key")) {
      var v = STATE.view;
      if (!v) return;
      var list = v.projects || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i].path === row.getAttribute("data-key")) {
          vscode.postMessage({ type: "openProjectDetail", projectPath: list[i].path, projectName: list[i].name });
          return;
        }
      }
      return;
    }
    if (!t.id) return;
    if (t.id === "refresh") post("reload");
    else if (t.id === "sort-field") { STATE.sortKey = STATE.sortKey === "tokens" ? "usd" : STATE.sortKey === "usd" ? "recent" : "tokens"; STATE.page = 0; renderProjects(); }
    else if (t.id === "sort-dir") { STATE.sortDir = STATE.sortDir === "desc" ? "asc" : "desc"; STATE.page = 0; renderProjects(); }
    else if (t.id === "scope") { STATE.scope = STATE.scope === "month" ? "all" : "month"; STATE.page = 0; renderProjects(); }
    else if (t.id === "pg-prev") { STATE.page -= 1; renderProjects(); }
    else if (t.id === "pg-next") { STATE.page += 1; renderProjects(); }
  });

  document.addEventListener("input", function (e) {
    const t = e.target;
    if (t && t.id === "proj-search") { STATE.query = t.value || ""; STATE.page = 0; renderProjects(); }
  });

  document.addEventListener("mousemove", updateTip);
  document.addEventListener("mouseleave", hideTip);
  window.addEventListener("scroll", hideTip, true);

  window.addEventListener("message", function (ev) {
    const m = ev.data;
    if (m && m.type === "budget") render(m);
  });

  post("ready");
</script>
</body></html>`;
}

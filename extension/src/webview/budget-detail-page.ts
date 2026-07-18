import * as vscode from "vscode";

import {
  type Breakdown,
  type Bucket,
  type UsageSummary,
  collapseProjectDayDetail,
  collapseProjectHours,
  getInstantUsage,
  refreshUsage,
} from "../usage";

// Editor-area panel: ONE project's Claude usage over time, as a bar chart.
// Opened from a project row on the Budget page (budget.ts). The host collapses
// the summary's per-cwd hourly buckets into a single hour-keyed series for THIS
// project (usage.collapseProjectHours) and hands the webview only that series;
// the client rolls it up over a user-chosen date RANGE [start, end] (picked via a
// two-click calendar or a preset), with the bar unit DERIVED from the span (<=2d ->
// hourly, <=92d -> daily, <=1095d -> monthly, else yearly); clicking a bar zooms
// into its sub-range. Below the bars, a donut pie breaks the SAME range's spend
// into input / output / cache-write / cache-read (host sends per-day byProject
// DayDetail as `seriesDetail`). Bars use the same blue as the project rows'.
//
// Singleton panel (mirrors budget.ts). _root/_name hold the currently-shown
// project so a background refresh re-collapses the right series.
let _panel: vscode.WebviewPanel | undefined;
let _root = "";
let _name = "";

export function openBudgetDetailPanel(
  projectRoot: string,
  projectName: string,
  summary: UsageSummary,
): vscode.WebviewPanel {
  _root = projectRoot;
  _name = projectName;

  if (_panel) {
    _panel.title = projectName + " — Usage";
    _panel.reveal();
    postDetail(_panel, summary); // instant paint from the passed snapshot
    // Reuse path: also kick a fresh scan + repaint (mirrors the ready handler on
    // first open). Without this, reopening the panel for an actively-growing project
    // only ever shows the cached summary passed in — so recent usage looks missing.
    const panel = _panel;
    void refreshUsage()
      .then((fresh) => postDetail(panel, fresh))
      .catch(() => {});
    return _panel;
  }

  const panel = vscode.window.createWebviewPanel(
    "missioncontrol.budget-detail",
    projectName + " — Usage",
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );

  _panel = panel;
  panel.onDidDispose(() => {
    _panel = undefined;
  });

  panel.webview.html = renderDetailShell();

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (!msg || typeof msg.type !== "string") return;
    if (msg.type === "ready") {
      const instant = await getInstantUsage();
      if (instant) postDetail(panel, instant);
      // Fresh scan in the background, then repaint — same stale-while-revalidate
      // pattern as the budget panel.
      void refreshUsage()
        .then((fresh) => postDetail(panel, fresh))
        .catch(() => {});
    }
  });

  return panel;
}

function postDetail(panel: vscode.WebviewPanel, summary: UsageSummary): void {
  const series: Record<string, Bucket> = collapseProjectHours(summary, _root);
  const seriesDetail: Record<string, Breakdown> = collapseProjectDayDetail(summary, _root);
  panel.webview.postMessage({ type: "updateDetail", projectName: _name, series, seriesDetail });
}

// NOTE: like budget.ts, the client <script> below is written with string
// concatenation only — NO backticks and NO backslashes — so this outer template
// literal never has to escape anything inside it.
function renderDetailShell(): string {
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
  .wrap { max-width: 1100px; margin: 0 auto; }
  .head { margin-bottom: 22px; }
  .title { font-size: 12px; font-weight: 600; letter-spacing: 0.4px; text-transform: uppercase; opacity: 0.55; margin: 0 0 6px; }
  .hero { font-size: 26px; font-weight: 800; line-height: 1.05; letter-spacing: -0.8px; word-break: break-all; }
  .subtitle { font-size: 12px; opacity: 0.6; margin-top: 5px; }

  .controls { display: flex; align-items: center; gap: 14px; margin-bottom: 18px; flex-wrap: wrap; }
  .seg { display: inline-flex; gap: 4px; }
  .btn { background: transparent; color: var(--vscode-foreground); border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35)); border-radius: 6px; padding: 6px 14px; font-size: 12px; cursor: pointer; }
  .btn.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; font-weight: 600; }
  .btn:hover:not(.active) { border-color: var(--vscode-focusBorder); background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.15)); }

  .range-picker { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; position: relative; }
  .range-trigger { font-variant-numeric: tabular-nums; min-width: 216px; text-align: center; }
  .btn[disabled] { opacity: 0.4; cursor: default; }
  .btn[disabled]:hover { border-color: var(--vscode-panel-border, rgba(128,128,128,0.35)); background: transparent; }

  /* range calendar popover (two-click: pick start, then end) */
  .cal-pop { position: absolute; top: calc(100% + 6px); left: 0; z-index: 60; width: 256px; padding: 10px; border-radius: 10px;
    background: var(--vscode-editorHoverWidget-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-panel-border, rgba(128,128,128,0.4)));
    box-shadow: 0 8px 28px rgba(0,0,0,0.32); }
  .cal-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
  .cal-title { font-size: 12.5px; font-weight: 700; }
  .cal-nav { background: transparent; color: var(--vscode-foreground); border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35)); border-radius: 6px; width: 26px; height: 26px; cursor: pointer; font-size: 15px; line-height: 1; }
  .cal-nav:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.15)); }
  .cal-hint { font-size: 11px; opacity: 0.6; margin: 2px 0 8px; }
  .cal-week, .cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; }
  .cal-week span { font-size: 10px; opacity: 0.5; text-align: center; padding: 2px 0; }
  .cal-cell { text-align: center; font-size: 12px; padding: 6px 0; border-radius: 6px; font-variant-numeric: tabular-nums; }
  .cal-day { cursor: pointer; }
  .cal-day:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.18)); }
  .cal-blank { visibility: hidden; }
  .in-range { background: var(--vscode-list-inactiveSelectionBackground, rgba(77,157,224,0.22)); }
  .sel-start, .sel-end { background: var(--vscode-button-background, var(--vscode-charts-blue, #4d9de0)); color: var(--vscode-button-foreground, #ffffff); font-weight: 700; }

  .chart-box { padding: 16px 18px; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25)); border-radius: 10px; background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.05)); }
  .chart-title { font-size: 12px; font-weight: 600; opacity: 0.8; margin-bottom: 14px; letter-spacing: 0.2px; }
  #chart { width: 100%; height: 340px; display: block; }

  .bar { fill: var(--vscode-charts-blue, #4d9de0); transition: opacity 0.1s; }
  .bar:hover { opacity: 0.72; }
  .axis-label { font-size: 10px; fill: var(--vscode-foreground); opacity: 0.55; }
  .axis-line { stroke: var(--vscode-foreground); stroke-width: 1; opacity: 0.18; }

  .legend { display: flex; gap: 18px; flex-wrap: wrap; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2)); font-size: 12px; opacity: 0.85; }
  .legend-item { display: flex; align-items: center; gap: 6px; font-variant-numeric: tabular-nums; }
  .legend-swatch { width: 11px; height: 11px; border-radius: 3px; background: var(--vscode-charts-blue, #4d9de0); }

  /* token-cost breakdown pie (donut), scoped to the selected range */
  .pie-box { margin-top: 16px; padding: 16px 18px; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25)); border-radius: 10px; background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.05)); }
  .pie-title { font-size: 12px; font-weight: 600; opacity: 0.8; margin-bottom: 14px; letter-spacing: 0.2px; }
  .pie-wrap { display: flex; gap: 26px; align-items: center; flex-wrap: wrap; }
  #pie { width: 188px; height: 188px; flex: 0 0 auto; }
  .pie-slice { transition: opacity 0.1s; }
  .pie-slice:hover { opacity: 0.78; }
  .pie-legend { display: flex; flex-direction: column; gap: 9px; font-size: 12px; flex: 1 1 240px; min-width: 240px; }
  .pie-legend .row { display: flex; align-items: center; gap: 9px; font-variant-numeric: tabular-nums; }
  .pie-legend .sw { width: 11px; height: 11px; border-radius: 3px; flex: 0 0 auto; }
  .pie-legend .lab { opacity: 0.9; min-width: 88px; }
  .pie-legend .val { opacity: 0.7; }
  .pie-legend .pct { margin-left: auto; opacity: 0.55; }
  .pie-total { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2)); font-size: 12px; opacity: 0.85; font-variant-numeric: tabular-nums; }

  /* year/month bars drill one level deeper on click */
  .bar.drill, .hit.drill { cursor: pointer; }

  /* floating detail tooltip (follows the cursor; never eats the click) */
  #tip {
    position: fixed; z-index: 50; pointer-events: none; display: none; min-width: 128px; max-width: 260px;
    background: var(--vscode-editorHoverWidget-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-panel-border, rgba(128,128,128,0.4)));
    border-radius: 9px; padding: 10px 12px; box-shadow: 0 6px 24px rgba(0,0,0,0.28); font-size: 12px;
  }
  #tip .tt-when { font-weight: 700; font-size: 12.5px; margin-bottom: 5px; }
  #tip .tt-cost { font-size: 17px; font-weight: 800; letter-spacing: -0.4px; font-variant-numeric: tabular-nums; }
  #tip .tt-cost .cur { font-size: 12px; font-weight: 700; opacity: 0.55; margin-right: 1px; }
  #tip .tt-tok { opacity: 0.62; margin-top: 2px; font-variant-numeric: tabular-nums; }
  #tip .tt-hint { margin-top: 7px; padding-top: 6px; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25)); opacity: 0.62; font-size: 11px; }
</style>
</head>
<body>
<div class="wrap">
  <div class="head">
    <div class="title">Mission Control — Project usage</div>
    <div class="hero" id="proj-name">—</div>
    <div class="subtitle">ยอดใช้จ่าย Claude Code ของโปรเจกต์นี้ ตามช่วงเวลา</div>
  </div>

  <div class="controls">
    <div class="range-picker">
      <button class="btn range-trigger" id="range-trigger" title="เลือกช่วงวันที่"><span id="range-text">—</span></button>
      <div class="cal-pop" id="cal-pop" style="display:none;">
        <div class="cal-head">
          <button class="cal-nav" id="cal-prev" title="เดือนก่อนหน้า">‹</button>
          <div class="cal-title" id="cal-title">—</div>
          <button class="cal-nav" id="cal-next" title="เดือนถัดไป">›</button>
        </div>
        <div class="cal-hint" id="cal-hint">เลือกวันเริ่มต้น</div>
        <div class="cal-week"><span>อา</span><span>จ</span><span>อ</span><span>พ</span><span>พฤ</span><span>ศ</span><span>ส</span></div>
        <div class="cal-grid" id="cal-grid"></div>
      </div>
    </div>
    <div class="seg presets">
      <button class="btn" data-preset="today">วันนี้</button>
      <button class="btn" data-preset="week">สัปดาห์นี้</button>
      <button class="btn" data-preset="month">เดือนนี้</button>
      <button class="btn" data-preset="year">ปีนี้</button>
    </div>
  </div>

  <div class="chart-box">
    <div class="chart-title" id="chart-title">—</div>
    <svg id="chart" viewBox="0 0 1000 340" preserveAspectRatio="xMidYMid meet"></svg>
    <div class="legend" id="legend"></div>
  </div>

  <div class="pie-box" id="pie-box">
    <div class="pie-title" id="pie-title">สัดส่วนค่าใช้จ่ายตามชนิด token</div>
    <div class="pie-wrap">
      <svg id="pie" viewBox="0 0 200 200" preserveAspectRatio="xMidYMid meet"></svg>
      <div class="pie-legend" id="pie-legend"></div>
    </div>
    <div class="pie-total" id="pie-total"></div>
  </div>
</div>

<div id="tip"></div>

<script>
  var vscode = acquireVsCodeApi();
  var MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
  var THMONTHS_FULL = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
  // token-cost categories for the pie — mirrors budget-detail.ts CATS (colors +
  // Thai meanings). tok/cost are the Breakdown field names to read per category.
  var PIE_CATS = [
    { label: "Input", color: "var(--vscode-charts-green, #3fb950)", tok: "inTok", cost: "inCost", meaning: "โค้ด/ข้อความที่ Claude อ่านสดรอบนั้น (ไม่อยู่ใน cache)" },
    { label: "Output", color: "var(--vscode-charts-red, #f14c4c)", tok: "outTok", cost: "outCost", meaning: "คำตอบที่ Claude สร้าง — แพงสุดต่อ token" },
    { label: "Cache write", color: "var(--vscode-charts-orange, #e0803f)", tok: "cacheWriteTok", cost: "cacheWriteCost", meaning: "บันทึก context ลง cache ครั้งแรก — 1.25-2x ของ input" },
    { label: "Cache read", color: "var(--vscode-charts-blue, #4d9de0)", tok: "cacheReadTok", cost: "cacheReadCost", meaning: "อ่าน context เดิมซ้ำจาก cache — ถูกสุด 0.1x ของ input; session ยิ่งยาว/ไม่ compact ยิ่งบวมตรงนี้" }
  ];

  var state = { series: {}, seriesDetail: {}, start: "", end: "", bucket: "day", autoRange: true, projectName: "" };
  var calMonth = "", pickStart = null, pickHover = null, calOpen = false; // range-calendar popover state
  var LAST = []; // buckets from the last renderChart, indexed to match each rect's data-i
  var PIE_LAST = []; // pie slices from the last renderPie, indexed to match each slice's data-cat
  var TOKFMT = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
  function fmtTok(n) { return TOKFMT.format(n || 0); }
  function fmtUsd3(n) { return String(parseFloat((n || 0).toFixed(3))); } // up to 3 decimals, trimmed

  function esc(x) {
    return String(x == null ? "" : x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function pad2(n) { n = String(n); return n.length < 2 ? "0" + n : n; }
  function fmtY(v) {
    if (v >= 100) return String(Math.round(v));
    if (v >= 10) return v.toFixed(1);
    return v.toFixed(2);
  }
  function daysInMonth(y, m) { return new Date(y, m, 0).getDate(); } // m = 1..12

  // ── date helpers (all dates are LOCAL "YYYY-MM-DD" strings) ──
  function parseDate(s) {
    var y = parseInt(s.substring(0, 4), 10);
    var m = parseInt(s.substring(5, 7), 10) || 1;
    var d = parseInt(s.substring(8, 10), 10) || 1;
    return new Date(y, m - 1, d);
  }
  function fmtDate(dt) { return dt.getFullYear() + "-" + pad2(dt.getMonth() + 1) + "-" + pad2(dt.getDate()); }
  function addDays(s, n) { var dt = parseDate(s); dt.setDate(dt.getDate() + n); return fmtDate(dt); }
  function spanDays(a, b) { return Math.round((parseDate(b) - parseDate(a)) / 86400000); }

  // Bar unit is DERIVED from the range span so any range shows a sane bar count.
  function deriveBucket() {
    var n = spanDays(state.start, state.end);
    if (n <= 2) return "hour";
    if (n <= 92) return "day";
    if (n <= 1095) return "month";
    return "year";
  }

  // latest / earliest day that actually has usage (series keys are "YYYY-MM-DD HH:00")
  function anchorDay() {
    var keys = Object.keys(state.series);
    if (keys.length) { keys.sort(); return keys[keys.length - 1].substring(0, 10); }
    var now = new Date();
    return now.getFullYear() + "-" + pad2(now.getMonth() + 1) + "-" + pad2(now.getDate());
  }
  function minActiveDay() {
    var keys = Object.keys(state.series);
    if (!keys.length) return anchorDay();
    keys.sort(); return keys[0].substring(0, 10);
  }

  // Roll the hour-keyed series up to the DERIVED bucket over [start,end], ZERO-
  // FILLING every slot so the time axis stays continuous. Each item carries its
  // canonical key + kind so tooltip / zoom needn't re-derive from the bar index.
  function bucketsFor() {
    var s = state.series || {};
    var keys = Object.keys(s);
    var bkt = state.bucket;
    var out = [], agg = {}, i, k, b;

    function keyOf(k) {
      if (bkt === "hour") return k.substring(0, 13);  // "YYYY-MM-DD HH"
      if (bkt === "day") return k.substring(0, 10);   // "YYYY-MM-DD"
      if (bkt === "month") return k.substring(0, 7);  // "YYYY-MM"
      return k.substring(0, 4);                       // "YYYY"
    }
    for (i = 0; i < keys.length; i++) {
      k = keys[i];
      var dpart = k.substring(0, 10);
      if (dpart < state.start || dpart > state.end) continue; // range filter (lexical on YYYY-MM-DD)
      var kk = keyOf(k);
      b = agg[kk] || (agg[kk] = { cost: 0, tokens: 0 });
      b.cost += s[k].cost; b.tokens += s[k].tokens;
    }
    function push(key, label, kind) {
      var g = agg[key] || { cost: 0, tokens: 0 };
      out.push({ key: key, label: label, kind: kind, cost: g.cost, tokens: g.tokens });
    }

    if (bkt === "hour") {
      var cur = state.start;
      while (cur <= state.end) {
        for (var h = 0; h < 24; h++) push(cur + " " + pad2(h), pad2(h), "hour");
        cur = addDays(cur, 1);
      }
    } else if (bkt === "day") {
      var dd = state.start;
      while (dd <= state.end) {
        push(dd, parseInt(dd.substring(8, 10), 10) + "/" + parseInt(dd.substring(5, 7), 10), "day");
        dd = addDays(dd, 1);
      }
    } else if (bkt === "month") {
      var multiYear = state.start.substring(0, 4) !== state.end.substring(0, 4);
      var y = parseInt(state.start.substring(0, 4), 10), m = parseInt(state.start.substring(5, 7), 10);
      var ey = parseInt(state.end.substring(0, 4), 10), em = parseInt(state.end.substring(5, 7), 10);
      while (y < ey || (y === ey && m <= em)) {
        push(y + "-" + pad2(m), MONTHS[m - 1] + (multiYear ? " " + String(y).substring(2) : ""), "month");
        m++; if (m > 12) { m = 1; y++; }
      }
    } else {
      var y0 = parseInt(state.start.substring(0, 4), 10), y1 = parseInt(state.end.substring(0, 4), 10);
      for (var yy = y0; yy <= y1; yy++) push(String(yy), String(yy), "year");
    }
    return out;
  }

  function unitLabel() {
    if (state.bucket === "hour") return "รายชั่วโมง";
    if (state.bucket === "day") return "รายวัน";
    if (state.bucket === "month") return "รายเดือน";
    return "รายปี";
  }
  function humanDate(s) {
    var mo = parseInt(s.substring(5, 7), 10);
    return parseInt(s.substring(8, 10), 10) + " " + MONTHS[mo - 1] + " " + s.substring(0, 4);
  }
  function dmy(s) { return s.substring(8, 10) + "/" + s.substring(5, 7) + "/" + s.substring(0, 4); }
  function chartTitle() {
    if (state.start === state.end) return unitLabel() + " · " + humanDate(state.start);
    return unitLabel() + " · " + humanDate(state.start) + " – " + humanDate(state.end);
  }

  function line(x1, y1, x2, y2) {
    return '<line class="axis-line" x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" />';
  }

  function renderChart() {
    var svg = document.getElementById("chart");
    document.getElementById("chart-title").textContent = chartTitle();
    var data = bucketsFor();
    LAST = data;
    hideTip(); // a repaint replaces the rects a tip/highlight was anchored to
    renderPie(); // the token-cost pie follows the same [start,end] range

    var totalCost = 0, active = 0, maxCost = 0, i;
    for (i = 0; i < data.length; i++) {
      totalCost += data[i].cost;
      if (data[i].cost > 0) active++;
      if (data[i].cost > maxCost) maxCost = data[i].cost;
    }

    if (!data.length || totalCost <= 0) {
      svg.innerHTML = '<text x="500" y="168" text-anchor="middle" class="axis-label" style="font-size:13px;">ไม่มีข้อมูลการใช้งานในช่วงเวลานี้</text>';
      document.getElementById("legend").innerHTML = "";
      return;
    }
    if (maxCost <= 0) maxCost = 0.01;

    var W = 1000, H = 340, padL = 56, padR = 16, padT = 16, padB = 44;
    var cw = W - padL - padR, ch = H - padT - padB;

    var out = "<g>";
    out += line(padL, padT, padL, H - padB);
    out += line(padL, H - padB, W - padR, H - padB);

    for (i = 0; i <= 4; i++) {
      var gy = padT + (ch / 4) * i;
      var val = maxCost * (1 - i / 4);
      out += '<line class="axis-line" x1="' + padL + '" y1="' + gy.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + gy.toFixed(1) + '" stroke-dasharray="2,3" opacity="0.12" />';
      out += '<text class="axis-label" x="' + (padL - 8) + '" y="' + (gy + 3).toFixed(1) + '" text-anchor="end">$' + fmtY(val) + "</text>";
    }

    var slot = cw / data.length;
    var bw = Math.max(1, slot * 0.66);
    var step = data.length > 16 ? Math.ceil(data.length / 16) : 1;
    var dc = state.bucket !== "hour" ? " drill" : ""; // any non-hour bar zooms in on click
    for (i = 0; i < data.length; i++) {
      var d = data[i];
      var cx = padL + slot * (i + 0.5);
      if (d.cost > 0) {
        var bh = (d.cost / maxCost) * ch;
        var bx = cx - bw / 2;
        var by = H - padB - bh;
        // full-height transparent hit area so the WHOLE column reacts to hover/click
        out += '<rect class="hit' + dc + '" data-i="' + i + '" x="' + (cx - slot / 2).toFixed(1) + '" y="' + padT + '" width="' + slot.toFixed(1) + '" height="' + ch + '" fill="transparent" pointer-events="all" />';
        out += '<rect class="bar' + dc + '" data-i="' + i + '" x="' + bx.toFixed(1) + '" y="' + by.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + bh.toFixed(1) + '" rx="2" />';
      }
      if (i % step === 0) {
        out += '<text class="axis-label" x="' + cx.toFixed(1) + '" y="' + (H - padB + 15) + '" text-anchor="middle">' + esc(d.label) + "</text>";
      }
    }
    out += "</g>";
    svg.innerHTML = out;

    document.getElementById("legend").innerHTML =
      '<div class="legend-item"><span class="legend-swatch"></span><span>รวม $' + totalCost.toFixed(2) + "</span></div>" +
      '<div class="legend-item"><span>ช่วงที่มีการใช้งาน ' + active + "/" + data.length + "</span></div>" +
      '<div class="legend-item"><span>สูงสุด $' + maxCost.toFixed(2) + "</span></div>";
  }

  // ── token-cost breakdown pie (donut), summed over the selected range ────────
  function sumDetail() {
    var s = state.seriesDetail || {}, keys = Object.keys(s), i, k, b;
    var t = { inTok: 0, outTok: 0, cacheReadTok: 0, cacheWriteTok: 0, inCost: 0, outCost: 0, cacheReadCost: 0, cacheWriteCost: 0 };
    for (i = 0; i < keys.length; i++) {
      k = keys[i]; // "YYYY-MM-DD" (per-day breakdown)
      if (k < state.start || k > state.end) continue; // range filter (lexical on YYYY-MM-DD)
      b = s[k];
      t.inTok += b.inTok; t.outTok += b.outTok; t.cacheReadTok += b.cacheReadTok; t.cacheWriteTok += b.cacheWriteTok;
      t.inCost += b.inCost; t.outCost += b.outCost; t.cacheReadCost += b.cacheReadCost; t.cacheWriteCost += b.cacheWriteCost;
    }
    return t;
  }
  function renderPie() {
    var bd = sumDetail();
    var total = bd.inCost + bd.outCost + bd.cacheReadCost + bd.cacheWriteCost;
    var svg = document.getElementById("pie");
    var legend = document.getElementById("pie-legend");
    var rangeTxt = state.start === state.end ? humanDate(state.start) : humanDate(state.start) + " – " + humanDate(state.end);
    document.getElementById("pie-title").textContent = "สัดส่วนค่าใช้จ่ายตามชนิด token · " + rangeTxt;
    if (total <= 0) {
      svg.innerHTML = '<text x="100" y="104" text-anchor="middle" class="axis-label" style="font-size:12px;">ไม่มีค่าใช้จ่ายในช่วงนี้</text>';
      legend.innerHTML = "";
      document.getElementById("pie-total").textContent = "";
      return;
    }
    // slices sorted by cost desc (same ordering as budget-detail.ts buildDetail)
    var slices = PIE_CATS.map(function (c) {
      var cost = bd[c.cost];
      return { label: c.label, color: c.color, meaning: c.meaning, cost: cost, tok: bd[c.tok], pct: Math.round((cost / total) * 1000) / 10 };
    }).sort(function (a, b) { return b.cost - a.cost; });
    PIE_LAST = slices;

    // Donut via stroked circle arcs. A real-but-tiny slice (e.g. Input at 0.0%)
    // has a sub-pixel arc that used to paint as a stray radial streak, so the old
    // code skipped it — which made it vanish from the ring. Instead floor every
    // NONZERO slice to MIN_ARC so it always shows as a wedge big enough to see AND
    // to hover, never a razor streak, never gone. A genuinely zero slice (cost 0)
    // draws nothing and lives in the legend only. off advances by the DRAWN length
    // so a floored slice can't be overpainted by the next one.
    var R = 66, W = 26, C = 2 * Math.PI * R, MIN_ARC = 10, off = 0, out = "", i;
    for (i = 0; i < slices.length; i++) {
      var s = slices[i], len = (s.cost / total) * C;
      if (len > 0) {
        var drawn = len < MIN_ARC ? MIN_ARC : len;
        out += '<circle class="pie-slice" data-cat="' + i + '" cx="100" cy="100" r="' + R + '" fill="none" stroke="' + s.color + '" stroke-width="' + W + '"'
          + ' stroke-dasharray="' + drawn.toFixed(2) + " " + (C - drawn).toFixed(2) + '" stroke-dashoffset="' + (-off).toFixed(2) + '"'
          + ' transform="rotate(-90 100 100)"></circle>';
        off += drawn;
      }
    }
    svg.innerHTML = out;

    var lg = "", j;
    for (j = 0; j < slices.length; j++) {
      var s2 = slices[j];
      lg += '<div class="row" data-cat="' + j + '">'
        + '<span class="sw" style="background:' + s2.color + '"></span>'
        + '<span class="lab">' + esc(s2.label) + "</span>"
        + '<span class="val">' + esc(fmtTok(s2.tok) + " (" + fmtUsd3(s2.cost) + " usd)") + "</span>"
        + '<span class="pct">' + s2.pct.toFixed(1) + "%</span></div>";
    }
    legend.innerHTML = lg;
    var totalTok = bd.inTok + bd.outTok + bd.cacheReadTok + bd.cacheWriteTok;
    document.getElementById("pie-total").textContent = "รวม " + fmtTok(totalTok) + " (" + fmtUsd3(total) + " usd)";
  }
  // pie tooltip — reuses the bars' floating #tip (styled, instant) instead of the
  // native title, so hovering a slice/legend row feels the same as the bars.
  function pieTipHtml(i) {
    var s = PIE_LAST[i];
    if (!s) return "";
    var h = '<div class="tt-when">' + esc(s.label) + "</div>";
    h += '<div class="tt-cost"><span class="cur">$</span>' + fmtUsd3(s.cost) + "</div>";
    h += '<div class="tt-tok">' + fmtTok(s.tok) + " tokens · " + s.pct.toFixed(1) + "%</div>";
    h += '<div class="tt-hint">' + esc(s.meaning) + "</div>";
    return h;
  }

  // ── Hover detail + click-to-drill ─────────────────────────────────────────
  function periodLabel(i) {
    var d = LAST[i];
    if (!d) return "";
    if (d.kind === "hour") {
      var hh = d.key.substring(11, 13);
      return humanDate(d.key.substring(0, 10)) + " " + hh + ":00 - " + hh + ":59 น.";
    }
    if (d.kind === "day") return humanDate(d.key);
    if (d.kind === "month") return MONTHS[parseInt(d.key.substring(5, 7), 10) - 1] + " " + d.key.substring(0, 4);
    return "ปี " + d.key;
  }
  function drillHint() {
    return state.bucket === "hour" ? "" : "คลิกเพื่อซูมเข้าไปในช่วงนี้";
  }
  function tipContent(i) {
    var d = LAST[i];
    if (!d) return "";
    var html = '<div class="tt-when">' + esc(periodLabel(i)) + "</div>";
    html += '<div class="tt-cost"><span class="cur">$</span>' + d.cost.toFixed(2) + "</div>";
    html += '<div class="tt-tok">' + fmtTok(d.tokens) + " tokens</div>";
    var hint = drillHint();
    if (hint) html += '<div class="tt-hint">' + hint + "</div>";
    return html;
  }
  function setHighlight(i) {
    var bars = document.querySelectorAll("rect.bar");
    for (var j = 0; j < bars.length; j++) bars[j].style.opacity = "";
    if (i >= 0) {
      var el = document.querySelector('rect.bar[data-i="' + i + '"]');
      if (el) el.style.opacity = "0.72";
    }
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
  var TIP_I = -1;
  function showTip(i, x, y) {
    var tip = document.getElementById("tip");
    if (TIP_I !== i) { tip.innerHTML = tipContent(i); tip.style.display = "block"; setHighlight(i); TIP_I = i; }
    positionTip(x, y);
  }
  function hideTip() {
    var tip = document.getElementById("tip");
    if (tip) tip.style.display = "none";
    setHighlight(-1);
    TIP_I = -1;
  }
  function zoomInto(i) {
    var d = LAST[i];
    if (!d || d.kind === "hour") return; // hour is the deepest level
    if (d.kind === "year") { applyRange(d.key + "-01-01", d.key + "-12-31"); return; }
    if (d.kind === "month") {
      var y = parseInt(d.key.substring(0, 4), 10), m = parseInt(d.key.substring(5, 7), 10);
      applyRange(d.key + "-01", d.key + "-" + pad2(daysInMonth(y, m)));
      return;
    }
    applyRange(d.key, d.key); // day -> that single day (auto-becomes hourly)
  }

  // ── range control ──────────────────────────────────────────────────────────
  function syncControls() {
    document.getElementById("range-text").textContent = dmy(state.start) + " – " + dmy(state.end);
    if (calOpen) renderCal();
  }
  function applyRange(ns, ne) {
    if (!ns || !ne) return;
    if (ns > ne) { var t = ns; ns = ne; ne = t; } // forgiving: swap a reversed range
    state.autoRange = false; // an explicit pick (calendar/preset/bar-zoom) — stop auto-following the data span
    state.start = ns; state.end = ne;
    state.bucket = deriveBucket();
    syncControls();
    renderChart();
  }
  function realToday() {
    var now = new Date();
    return now.getFullYear() + "-" + pad2(now.getMonth() + 1) + "-" + pad2(now.getDate());
  }
  // calendar presets: today / this-week (Sun-first) / this-month / this-year,
  // each running from the period start up to today.
  function applyPreset(p) {
    var today = realToday(), start;
    if (p === "today") start = today;
    else if (p === "week") start = addDays(today, -parseDate(today).getDay()); // back to Sunday
    else if (p === "month") start = today.substring(0, 7) + "-01";
    else if (p === "year") start = today.substring(0, 4) + "-01-01";
    else return;
    applyRange(start, today);
  }

  // ── range calendar (popover, two-click start -> end, queries on 2nd click) ──
  function openCal() {
    calOpen = true; pickStart = null; pickHover = null;
    calMonth = state.end.substring(0, 7); // open on the current end month
    document.getElementById("cal-pop").style.display = "block";
    renderCal();
  }
  function closeCal() {
    calOpen = false; pickStart = null; pickHover = null;
    document.getElementById("cal-pop").style.display = "none";
  }
  function navMonth(delta) {
    var y = parseInt(calMonth.substring(0, 4), 10), m = parseInt(calMonth.substring(5, 7), 10) + delta;
    while (m < 1) { m += 12; y--; }
    while (m > 12) { m -= 12; y++; }
    calMonth = y + "-" + pad2(m);
    renderCal();
  }
  // rs..re to highlight: pending pick (start..hover) while selecting, else committed range
  function pickRange() {
    if (pickStart) {
      var other = pickHover || pickStart;
      return pickStart < other ? [pickStart, other] : [other, pickStart];
    }
    return [state.start, state.end];
  }
  // Update highlight classes IN PLACE on the existing cells. MUST NOT rebuild the
  // grid: reassigning innerHTML under the pointer makes the browser re-fire
  // mouseover, and a mouseover-driven rebuild storms (re-render loop) that eats the
  // click (mousedown/mouseup land on different node generations).
  function paintRange() {
    var r = pickRange(), rs = r[0], re = r[1];
    var cells = document.getElementById("cal-grid").querySelectorAll("[data-date]");
    for (var i = 0; i < cells.length; i++) {
      var ds = cells[i].getAttribute("data-date");
      var cls = "cal-cell cal-day";
      if (ds === rs) cls += " sel-start";
      if (ds === re) cls += " sel-end";
      if (ds > rs && ds < re) cls += " in-range";
      cells[i].className = cls;
    }
  }
  // Full structure rebuild — only when the visible month changes (open / nav).
  function renderCal() {
    var y = parseInt(calMonth.substring(0, 4), 10), m = parseInt(calMonth.substring(5, 7), 10);
    document.getElementById("cal-title").textContent = THMONTHS_FULL[m - 1] + " " + y;
    document.getElementById("cal-hint").textContent = pickStart ? "เลือกวันสิ้นสุด" : "เลือกวันเริ่มต้น";
    var firstDow = new Date(y, m - 1, 1).getDay(); // 0 = Sunday
    var dim = daysInMonth(y, m), html = "", i, d;
    for (i = 0; i < firstDow; i++) html += '<span class="cal-cell cal-blank"></span>';
    for (d = 1; d <= dim; d++) html += '<span class="cal-cell cal-day" data-date="' + (calMonth + "-" + pad2(d)) + '">' + d + "</span>";
    document.getElementById("cal-grid").innerHTML = html;
    paintRange();
  }
  function onDayClick(ds) {
    if (!ds) return;
    if (!pickStart) { // first click: mark start, repaint in place (no rebuild -> no storm)
      pickStart = ds; pickHover = ds;
      document.getElementById("cal-hint").textContent = "เลือกวันสิ้นสุด";
      paintRange();
      return;
    }
    var s = pickStart < ds ? pickStart : ds;
    var e = pickStart < ds ? ds : pickStart;
    closeCal();
    applyRange(s, e); // second click commits + queries immediately
  }
  function onDayHover(ds) {
    if (!pickStart || !ds) return;
    pickHover = ds; paintRange(); // repaint in place; never rebuild the grid on hover
  }

  var chartEl = document.getElementById("chart");
  chartEl.addEventListener("mousemove", function (e) {
    var el = e.target && e.target.closest ? e.target.closest("[data-i]") : null;
    if (!el) { hideTip(); return; }
    showTip(parseInt(el.getAttribute("data-i"), 10), e.clientX, e.clientY);
  });
  chartEl.addEventListener("mouseleave", hideTip);
  chartEl.addEventListener("click", function (e) {
    var el = e.target && e.target.closest ? e.target.closest("[data-i]") : null;
    if (!el) return;
    zoomInto(parseInt(el.getAttribute("data-i"), 10));
  });

  // pie slices + legend rows share the bars' floating tooltip (via data-cat)
  function pieMove(e) {
    var el = e.target && e.target.closest ? e.target.closest("[data-cat]") : null;
    if (!el) { hideTip(); return; }
    var tip = document.getElementById("tip");
    tip.innerHTML = pieTipHtml(parseInt(el.getAttribute("data-cat"), 10));
    tip.style.display = "block";
    positionTip(e.clientX, e.clientY);
  }
  ["pie", "pie-legend"].forEach(function (id) {
    var el = document.getElementById(id);
    el.addEventListener("mousemove", pieMove);
    el.addEventListener("mouseleave", hideTip);
  });

  // range trigger + calendar + preset controls
  document.getElementById("range-trigger").addEventListener("click", function (e) {
    e.stopPropagation();
    if (calOpen) closeCal(); else openCal();
  });
  document.getElementById("cal-pop").addEventListener("click", function (e) { e.stopPropagation(); });
  document.getElementById("cal-prev").addEventListener("click", function () { navMonth(-1); });
  document.getElementById("cal-next").addEventListener("click", function () { navMonth(1); });
  (function () {
    var grid = document.getElementById("cal-grid");
    grid.addEventListener("click", function (e) {
      var c = e.target && e.target.closest ? e.target.closest("[data-date]") : null;
      if (c) onDayClick(c.getAttribute("data-date"));
    });
    grid.addEventListener("mouseover", function (e) {
      var c = e.target && e.target.closest ? e.target.closest("[data-date]") : null;
      if (c) onDayHover(c.getAttribute("data-date"));
    });
  })();
  (function () {
    var pb = document.querySelectorAll("[data-preset]");
    for (var i = 0; i < pb.length; i++) {
      (function (btn) {
        btn.addEventListener("click", function () { applyPreset(btn.getAttribute("data-preset")); });
      })(pb[i]);
    }
  })();
  document.addEventListener("click", function () { if (calOpen) closeCal(); });

  window.addEventListener("message", function (ev) {
    var m = ev.data;
    if (!m || m.type !== "updateDetail") return;
    var projChanged = m.projectName && m.projectName !== state.projectName;
    state.series = m.series || {};
    state.seriesDetail = m.seriesDetail || {};
    if (projChanged) state.autoRange = true; // new project (singleton panel reuse) -> follow ITS data span again
    state.projectName = m.projectName || state.projectName;
    document.getElementById("proj-name").textContent = m.projectName || "—";
    // While autoRange (until the user picks a range) keep the window on the full
    // active span (earliest..latest day with usage). This makes late-arriving data
    // (a fresh background scan) and project switches show up instead of being hidden
    // behind a stale window. A user pick sets autoRange=false (see applyRange).
    if (state.autoRange) {
      state.start = minActiveDay();
      state.end = anchorDay();
      state.bucket = deriveBucket();
      syncControls();
    }
    renderChart();
  });

  post("ready");
  function post(type) { vscode.postMessage({ type: type }); }
</script>
</body></html>`;
}

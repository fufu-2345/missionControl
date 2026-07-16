import * as vscode from "vscode";

import {
  type Bucket,
  type UsageSummary,
  collapseProjectHours,
  getInstantUsage,
  refreshUsage,
} from "../usage";

// Editor-area panel: ONE project's Claude usage over time, as a bar chart.
// Opened from a project row on the Budget page (budget.ts). The host collapses
// the summary's per-cwd hourly buckets into a single hour-keyed series for THIS
// project (usage.collapseProjectHours) and hands the webview only that series;
// the client rolls it up to the chosen granularity — year -> 12 months,
// month -> the month's days, day -> 24 hours (1-hour resolution). Bars use the
// same blue as the project rows' bars / the pie's cache-read slice.
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
    postDetail(_panel, summary);
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
  panel.webview.postMessage({ type: "updateDetail", projectName: _name, series });
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

  .date-picker { display: flex; gap: 8px; align-items: center; }
  .date-picker label { font-size: 12px; opacity: 0.7; }
  .date-picker input { background: var(--vscode-input-background, transparent); color: var(--vscode-input-foreground, inherit); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, rgba(128,128,128,0.35))); border-radius: 6px; padding: 5px 10px; font-size: 12px; font-family: inherit; }
  .date-picker input:focus { outline: none; border-color: var(--vscode-focusBorder); }

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
    <div class="seg">
      <button class="btn active" id="gran-year" title="12 เดือนของปีนั้น">ปี</button>
      <button class="btn" id="gran-month" title="รายวันของเดือนนั้น">เดือน</button>
      <button class="btn" id="gran-day" title="รายชั่วโมงของวันนั้น">วัน</button>
    </div>
    <div class="date-picker" id="date-picker" style="display:none;">
      <label for="date-input" id="date-label">วันที่</label>
      <input type="date" id="date-input" />
    </div>
  </div>

  <div class="chart-box">
    <div class="chart-title" id="chart-title">—</div>
    <svg id="chart" viewBox="0 0 1000 340" preserveAspectRatio="xMidYMid meet"></svg>
    <div class="legend" id="legend"></div>
  </div>
</div>

<div id="tip"></div>

<script>
  var vscode = acquireVsCodeApi();
  var MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];

  var state = { series: {}, granularity: "year", selectedDate: "", dateInited: false };
  var LAST = []; // buckets from the last renderChart, indexed to match each rect's data-i
  var TOKFMT = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
  function fmtTok(n) { return TOKFMT.format(n || 0); }

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

  document.getElementById("gran-year").addEventListener("click", function () { setGran("year"); });
  document.getElementById("gran-month").addEventListener("click", function () { setGran("month"); });
  document.getElementById("gran-day").addEventListener("click", function () { setGran("day"); });
  document.getElementById("date-input").addEventListener("change", function (e) {
    var val = e.target.value || "";
    if (!val) return;
    // month picker gives "YYYY-MM"; keep a full "YYYY-MM-DD" internally
    state.selectedDate = state.granularity === "month" ? val + "-01" : val;
    renderChart();
  });

  function setGran(g) {
    state.granularity = g;
    ["year", "month", "day"].forEach(function (x) {
      document.getElementById("gran-" + x).classList[x === g ? "add" : "remove"]("active");
    });
    updateDatePicker();
    renderChart();
  }

  function updateDatePicker() {
    var picker = document.getElementById("date-picker");
    var input = document.getElementById("date-input");
    var label = document.getElementById("date-label");
    if (state.granularity === "year") {
      picker.style.display = "none";
      return;
    }
    picker.style.display = "flex";
    if (state.granularity === "month") {
      input.type = "month";
      input.value = state.selectedDate.substring(0, 7);
      label.textContent = "เดือน";
    } else {
      input.type = "date";
      input.value = state.selectedDate.substring(0, 10);
      label.textContent = "วันที่";
    }
  }

  // Roll the hour-keyed series up to the chosen granularity, ZERO-FILLING the
  // period so the bar count is fixed: year -> 12 months, month -> that month's
  // days, day -> 24 hours. Keys are "YYYY-MM-DD HH:00" (LOCAL).
  function bucketsFor() {
    var s = state.series || {};
    var g = state.granularity;
    var out = [];
    var keys = Object.keys(s);
    var i, k, b;

    if (g === "year") {
      var year = state.selectedDate.substring(0, 4);
      var months = {};
      for (i = 0; i < keys.length; i++) {
        k = keys[i];
        if (k.substring(0, 4) !== year) continue;
        var mk = k.substring(0, 7);
        b = months[mk] || (months[mk] = { cost: 0, tokens: 0 });
        b.cost += s[k].cost; b.tokens += s[k].tokens;
      }
      for (var m = 1; m <= 12; m++) {
        var mkey = year + "-" + pad2(m);
        b = months[mkey] || { cost: 0, tokens: 0 };
        out.push({ label: MONTHS[m - 1], cost: b.cost, tokens: b.tokens });
      }
    } else if (g === "month") {
      var ym = state.selectedDate.substring(0, 7);
      var y = parseInt(ym.substring(0, 4), 10);
      var mo = parseInt(ym.substring(5, 7), 10);
      var days = {};
      for (i = 0; i < keys.length; i++) {
        k = keys[i];
        if (k.substring(0, 7) !== ym) continue;
        var dk = k.substring(0, 10);
        b = days[dk] || (days[dk] = { cost: 0, tokens: 0 });
        b.cost += s[k].cost; b.tokens += s[k].tokens;
      }
      var dim = (y && mo) ? daysInMonth(y, mo) : 31;
      for (var d = 1; d <= dim; d++) {
        var dkey = ym + "-" + pad2(d);
        b = days[dkey] || { cost: 0, tokens: 0 };
        out.push({ label: String(d), cost: b.cost, tokens: b.tokens });
      }
    } else {
      var day = state.selectedDate.substring(0, 10);
      var hours = {};
      for (i = 0; i < keys.length; i++) {
        k = keys[i];
        if (k.substring(0, 10) !== day) continue;
        var h = parseInt(k.substring(11, 13), 10);
        b = hours[h] || (hours[h] = { cost: 0, tokens: 0 });
        b.cost += s[k].cost; b.tokens += s[k].tokens;
      }
      for (var hh = 0; hh < 24; hh++) {
        b = hours[hh] || { cost: 0, tokens: 0 };
        out.push({ label: pad2(hh), cost: b.cost, tokens: b.tokens });
      }
    }
    return out;
  }

  function chartTitle() {
    if (state.granularity === "year") return "รายเดือน · ปี " + state.selectedDate.substring(0, 4);
    if (state.granularity === "month") return "รายวัน · " + state.selectedDate.substring(0, 7);
    return "รายชั่วโมง · " + state.selectedDate.substring(0, 10);
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
    var dc = state.granularity !== "day" ? " drill" : ""; // year/month bars drill on click
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

  // ── Hover detail + click-to-drill ─────────────────────────────────────────
  function periodLabel(i) {
    if (state.granularity === "year") return MONTHS[i] + " " + state.selectedDate.substring(0, 4);
    if (state.granularity === "month") {
      var mo = parseInt(state.selectedDate.substring(5, 7), 10);
      return (i + 1) + " " + MONTHS[mo - 1] + " " + state.selectedDate.substring(0, 4);
    }
    return pad2(i) + ":00 - " + pad2(i) + ":59 น.";
  }
  function drillHint() {
    if (state.granularity === "year") return "คลิกเพื่อดูรายวันของเดือนนี้";
    if (state.granularity === "month") return "คลิกเพื่อดูรายชั่วโมงของวันนี้";
    return "";
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
  function drillFrom(i) {
    if (i < 0 || i >= LAST.length) return;
    if (state.granularity === "year") {
      // month index i (0-11) -> that month, then show its days
      state.selectedDate = state.selectedDate.substring(0, 4) + "-" + pad2(i + 1) + "-01";
      setGran("month");
    } else if (state.granularity === "month") {
      // day index i (0-based) -> that day, then show its hours
      state.selectedDate = state.selectedDate.substring(0, 7) + "-" + pad2(i + 1);
      setGran("day");
    }
    // day granularity is the deepest level — nothing to drill into
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
    drillFrom(parseInt(el.getAttribute("data-i"), 10));
  });

  window.addEventListener("message", function (ev) {
    var m = ev.data;
    if (!m || m.type !== "updateDetail") return;
    state.series = m.series || {};
    document.getElementById("proj-name").textContent = m.projectName || "—";
    // On the FIRST payload, default the selected date to the latest active day so
    // Month/Day open on real data. A later background-refresh keeps the user's pick.
    if (!state.dateInited) {
      var keys = Object.keys(state.series);
      if (keys.length) {
        keys.sort();
        state.selectedDate = keys[keys.length - 1].substring(0, 10);
      } else {
        var now = new Date();
        state.selectedDate = now.getFullYear() + "-" + pad2(now.getMonth() + 1) + "-" + pad2(now.getDate());
      }
      state.dateInited = true;
      updateDatePicker();
    }
    renderChart();
  });

  post("ready");
  function post(type) { vscode.postMessage({ type: type }); }
</script>
</body></html>`;
}

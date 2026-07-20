import * as fs from "node:fs";
import * as path from "node:path";

import * as vscode from "vscode";

import { loadDataIndex, type ProjectRow } from "../commands/dataView";

/** Singleton panel — a second open reveals the existing one instead of spawning a twin. */
let current: vscode.WebviewPanel | undefined;

/** Open (or reveal) the cross-project Data View: every project's status parsed from
 *  its `.md` docs, shown as table / kanban / timeline. Read-only. */
export async function openDataViewPanel(): Promise<vscode.WebviewPanel> {
  if (current) {
    current.reveal(vscode.ViewColumn.Active);
    void refresh(current);
    return current;
  }
  const panel = vscode.window.createWebviewPanel(
    "missioncontrol.dataView",
    "Data View",
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  current = panel;
  panel.onDidDispose(() => {
    if (current === panel) current = undefined;
  });

  const rows = await loadDataIndex();
  panel.webview.html = renderHtml(rows);

  panel.webview.onDidReceiveMessage(async (msg) => {
    switch (msg?.type) {
      case "refresh":
        await refresh(panel);
        return;
      case "open_project":
        openProject(typeof msg.path === "string" ? msg.path : "");
        return;
      case "open_github":
        if (typeof msg.url === "string" && msg.url) {
          void vscode.env.openExternal(vscode.Uri.parse(msg.url));
        }
        return;
    }
  });
  return panel;
}

async function refresh(panel: vscode.WebviewPanel): Promise<void> {
  const rows = await loadDataIndex();
  void panel.webview.postMessage({ type: "index", rows });
}

/** Open a project's most useful doc in the editor: plan.md → latest sprint → reveal folder. */
function openProject(projectPath: string): void {
  if (!projectPath) return;
  const plan = path.join(projectPath, "docs", "plan.md");
  let target: string | null = null;
  if (fs.existsSync(plan)) target = plan;
  else {
    try {
      const docs = path.join(projectPath, "docs");
      const sprint = fs
        .readdirSync(docs)
        .filter((f) => /^(?:.+-)?sprint-\d+.*\.md$/i.test(f))
        .sort()
        .pop();
      if (sprint) target = path.join(docs, sprint);
    } catch {
      /* no docs */
    }
  }
  if (target) {
    void vscode.window.showTextDocument(vscode.Uri.file(target), { preview: true });
  } else {
    void vscode.commands.executeCommand("revealInExplorer", vscode.Uri.file(projectPath));
  }
}

function renderHtml(rows: ProjectRow[]): string {
  // `<` escaped so a project name containing `</script>` can't break out of the block.
  const data = JSON.stringify(rows).replace(/</g, "\\u003c");
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  :root { --gap: 10px; }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 14px; margin: 0; }
  h1 { font-size: 16px; margin: 0 0 4px; }
  .sub { font-size: 11px; opacity: 0.65; margin-bottom: 12px; }
  .toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 12px; }
  .tabs { display: flex; gap: 4px; }
  .tab { padding: 5px 12px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; cursor: pointer; font-size: 12px; background: transparent; color: var(--vscode-foreground); }
  .tab.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: var(--vscode-button-background); }
  .spacer { flex: 1; }
  input[type=search] { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 4px; padding: 4px 8px; font-size: 12px; min-width: 160px; }
  .chk { font-size: 12px; opacity: 0.85; display: flex; align-items: center; gap: 4px; cursor: pointer; }
  button.btn { background: var(--vscode-button-secondaryBackground, transparent); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 4px 10px; font-size: 12px; cursor: pointer; }
  button.btn:hover { background: var(--vscode-button-hoverBackground); }

  /* table */
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); white-space: nowrap; }
  th { cursor: pointer; user-select: none; position: sticky; top: 0; background: var(--vscode-editor-background); }
  th .arr { opacity: 0.5; font-size: 10px; }
  tr.proj { cursor: pointer; }
  tr.proj:hover td { background: var(--vscode-list-hoverBackground); }
  tr.grouphdr td { font-weight: 600; opacity: 0.8; background: var(--vscode-editor-inactiveSelectionBackground); }
  .badge { display: inline-block; padding: 1px 7px; border-radius: 9px; font-size: 11px; }
  .s-done { background: rgba(63,185,80,0.18); color: #3fb950; }
  .s-in-progress { background: rgba(88,166,255,0.18); color: #58a6ff; }
  .s-not-started { background: var(--vscode-editor-inactiveSelectionBackground); opacity: 0.8; }
  .bar { height: 5px; border-radius: 3px; background: var(--vscode-progressBar-background); width: 70px; overflow: hidden; display: inline-block; vertical-align: middle; }
  .bar > i { display: block; height: 100%; background: #3fb950; }
  .tag { font-size: 10px; opacity: 0.7; }
  .deltag { font-size: 10px; color: #e3a13a; opacity: 0.9; }
  .deleted { opacity: 0.6; }

  /* kanban */
  .kb { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--gap); align-items: start; }
  .kb .col { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 8px; min-height: 60px; }
  .kb .col h3 { font-size: 12px; margin: 0 0 8px; opacity: 0.8; display: flex; justify-content: space-between; }
  .card { border: 1px solid var(--vscode-panel-border); border-radius: 5px; padding: 8px; margin-bottom: 8px; cursor: pointer; background: var(--vscode-editor-inactiveSelectionBackground); }
  .card:hover { background: var(--vscode-list-hoverBackground); }
  .card .nm { font-weight: 600; font-size: 12px; }
  .card .meta { font-size: 11px; opacity: 0.7; margin-top: 3px; display: flex; justify-content: space-between; gap: 6px; }
  .swim { font-size: 11px; font-weight: 600; opacity: 0.75; margin: 10px 0 6px; }

  /* timeline */
  .tl { font-size: 12px; }
  .tl .axis { display: flex; justify-content: space-between; font-size: 10px; opacity: 0.6; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 3px; margin-bottom: 6px; }
  .tl .row { display: grid; grid-template-columns: 180px 1fr; gap: 8px; align-items: center; padding: 4px 0; }
  .tl .row:hover { background: var(--vscode-list-hoverBackground); }
  .tl .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
  .tl .track { position: relative; height: 16px; }
  .tl .seg { position: absolute; top: 7px; height: 2px; background: var(--vscode-panel-border); }
  .tl .dot { position: absolute; top: 3px; width: 10px; height: 10px; border-radius: 50%; background: #58a6ff; transform: translateX(-50%); }
  .tl .nodate { font-size: 11px; opacity: 0.5; }
  .empty { opacity: 0.6; font-size: 12px; padding: 20px 0; }
</style>
</head>
<body>
  <h1>Data View</h1>
  <div class="sub" id="sub"></div>
  <div class="toolbar">
    <div class="tabs">
      <button class="tab active" data-view="table">Table</button>
      <button class="tab" data-view="kanban">Kanban</button>
      <button class="tab" data-view="timeline">Timeline</button>
    </div>
    <input type="search" id="q" placeholder="ค้นหาชื่อโปรเจกต์…">
    <label class="chk"><input type="checkbox" id="grp"> group by category</label>
    <div class="spacer"></div>
    <button class="btn" id="refresh">Refresh</button>
  </div>
  <div id="view"></div>

<script>
  const vscode = acquireVsCodeApi();
  let ROWS = ${data};
  const S = { view: "table", q: "", group: false, sortKey: "updated", sortDir: -1 };

  const esc = (s) => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  // deleted (backed-up) project → a plain-text tag; no emoji (terminal renders them blank)
  function delTag(r){
    return r && r.deleted
      ? ' <span class="deltag" title="โปรเจกต์นี้ถูกลบจากเครื่องแล้ว — กำลังดูจากสำเนาสำรอง">(ลบแล้ว '
        + esc(r.deletedAt ? String(r.deletedAt).slice(0,10) : '') + ')</span>'
      : '';
  }
  const STATUS_ORDER = { "not-started": 0, "in-progress": 1, "done": 2 };
  const COLS = [
    { k: "name", t: "Project" },
    { k: "category", t: "Category" },
    { k: "status", t: "Status" },
    { k: "sprintsDone", t: "Sprints" },
    { k: "percentDone", t: "Done%" },
    { k: "latest", t: "Latest" },
    { k: "updated", t: "Updated" },
  ];

  function filtered() {
    const q = S.q.trim().toLowerCase();
    return ROWS.filter(r => !q || r.name.toLowerCase().includes(q));
  }
  function cmp(a, b, k) {
    if (k === "status") return STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (k === "latest") return (a.latestSprint?.n ?? 0) - (b.latestSprint?.n ?? 0);
    let av = a[k], bv = b[k];
    if (typeof av === "number") return av - (bv ?? 0);
    return String(av ?? "").localeCompare(String(bv ?? ""));
  }
  function sorted(list) {
    return [...list].sort((a, b) => cmp(a, b, S.sortKey) * S.sortDir || a.name.localeCompare(b.name));
  }
  function byCategory(list) {
    const m = new Map();
    for (const r of list) { const c = r.category || "uncategorized"; if (!m.has(c)) m.set(c, []); m.get(c).push(r); }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }
  function openProj(p) { vscode.postMessage({ type: "open_project", path: p }); }

  function statusBadge(s) { return '<span class="badge s-' + s + '">' + s + '</span>'; }
  function bar(pct) { return '<span class="bar"><i style="width:' + pct + '%"></i></span> ' + pct + '%'; }

  function rowCells(r) {
    return '<td>' + esc(r.name) + delTag(r) + (r.githubUrl ? ' <a href="#" class="tag gh" data-url="' + esc(r.githubUrl) + '">↗</a>' : '') + '</td>'
      + '<td class="tag">' + esc(r.category) + '</td>'
      + '<td>' + statusBadge(r.status) + '</td>'
      + '<td>' + r.sprintsDone + '/' + r.sprintsTotal + '</td>'
      + '<td>' + bar(r.percentDone) + '</td>'
      + '<td class="tag">' + (r.latestSprint ? esc("s" + r.latestSprint.n + " " + r.latestSprint.name) : "—") + '</td>'
      + '<td class="tag">' + esc(r.updated ?? "—") + '</td>';
  }

  function renderTable() {
    const list = sorted(filtered());
    const head = '<tr>' + COLS.map(c => '<th data-k="' + c.k + '">' + c.t + (S.sortKey === c.k ? ' <span class="arr">' + (S.sortDir < 0 ? "▼" : "▲") + '</span>' : '') + '</th>').join('') + '</tr>';
    let body = "";
    if (!list.length) return '<div class="empty">ไม่มีโปรเจกต์ที่ตรงกับตัวกรอง</div>';
    if (S.group) {
      for (const [cat, items] of byCategory(list)) {
        body += '<tr class="grouphdr"><td colspan="' + COLS.length + '">' + esc(cat) + ' (' + items.length + ')</td></tr>';
        for (const r of items) body += '<tr class="proj' + (r.deleted ? ' deleted' : '') + '" data-p="' + esc(r.path) + '">' + rowCells(r) + '</tr>';
      }
    } else {
      for (const r of list) body += '<tr class="proj' + (r.deleted ? ' deleted' : '') + '" data-p="' + esc(r.path) + '">' + rowCells(r) + '</tr>';
    }
    return '<table><thead>' + head + '</thead><tbody>' + body + '</tbody></table>';
  }

  function card(r) {
    return '<div class="card' + (r.deleted ? ' deleted' : '') + '" data-p="' + esc(r.path) + '"><div class="nm">' + esc(r.name) + delTag(r) + '</div>'
      + '<div class="meta"><span>' + esc(r.category) + '</span><span>' + r.sprintsDone + '/' + r.sprintsTotal + ' · ' + r.percentDone + '%</span></div></div>';
  }
  function kanbanCols(list) {
    const cols = [["not-started", "ยังไม่เริ่ม"], ["in-progress", "กำลังทำ"], ["done", "เสร็จ"]];
    return '<div class="kb">' + cols.map(([st, label]) => {
      const items = list.filter(r => r.status === st);
      return '<div class="col"><h3><span>' + label + '</span><span>' + items.length + '</span></h3>' + items.map(card).join('') + '</div>';
    }).join('') + '</div>';
  }
  function renderKanban() {
    const list = filtered();
    if (!list.length) return '<div class="empty">ไม่มีโปรเจกต์ที่ตรงกับตัวกรอง</div>';
    if (!S.group) return kanbanCols(list);
    let out = "";
    for (const [cat, items] of byCategory(list)) out += '<div class="swim">' + esc(cat) + '</div>' + kanbanCols(items);
    return out;
  }

  function allDates(list) {
    const ds = [];
    for (const r of list) for (const s of r.sprints || []) if (s.date) ds.push(s.date);
    for (const r of list) if (r.updated) ds.push(r.updated);
    return ds.sort();
  }
  function tlRow(r, min, max) {
    const span = Math.max(1, Date.parse(max) - Date.parse(min));
    const pos = (d) => ((Date.parse(d) - Date.parse(min)) / span) * 100;
    const dated = (r.sprints || []).filter(s => s.date);
    let track;
    if (!dated.length) track = '<span class="nodate">ไม่มีวันที่</span>';
    else {
      const xs = dated.map(s => pos(s.date));
      const lo = Math.min(...xs), hi = Math.max(...xs);
      track = '<div class="track"><div class="seg" style="left:' + lo + '%;width:' + (hi - lo) + '%"></div>'
        + dated.map(s => '<div class="dot" title="s' + s.n + ' ' + esc(s.date) + '" style="left:' + pos(s.date) + '%"></div>').join('') + '</div>';
    }
    return '<div class="row' + (r.deleted ? ' deleted' : '') + '"><div class="nm" data-p="' + esc(r.path) + '">' + esc(r.name) + delTag(r) + '</div>' + track + '</div>';
  }
  function renderTimeline() {
    const list = sorted(filtered());
    if (!list.length) return '<div class="empty">ไม่มีโปรเจกต์ที่ตรงกับตัวกรอง</div>';
    const ds = allDates(list);
    if (!ds.length) return '<div class="empty">ไม่มีข้อมูลวันที่สำหรับ timeline</div>';
    const min = ds[0], max = ds[ds.length - 1];
    const axis = '<div class="axis"><span>' + esc(min) + '</span><span>' + esc(max) + '</span></div>';
    let body = "";
    if (S.group) for (const [cat, items] of byCategory(list)) { body += '<div class="swim">' + esc(cat) + '</div>'; for (const r of items) body += tlRow(r, min, max); }
    else for (const r of list) body += tlRow(r, min, max);
    return '<div class="tl">' + axis + body + '</div>';
  }

  function render() {
    document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.view === S.view));
    const shown = filtered().length;
    document.getElementById("sub").textContent = ROWS.length + " โปรเจกต์" + (shown !== ROWS.length ? " (แสดง " + shown + ")" : "") + " · อ่านจากไฟล์ .md";
    const el = document.getElementById("view");
    el.innerHTML = S.view === "table" ? renderTable() : S.view === "kanban" ? renderKanban() : renderTimeline();
  }

  document.querySelector(".tabs").addEventListener("click", (e) => {
    const t = e.target.closest(".tab"); if (!t) return; S.view = t.dataset.view; render();
  });
  document.getElementById("q").addEventListener("input", (e) => { S.q = e.target.value; render(); });
  document.getElementById("grp").addEventListener("change", (e) => { S.group = e.target.checked; render(); });
  document.getElementById("refresh").addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
  document.getElementById("view").addEventListener("click", (e) => {
    const gh = e.target.closest(".gh");
    if (gh) { e.preventDefault(); e.stopPropagation(); vscode.postMessage({ type: "open_github", url: gh.dataset.url }); return; }
    const th = e.target.closest("th");
    if (th && th.dataset.k) { if (S.sortKey === th.dataset.k) S.sortDir = -S.sortDir; else { S.sortKey = th.dataset.k; S.sortDir = 1; } render(); return; }
    const p = e.target.closest("[data-p]");
    if (p) openProj(p.dataset.p);
  });
  window.addEventListener("message", (ev) => {
    if (ev.data?.type === "index") { ROWS = ev.data.rows || []; render(); }
  });
  render();
</script>
</body>
</html>`;
}

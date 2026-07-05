import * as vscode from "vscode";

import {
  availableModels,
  createTeam,
  deleteTeam,
  listTeamSummaries,
  oracleCandidates,
  readTeamDetailSync,
  saveTeam,
} from "../commands/teamsOps";
import {
  COLOR_OPTIONS,
  DEFAULT_MODEL,
  DEFAULT_ROLE,
  ROLE_OPTIONS,
  isSafeTeamName,
  type TeamMember,
} from "../commands/teamsModel";

// Editor-area panel for browsing + editing maw oracle-teams. Mirrors skills.ts:
// singleton _panel, renderShell HTML, postMessage list/detail, a message switch.
// Three in-panel views (list → detail → new) swapped client-side. Membership +
// roles persist through the maw CLI (teamsOps); description + model/color are
// data-file writes into maw's own stores (no CLI verb exists). Rename is out of
// scope for v1 (no CLI verb; would touch 3 stores + the sessions pin).
let _panel: vscode.WebviewPanel | undefined;

const OPTIONS = {
  roleOptions: [...ROLE_OPTIONS],
  colorOptions: [...COLOR_OPTIONS],
  defaultRole: DEFAULT_ROLE,
  defaultModel: DEFAULT_MODEL,
};

function pushList(panel: vscode.WebviewPanel) {
  panel.webview.postMessage({ type: "team_list", teams: listTeamSummaries() });
}

async function pushDetail(panel: vscode.WebviewPanel, name: string) {
  const team = readTeamDetailSync(name);
  const candidates = oracleCandidates(team.members.map((m) => m.oracle));
  const modelOptions = await availableModels();
  panel.webview.postMessage({
    type: "team_detail",
    team,
    candidates,
    ...OPTIONS,
    modelOptions,
  });
}

/** Coerce a webview-sent member list into clean TeamMember[]. */
function sanitizeMembers(raw: unknown): TeamMember[] {
  if (!Array.isArray(raw)) return [];
  const out: TeamMember[] = [];
  for (const m of raw) {
    // Normalize to the oracle STEM: `maw bud <stem>` makes repo <stem>-oracle,
    // so a typed "fusion-oracle" would become "fusion-oracle-oracle". Strip it.
    const oracle = (typeof m?.oracle === "string" ? m.oracle.trim() : "").replace(
      /-oracle$/,
      "",
    );
    if (!oracle) continue;
    out.push({
      oracle,
      role: typeof m?.role === "string" && m.role.trim() ? m.role.trim() : DEFAULT_ROLE,
      model: typeof m?.model === "string" && m.model.trim() ? m.model.trim() : undefined,
      color: typeof m?.color === "string" && m.color.trim() ? m.color.trim() : undefined,
    });
  }
  return out;
}

export function openTeamsPanel(_projectId: string | null = null): vscode.WebviewPanel {
  if (_panel) {
    _panel.reveal();
    return _panel;
  }
  const panel = vscode.window.createWebviewPanel(
    "missioncontrol.teams",
    "Mission Control — Team Config",
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
      case "ready":
      case "reload":
        pushList(panel);
        return;
      case "open_team":
        if (typeof msg.name === "string") void pushDetail(panel, msg.name);
        return;
      case "new_team": {
        const modelOptions = await availableModels();
        panel.webview.postMessage({
          type: "team_new",
          candidates: oracleCandidates([]),
          ...OPTIONS,
          modelOptions,
        });
        return;
      }
      case "save_team": {
        const name = typeof msg.name === "string" ? msg.name : "";
        if (!isSafeTeamName(name)) return;
        const members = sanitizeMembers(msg.members);
        const description = typeof msg.description === "string" ? msg.description : "";
        const r = await saveTeam(name, description, members);
        vscode.window[r.ok ? "showInformationMessage" : "showErrorMessage"](
          r.ok
            ? `Teams: บันทึก '${name}' แล้ว`
            : `Teams: บันทึก '${name}' มีปัญหา — ${r.errors.join(" · ")}`,
        );
        await pushDetail(panel, name);
        return;
      }
      case "create_team": {
        const name = typeof msg.name === "string" ? msg.name.trim() : "";
        if (!isSafeTeamName(name)) {
          vscode.window.showErrorMessage(
            `Teams: ชื่อทีมไม่ถูกต้อง (ใช้ได้แค่ A-Z a-z 0-9 . _ -): '${name}'`,
          );
          return;
        }
        if (listTeamSummaries().some((t) => t.name === name)) {
          vscode.window.showErrorMessage(`Teams: ทีม '${name}' มีอยู่แล้ว`);
          return;
        }
        const members = sanitizeMembers(msg.members);
        const description = typeof msg.description === "string" ? msg.description : "";
        const r = await createTeam(name, description, members);
        vscode.window[r.ok ? "showInformationMessage" : "showErrorMessage"](
          r.ok
            ? `Teams: สร้าง '${name}' (${members.length} สมาชิก) แล้ว`
            : `Teams: สร้าง '${name}' มีปัญหา — ${r.errors.join(" · ")}`,
        );
        pushList(panel);
        await pushDetail(panel, name); // jump straight into the new team
        return;
      }
      case "delete_team": {
        const name = typeof msg.name === "string" ? msg.name : "";
        if (!isSafeTeamName(name)) return;
        const pick = await vscode.window.showWarningMessage(
          `ลบทีม '${name}'? (ลบสมาชิก+config ของทีมนี้ — oracle แต่ละตัวไม่ถูกลบ)`,
          { modal: true },
          "Delete",
        );
        if (pick !== "Delete") return;
        const r = await deleteTeam(name);
        vscode.window[r.ok ? "showInformationMessage" : "showErrorMessage"](
          r.ok
            ? `Teams: ลบ '${name}' แล้ว`
            : `Teams: ลบ '${name}' มีปัญหา — ${r.errors.join(" · ")}`,
        );
        pushList(panel);
        panel.webview.postMessage({ type: "go_list" });
        return;
      }
      case "close":
        panel.dispose();
        return;
    }
  });

  return panel;
}

function renderShell(): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  html, body { height: 100%; margin: 0; padding: 0; }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
    background: var(--vscode-editor-background); display: flex; flex-direction: column; overflow: hidden; }
  .topbar { display: flex; align-items: center; justify-content: space-between;
    padding: 10px 16px; border-bottom: 1px solid var(--vscode-panel-border); }
  .topbar h1 { font-size: 14px; margin: 0; font-weight: 600; }
  .topbar h1 .count { font-size: 11px; opacity: 0.6; margin-left: 8px; font-weight: 400; }
  .topbar .actions { display: flex; gap: 6px; }
  button { background: transparent; color: var(--vscode-foreground);
    border: 1px solid var(--vscode-panel-border); padding: 4px 10px; border-radius: 3px;
    font-size: 11px; cursor: pointer; }
  button:hover { background: var(--vscode-list-hoverBackground); }
  button.primary { background: #238636; color: #fff; border-color: #238636; }
  button.danger { background: #da3633; color: #fff; border-color: #da3633; }
  .content { flex: 1; overflow-y: auto; padding: 14px 18px 28px; box-sizing: border-box; }
  .empty { opacity: 0.6; font-size: 13px; padding: 24px 0; }

  .team-card { display: flex; align-items: center; justify-content: space-between;
    padding: 12px 14px; margin-bottom: 8px; border-radius: 8px; cursor: pointer;
    background: var(--vscode-editor-inactiveSelectionBackground);
    border: 1px solid var(--vscode-panel-border); }
  .team-card:hover { background: var(--vscode-list-hoverBackground); }
  .team-card .tc-name { font-size: 13px; font-weight: 600; }
  .team-card .tc-meta { font-size: 11px; opacity: 0.65; margin-top: 2px; }

  label { font-size: 11px; opacity: 0.8; display: block; margin: 10px 0 3px; }
  input[type=text], textarea, select {
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: 4px; padding: 5px 7px; font-size: 12px; box-sizing: border-box;
    font-family: var(--vscode-font-family); }
  input[type=text], textarea { width: 100%; }
  .hdr-config { border: 1px solid var(--vscode-panel-border); border-radius: 8px;
    padding: 12px 14px; margin-bottom: 16px; }
  .hdr-config .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .hdr-config h2 { font-size: 15px; margin: 0; }

  table.members { width: 100%; border-collapse: collapse; margin-top: 4px; }
  table.members th { text-align: left; font-size: 10px; text-transform: uppercase;
    letter-spacing: .06em; opacity: .55; padding: 4px 6px; font-weight: 600; }
  table.members td { padding: 4px 6px; border-top: 1px solid var(--vscode-panel-border); }
  table.members .oracle-name { font-size: 12px; font-weight: 600; }
  table.members input.oracle-new { width: 100%; min-width: 130px; }
  table.members select.role { min-width: 120px; }
  table.members select.model { min-width: 120px; }
  table.members select.color { width: 92px; }
  .sw { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 5px;
    vertical-align: middle; }
  .note { font-size: 11px; opacity: 0.6; margin-top: 8px; line-height: 1.5; }
  .barrow { display: flex; gap: 8px; margin-top: 14px; align-items: center; }
  .x { color: #f85149; cursor: pointer; font-weight: 700; border: none; background: none; font-size: 14px; }
</style></head>
<body>
  <div class="topbar">
    <h1 id="title">Teams <span class="count" id="count"></span></h1>
    <div class="actions" id="topActions"></div>
  </div>
  <div class="content" id="content"><div class="empty">Loading…</div></div>
<script>
  const vscode = acquireVsCodeApi();
  let VIEW = "list";
  let OPT = { roleOptions: [], colorOptions: [], modelOptions: [], defaultRole: "member", defaultModel: "claude-sonnet-5" };
  const COLOR_HEX = { blue:'#4ea1ff', green:'#3fb950', red:'#f85149', yellow:'#e3b341',
    magenta:'#d2a8ff', cyan:'#39c5cf', white:'#e6edf3', orange:'#f0883e' };

  function esc(s){ return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
  function el(id){ return document.getElementById(id); }
  function post(type, extra){ vscode.postMessage(Object.assign({ type: type }, extra||{})); }

  function optionList(values, sel){
    return values.map(v => '<option value="'+esc(v)+'"'+(v===sel?' selected':'')+'>'+esc(v)+'</option>').join('');
  }
  function roleSelect(sel){ return '<select class="role">'+optionList(OPT.roleOptions, sel||OPT.defaultRole)+'</select>'; }
  function colorSelect(sel){
    var opts = '<option value=""'+(!sel?' selected':'')+'>—</option>'
      + OPT.colorOptions.map(c => '<option value="'+esc(c)+'"'+(c===sel?' selected':'')+'>'+esc(c)+'</option>').join('');
    return '<select class="color">'+opts+'</select>';
  }
  function modelSelect(sel){
    var def = OPT.defaultModel || 'claude-sonnet-5';
    if (!sel || sel === 'claude') sel = def; // no model, or the bare engine name "claude" maw writes → default to sonnet-5
    var strip = function(v){ return String(v).replace(/^claude-/, ''); }; // display without the provider prefix; value keeps the full id
    var opts = (OPT.modelOptions || []).slice();
    if (opts.indexOf(sel) < 0) opts.unshift(sel); // keep a stored/default value not already in the list
    var body = opts.map(function(v){ return '<option value="'+esc(v)+'"'+(v===sel?' selected':'')+'>'+esc(strip(v))+'</option>'; }).join('');
    return '<select class="model">'+body+'</select>';
  }
  function swatch(c){ return c ? '<span class="sw" style="background:'+(COLOR_HEX[c]||'#8b949e')+'"></span>' : ''; }

  // ── List view ──────────────────────────────────────────────────────────────
  function renderList(teams){
    VIEW = "list";
    el("title").innerHTML = 'Teams <span class="count">'+teams.length+'</span>';
    el("topActions").innerHTML =
      '<button class="primary" onclick="post(\\'new_team\\')">＋ New Team</button>'
      + '<button onclick="post(\\'reload\\')">Reload</button>'
      + '<button onclick="post(\\'close\\')">Close</button>';
    el("content").innerHTML = teams.length
      ? teams.map(t =>
          '<div class="team-card" data-name="'+esc(t.name)+'">'
          + '<div><div class="tc-name">'+esc(t.name)+'</div>'
          + '<div class="tc-meta">'+t.memberCount+' สมาชิก · '+esc((t.roles||[]).join(', ')||'—')+'</div></div>'
          + '<div style="opacity:.4">›</div></div>'
        ).join('')
      : '<div class="empty">ยังไม่มีทีม — กด ＋ New Team</div>';
    el("content").querySelectorAll('.team-card').forEach(c =>
      c.addEventListener('click', () => post('open_team', { name: c.dataset.name })));
  }

  // ── Member table (shared by detail + create) ────────────────────────────────
  function memberRowHtml(m, editableOracle, candidates){
    var nameCell = editableOracle
      ? '<input type="text" class="oracle-new" list="oracle-suggest" placeholder="ชื่อ oracle ใหม่" value="'+esc(m.oracle||'')+'">'
      : '<span class="oracle-name">'+esc(m.oracle)+'</span>';
    return '<tr>'
      + '<td>'+nameCell+'</td>'
      + '<td>'+roleSelect(m.role)+'</td>'
      + '<td>'+modelSelect(m.model||'')+'</td>'
      + '<td>'+swatch(m.color)+colorSelect(m.color)+'</td>'
      + '<td><button class="x" title="ลบ">✕</button></td>'
      + '</tr>';
  }
  function readMembers(tbody){
    var out = [];
    tbody.querySelectorAll('tr').forEach(function(tr){
      var newInput = tr.querySelector('.oracle-new');
      var nameSpan = tr.querySelector('.oracle-name');
      var oracle = newInput ? newInput.value.trim() : (nameSpan ? nameSpan.textContent : '');
      if (!oracle) return;
      out.push({
        oracle: oracle,
        role: tr.querySelector('.role').value,
        model: tr.querySelector('.model').value.trim(),
        color: tr.querySelector('.color').value,
      });
    });
    return out;
  }
  function wireMemberTable(root, candidates){
    var tbody = root.querySelector('tbody');
    root.querySelectorAll('.x').forEach(function(b){
      b.addEventListener('click', function(){ b.closest('tr').remove(); });
    });
    var addBtn = root.querySelector('.add-member');
    if (addBtn) addBtn.addEventListener('click', function(){
      // Always addable — a blank row where you TYPE a new (or existing) oracle
      // name; brand-new names get scaffolded into a real oracle on Save.
      var holder = document.createElement('tbody');
      holder.innerHTML = memberRowHtml({ oracle: '', role: OPT.defaultRole }, true, candidates);
      var row = holder.firstElementChild;
      tbody.appendChild(row);
      row.querySelector('.x').addEventListener('click', function(){ row.remove(); });
      var inp = row.querySelector('.oracle-new'); if (inp) inp.focus();
    });
  }
  function memberTableHtml(members, editableOracle, candidates){
    // Shared suggestions: existing oracle names autocomplete in the text input,
    // but you can also just type a brand-new name to create one.
    var dl = '<datalist id="oracle-suggest">'
      + (candidates||[]).map(function(c){ return '<option value="'+esc(c)+'">'; }).join('')
      + '</datalist>';
    return '<table class="members"><thead><tr>'
      + '<th>oracle</th><th>role</th><th>model</th><th>color</th><th></th>'
      + '</tr></thead><tbody>'
      + members.map(function(m){ return memberRowHtml(m, editableOracle, candidates); }).join('')
      + '</tbody></table>' + dl
      + '<div class="barrow"><button class="add-member">＋ Add member</button></div>';
  }

  // ── Detail view ─────────────────────────────────────────────────────────────
  function renderDetail(m){
    VIEW = "detail";
    OPT = { roleOptions: m.roleOptions, colorOptions: m.colorOptions,
      modelOptions: m.modelOptions || [], defaultRole: m.defaultRole, defaultModel: m.defaultModel };
    var t = m.team;
    el("title").innerHTML = 'Team · '+esc(t.name);
    el("topActions").innerHTML =
      '<button onclick="post(\\'reload\\')">← Teams</button>'
      + '<button onclick="post(\\'close\\')">Close</button>';
    el("content").innerHTML =
      '<div class="hdr-config">'
      + '<div class="row"><h2>'+esc(t.name)+'</h2>'
      + '<button class="danger" id="delTeam">🗑 Delete team</button></div>'
      + '<label>คำอธิบายทีม</label>'
      + '<textarea id="teamDesc" rows="2">'+esc(t.description||'')+'</textarea>'
      + '</div>'
      + '<label>สมาชิก ('+t.members.length+')</label>'
      + memberTableHtml(t.members, false, m.candidates)
      + '<div class="barrow"><button class="primary" id="saveTeam">Save</button></div>';
    var content = el("content");
    wireMemberTable(content, m.candidates);
    el("delTeam").addEventListener('click', function(){ post('delete_team', { name: t.name }); });
    el("saveTeam").addEventListener('click', function(){
      post('save_team', {
        name: t.name,
        description: el("teamDesc").value,
        members: readMembers(content.querySelector('tbody')),
      });
    });
  }

  // ── New team view ────────────────────────────────────────────────────────────
  function renderNew(m){
    VIEW = "new";
    OPT = { roleOptions: m.roleOptions, colorOptions: m.colorOptions,
      modelOptions: m.modelOptions || [], defaultRole: m.defaultRole, defaultModel: m.defaultModel };
    el("title").innerHTML = 'New Team';
    el("topActions").innerHTML =
      '<button onclick="post(\\'reload\\')">← Teams</button>'
      + '<button onclick="post(\\'close\\')">Close</button>';
    el("content").innerHTML =
      '<div class="hdr-config">'
      + '<label>ชื่อทีม (A-Z a-z 0-9 . _ -)</label>'
      + '<input type="text" id="newName" placeholder="เช่น alpha">'
      + '<label>คำอธิบาย</label>'
      + '<textarea id="newDesc" rows="2"></textarea>'
      + '</div>'
      + '<label>สมาชิก</label>'
      + memberTableHtml([], true, m.candidates)
      + '<div class="barrow"><button class="primary" id="createTeam">Create</button></div>';
    var content = el("content");
    wireMemberTable(content, m.candidates);
    el("createTeam").addEventListener('click', function(){
      post('create_team', {
        name: el("newName").value,
        description: el("newDesc").value,
        members: readMembers(content.querySelector('tbody')),
      });
    });
  }

  window.addEventListener("message", function(e){
    var m = e.data;
    if (!m || !m.type) return;
    if (m.type === "team_list") renderList(m.teams || []);
    else if (m.type === "team_detail") renderDetail(m);
    else if (m.type === "team_new") renderNew(m);
    else if (m.type === "go_list") post('reload');
  });
  post("ready");
</script></body></html>`;
}

import * as vscode from "vscode";

import {
  availableModels,
  createTeam,
  deleteTeam,
  listTeamSummaries,
  oracleCandidates,
  readTeamDetailSync,
  saveTeam,
  teamExists,
} from "../commands/teamsOps";
import {
  COLOR_OPTIONS,
  DEFAULT_ROLE,
  ROLE_OPTIONS,
  isSafeTeamName,
  normalizeOracle,
  type TeamMember,
} from "../commands/teamsModel";
import { getDefaultMemberModel } from "../commands/settingsOps";
import { teamUp, teamUpMember } from "../commands/teamUp";

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
};

// defaultModel is resolved fresh each push (not baked into OPTIONS) so a change
// on the Settings page takes effect without reopening the panel. The Settings
// knob default_member_model drives what a new/empty member row pre-selects.
function panelOptions() {
  return { ...OPTIONS, defaultModel: getDefaultMemberModel() };
}

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
    ...panelOptions(),
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
    // Shared with the panel's duplicate check (normalizeOracle) so both agree.
    const oracle = normalizeOracle(typeof m?.oracle === "string" ? m.oracle : "");
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
    "Team Config",
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
          ...panelOptions(),
          modelOptions,
        });
        return;
      }
      case "save_team": {
        const name = typeof msg.name === "string" ? msg.name : "";
        if (!isSafeTeamName(name)) {
          // busy() already disabled the Save button — must release it or it
          // stays stuck at "Working…" forever.
          vscode.window.showErrorMessage(`Teams: ชื่อทีมไม่ถูกต้อง: '${name}'`);
          panel.webview.postMessage({ type: "op_done" });
          return;
        }
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
      case "team_up": {
        const name = typeof msg.name === "string" ? msg.name : "";
        if (!isSafeTeamName(name)) {
          vscode.window.showErrorMessage(`Teams: ชื่อทีมไม่ถูกต้อง: '${name}'`);
          panel.webview.postMessage({ type: "op_done" });
          return;
        }
        const r = teamUp(name);
        if (r.error) {
          vscode.window.showErrorMessage(`Teams: team up '${name}' — ${r.error}`);
        } else if (r.minted) {
          vscode.window.showInformationMessage(
            `Teams: '${name}' มี session อยู่แล้ว → เปิด instance ใหม่ '${r.session}' (attach ใน terminal)`,
          );
        } else {
          vscode.window.showInformationMessage(
            `Teams: team up '${name}' → session '${r.session}' (attach ใน terminal)`,
          );
        }
        // Opening a terminal returns immediately — release the button.
        panel.webview.postMessage({ type: "op_done" });
        return;
      }
      case "team_up_member": {
        const name = typeof msg.name === "string" ? msg.name : "";
        const oracle = typeof msg.oracle === "string" ? msg.oracle : "";
        if (!isSafeTeamName(name) || !isSafeTeamName(oracle)) {
          vscode.window.showErrorMessage(`Teams: ชื่อทีม/oracle ไม่ถูกต้อง: '${name}' / '${oracle}'`);
          panel.webview.postMessage({ type: "op_done" });
          return;
        }
        const r = teamUpMember(name, oracle);
        if (r.error) {
          vscode.window.showErrorMessage(`Teams: wake '${oracle}' — ${r.error}`);
        } else if (r.minted) {
          vscode.window.showInformationMessage(
            `Teams: '${name}' มี session อยู่แล้ว → ปลุก '${oracle}' เข้า instance ใหม่ '${r.session}' (attach ใน terminal)`,
          );
        } else {
          vscode.window.showInformationMessage(
            `Teams: ปลุก '${oracle}' → session '${r.session}' (attach ใน terminal)`,
          );
        }
        panel.webview.postMessage({ type: "op_done" });
        return;
      }
      case "create_team": {
        const name = typeof msg.name === "string" ? msg.name.trim() : "";
        if (!isSafeTeamName(name)) {
          vscode.window.showErrorMessage(
            `Teams: ชื่อทีมไม่ถูกต้อง (ใช้ได้แค่ A-Z a-z 0-9 . _ -): '${name}'`,
          );
          panel.webview.postMessage({ type: "op_done" });
          return;
        }
        // Guard against ALL stores (incl. the ψ vault maw checks) so a duplicate
        // — even a vault-only ghost — is caught here with a clean message rather
        // than reaching maw and failing with a cryptic error.
        if (teamExists(name)) {
          vscode.window.showErrorMessage(`Teams: ทีม '${name}' มีอยู่แล้ว`);
          panel.webview.postMessage({ type: "op_done" });
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
        if (r.ok) {
          pushList(panel); // refresh list, then jump into the new team
          await pushDetail(panel, name);
        } else {
          // Stay on the form so the user can fix + retry; re-enable its button.
          // (Do NOT pushList here — it re-renders the list view over the form,
          // wiping the typed name/members the user needs to fix.)
          panel.webview.postMessage({ type: "op_done" });
        }
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

export function renderShell(): string {
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
  .wake { color: #3fb950; cursor: pointer; font-weight: 700; border: none; background: none;
    font-size: 12px; padding: 0; margin-right: 6px; }
  table.members tr.dup td { background: rgba(248,81,73,0.09); }
  table.members tr.dup .oracle-new { border-color: #f85149; box-shadow: 0 0 0 1px #f85149; }
  table.members tr.dup .oracle-name { color: #f85149; }
  .dup-msg { color: #f85149; font-size: 12px; margin: 12px 0 0; display: none; }
  button:disabled { opacity: 0.45; cursor: not-allowed; }
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
  // Disable a submit button on click so a create/save can't be double-fired
  // while the extension is mid-maw (a create with new members takes seconds).
  // Returns true if already busy (caller should bail). The extension re-enables
  // via an "op_done" message on failure; on success it re-renders a fresh DOM.
  function busy(btn){
    if (btn.disabled) return true;
    btn.disabled = true;
    btn.dataset.label = btn.textContent;
    btn.textContent = 'Working…';
    return false;
  }
  function clearBusy(){
    var b = document.querySelector('button[data-label]');
    while (b){ b.disabled = false; b.textContent = b.dataset.label; delete b.dataset.label;
      b = document.querySelector('button[data-label]'); }
  }

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
    var wakeBtn = editableOracle ? '' : '<button class="wake" title="ปลุก '+esc(m.oracle)+' คนเดียว">▶</button>';
    return '<tr>'
      + '<td>'+nameCell+'</td>'
      + '<td>'+roleSelect(m.role)+'</td>'
      + '<td>'+modelSelect(m.model||'')+'</td>'
      + '<td>'+swatch(m.color)+colorSelect(m.color)+'</td>'
      + '<td>'+wakeBtn+'<button class="x" title="ลบ">✕</button></td>'
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
  // ── Duplicate-name guard ─────────────────────────────────────────────────────
  // Mirrors teamsModel.normalizeOracle / findDuplicateOracleNames (a webview
  // script can't import). Uses a Set (NOT a plain object) so oracle names like
  // "toString"/"constructor" don't collide with Object.prototype keys.
  function normOracle(s){
    s = String(s == null ? '' : s).trim();
    return s.slice(-7) === '-oracle' ? s.slice(0, -7) : s;
  }
  function duplicateNames(names){
    var seen = new Set(), dup = new Set();
    names.forEach(function(n){
      var k = normOracle(n);
      if (!k) return;            // blank rows are never a duplicate
      if (seen.has(k)) dup.add(k);
      seen.add(k);
    });
    return dup;
  }
  function rowNames(tbody){
    return Array.prototype.map.call(tbody.querySelectorAll('tr'), function(tr){
      var ni = tr.querySelector('.oracle-new');
      var ns = tr.querySelector('.oracle-name');
      return ni ? ni.value : (ns ? ns.textContent : '');
    });
  }
  // Highlight every row in a duplicated-name group, show the message, and block
  // Save until the roster is unique. Runs live (typing/add/remove) + on render.
  function validateMembers(root){
    var tbody = root.querySelector('tbody'); if (!tbody) return;
    var trs = tbody.querySelectorAll('tr');
    var names = rowNames(tbody);
    var dup = duplicateNames(names);
    Array.prototype.forEach.call(trs, function(tr, i){
      var k = normOracle(names[i]);
      tr.classList.toggle('dup', !!k && dup.has(k));
    });
    var list = []; dup.forEach(function(k){ list.push(k); });
    var msg = el('dupMsg');
    if (msg){
      if (list.length){
        msg.textContent = '⚠ ชื่อ oracle ซ้ำ: ' + list.join(', ') + ' — แก้ให้ไม่ซ้ำก่อนบันทึก';
        msg.style.display = 'block';
      } else {
        msg.textContent = ''; msg.style.display = 'none';
      }
    }
    // Don't fight busy(): only manage the disabled state when the button isn't
    // mid-save (busy() tags it with data-label while a save/create is in flight).
    var save = el('saveTeam') || el('createTeam');
    if (save && !save.dataset.label) save.disabled = list.length > 0;
  }

  function wireMemberTable(root, candidates){
    var tbody = root.querySelector('tbody');
    function bindRow(tr){
      var x = tr.querySelector('.x');
      if (x) x.addEventListener('click', function(){ tr.remove(); validateMembers(root); });
      var inp = tr.querySelector('.oracle-new');
      if (inp) inp.addEventListener('input', function(){ validateMembers(root); });
    }
    Array.prototype.forEach.call(tbody.querySelectorAll('tr'), bindRow);
    var addBtn = root.querySelector('.add-member');
    if (addBtn) addBtn.addEventListener('click', function(){
      // Always addable — a blank row where you TYPE a new (or existing) oracle
      // name; brand-new names get scaffolded into a real oracle on Save.
      var holder = document.createElement('tbody');
      holder.innerHTML = memberRowHtml({ oracle: '', role: OPT.defaultRole }, true, candidates);
      var row = holder.firstElementChild;
      tbody.appendChild(row);
      bindRow(row);
      var inp = row.querySelector('.oracle-new'); if (inp) inp.focus();
      validateMembers(root);
    });
    validateMembers(root); // initial state — flags divergent stores that already dup
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
      + '<div style="display:flex;gap:6px">'
      + '<button class="primary" id="teamUp" title="maw team up — ปลุกทีมนี้เข้า tmux session แล้ว attach (ถ้ามี session อยู่แล้วเปิด instance ใหม่ -N)">▶ Team up</button>'
      + '<button class="danger" id="delTeam">🗑 Delete team</button></div></div>'
      + '<label>คำอธิบายทีม</label>'
      + '<textarea id="teamDesc" rows="2">'+esc(t.description||'')+'</textarea>'
      + '</div>'
      + '<label>สมาชิก ('+t.members.length+')</label>'
      + memberTableHtml(t.members, false, m.candidates)
      + '<div class="dup-msg" id="dupMsg"></div>'
      + '<div class="barrow"><button class="primary" id="saveTeam">Save</button></div>';
    var content = el("content");
    wireMemberTable(content, m.candidates);
    content.querySelectorAll('.wake').forEach(function(btn){
      btn.addEventListener('click', function(){
        if (busy(this)) return;
        var span = this.closest('tr').querySelector('.oracle-name');
        post('team_up_member', { name: t.name, oracle: span ? span.textContent : '' });
      });
    });
    el("delTeam").addEventListener('click', function(){ post('delete_team', { name: t.name }); });
    el("teamUp").addEventListener('click', function(){
      if (busy(this)) return;
      post('team_up', { name: t.name });
    });
    el("saveTeam").addEventListener('click', function(){
      if (busy(this)) return;
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
      + '<div class="dup-msg" id="dupMsg"></div>'
      + '<div class="barrow"><button class="primary" id="createTeam">Create</button></div>';
    var content = el("content");
    wireMemberTable(content, m.candidates);
    el("createTeam").addEventListener('click', function(){
      if (busy(this)) return;
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
    else if (m.type === "op_done") clearBusy();
  });
  post("ready");
</script></body></html>`;
}

import * as vscode from "vscode";

import * as gitOps from "../commands/gitOps";
import { parseGitButtonState, type GitButtonState } from "../commands/gitStatus";
import {
  defaultTeamFor,
  launchOrchestrator,
  listOrchestratorTeams,
  scanResumableProjects,
} from "../commands/startOrchestrator";
import type { ResumableProject } from "../commands/orchestratorResume";
import type { OracleTeam } from "../commands/teams";

// Dedicated editor-tab panel for the "▶ เริ่มใหม่ / ⏮ ทำต่อ" orchestrator flow —
// its OWN webview (not a dashboard overlay), mirroring teams.ts. Wizard steps:
//   continue: project → team → orchestrator → launch (resume)
//   new:                team → orchestrator → launch
// The project step carries the per-repo git buttons (Commit/Push/Create&Push).
// One panel per mode is enough; reopening reveals + resets to step 1.
let _panel: vscode.WebviewPanel | undefined;

interface WizState {
  mode: "new" | "continue";
  projects: ResumableProject[];
  project?: ResumableProject;
  team?: OracleTeam;
}
let _st: WizState | undefined;

async function computeGitStates(
  projects: ResumableProject[],
  fetch = false,
): Promise<Record<string, GitButtonState>> {
  const out: Record<string, GitButtonState> = {};
  await Promise.all(
    projects.map(async (p) => {
      if (fetch) await gitOps.fetchRepo(p.path);
      out[p.path] = parseGitButtonState(await gitOps.readGitStatus(p.path));
    }),
  );
  return out;
}

async function pushProjectsScreen(panel: vscode.WebviewPanel, fetch = false) {
  const projects = _st?.projects ?? [];
  const states = await computeGitStates(projects, fetch);
  panel.webview.postMessage({
    type: "screen_projects",
    title: "⏮ ทำต่อ — เลือก project ค้าง",
    subtitle: projects.length
      ? "📋 เหลือ = sprint ที่วางแผนไว้ (docs/plan.md) ยังไม่ทำ · 🔨 ค้าง = sprint ทำไม่จบ (worktree เปิด) · ปุ่มขวา = git"
      : "ไม่พบงานค้าง — ต้องมี docs/plan.md, docs/sprint-*.md หรือ worktree agents/* เปิดอยู่",
    items: projects.map((p) => ({
      path: p.path,
      name: p.name,
      sprints: p.sprintDocs,
      worktrees: p.openWorktrees,
      plannedTotal: p.plannedTotal,
      plannedDone: p.plannedDone,
      git: { path: p.path, ...states[p.path] },
    })),
  });
}

function pushTeamsScreen(panel: vscode.WebviewPanel) {
  const teams = listOrchestratorTeams();
  const def = _st?.project ? defaultTeamFor(_st.project, teams) : null;
  // Last-used team floats to the top; the rest keep their existing order.
  const ordered = def
    ? [...teams.filter((t) => t.name === def), ...teams.filter((t) => t.name !== def)]
    : teams;
  panel.webview.postMessage({
    type: "screen_teams",
    title: (_st?.mode === "continue" ? "⏮ ทำต่อ" : "▶ เริ่มใหม่") + " — เลือกทีม",
    subtitle: _st?.project ? `project: ${_st.project.name}` : "เลือก oracle-team",
    canBack: _st?.mode === "continue",
    items: ordered.map((t) => ({
      name: t.name,
      isDefault: t.name === def,
      sub: `${t.members.length} members · orchestrator: ${
        t.orchestrators.join(", ") || "(none)"
      }`,
    })),
  });
}

function pushOrchScreen(panel: vscode.WebviewPanel, team: OracleTeam) {
  panel.webview.postMessage({
    type: "screen_orch",
    title: `${team.name} — เลือก orchestrator`,
    subtitle: "ทีมนี้มี orchestrator หลายตัว",
    items: team.orchestrators.map((o) => ({ name: o })),
  });
}

/** Team chosen → 1 orchestrator auto-launches; >1 asks; 0 guides. */
function pickTeam(panel: vscode.WebviewPanel, name: string) {
  if (!_st) return;
  const team = listOrchestratorTeams().find((t) => t.name === name);
  if (!team) return;
  _st.team = team;
  if (!team.orchestrators.length) {
    vscode.window.showWarningMessage(
      `Orchestrator: ทีม '${team.name}' ไม่มี member role:orchestrator — เพิ่มก่อนในหน้า Teams`,
    );
    return;
  }
  if (team.orchestrators.length === 1) {
    doLaunch(panel, team.orchestrators[0]);
  } else {
    pushOrchScreen(panel, team);
  }
}

function doLaunch(panel: vscode.WebviewPanel, orch: string) {
  if (!_st?.team) return;
  const err = launchOrchestrator({
    orch,
    team: _st.team,
    mode: _st.mode === "continue" ? "resume" : "new",
    project: _st.project,
  });
  if (err) {
    vscode.window.showErrorMessage(`Orchestrator: ${err}`);
    return;
  }
  vscode.window.showInformationMessage(
    `Orchestrator: ปลุก '${orch}' (team ${_st.team.name})` +
      (_st.project ? ` · resume ${_st.project.name}` : "") +
      " — เปิด terminal คุย requirement ได้เลย",
  );
  panel.dispose();
}

export function openOrchestratorPanel(mode: "new" | "continue"): vscode.WebviewPanel {
  _st = { mode, projects: mode === "continue" ? scanResumableProjects() : [] };
  if (_panel) {
    _panel.title = titleFor(mode);
    _panel.reveal();
    // reset to step 1 for the freshly-chosen mode
    if (mode === "continue") void pushProjectsScreen(_panel);
    else pushTeamsScreen(_panel);
    return _panel;
  }
  const panel = vscode.window.createWebviewPanel(
    "missioncontrol.orchestrator",
    titleFor(mode),
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  _panel = panel;
  panel.onDidDispose(() => {
    _panel = undefined;
    _st = undefined;
  });
  panel.webview.html = renderShell();

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (!msg || typeof msg.type !== "string" || !_st) return;
    switch (msg.type) {
      case "ready":
        if (_st.mode === "continue") await pushProjectsScreen(panel);
        else pushTeamsScreen(panel);
        return;
      case "pick_project": {
        const p = _st.projects.find((x) => x.path === msg.path);
        if (!p) return;
        _st.project = p;
        pushTeamsScreen(panel);
        return;
      }
      case "pick_team":
        if (typeof msg.name === "string") pickTeam(panel, msg.name);
        return;
      case "pick_orch":
        if (typeof msg.name === "string") doLaunch(panel, msg.name);
        return;
      case "back":
        // teams → back to projects (continue mode only)
        if (_st.mode === "continue") {
          _st.project = undefined;
          _st.team = undefined;
          await pushProjectsScreen(panel);
        }
        return;
      case "git_refresh":
        await pushProjectsScreen(panel, true);
        return;
      case "git_init": {
        const p = typeof msg.path === "string" ? msg.path : "";
        if (!p) return;
        const r = await gitOps.gitInit(p);
        notify(r.ok, `git init ${short(p)}`, r);
        await pushProjectsScreen(panel);
        return;
      }
      case "git_auto": {
        const p = typeof msg.path === "string" ? msg.path : "";
        if (!p) return;
        panel.webview.postMessage({
          type: "git_auto_result",
          path: p,
          message: await gitOps.autoCommitMessage(p),
        });
        return;
      }
      case "git_commit": {
        const p = typeof msg.path === "string" ? msg.path : "";
        const message = typeof msg.message === "string" ? msg.message.trim() : "";
        if (!p || !message) return;
        const r = await gitOps.commitAll(p, message);
        notify(r.ok, `commit ${short(p)}`, r);
        await pushProjectsScreen(panel);
        return;
      }
      case "git_push": {
        const p = typeof msg.path === "string" ? msg.path : "";
        if (!p) return;
        const st = await gitOps.readGitStatus(p);
        const r = await gitOps.pushRepo(p, st.hasUpstream);
        notify(r.ok, `push ${short(p)}`, r);
        await pushProjectsScreen(panel);
        return;
      }
      case "git_createpush": {
        const p = typeof msg.path === "string" ? msg.path : "";
        const repoName = typeof msg.repoName === "string" ? msg.repoName.trim() : "";
        const isPrivate = msg.isPrivate !== false;
        if (!p || !repoName) return;
        const pick = await vscode.window.showWarningMessage(
          `สร้าง GitHub repo ${isPrivate ? "(private)" : "(public)"} '${repoName}' จาก ${short(
            p,
          )} แล้ว push?`,
          { modal: true },
          "Create & Push",
        );
        if (pick !== "Create & Push") return;
        const r = await gitOps.createAndPush(p, repoName, isPrivate);
        notify(r.ok, `create+push '${repoName}'`, r);
        await pushProjectsScreen(panel);
        return;
      }
    }
  });
  return panel;
}

function titleFor(mode: "new" | "continue"): string {
  return mode === "continue" ? "Orchestrator — ⏮ ทำต่อ" : "Orchestrator — ▶ เริ่มใหม่";
}
function short(p: string): string {
  return p.split("/").pop() || p;
}
function notify(ok: boolean, what: string, r: gitOps.RunResult): void {
  vscode.window[ok ? "showInformationMessage" : "showErrorMessage"](
    ok
      ? `Orchestrator: ${what} สำเร็จ`
      : `Orchestrator: ${what} ล้มเหลว — ${(r.stderr || r.stdout).split("\n")[0]}`,
  );
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
  .topbar .sub { font-size: 11px; opacity: 0.6; margin-top: 3px; font-weight: 400; }
  .topbar .actions { display: flex; gap: 6px; }
  button { background: transparent; color: var(--vscode-foreground);
    border: 1px solid var(--vscode-panel-border); padding: 4px 10px; border-radius: 3px;
    font-size: 11px; cursor: pointer; }
  button:hover { background: var(--vscode-list-hoverBackground); }
  .content { flex: 1; overflow-y: auto; padding: 14px 18px 28px; box-sizing: border-box; }
  .empty { opacity: 0.6; font-size: 13px; padding: 24px 0; }
  .card { display: flex; align-items: center; gap: 10px; padding: 12px 14px; margin-bottom: 8px;
    border-radius: 8px; background: var(--vscode-editor-inactiveSelectionBackground);
    border: 1px solid var(--vscode-panel-border); cursor: pointer; }
  .card .pick { flex: 1; display: flex; flex-direction: column; cursor: pointer; background: none;
    border: none; text-align: left; color: inherit; padding: 0; }
  .card:hover { background: var(--vscode-list-hoverBackground); }
  .card .cname { font-size: 13px; font-weight: 600; }
  .card .csub { font-size: 11px; opacity: 0.65; margin-top: 2px; }
  /* team-picker cards are the main action here → bigger + button-like */
  .teamcard { padding: 16px 18px; }
  .teamcard .cname { font-size: 15px; }
  .teamcard .csub { font-size: 12px; margin-top: 4px; }
  .card.default { border-color: #3fb950; background: rgba(63,185,80,0.12); }
  .card.default:hover { background: rgba(63,185,80,0.18); }
  .card.default .cname { color: #56d364; }
  .badge-last { font-size: 10px; font-weight: 700; color: #0d1117; background: #3fb950;
    padding: 1px 8px; border-radius: 8px; margin-left: 8px; vertical-align: middle; }
  .chip { font-size: 10px; padding: 1px 7px; border-radius: 8px; margin-left: 8px;
    vertical-align: middle; font-weight: 600; }
  .chip.act { background: rgba(196,127,26,0.22); color: #e3a13a; }
  .chip.idle { background: rgba(125,133,144,0.18); color: #9aa4af; }
  .chip.plan { background: rgba(56,139,253,0.20); color: #6cb0ff; }
  .git-editor { margin-top: 6px; }
  .git-editor textarea, .git-editor input { background: var(--vscode-input-background);
    color: var(--vscode-input-foreground); border: 1px solid var(--vscode-panel-border);
    border-radius: 4px; padding: 5px 7px; font-size: 12px; box-sizing: border-box;
    font-family: var(--vscode-font-family); cursor: auto; }
  .barrow { display: flex; gap: 6px; margin-top: 4px; }
</style></head>
<body>
  <div class="topbar">
    <div><h1 id="title">Orchestrator</h1><div class="sub" id="subtitle"></div></div>
    <div class="actions" id="actions"></div>
  </div>
  <div class="content" id="content"><div class="empty">Loading…</div></div>
<script>
  const vscode = acquireVsCodeApi();
  var COLOR = { commit:'#c47f1a', push:'#1f6feb', 'create-push':'#238636', init:'#57606a' };
  function esc(s){ return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
  function el(id){ return document.getElementById(id); }
  function post(t,x){ vscode.postMessage(Object.assign({type:t}, x||{})); }

  function actionsHtml(canBack){
    return (canBack ? '<button id="backBtn">← กลับ</button>' : '')
      + '<button id="reloadBtn">fetch</button>';
  }
  function wireActions(canBack){
    if (canBack){ var b=el("backBtn"); if(b) b.addEventListener('click',function(){post('back');}); }
    el("reloadBtn").addEventListener('click',function(){post('git_refresh');});
  }

  // ── git button (project rows) ────────────────────────────────────────────
  function gitCell(g){
    if (!g || g.kind==='none') return '';
    if (g.kind==='uptodate') return '<span style="color:#7d8590;font-size:11px;">'+esc(g.label)+'</span>';
    // commit / create-push open an inline form (message / repo name) — the caret
    // signals that, so the orange button doesn't read as "commit right now".
    var caret = (g.kind==='commit'||g.kind==='create-push') ? ' ▾' : '';
    return '<button class="git-act" data-kind="'+g.kind+'" style="background:'+(COLOR[g.kind]||'#555')
      +';color:#fff;border:none;border-radius:5px;padding:4px 10px;font-size:11px;">'+esc(g.label)+caret+'</button>';
  }
  function gitEditor(g){
    if (g.kind==='commit') return '<div class="git-editor" style="display:none">'
      +'<textarea class="git-msg" rows="2" style="width:100%" placeholder="commit message…"></textarea>'
      +'<div class="barrow"><button class="git-auto">✨ auto</button>'
      +'<button class="git-go" style="background:#238636;color:#fff;border:none;border-radius:5px;padding:4px 12px;font-weight:600;">✓ Commit</button>'
      +'<button class="git-x">ยกเลิก</button></div></div>';
    if (g.kind==='create-push'){ var _p=String(g.path||'').split('/').filter(Boolean); var def=_p[_p.length-1]||'';
      return '<div class="git-editor" style="display:none">'
      +'<input class="git-repo" value="'+esc(def)+'" style="width:55%"> '
      +'<label style="font-size:11px"><input type="checkbox" class="git-priv" checked> private</label>'
      +'<div class="barrow"><button class="git-go2">Create & Push</button><button class="git-x">ยกเลิก</button></div></div>'; }
    return '';
  }

  function renderProjects(m){
    el("title").textContent = m.title; el("subtitle").textContent = m.subtitle;
    el("actions").innerHTML = actionsHtml(false); wireActions(false);
    var items = m.items||[];
    el("content").innerHTML = items.length ? items.map(function(it){
      var wt = it.worktrees||0, sp = it.sprints||0;
      var pt = it.plannedTotal||0, pd = it.plannedDone||0;
      // 🔨 = an interrupted sprint (open worktree). Separate from the plan: a
      // project can be clean (no worktree) yet still have planned sprints left.
      var chip = wt > 0 ? '<span class="chip act">🔨 ค้าง '+wt+' sprint</span>' : '';
      // When docs/plan.md exists we know the FULL plan → show real progress
      // "did X of N, Y remaining" + a 📋 chip for the remaining planned sprints
      // (this is the fix for "asked for 3 sprints, only 1 ran, looked like a bug"
      // — the plan is now persisted, not lost when the build paused at a
      // checkpoint). No plan.md → fall back to the sprint-doc count.
      var sub, planChip = '';
      if (pt > 0) {
        var rem = pt - pd; if (rem < 0) rem = 0;
        sub = 'ทำ '+pd+'/'+pt+' sprint' + (rem > 0 ? ' · เหลือ '+rem : ' · ครบแล้ว');
        if (rem > 0) planChip = '<span class="chip plan">📋 เหลือ '+rem+'</span>';
      } else {
        sub = 'ทำไปแล้ว '+sp+' sprint';
      }
      return '<div class="card" data-path="'+esc(it.path)+'">'
        +'<div style="flex:1"><button class="pick"><span class="cname">'+esc(it.name)+planChip+chip+'</span>'
        +'<span class="csub">'+sub+'</span></button>'+gitEditor(it.git)+'</div>'
        +'<span class="git-cell">'+gitCell(it.git)+'</span></div>';
    }).join('') : '<div class="empty">'+esc(m.subtitle)+'</div>';
    el("content").querySelectorAll('.card').forEach(function(card){
      var path=card.dataset.path;
      // Whole row selects the project — except clicks on the git button or its
      // inline form (those do their own thing).
      card.addEventListener('click',function(e){
        if (e.target.closest('.git-act') || e.target.closest('.git-editor')) return;
        post('pick_project',{path:path});
      });
      wireGit(card, path);
    });
  }
  function wireGit(card, path){
    var ed=card.querySelector('.git-editor'), act=card.querySelector('.git-act');
    if(act) act.addEventListener('click',function(e){ e.stopPropagation();
      var k=act.dataset.kind;
      if(k==='push'){ post('git_push',{path:path}); return; }
      if(k==='init'){ post('git_init',{path:path}); return; }
      // commit / create-push: OPEN the form (never toggle-closed). Re-clicking the
      // orange button used to collapse it → looked like "nothing happened / stuck".
      if(ed){ ed.style.display='block'; var mb=ed.querySelector('.git-msg'); if(mb) mb.focus(); } });
    if(!ed) return;
    var x=ed.querySelector('.git-x'); if(x) x.addEventListener('click',function(){ed.style.display='none';});
    var au=ed.querySelector('.git-auto'); if(au) au.addEventListener('click',function(){au.textContent='✨ …';au.disabled=true;post('git_auto',{path:path});});
    var go=ed.querySelector('.git-go'); if(go) go.addEventListener('click',function(){
      var v=(ed.querySelector('.git-msg').value||'').trim(); if(!v)return; post('git_commit',{path:path,message:v}); ed.style.display='none';});
    var go2=ed.querySelector('.git-go2'); if(go2) go2.addEventListener('click',function(){
      var n=(ed.querySelector('.git-repo').value||'').trim(); if(!n)return;
      post('git_createpush',{path:path,repoName:n,isPrivate:ed.querySelector('.git-priv').checked}); ed.style.display='none';});
  }
  function fillAuto(path,message){
    var card=el("content").querySelector('.card[data-path="'+(window.CSS&&CSS.escape?CSS.escape(path):path)+'"]');
    if(!card)return; var au=card.querySelector('.git-auto'); if(au){au.textContent='✨ auto';au.disabled=false;}
    var ed=card.querySelector('.git-editor'); if(ed) ed.style.display='block';
    var box=card.querySelector('.git-msg'); if(box&&message) box.value=message;
  }

  function renderTeams(m){
    el("title").textContent=m.title; el("subtitle").textContent=m.subtitle;
    el("actions").innerHTML=actionsHtml(m.canBack); wireActions(m.canBack);
    var items=m.items||[];
    el("content").innerHTML = items.length ? items.map(function(it){
      return '<div class="card teamcard'+(it.isDefault?' default':'')+'" data-name="'+esc(it.name)+'"><button class="pick">'
        +'<span class="cname">'+esc(it.name)+(it.isDefault?'<span class="badge-last">⭐ ทำล่าสุด</span>':'')+'</span>'
        +'<span class="csub">'+esc(it.sub)+'</span></button></div>';
    }).join('') : '<div class="empty">ยังไม่มีทีม — สร้างในหน้า Teams ก่อน</div>';
    el("content").querySelectorAll('.card').forEach(function(c){
      c.addEventListener('click',function(){post('pick_team',{name:c.dataset.name});});});
  }
  function renderOrch(m){
    el("title").textContent=m.title; el("subtitle").textContent=m.subtitle;
    el("actions").innerHTML=actionsHtml(false); wireActions(false);
    el("content").innerHTML=(m.items||[]).map(function(it){
      return '<div class="card" data-name="'+esc(it.name)+'"><button class="pick">'
        +'<span class="cname">'+esc(it.name)+'</span><span class="csub">orchestrator</span></button></div>';
    }).join('');
    el("content").querySelectorAll('.card').forEach(function(c){
      c.addEventListener('click',function(){post('pick_orch',{name:c.dataset.name});});});
  }

  window.addEventListener("message",function(e){
    var m=e.data; if(!m||!m.type) return;
    if(m.type==="screen_projects") renderProjects(m);
    else if(m.type==="screen_teams") renderTeams(m);
    else if(m.type==="screen_orch") renderOrch(m);
    else if(m.type==="git_auto_result") fillAuto(m.path,m.message);
  });
  post("ready");
</script></body></html>`;
}

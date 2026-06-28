import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

// Frontend-only build: skills are read straight off disk from
// ~/.claude/skills/<name>/SKILL.md — no backend involved. Each skill is a
// directory containing a SKILL.md whose YAML frontmatter carries `name` and
// `description`. The panel shows them as a grid (4 per row) grouped by
// category; hovering a card pops up its description, clicking opens the file.
const SKILLS_DIR = path.join(os.homedir(), ".claude", "skills");

export type SkillSummary = {
  name: string;
  description: string;
  category: string | null;
  path: string;
};

// Singleton — only one Skills panel makes sense at a time. Cleared on
// onDidDispose so the next openSkillsPanel call creates a fresh one.
let _panel: vscode.WebviewPanel | undefined;

/** Open (or reveal) the Skills viewer panel. `projectId` is accepted for
 *  call-site parity with the other webviews but unused — skills are local. */
export function openSkillsPanel(
  _projectId: string | null = null,
): vscode.WebviewPanel {
  if (_panel) {
    _panel.reveal();
    return _panel;
  }
  const panel = vscode.window.createWebviewPanel(
    "missioncontrol.skills",
    "Mission Control — Skills",
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true },
  );
  _panel = panel;
  panel.onDidDispose(() => {
    _panel = undefined;
  });

  // Cached so open_skill can resolve a name → on-disk path without rescanning.
  let skills = listSkills();

  panel.webview.html = renderShell();
  panel.webview.postMessage({ type: "render_list", skills });

  panel.webview.onDidReceiveMessage((msg) => {
    if (msg?.type === "close") {
      panel.dispose();
      return;
    }
    if (msg?.type === "reload") {
      skills = listSkills();
      panel.webview.postMessage({ type: "render_list", skills });
      return;
    }
    if (msg?.type === "open_skill" && typeof msg.name === "string") {
      const skill = skills.find((s) => s.name === msg.name);
      if (!skill) return;
      // Open the full SKILL.md beside the panel (preview tab is reused, so
      // repeated clicks don't stack editors).
      void vscode.window.showTextDocument(vscode.Uri.file(skill.path), {
        viewColumn: vscode.ViewColumn.Beside,
        preview: true,
      });
      return;
    }
  });

  return panel;
}

// ── Disk reading ───────────────────────────────────────────────────────────

/** Scan each ~/.claude/skills/<dir>/SKILL.md and return one summary per dir.
 *  Exported so the dashboard's Skills tile can show a real on-disk count. */
export function listSkills(): SkillSummary[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: SkillSummary[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const skillPath = path.join(SKILLS_DIR, e.name, "SKILL.md");
    let raw: string;
    try {
      raw = fs.readFileSync(skillPath, "utf8");
    } catch {
      continue; // dir without a SKILL.md — not a skill
    }
    const meta = parseFrontmatter(splitFrontmatter(raw).fm);
    const rawDesc = meta.description ?? "";
    const { category, text } = splitCategory(rawDesc);
    out.push({
      name: meta.name || e.name,
      description: text || rawDesc,
      category,
      path: skillPath,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Split a markdown file into its leading `---`-fenced frontmatter and body. */
function splitFrontmatter(raw: string): { fm: string; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  return m ? { fm: m[1], body: m[2] } : { fm: "", body: raw };
}

/** Minimal single-line YAML reader for the two keys we need. */
function parseFrontmatter(fm: string): { name?: string; description?: string } {
  const out: { name?: string; description?: string } = {};
  for (const key of ["name", "description"] as const) {
    const m = fm.match(new RegExp(`^${key}:[ \\t]*(.*)$`, "m"));
    if (m) out[key] = unquoteYaml(m[1].trim());
  }
  return out;
}

function unquoteYaml(v: string): string {
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
    return v.slice(1, -1).replace(/''/g, "'");
  }
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\"/g, '"');
  }
  return v;
}

/** Pull the leading "[standard]" tag off a description and strip the
 *  "vX.Y.Z G-SKLL | " version preamble these skills embed, leaving the
 *  human-readable description. Non-tagged descriptions pass through. */
function splitCategory(desc: string): { category: string | null; text: string } {
  let category: string | null = null;
  let text = desc;
  const tag = text.match(/^\s*\[([^\]]+)\]\s*/);
  if (tag) {
    category = tag[1];
    text = text.slice(tag[0].length);
  }
  const bar = text.match(/G-SKLL\s*\|\s*([\s\S]*)$/);
  if (bar) text = bar[1];
  text = text.trim();
  // Some descriptions wrap their prose in literal quotes after the "|" — drop a
  // balanced surrounding pair so the preview reads cleanly.
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    text = text.slice(1, -1).trim();
  }
  return { category, text };
}

// ── Webview shell ────────────────────────────────────────────────────────────

function renderShell(): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { height: 100%; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 16px;
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  .topbar h1 { font-size: 14px; margin: 0; font-weight: 600; }
  .topbar .count { font-size: 11px; opacity: 0.6; margin-left: 8px; font-weight: 400; }
  .topbar .actions { display: flex; gap: 6px; }
  .topbar button {
    background: transparent;
    color: var(--vscode-foreground);
    border: 1px solid var(--vscode-panel-border);
    padding: 4px 10px;
    border-radius: 3px;
    font-size: 11px;
    cursor: pointer;
  }
  .topbar button:hover { background: var(--vscode-list-hoverBackground); }

  .content { flex: 1; overflow-y: auto; padding: 6px 18px 28px; box-sizing: border-box; }

  /* A category block: colored header + a 4-column grid of cards. The accent
     color is supplied per-section via the inline --c custom property. */
  .section { margin-top: 18px; }
  .section-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
  .section-head .bar { width: 4px; height: 18px; border-radius: 2px; background: var(--c, #8b949e); }
  .section-head .label {
    font-size: 12px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.09em; color: var(--c, #8b949e);
  }
  .section-head .n { font-size: 11px; opacity: 0.55; }
  .section-head .line { flex: 1; height: 1px; background: var(--vscode-panel-border); opacity: 0.6; }

  .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
  .card {
    min-height: 40px;
    display: flex;
    align-items: center;
    padding: 8px 10px;
    border-radius: 6px;
    cursor: pointer;
    background: var(--vscode-editor-inactiveSelectionBackground);
    border: 1px solid var(--vscode-panel-border);
    border-left: 3px solid var(--c, #8b949e);
    box-sizing: border-box;
    transition: background 0.1s;
  }
  .card:hover { background: var(--vscode-list-hoverBackground); }
  .card .cname {
    font-size: 12px; font-weight: 600; line-height: 1.3;
    word-break: break-word;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }

  .empty { opacity: 0.6; font-size: 13px; padding: 24px 0; }

  /* Floating description pane — pops up next to the hovered card. */
  #hovercard {
    position: fixed;
    display: none;
    z-index: 50;
    width: 340px;
    max-height: 60vh;
    overflow: hidden;
    background: var(--vscode-editorHoverWidget-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-panel-border));
    border-radius: 6px;
    padding: 12px 14px;
    box-shadow: 0 6px 22px rgba(0,0,0,0.45);
    pointer-events: none;
  }
  #hovercard .hc-name { font-weight: 700; font-size: 13px; margin-bottom: 7px; display: flex; align-items: center; gap: 7px; }
  #hovercard .hc-desc { font-size: 12px; line-height: 1.55; opacity: 0.92; }
  .chip {
    display: inline-block;
    font-size: 10px;
    padding: 1px 7px;
    border-radius: 8px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
</style>
</head>
<body>
  <div class="topbar">
    <h1>Skills <span class="count" id="count"></span></h1>
    <div class="actions">
      <button onclick="reload()">Reload</button>
      <button onclick="close_()">Close</button>
    </div>
  </div>
  <div class="content" id="content"><div class="empty">Loading…</div></div>
  <div id="hovercard"></div>
<script>
  const vscode = acquireVsCodeApi();
  let skills = [];

  // Category ordering + colors. Unknown categories fall through to "other".
  const ORDER = ['core', 'standard', 'lab', 'zombie'];
  const COLORS = {
    core: '#4ea1ff', standard: '#3fb950', lab: '#bc8cff',
    zombie: '#f0883e', other: '#8b949e',
  };
  function color(cat) { return COLORS[cat] || '#8b949e'; }

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function find(name) { return skills.find(s => s.name === name); }

  function renderList(list) {
    skills = list;
    document.getElementById('count').textContent = list.length ? '(' + list.length + ')' : '';
    const root = document.getElementById('content');
    if (!list.length) {
      root.innerHTML = '<div class="empty">No skills found in ~/.claude/skills/.</div>';
      return;
    }
    // Bucket by category.
    const map = {};
    for (const s of list) { const k = s.category || 'other'; (map[k] = map[k] || []).push(s); }
    const known = ORDER.filter(k => map[k]);
    const extras = Object.keys(map).filter(k => !ORDER.includes(k) && k !== 'other').sort();
    const cats = [...known, ...extras, ...(map['other'] ? ['other'] : [])];

    root.innerHTML = cats.map(cat => {
      const items = map[cat];
      const cards = items.map(s =>
        '<div class="card" data-name="' + escapeHtml(s.name) + '">'
        + '<div class="cname">' + escapeHtml(s.name) + '</div></div>'
      ).join('');
      return '<section class="section" style="--c:' + color(cat) + '">'
        + '<div class="section-head"><span class="bar"></span>'
        +   '<span class="label">' + escapeHtml(cat) + '</span>'
        +   '<span class="n">' + items.length + '</span><span class="line"></span></div>'
        + '<div class="grid">' + cards + '</div></section>';
    }).join('');

    root.querySelectorAll('.card').forEach(el => {
      const name = el.getAttribute('data-name');
      el.addEventListener('mouseenter', () => showCard(name, el));
      el.addEventListener('mouseleave', hideCard);
      el.addEventListener('click', () => vscode.postMessage({ type: 'open_skill', name }));
    });
  }

  const card = document.getElementById('hovercard');
  function showCard(name, anchor) {
    const s = find(name);
    if (!s) return;
    const col = color(s.category || 'other');
    const chip = '<span class="chip" style="background:' + col + '22;color:' + col + '">'
      + escapeHtml(s.category || 'other') + '</span>';
    card.innerHTML = '<div class="hc-name">' + escapeHtml(s.name) + chip + '</div>'
      + '<div class="hc-desc">' + escapeHtml(s.description || '(no description)') + '</div>';
    card.style.display = 'block';
    // Position: prefer below-left of the card, flip/clamp to stay on screen.
    const r = anchor.getBoundingClientRect();
    const cw = card.offsetWidth, ch = card.offsetHeight, pad = 8;
    let left = r.left;
    let top = r.bottom + 6;
    if (left + cw > window.innerWidth - pad) left = window.innerWidth - cw - pad;
    if (left < pad) left = pad;
    if (top + ch > window.innerHeight - pad) top = r.top - ch - 6; // flip above
    if (top < pad) top = pad;
    card.style.left = left + 'px';
    card.style.top = top + 'px';
  }
  function hideCard() { card.style.display = 'none'; }

  function reload() { vscode.postMessage({ type: 'reload' }); }
  function close_() { vscode.postMessage({ type: 'close' }); }

  // A scroll moves the anchor out from under the pane — just hide it.
  document.getElementById('content').addEventListener('scroll', hideCard);

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'render_list') renderList(msg.skills || []);
  });
</script>
</body>
</html>`;
}

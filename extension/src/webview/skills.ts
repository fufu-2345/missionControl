import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

// Frontend-only build: skills are read straight off disk from
// ~/.claude/skills/<name>/SKILL.md — no backend involved. Each skill is a
// directory containing a SKILL.md whose YAML frontmatter carries `name` and
// `description`. The panel shows them as an accordion with just two buckets —
// "system" (every non-uploaded skill, whatever [tag] it self-declares) and
// "uploaded" (dropped in via the uploader). Each bucket is a full-width bar,
// collapsed by default; clicking it reveals a 4-column grid of its skills
// (paginated 50 at a time). A card's real [tag] still shows on hover.
// Overridable for tests (MC_SKILLS_DIR); defaults to the real global skills dir.
const SKILLS_DIR =
  process.env.MC_SKILLS_DIR || path.join(os.homedir(), ".claude", "skills");
// Skills added through the panel's uploader get this empty marker file so
// listSkills can force them into the synthetic "uploaded" category regardless
// of any [tag] their own SKILL.md carries.
const UPLOAD_MARKER = ".mc-uploaded";
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export type SkillSummary = {
  name: string;
  description: string;
  /** The skill's own [tag] (core/standard/lab/zombie…), or null when untagged.
   *  Shown verbatim on the hover chip. Uploaded skills report "uploaded". */
  category: string | null;
  /** Accordion bucket — the panel groups by THIS, not `category`. Uploaded
   *  skills are "uploaded"; auto-created skills (frontmatter installer:auto-skill)
   *  are "generated"; every other skill collapses into "system". */
  group: "system" | "uploaded" | "generated";
  path: string;
  /** True when dropped in via the uploader (has UPLOAD_MARKER). Only these
   *  get an on/off toggle; system skills are always active. */
  uploaded: boolean;
  /** False when the skill is disabled (SKILL.md renamed to SKILL.md.disabled). */
  enabled: boolean;
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
    if (msg?.type === "upload_skill" && typeof msg.dataB64 === "string") {
      void handleUpload(String(msg.filename ?? ""), msg.dataB64).then((res) => {
        if (res.ok) {
          skills = listSkills();
          panel.webview.postMessage({ type: "render_list", skills });
          panel.webview.postMessage({ type: "upload_ok", name: res.name });
        } else {
          panel.webview.postMessage({ type: "upload_error", message: res.message });
        }
      });
      return;
    }
    if (msg?.type === "toggle_skill" && typeof msg.name === "string") {
      const res = toggleSkill(msg.name, skills);
      if (res.ok) {
        skills = listSkills();
        panel.webview.postMessage({ type: "render_list", skills });
      } else {
        panel.webview.postMessage({ type: "upload_error", message: res.message });
      }
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
    const dir = path.join(SKILLS_DIR, e.name);
    // A skill is normally <dir>/SKILL.md. Disabling an uploaded skill renames
    // that to SKILL.md.disabled (so Claude Code stops discovering it) while we
    // still list it here as an "off" card the user can flip back on.
    let skillPath = path.join(dir, "SKILL.md");
    let enabled = true;
    let raw: string;
    try {
      raw = fs.readFileSync(skillPath, "utf8");
    } catch {
      const disabledPath = skillPath + ".disabled";
      try {
        raw = fs.readFileSync(disabledPath, "utf8");
        skillPath = disabledPath;
        enabled = false;
      } catch {
        continue; // neither SKILL.md nor SKILL.md.disabled — not a skill
      }
    }
    const meta = parseFrontmatter(splitFrontmatter(raw).fm);
    const rawDesc = meta.description ?? "";
    const { category, text } = splitCategory(rawDesc);
    // A marker file (dropped by the uploader) wins over the parsed tag — these
    // are surfaced under the "uploaded" category no matter what they self-tag.
    const uploaded = fs.existsSync(path.join(dir, UPLOAD_MARKER));
    // Auto-created skills stamp installer:auto-skill — they get their own
    // "generated" bucket instead of collapsing into "system".
    const generated = !uploaded && meta.installer === "auto-skill";
    out.push({
      name: meta.name || e.name,
      description: text || rawDesc,
      // `category` keeps the real [tag] for the hover chip; `group` is the
      // accordion key. uploaded wins the marker; auto-created → generated;
      // everything else → system.
      category: uploaded ? "uploaded" : generated ? meta.category || "generated" : category,
      group: uploaded ? "uploaded" : generated ? "generated" : "system",
      path: skillPath,
      uploaded,
      enabled,
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
function parseFrontmatter(fm: string): {
  name?: string;
  description?: string;
  installer?: string;
  category?: string;
} {
  const out: { name?: string; description?: string; installer?: string; category?: string } = {};
  for (const key of ["name", "description", "installer", "category"] as const) {
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

// ── Uploading a skill (.zip) ─────────────────────────────────────────────────

/** Handle a dropped/selected .zip: unzip to a temp dir, locate the folder
 *  holding SKILL.md, and copy it into ~/.claude/skills/<name>/ with an
 *  UPLOAD_MARKER so it lands under "uploaded". Every failure returns a typed
 *  message the webview surfaces; nothing throws. */
async function handleUpload(
  filename: string,
  dataB64: string,
): Promise<{ ok: true; name: string } | { ok: false; message: string }> {
  if (!filename.toLowerCase().endsWith(".zip")) {
    return { ok: false, message: "Only .zip files are supported." };
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(dataB64, "base64");
  } catch {
    return { ok: false, message: "Could not read the uploaded file." };
  }
  if (buf.length === 0) return { ok: false, message: "The file is empty." };
  if (buf.length > MAX_UPLOAD_BYTES) {
    return { ok: false, message: "File too large (max 25 MB)." };
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mc-skill-"));
  const zipPath = path.join(tmpRoot, "upload.zip");
  const outDir = path.join(tmpRoot, "out");
  try {
    fs.writeFileSync(zipPath, buf);
    fs.mkdirSync(outDir);
    const un = cp.spawnSync("unzip", ["-oq", zipPath, "-d", outDir], {
      timeout: 20000,
    });
    if (un.error || un.status !== 0) {
      return {
        ok: false,
        message: "Could not unzip — the file may be corrupt or not a real .zip.",
      };
    }
    const skillDir = findSkillDir(outDir, 0);
    if (!skillDir) {
      return { ok: false, message: "No SKILL.md found inside the zip." };
    }
    const name = deriveSkillName(skillDir, outDir, filename);
    if (!isSafeName(name)) {
      return {
        ok: false,
        message: "Could not derive a safe skill name from the zip.",
      };
    }
    const dest = path.join(SKILLS_DIR, name);
    if (fs.existsSync(dest)) {
      return {
        ok: false,
        message: `A skill named "${name}" already exists — remove it first.`,
      };
    }
    fs.mkdirSync(SKILLS_DIR, { recursive: true });
    fs.cpSync(skillDir, dest, { recursive: true });
    fs.writeFileSync(path.join(dest, UPLOAD_MARKER), "");
    return { ok: true, name };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* best effort — temp dir cleanup */
    }
  }
}

/** Find the directory holding SKILL.md — the extraction root, or a nested
 *  folder (common when a zip wraps everything in a top-level <skill>/ dir).
 *  Bounded to two levels so a deep archive can't spin. */
function findSkillDir(root: string, depth: number): string | null {
  if (fs.existsSync(path.join(root, "SKILL.md"))) return root;
  if (depth >= 2) return null;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === "__MACOSX") continue;
    const found = findSkillDir(path.join(root, e.name), depth + 1);
    if (found) return found;
  }
  return null;
}

/** Skill name = the SKILL.md's folder name when it sits in a named subdir,
 *  else the zip's filename stem. Slugified to a filesystem-safe token. */
function deriveSkillName(
  skillDir: string,
  outRoot: string,
  zipFilename: string,
): string {
  const base =
    path.resolve(skillDir) === path.resolve(outRoot)
      ? zipFilename
      : path.basename(skillDir);
  return slugifyName(base);
}

function slugifyName(s: string): string {
  return s
    .trim()
    .replace(/\.(zip|skill)$/i, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
}

/** Guard against path traversal / weird names before we touch the FS. */
function isSafeName(name: string): boolean {
  return (
    /^[A-Za-z0-9._-]+$/.test(name) &&
    name !== "." &&
    name !== ".." &&
    !name.includes("..")
  );
}

/** Flip an uploaded skill on/off by renaming SKILL.md <-> SKILL.md.disabled.
 *  Only uploaded skills toggle; system skills stay always-active. */
function toggleSkill(
  name: string,
  skills: SkillSummary[],
): { ok: true } | { ok: false; message: string } {
  const s = skills.find((x) => x.name === name);
  if (!s) return { ok: false, message: "Skill not found." };
  if (!s.uploaded) {
    return { ok: false, message: "Only uploaded skills can be toggled." };
  }
  const dir = path.dirname(s.path);
  const on = path.join(dir, "SKILL.md");
  const off = path.join(dir, "SKILL.md.disabled");
  try {
    if (fs.existsSync(on)) {
      fs.renameSync(on, off); // enabled -> disabled
    } else if (fs.existsSync(off)) {
      fs.renameSync(off, on); // disabled -> enabled
    } else {
      return { ok: false, message: "SKILL.md is missing." };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Webview shell ────────────────────────────────────────────────────────────
//
// IMPORTANT: the client <script> below lives inside this template literal, so
// any backslash here is consumed by the template (e.g. a `\/` in a regex would
// collapse to `//` and comment out the rest of a line). Keep the client script
// backslash-free — the only regexes used (escapeHtml) contain none.

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
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 16px; border-bottom: 1px solid var(--vscode-panel-border);
  }
  .topbar h1 { font-size: 14px; margin: 0; font-weight: 600; }
  .topbar .count { font-size: 11px; opacity: 0.6; margin-left: 8px; font-weight: 400; }
  .topbar .actions { display: flex; gap: 6px; }
  .topbar button {
    background: transparent; color: var(--vscode-foreground);
    border: 1px solid var(--vscode-panel-border); padding: 4px 10px;
    border-radius: 3px; font-size: 11px; cursor: pointer;
  }
  .topbar button:hover { background: var(--vscode-list-hoverBackground); }

  .content { flex: 1; overflow-y: auto; padding: 12px 18px 28px; box-sizing: border-box; }

  /* Uploader — always visible above the category list. */
  .uploader { margin-bottom: 10px; }
  .dz {
    border: 1.5px dashed var(--vscode-panel-border);
    border-radius: 8px; padding: 18px 16px; text-align: center; cursor: pointer;
    background: var(--vscode-editor-inactiveSelectionBackground);
    transition: background 0.1s, border-color 0.1s;
  }
  .dz:hover { background: var(--vscode-list-hoverBackground); }
  .dz.drag { border-color: #f778ba; background: var(--vscode-list-hoverBackground); }
  .dz .dz-icon { font-size: 20px; opacity: 0.7; line-height: 1; }
  .dz .dz-title { font-size: 13px; font-weight: 700; margin-top: 6px; }
  .dz .dz-sub { font-size: 11px; opacity: 0.6; margin-top: 4px; }
  .upmsg { font-size: 11px; margin-top: 7px; min-height: 14px; }
  .upmsg.ok { color: #3fb950; }
  .upmsg.err { color: #f85149; }
  .upmsg.busy { opacity: 0.75; }

  /* Category accordion: each category is ONE bordered box (accent on the left)
     that wraps its header bar AND — when expanded — the grid of its skills. */
  .section {
    margin-top: 8px;
    border: 1px solid var(--vscode-panel-border);
    border-left: 4px solid var(--c, #8b949e);
    border-radius: 8px;
    overflow: hidden;
  }
  .cat-bar {
    display: flex; align-items: center; gap: 9px; width: 100%;
    padding: 10px 12px; box-sizing: border-box; text-align: left;
    background: var(--vscode-editor-inactiveSelectionBackground);
    color: var(--vscode-foreground);
    border: 0; cursor: pointer; font: inherit;
    transition: background 0.1s;
  }
  .cat-bar:hover { background: var(--vscode-list-hoverBackground); }
  .cat-bar .chev {
    display: inline-block; font-size: 11px; opacity: 0.8;
    transition: transform 0.12s; transform: rotate(0deg);
  }
  .cat-bar .chev.open { transform: rotate(90deg); }
  .cat-bar .clabel {
    font-size: 12px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.09em; color: var(--c, #8b949e);
  }
  .cat-bar .cn { font-size: 11px; opacity: 0.55; }

  .cat-body { padding: 10px 12px 12px; border-top: 1px solid var(--vscode-panel-border); }
  .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
  .card {
    min-height: 40px; display: flex; align-items: center;
    padding: 8px 10px; border-radius: 6px; cursor: pointer;
    background: var(--vscode-editor-inactiveSelectionBackground);
    border: 1px solid var(--vscode-panel-border);
    border-left: 3px solid var(--c, #8b949e);
    box-sizing: border-box; transition: background 0.1s;
  }
  .card:hover { background: var(--vscode-list-hoverBackground); }
  .card.off { opacity: 0.5; }
  .card.off .cname { text-decoration: line-through; }
  .card .cname {
    flex: 1 1 auto; min-width: 0;
    font-size: 12px; font-weight: 600; line-height: 1.3; word-break: break-word;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  /* On/off switch — rendered only on uploaded skills. */
  .tog {
    flex: none; margin-left: 8px; font: inherit; font-size: 10px; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.04em; padding: 2px 8px;
    border-radius: 10px; cursor: pointer; border: 1px solid var(--vscode-panel-border);
    background: transparent; color: var(--vscode-descriptionForeground, #8b949e);
  }
  .tog.on { background: #3fb95022; color: #3fb950; border-color: #3fb95055; }
  .tog:hover { filter: brightness(1.15); }

  .pager { display: flex; align-items: center; justify-content: center; gap: 10px; margin: 10px 0 2px; font-size: 11px; }
  .pager button {
    background: transparent; color: var(--vscode-foreground);
    border: 1px solid var(--vscode-panel-border); padding: 3px 10px;
    border-radius: 3px; font-size: 11px; cursor: pointer;
  }
  .pager button:hover:not([disabled]) { background: var(--vscode-list-hoverBackground); }
  .pager button[disabled] { opacity: 0.4; cursor: default; }
  .pager .rng { opacity: 0.6; }

  .empty { opacity: 0.6; font-size: 13px; padding: 24px 0; }

  /* Floating description pane — pops up next to the hovered card. */
  #hovercard {
    position: fixed; display: none; z-index: 50; width: 340px; max-height: 60vh;
    overflow: hidden;
    background: var(--vscode-editorHoverWidget-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-panel-border));
    border-radius: 6px; padding: 12px 14px; box-shadow: 0 6px 22px rgba(0,0,0,0.45);
    pointer-events: none;
  }
  #hovercard .hc-name { font-weight: 700; font-size: 13px; margin-bottom: 7px; display: flex; align-items: center; gap: 7px; }
  #hovercard .hc-desc { font-size: 12px; line-height: 1.55; opacity: 0.92; }
  .chip {
    display: inline-block; font-size: 10px; padding: 1px 7px; border-radius: 8px;
    font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em;
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
  <div class="content" id="content">
    <div class="uploader">
      <div class="dz" id="dropzone" role="button" tabindex="0" title="Upload a skill packaged as a .zip">
        <div class="dz-icon">&#8679;</div>
        <div class="dz-title">Drop or select a ZIP file to upload a new skill</div>
        <div class="dz-sub">Click to browse &mdash; or drag &amp; drop a .zip. It lands under the &ldquo;uploaded&rdquo; category.</div>
        <input type="file" id="fileInput" accept=".zip" style="display:none">
      </div>
      <div class="upmsg" id="uploadMsg"></div>
    </div>
    <div id="sections"><div class="empty">Loading&hellip;</div></div>
  </div>
  <div id="hovercard"></div>
<script>
  const vscode = acquireVsCodeApi();
  let skills = [];
  const PAGE_SIZE = 50;
  const expanded = {};   // category -> is it open
  const pageByCat = {};  // category -> current 1-based page

  // The accordion buckets (system + generated + uploaded); ORDER drives the
  // section bars. The per-tag colors below are still used by the hover chip,
  // which shows each skill's real [tag] even though the bars collapse it.
  const ORDER = ['system', 'generated', 'uploaded'];
  const COLORS = {
    system: '#4ea1ff', generated: '#e3b341', uploaded: '#f778ba',
    core: '#4ea1ff', standard: '#3fb950', lab: '#bc8cff',
    zombie: '#f0883e', other: '#8b949e',
  };
  function color(cat) { return COLORS[cat] || '#8b949e'; }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function find(name) { return skills.find(s => s.name === name); }

  function renderList(list) {
    skills = list;
    document.getElementById('count').textContent = list.length ? '(' + list.length + ')' : '';
    const sroot = document.getElementById('sections');
    if (!list.length) {
      sroot.innerHTML = '<div class="empty">No skills found in ~/.claude/skills/.</div>';
      return;
    }
    // Bucket into the accordion groups (system / generated / uploaded).
    const map = {};
    for (const s of list) { const k = s.group || 'system'; (map[k] = map[k] || []).push(s); }
    // Always show the canonical buckets even when empty (stable list); unknown
    // extra groups only appear when they actually have skills.
    const extras = Object.keys(map).filter(k => ORDER.indexOf(k) < 0).sort();
    const cats = ORDER.concat(extras);
    sroot.innerHTML = cats.map(cat => section(cat, map[cat] || [])).join('');
    wire(sroot);
  }

  function section(cat, items) {
    const open = !!expanded[cat];
    const col = color(cat);
    const total = items.length;
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    let page = pageByCat[cat] || 1;
    if (page > pages) page = pages;
    if (page < 1) page = 1;
    pageByCat[cat] = page;

    const head = '<button class="cat-bar" data-cat="' + escapeHtml(cat) + '">'
      + '<span class="chev' + (open ? ' open' : '') + '">&#9654;</span>'
      + '<span class="clabel">' + escapeHtml(cat) + '</span>'
      + '<span class="cn">' + total + '</span></button>';
    if (!open) return '<div class="section" style="--c:' + col + '">' + head + '</div>';
    if (total === 0) return '<div class="section" style="--c:' + col + '">' + head
      + '<div class="cat-body"><div class="empty" style="padding:6px 2px;font-size:12px">No skills in this category yet.</div></div></div>';

    const start = (page - 1) * PAGE_SIZE;
    const slice = items.slice(start, start + PAGE_SIZE);
    const cards = slice.map(s => {
      // Uploaded skills carry an on/off switch; system skills never do.
      const isOff = s.uploaded && !s.enabled;
      const tog = s.uploaded
        ? '<button class="tog ' + (s.enabled ? 'on' : 'off') + '" data-tog="' + escapeHtml(s.name)
          + '" title="' + (s.enabled ? 'Disable this skill' : 'Enable this skill') + '">'
          + (s.enabled ? 'on' : 'off') + '</button>'
        : '';
      return '<div class="card' + (isOff ? ' off' : '') + '" data-name="' + escapeHtml(s.name)
        + '" style="--c:' + col + '">'
        + '<div class="cname">' + escapeHtml(s.name) + '</div>' + tog + '</div>';
    }).join('');

    let pager = '';
    if (pages > 1) {
      const from = start + 1;
      const to = start + slice.length;
      pager = '<div class="pager">'
        + '<button class="pg" data-cat="' + escapeHtml(cat) + '" data-pg="' + (page - 1) + '"' + (page <= 1 ? ' disabled' : '') + '>Prev</button>'
        + '<span class="rng">' + from + '&ndash;' + to + ' of ' + total + '</span>'
        + '<button class="pg" data-cat="' + escapeHtml(cat) + '" data-pg="' + (page + 1) + '"' + (page >= pages ? ' disabled' : '') + '>Next</button>'
        + '</div>';
    }
    return '<div class="section">' + head
      + '<div class="cat-body"><div class="grid">' + cards + '</div>' + pager + '</div></div>';
  }

  function wire(sroot) {
    sroot.querySelectorAll('.cat-bar').forEach(el => {
      el.addEventListener('click', () => {
        const cat = el.getAttribute('data-cat');
        expanded[cat] = !expanded[cat];
        renderList(skills);
      });
    });
    sroot.querySelectorAll('.pg').forEach(el => {
      el.addEventListener('click', () => {
        if (el.hasAttribute('disabled')) return;
        const cat = el.getAttribute('data-cat');
        pageByCat[cat] = parseInt(el.getAttribute('data-pg'), 10) || 1;
        renderList(skills);
      });
    });
    sroot.querySelectorAll('.tog').forEach(el => {
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();       // don't also open the skill file
        hideCard();
        vscode.postMessage({ type: 'toggle_skill', name: el.getAttribute('data-tog') });
      });
    });
    sroot.querySelectorAll('.card').forEach(el => {
      const name = el.getAttribute('data-name');
      el.addEventListener('mouseenter', () => showCard(name, el));
      el.addEventListener('mouseleave', hideCard);
      el.addEventListener('click', () => vscode.postMessage({ type: 'open_skill', name: name }));
    });
  }

  const hc = document.getElementById('hovercard');
  function showCard(name, anchor) {
    const s = find(name);
    if (!s) return;
    const col = color(s.category || 'other');
    const chip = '<span class="chip" style="background:' + col + '22;color:' + col + '">'
      + escapeHtml(s.category || 'other') + '</span>';
    hc.innerHTML = '<div class="hc-name">' + escapeHtml(s.name) + chip + '</div>'
      + '<div class="hc-desc">' + escapeHtml(s.description || '(no description)') + '</div>';
    hc.style.display = 'block';
    // Position: prefer below-left of the card, flip/clamp to stay on screen.
    const r = anchor.getBoundingClientRect();
    const cw = hc.offsetWidth, ch = hc.offsetHeight, pad = 8;
    let left = r.left;
    let top = r.bottom + 6;
    if (left + cw > window.innerWidth - pad) left = window.innerWidth - cw - pad;
    if (left < pad) left = pad;
    if (top + ch > window.innerHeight - pad) top = r.top - ch - 6; // flip above
    if (top < pad) top = pad;
    hc.style.left = left + 'px';
    hc.style.top = top + 'px';
  }
  function hideCard() { hc.style.display = 'none'; }

  // Uploader wiring — the dropzone is static in the HTML, so wire it once here.
  const dz = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');
  const upMsg = document.getElementById('uploadMsg');
  function setUp(text, kind) { upMsg.textContent = text; upMsg.className = 'upmsg' + (kind ? ' ' + kind : ''); }

  function toB64(bufArr) {
    const bytes = new Uint8Array(bufArr);
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }
  async function handleFile(file) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.zip')) { setUp('Only .zip files are supported.', 'err'); return; }
    if (file.size > 25 * 1024 * 1024) { setUp('File too large (max 25 MB).', 'err'); return; }
    setUp('Uploading ' + file.name + ' …', 'busy');
    try {
      const buf = await file.arrayBuffer();
      vscode.postMessage({ type: 'upload_skill', filename: file.name, dataB64: toB64(buf) });
    } catch (e) {
      setUp('Could not read file: ' + (e && e.message ? e.message : e), 'err');
    }
  }

  dz.addEventListener('click', () => fileInput.click());
  dz.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', e => {
    e.preventDefault();
    dz.classList.remove('drag');
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleFile(f);
  });
  fileInput.addEventListener('change', () => {
    const f = fileInput.files && fileInput.files[0];
    if (f) handleFile(f);
    fileInput.value = '';
  });

  function reload() { vscode.postMessage({ type: 'reload' }); }
  function close_() { vscode.postMessage({ type: 'close' }); }

  // A scroll moves the anchor out from under the pane — just hide it.
  document.getElementById('content').addEventListener('scroll', hideCard);

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'render_list') renderList(msg.skills || []);
    else if (msg.type === 'upload_ok') { expanded['uploaded'] = true; renderList(skills); setUp('Uploaded ' + msg.name + ' ✓', 'ok'); }
    else if (msg.type === 'upload_error') setUp(msg.message || 'Upload failed.', 'err');
  });
</script>
</body>
</html>`;
}

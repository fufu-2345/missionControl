import * as fs from "node:fs";
import * as path from "node:path";
import { marked } from "marked";

export interface DocRef {
  rel: string; // project-relative POSIX path, e.g. "docs/wiki/overview.md"
  label: string; // display label, e.g. "overview" or "decisions/0001-db"
}
export interface ProjectDocs {
  wiki: DocRef[];
  plan: DocRef | null;
  sprints: DocRef[];
}

// Wiki pages in this priority first (by index), then everything else alphabetically.
const WIKI_PRIORITY = ["README", "overview", "architecture", "setup"];

/** List a project's docs: wiki pages (docs/wiki/**.md), plan.md, and sprint docs. */
export function listProjectDocs(projectPath: string): ProjectDocs {
  const docsDir = path.join(projectPath, "docs");
  return {
    wiki: listWiki(path.join(docsDir, "wiki")),
    plan: fs.existsSync(path.join(docsDir, "plan.md"))
      ? { rel: "docs/plan.md", label: "plan.md" }
      : null,
    sprints: listSprints(docsDir),
  };
}

function listWiki(wikiDir: string): DocRef[] {
  const rels: string[] = [];
  walkMd(wikiDir, wikiDir, rels);
  return rels
    // priority pages first, then top-level pages before subfolder pages (decisions/*), then alpha
    .sort(
      (a, b) =>
        wikiRank(a) - wikiRank(b) ||
        depth(a) - depth(b) ||
        a.localeCompare(b),
    )
    .map((relInWiki) => ({
      rel: "docs/wiki/" + relInWiki,
      label: relInWiki.replace(/\.md$/, ""),
    }));
}
function walkMd(dir: string, root: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkMd(full, root, out);
    else if (e.isFile() && e.name.endsWith(".md"))
      out.push(path.relative(root, full).split(path.sep).join("/"));
  }
}
function wikiRank(relInWiki: string): number {
  const base = relInWiki.replace(/\.md$/, "").split("/").pop() || "";
  const i = WIKI_PRIORITY.indexOf(base);
  return i === -1 ? WIKI_PRIORITY.length : i;
}
function depth(relInWiki: string): number {
  return (relInWiki.match(/\//g) || []).length;
}

function listSprints(docsDir: string): DocRef[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(docsDir);
  } catch {
    return [];
  }
  const rx = /^(?:.+-)?sprint-(\d+).*\.md$/;
  return entries
    .map((f) => ({ f, m: rx.exec(f) }))
    .filter((x): x is { f: string; m: RegExpExecArray } => x.m !== null)
    .sort((a, b) => Number(a.m[1]) - Number(b.m[1]) || a.f.localeCompare(b.f))
    .map((x) => ({ rel: "docs/" + x.f, label: x.f.replace(/\.md$/, "") }));
}

/** Resolve a project-relative doc path, guarding against traversal outside docs/.
 *  Returns the absolute path only if it is a real file under <project>/docs/. */
export function resolveDocPath(projectPath: string, rel: string): string | null {
  const docsRoot = path.resolve(projectPath, "docs");
  const abs = path.resolve(projectPath, rel);
  const within = abs === docsRoot || abs.startsWith(docsRoot + path.sep);
  if (!within) return null;
  try {
    if (!fs.statSync(abs).isFile()) return null;
  } catch {
    return null;
  }
  return abs;
}

/** Render markdown → sanitized HTML for injection into the webview. Content is our own
 *  generated docs in the user's repo (trusted), but we sanitize defensively anyway. */
export function renderMarkdown(md: string): string {
  const raw = marked.parse(md) as string; // marked v4: synchronous, returns string
  return sanitizeHtml(raw);
}

/** Remove script/dangerous tags, inline event handlers, and javascript: URLs. */
export function sanitizeHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<\/?(?:iframe|object|embed|link|meta|style)\b[^>]*>/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "")
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, "")
    .replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, "$1=$2#$2");
}

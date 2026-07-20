import * as fs from "node:fs";
import * as path from "node:path";

import { listBackedUpProjects } from "./docsBackup";
import { getGithubWebUrl } from "./gitOps";
import { dedupeByRealpath, parsePlan, projectScanDirs } from "./orchestratorResume";
// NOTE: resolveOwnerRoot lives in startOrchestrator.ts, which imports `vscode`.
// It is pulled in via dynamic import() inside loadDataIndex() only, so this module's
// tested core (buildProjectRow/parse*) stays loadable under `bun test` (no vscode).

/** One project's row in the Data View. The unit of the whole page: every view
 *  (table / kanban / timeline) is a different render of this same array. Derived
 *  entirely from the project's `.md` docs — never from live prose parsing. */
export interface ProjectRow {
  name: string; // project folder basename
  path: string; // absolute path
  category: string; // from docs/plan.md frontmatter; "uncategorized" if absent
  tags: string[]; // from docs/plan.md frontmatter; [] if absent
  sprintsTotal: number;
  sprintsDone: number;
  percentDone: number; // 0..100, rounded; 0 when total is 0
  status: "not-started" | "in-progress" | "done";
  sprints: { n: number; name: string; date: string | null }[]; // all sprint docs, ascending — powers the timeline
  latestSprint: { n: number; name: string; date: string | null } | null;
  updated: string | null; // ISO date (YYYY-MM-DD) of latest activity, best-effort
  hasPreview: boolean; // has .orches-preview.sh
  githubUrl: string | null;
  deleted?: boolean; // true = reconstructed from a backup, not a live project on disk
  deletedAt?: string | null; // ISO date the project was deleted (backups only)
}

const SPRINT_FILE_RX = /^(?:.+-)?sprint-(\d+).*\.md$/i;

interface SprintDoc {
  n: number;
  name: string;
  date: string | null;
  done: boolean;
  mtime: number;
}

/** Parse the YAML-ish frontmatter block at the very top of a markdown file.
 *  Only `category` (string) and `tags` (inline `[a, b]` or comma list) are read —
 *  everything else is ignored. No frontmatter / not starting with `---` → {}.
 *  Deliberately tiny (no YAML dep): the docs we generate are simple. */
export function parseFrontmatter(raw: string): { category?: string; tags?: string[] } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!m) return {};
  const out: { category?: string; tags?: string[] } = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    let val = kv[2].trim();
    if (key === "category" && val) out.category = stripQuotes(val);
    else if (key === "tags" && val) {
      val = val.replace(/^\[|\]$/g, "");
      const tags = val
        .split(",")
        .map((t) => stripQuotes(t.trim()))
        .filter(Boolean);
      if (tags.length) out.tags = tags;
    }
  }
  return out;
}

function stripQuotes(s: string): string {
  return s.replace(/^["']|["']$/g, "").trim();
}

/** Extract sprint metadata from one sprint doc. `n` comes from the filename (the
 *  authoritative ordering); name/date/done are best-effort from the doc heading and
 *  the `_YYYY-MM-DD · สถานะ: …_` status line. `done` is only used as a fallback when
 *  the project has no plan.md checklist. */
export function parseSprintDoc(filename: string, raw: string, mtime = 0): SprintDoc | null {
  const fm = SPRINT_FILE_RX.exec(filename);
  if (!fm) return null;
  const n = Number(fm[1]);
  const heading = /^#\s*Sprint\s+\d+\s*[—:\-]\s*(.+?)\s*$/im.exec(raw);
  const name = heading ? heading[1].trim() : `Sprint ${n}`;
  const dateM = /(\d{4}-\d{2}-\d{2})/.exec(raw);
  const date = dateM ? dateM[1] : null;
  const statusM = /สถานะ:\s*([^\n_·|]+)/.exec(raw);
  const statusText = statusM ? statusM[1] : "";
  // A written sprint doc means that sprint shipped — orches authors it on merge — so
  // treat it as done UNLESS its status line explicitly flags in-progress. Only the
  // status line is inspected, never the body (the todo/doing/done board always contains
  // the word "doing"). `done` is a fallback signal, used only when there is no plan.md.
  const done = !/(ยัง|ค้าง|กำลังทำ|กําลังทำ|in[\s-]?progress|doing)/i.test(statusText);
  return { n, name, date, done, mtime };
}

/** Read + parse every sprint doc under <project>/docs. Sorted ascending by N. */
function readSprintDocs(projectPath: string): SprintDoc[] {
  const docsDir = path.join(projectPath, "docs");
  const out: SprintDoc[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(docsDir);
  } catch {
    return out;
  }
  for (const fn of names) {
    if (!SPRINT_FILE_RX.test(fn)) continue;
    let raw = "";
    let mtime = 0;
    try {
      const abs = path.join(docsDir, fn);
      raw = fs.readFileSync(abs, "utf8");
      mtime = fs.statSync(abs).mtimeMs;
    } catch {
      /* unreadable sprint doc → still count it, best-effort */
    }
    const parsed = parseSprintDoc(fn, raw, mtime);
    if (parsed) out.push(parsed);
  }
  return out.sort((a, b) => a.n - b.n);
}

/** Latest mtime (ms) of any file directly under <project>/docs (non-recursive). */
function latestDocsMtime(projectPath: string): number {
  const docsDir = path.join(projectPath, "docs");
  let max = 0;
  try {
    for (const fn of fs.readdirSync(docsDir)) {
      try {
        const st = fs.statSync(path.join(docsDir, fn));
        if (st.isFile() && st.mtimeMs > max) max = st.mtimeMs;
      } catch {
        /* skip */
      }
    }
  } catch {
    /* no docs dir */
  }
  return max;
}

function isoDate(ms: number): string | null {
  if (!ms) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Build one project's row from its `.md` docs. Synchronous + git-free so it stays
 *  pure and unit-testable; `githubUrl` is filled in later by the async index build.
 *  Returns null for a folder with no `docs/` (not a build project). */
export function buildProjectRow(projectPath: string): ProjectRow | null {
  const docsDir = path.join(projectPath, "docs");
  try {
    if (!fs.statSync(docsDir).isDirectory()) return null;
  } catch {
    return null; // no docs/ → not a project we surface
  }

  // category / tags from plan.md frontmatter (absent for all projects today → uncategorized)
  let category = "uncategorized";
  let tags: string[] = [];
  let planRaw: string | null = null;
  try {
    planRaw = fs.readFileSync(path.join(docsDir, "plan.md"), "utf8");
    const fm = parseFrontmatter(planRaw);
    if (fm.category) category = fm.category;
    if (fm.tags) tags = fm.tags;
  } catch {
    /* no plan.md → uncategorized + checklist fallback below */
  }

  const sprints = readSprintDocs(projectPath);

  // total / done: plan.md checklist is authoritative; else fall back to sprint docs.
  let sprintsTotal: number;
  let sprintsDone: number;
  const plan = planRaw ? parsePlan(planRaw) : null;
  if (plan) {
    sprintsTotal = plan.total;
    sprintsDone = plan.done;
  } else {
    sprintsTotal = sprints.length;
    sprintsDone = sprints.filter((s) => s.done).length;
  }

  const percentDone = sprintsTotal > 0 ? Math.round((sprintsDone / sprintsTotal) * 100) : 0;
  const status: ProjectRow["status"] =
    sprintsTotal > 0 && sprintsDone >= sprintsTotal
      ? "done"
      : sprintsDone <= 0
        ? "not-started"
        : "in-progress";

  const last = sprints.length ? sprints[sprints.length - 1] : null;
  const latestSprint = last ? { n: last.n, name: last.name, date: last.date } : null;
  const updated = latestSprint?.date ?? isoDate(latestDocsMtime(projectPath));

  const hasPreview = fs.existsSync(path.join(projectPath, ".orches-preview.sh"));

  return {
    name: path.basename(projectPath),
    path: projectPath,
    category,
    tags,
    sprintsTotal,
    sprintsDone,
    percentDone,
    status,
    sprints: sprints.map((s) => ({ n: s.n, name: s.name, date: s.date })),
    latestSprint,
    updated,
    hasPreview,
    githubUrl: null,
  };
}

/** Enumerate every project dir the same way the Projects screen does (owner-root
 *  + ghq-root `projects/`, symlink-deduped, skipping ψ and dotfiles). */
function enumerateProjectDirs(ownerRoot: string): string[] {
  const candidates: string[] = [];
  for (const projectsDir of projectScanDirs(ownerRoot)) {
    try {
      for (const n of fs.readdirSync(projectsDir)) {
        if (n === "ψ" || n.startsWith(".")) continue;
        candidates.push(path.join(projectsDir, n));
      }
    } catch {
      /* no such projects/ dir */
    }
  }
  return dedupeByRealpath(candidates, (q) => fs.realpathSync(q));
}

/** One tagged ProjectRow per durable backup whose docs still parse. The row
 *  points at the backup folder (so a click opens the preserved copy) and is
 *  flagged `deleted` so the UI can mark it. Backups with no parseable docs
 *  (e.g. README-only) are skipped here — they still appear in the Orchestrator's
 *  deleted-projects list, which reads listBackedUpProjects() directly. */
export function loadBackupRows(): ProjectRow[] {
  const out: ProjectRow[] = [];
  for (const entry of listBackedUpProjects()) {
    let row: ProjectRow | null = null;
    try {
      row = buildProjectRow(entry.backupDir);
    } catch {
      /* corrupt backup → skip, never sink the index */
    }
    if (!row) continue;
    row.name = entry.name; // trust the manifest name over the folder basename
    row.path = entry.backupDir; // click → open the backup copy
    row.githubUrl = null; // a backup has no .git
    row.deleted = true;
    row.deletedAt = entry.deletedAt;
    out.push(row);
  }
  return out;
}

/** Build the full Data View index for a given owner root. Async only because of the
 *  per-project GitHub URL lookup; the row shape itself is computed synchronously. */
export async function buildDataIndex(ownerRoot: string): Promise<ProjectRow[]> {
  const rows: ProjectRow[] = [];
  for (const dir of enumerateProjectDirs(ownerRoot)) {
    let row: ProjectRow | null = null;
    try {
      row = buildProjectRow(dir);
    } catch {
      /* one bad project must not sink the whole index */
    }
    if (row) rows.push(row);
  }
  await Promise.all(
    rows.map(async (r) => {
      try {
        r.githubUrl = await getGithubWebUrl(r.path);
      } catch {
        r.githubUrl = null;
      }
    }),
  );
  // merge in deleted projects from the durable backup — skip any whose name is
  // still live on disk (the live row is authoritative).
  const liveNames = new Set(rows.map((r) => r.name));
  for (const br of loadBackupRows()) if (!liveNames.has(br.name)) rows.push(br);
  // most-recently-updated first, then name
  rows.sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? "") || a.name.localeCompare(b.name));
  return rows;
}

/** Resolve the owner root from config and build the index. Empty array if the
 *  owner root can't be resolved (no oracles.json / unexpected layout). */
export async function loadDataIndex(): Promise<ProjectRow[]> {
  const { resolveOwnerRoot } = await import("./startOrchestrator");
  const root = resolveOwnerRoot();
  if (!root) return [];
  return buildDataIndex(root);
}

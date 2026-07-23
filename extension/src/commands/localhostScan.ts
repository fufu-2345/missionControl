import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type Listener = {
  port: number;
  pid: number;
  pgid: number;
  comm: string;
  role: string;
};
export type ProjectGroup = { project: string; entries: Listener[] };
export type RawListener = {
  port: number;
  pid: number;
  cwd: string | null;
  pgid: number;
  comm: string;
};

/** Parse `ss -ltnpH` output → [{port, pid}]. The local address is the first
 *  token ending in `:<digits>` (the peer column ends in `:*`). Lines with no
 *  `pid=` (root-owned sockets we cannot inspect) are skipped. */
export function parseSsListeners(ssOutput: string): { port: number; pid: number }[] {
  const out: { port: number; pid: number }[] = [];
  const seen = new Set<string>();
  for (const raw of ssOutput.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const pidM = /pid=(\d+)/.exec(line);
    if (!pidM) continue;
    const local = line.split(/\s+/).find((t) => /:\d+$/.test(t));
    if (!local) continue;
    const portM = /:(\d+)$/.exec(local);
    if (!portM) continue;
    const port = Number(portM[1]);
    const pid = Number(pidM[1]);
    const key = `${port}/${pid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ port, pid });
  }
  return out;
}

/** Parse `ps -o pid=,pgid=,comm=` output → Map<pid, {pgid, comm}>.
 *  comm may contain spaces, so everything after the second number is the comm. */
export function parsePsOutput(out: string): Map<number, { pgid: number; comm: string }> {
  const m = new Map<number, { pgid: number; comm: string }>();
  for (const line of out.split("\n")) {
    const mm = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!mm) continue;
    m.set(Number(mm[1]), { pgid: Number(mm[2]), comm: mm[3].trim() });
  }
  return m;
}

/** Project name if `cwd` is strictly inside `<projectsRoot>/<name>/...`, else null. */
export function projectFromCwd(cwd: string | null, projectsRoot: string): string | null {
  if (!cwd) return null;
  const prefix = projectsRoot.replace(/\/+$/, "") + "/";
  if (!cwd.startsWith(prefix)) return null;
  const name = cwd.slice(prefix.length).split("/")[0];
  return name || null;
}

/** Light label from comm/port. Best-effort only. */
export function guessRole(comm: string, port: number): string {
  const c = comm.toLowerCase();
  if (/uvicorn|gunicorn|python|flask|django/.test(c) || port === 8000) return "api";
  if (/next|vite|node|astro|webpack|remix/.test(c)) return "web";
  return "srv";
}

/** Group raw listeners by the project their cwd lives in. Drops listeners not
 *  under any project. Groups sorted by name, entries sorted by port. */
export function groupListeners(raws: RawListener[], projectsRoot: string): ProjectGroup[] {
  const byProject = new Map<string, Listener[]>();
  for (const r of raws) {
    const project = projectFromCwd(r.cwd, projectsRoot);
    if (!project) continue;
    const list = byProject.get(project) ?? [];
    list.push({ port: r.port, pid: r.pid, pgid: r.pgid, comm: r.comm, role: guessRole(r.comm, r.port) });
    byProject.set(project, list);
  }
  const groups: ProjectGroup[] = [];
  for (const [project, entries] of byProject) {
    entries.sort((a, b) => a.port - b.port);
    groups.push({ project, entries });
  }
  groups.sort((a, b) => a.project.localeCompare(b.project));
  return groups;
}

// ── Live collectors ────────────────────────────────────────────────────────

/** `<owner>/projects` derived portably from ~/.maw/oracles.json (the same
 *  `.../github.com/<owner>` derivation as startOrchestrator.resolveOwnerRoot,
 *  inlined here so this module stays free of the `vscode` import — that keeps
 *  the scan unit-testable under `bun test`). null if it can't be resolved. */
export function getProjectsRoot(): string | null {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), ".maw", "oracles.json"), "utf8");
    const data = JSON.parse(raw) as { oracles?: { local_path?: string }[] };
    for (const o of data?.oracles ?? []) {
      const p = o?.local_path;
      if (typeof p !== "string" || !p) continue;
      const m = p.replace(/\/+$/, "").match(/^(.*\/github\.com\/[^/]+)\/[^/]+$/);
      if (m) return path.join(m[1], "projects");
    }
  } catch {
    /* file missing / malformed → unresolved */
  }
  return null;
}

function ssRaw(): string {
  try {
    return cp.execSync("ss -ltnpH", { encoding: "utf8", timeout: 4000 });
  } catch {
    try {
      return cp.execSync("ss -ltnp", { encoding: "utf8", timeout: 4000 });
    } catch {
      return "";
    }
  }
}

function psRaw(pids: number[]): string {
  if (!pids.length) return "";
  try {
    return cp.execSync(`ps -o pid=,pgid=,comm= -p ${pids.join(",")}`, {
      encoding: "utf8",
      timeout: 4000,
    });
  } catch {
    return "";
  }
}

/** Enumerate listeners and enrich each with cwd/pgid/comm. Two subprocesses
 *  total (one ss, one ps). Unreadable pids (root-owned) get cwd=null and are
 *  dropped by groupListeners. */
export function collectRaw(): RawListener[] {
  const listeners = parseSsListeners(ssRaw());
  const info = parsePsOutput(psRaw(listeners.map((l) => l.pid)));
  const raws: RawListener[] = [];
  for (const { port, pid } of listeners) {
    let cwd: string | null = null;
    try {
      cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      cwd = null;
    }
    const ps = info.get(pid);
    raws.push({ port, pid, cwd, pgid: ps?.pgid ?? 0, comm: ps?.comm ?? "" });
  }
  return raws;
}

/** Full scan: listeners grouped by project. Empty array if the projects root or
 *  ss is unavailable — callers render "unavailable" and move on. */
export function scanLocalhosts(): ProjectGroup[] {
  const projectsRoot = getProjectsRoot();
  if (!projectsRoot) return [];
  return groupListeners(collectRaw(), projectsRoot);
}

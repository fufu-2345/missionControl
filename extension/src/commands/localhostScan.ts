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

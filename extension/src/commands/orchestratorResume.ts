// Pure helpers for "⏮ ทำต่อ" (resume an existing/paused project). NO vscode/fs
// import here — the filesystem walk that finds candidate projects lives in
// startOrchestrator.ts (vscode side); this file only parses + decides so it can
// be unit-tested standalone with `bun test`.

/** Contents of a project's `.orches-meta.json` — a best-effort marker the
 *  orchestrator writes when it drives a project, used ONLY to default the team
 *  picker to whoever worked it last. Absent/invalid → no default (not an error). */
export interface OrchesMeta {
  team?: string;
  lastRun?: number; // epoch ms of the last drive
}

/** A project the "⏮ ทำต่อ" screen can offer to resume. */
export interface ResumableProject {
  name: string; // display name (basename of path)
  path: string; // absolute repo path
  sprintDocs: number; // count of docs/sprint-*.md
  openWorktrees: number; // count of `agents/*` git worktrees still open
  metaTeam?: string; // team from .orches-meta.json (default pick)
  lastRun?: number; // lastRun from .orches-meta.json (sort key)
}

/** Parse `.orches-meta.json`. Tolerant: bad JSON / wrong shape → null. */
export function parseOrchesMeta(raw: string): OrchesMeta | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const d = data as { team?: unknown; lastRun?: unknown };
  const meta: OrchesMeta = {};
  if (typeof d.team === "string" && d.team.trim()) meta.team = d.team.trim();
  if (typeof d.lastRun === "number" && Number.isFinite(d.lastRun)) meta.lastRun = d.lastRun;
  return meta;
}

/** Serialize `.orches-meta.json` (written when a drive starts/resumes). */
export function serializeOrchesMeta(team: string, lastRun: number): string {
  return JSON.stringify({ team, lastRun }, null, 2) + "\n";
}

/** A candidate dir is resumable when it has prior sprint output OR still has an
 *  open agents/* worktree — i.e. there's real leftover work to continue. */
export function isResumable(info: { sprintDocs: number; openWorktrees: number }): boolean {
  return info.sprintDocs > 0 || info.openWorktrees > 0;
}

/** Default team for the picker: the meta's team, but only if it's a real team
 *  the user can actually pick right now. Otherwise null (user picks manually). */
export function defaultTeamForProject(
  meta: OrchesMeta | null,
  teamNames: string[],
): string | null {
  if (meta?.team && teamNames.includes(meta.team)) return meta.team;
  return null;
}

/** Sort resumable projects for the list: most-recently-driven first (by
 *  lastRun), then most sprint activity, then name — so the likely target is on
 *  top. Pure (no Date), sorts a copy. */
export function sortResumable(list: ResumableProject[]): ResumableProject[] {
  return [...list].sort(
    (a, b) =>
      (b.lastRun ?? 0) - (a.lastRun ?? 0) ||
      b.sprintDocs - a.sprintDocs ||
      a.name.localeCompare(b.name),
  );
}

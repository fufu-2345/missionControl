// Pure logic + marker fs for the inline "▶ continue" button on the "⏮ ทำต่อ"
// (Orchestrator Projects) screen. NO vscode import here so the state machine can
// be unit-tested standalone with `bun test`; the tmux/git glue lives in
// startOrchestrator.ts. The single source of truth for a run is the per-project
// marker file `.orches-run.json`; button state is derived purely from
// (pending, marker, tmux-liveness).

import * as fs from "node:fs";
import * as path from "node:path";

import type { ResumableProject } from "./orchestratorResume";
import type { OracleTeam } from "./teams";

export type RunStatus = "running" | "done" | "error" | "cancelled";

export interface RunMarker {
  status: RunStatus;
  sprint?: number;
  session: string;
  sessionCreatedAt?: number; // tmux #{session_created}, epoch seconds
  baseMainSha?: string;
  startedAt: string; // ISO 8601
  errorMsg?: string;
}

const STATUSES: readonly RunStatus[] = ["running", "done", "error", "cancelled"];

/** Tolerant parse: any bad input returns null, never throws. */
export function parseRunMarker(raw: string): RunMarker | null {
  try {
    const o = JSON.parse(raw);
    if (!o || typeof o !== "object" || Array.isArray(o)) return null;
    if (!STATUSES.includes(o.status)) return null;
    if (typeof o.session !== "string" || typeof o.startedAt !== "string") return null;
    return o as RunMarker;
  } catch {
    return null;
  }
}

export function serializeRunMarker(m: RunMarker): string {
  return JSON.stringify(m, null, 2);
}

export function runMarkerPath(projectPath: string): string {
  return path.join(projectPath, ".orches-run.json");
}

export function readRunMarker(projectPath: string): RunMarker | null {
  try {
    return parseRunMarker(fs.readFileSync(runMarkerPath(projectPath), "utf8"));
  } catch {
    return null; // ENOENT or any read error → treated as "no run"
  }
}

/** Atomic write: temp file + rename, so a concurrent reader never sees a
 *  half-written file (extension and orches-drive both write this path). */
export function writeRunMarker(projectPath: string, m: RunMarker): void {
  const dst = runMarkerPath(projectPath);
  const tmp = dst + ".tmp";
  fs.writeFileSync(tmp, serializeRunMarker(m));
  fs.renameSync(tmp, dst);
}

export type ButtonState = "hidden" | "idle" | "spinning" | "stale" | "error";
export interface Live {
  alive: boolean;
  createdAt?: number; // tmux #{session_created}, epoch seconds
}

/** Pending sprints: plan.md count wins (total-done), else open agents/* worktrees. */
export function pendingSprints(
  p: Pick<ResumableProject, "plannedTotal" | "plannedDone" | "openWorktrees">,
): number {
  const n =
    (p.plannedTotal ?? 0) > 0
      ? (p.plannedTotal as number) - (p.plannedDone ?? 0)
      : p.openWorktrees;
  return n < 0 ? 0 : n;
}

/** Button state derived purely from marker + tmux liveness.
 *  running is trusted ONLY when the live session's creation time matches the
 *  one recorded at launch — a reused session name (created ≠ recorded) is a
 *  zombie, so the run is stale, not spinning. */
export function resolveButtonState(
  pending: number,
  marker: RunMarker | null,
  live: Live,
): { state: ButtonState; errorMsg?: string } {
  if (marker?.status === "running") {
    const zombie =
      marker.sessionCreatedAt !== undefined &&
      live.createdAt !== undefined &&
      live.createdAt !== marker.sessionCreatedAt;
    return live.alive && !zombie ? { state: "spinning" } : { state: "stale" };
  }
  if (marker?.status === "error") return { state: "error", errorMsg: marker.errorMsg };
  // done / cancelled / null → not running
  return { state: pending > 0 ? "idle" : "hidden" };
}

/** Resolve which team + orchestrator to launch WITHOUT asking the user.
 *  Uses the project's last-driven team (.orches-meta.json → metaTeam) and the
 *  team's first orchestrator. Returns an error string for the rare edge where a
 *  pending project has no resolvable team (caller shows a toast, never a picker). */
export function resolveContinueTarget(
  project: Pick<ResumableProject, "metaTeam">,
  teams: OracleTeam[],
): { team: OracleTeam; orch: string } | { error: string } {
  if (!project.metaTeam) {
    return {
      error:
        "ไม่รู้ว่าจะใช้ทีมไหน (project นี้ยังไม่มี .orches-meta.json) — เปิดด้วย ⏮ ทำต่อ สักครั้งก่อน",
    };
  }
  const team = teams.find((t) => t.name === project.metaTeam);
  if (!team) return { error: `ไม่พบทีม '${project.metaTeam}' ใน ~/.maw/teams` };
  if (!team.orchestrators.length) {
    return { error: `ทีม '${team.name}' ไม่มี orchestrator — tag ก่อน` };
  }
  return { team, orch: team.orchestrators[0] };
}

/** Cancel precedence: if the sprint finished/merged in the race between the
 *  user clicking cancel and orches-drive landing it, DON'T fake a cancel or
 *  revert merged work — keep the done outcome. */
export function decideCancelOutcome(
  statusAfterKill: RunStatus | undefined,
  alreadyMerged: boolean,
): "keep_done" | "revert" {
  if (statusAfterKill === "done" || alreadyMerged) return "keep_done";
  return "revert";
}

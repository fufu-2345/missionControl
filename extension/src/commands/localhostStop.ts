import * as cp from "node:child_process";
import * as fs from "node:fs";

import * as vscode from "vscode";

import { scanLocalhosts, getProjectsRoot } from "./localhostScan";
import { canKillGroup, buildKillCmd } from "./localhostKill";

// Stop-all orchestration for a project's localhost servers. Kept separate from
// localhostKill.ts (the pure guardrails) because this module imports `vscode`,
// which cannot be resolved under `bun test` — the guardrails stay unit-testable.

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Read the group leader's cwd + comm (pid == pgid). Both may be missing. */
function leaderInfo(pgid: number): { cwd: string | null; comm: string } {
  let cwd: string | null = null;
  try {
    cwd = fs.readlinkSync(`/proc/${pgid}/cwd`);
  } catch {
    cwd = null;
  }
  let comm = "";
  try {
    comm = cp.execSync(`ps -o comm= -p ${pgid}`, { encoding: "utf8", timeout: 3000 }).trim();
  } catch {
    comm = "";
  }
  return { cwd, comm };
}

/** Distinct, guardrail-approved pgids for a project's current listeners. */
function killablePgids(project: string, projectsRoot: string): number[] {
  const g = scanLocalhosts().find((x) => x.project === project);
  if (!g) return [];
  const pgids = [...new Set(g.entries.map((e) => e.pgid))];
  return pgids.filter((pgid) => {
    const { cwd, comm } = leaderInfo(pgid);
    return canKillGroup(pgid, cwd, comm, projectsRoot);
  });
}

/** Confirm, then TERM every process group of the project's servers; force-KILL
 *  survivors after a grace period. Bounded to the project by process group +
 *  cwd/comm guardrails — cannot reach VS Code / tmux / the shell. */
export async function stopProjectLocalhosts(project: string): Promise<void> {
  const projectsRoot = getProjectsRoot();
  if (!projectsRoot) return;

  const group = scanLocalhosts().find((x) => x.project === project);
  if (!group || group.entries.length === 0) {
    void vscode.window.showInformationMessage(
      `Mission Control: nothing running for ${project}.`,
    );
    return;
  }

  const portList = group.entries.map((e) => `:${e.port}`).join(" ");
  const choice = await vscode.window.showWarningMessage(
    `Stop ${group.entries.length} server(s) in ${project}?  (${portList})`,
    { modal: true },
    "Stop all",
  );
  if (choice !== "Stop all") return;

  for (const pgid of killablePgids(project, projectsRoot)) {
    try {
      cp.execSync(buildKillCmd(pgid, false), { timeout: 3000 });
    } catch {
      /* group may already be gone */
    }
  }

  await sleep(2000);

  const survivors = killablePgids(project, projectsRoot);
  for (const pgid of survivors) {
    try {
      cp.execSync(buildKillCmd(pgid, true), { timeout: 3000 });
    } catch {
      /* best effort */
    }
  }

  void vscode.window.showInformationMessage(`Mission Control: stopped ${project}.`);
}

# Continue-Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inline per-project `continue` button on the Orchestrator "⏮ ทำต่อ" page that runs the real `/orches` flow (`/orches-drive`) for exactly one sprint, headless in a normal (attachable) tmux session, online PR-merge like `/orches`, with zero user prompts — and stops/reverts safely on cancel.

**Architecture:** A per-project marker file `.orches-run.json` is the single source of truth for run state; button state is derived purely from `(pending, marker, tmux-liveness)`. The extension launches `/orches-drive --once` detached and polls the marker; `orches-drive` writes `done`/`error` and exits after one sprint; cancel kills the session and calls a new `orches-integrate.sh abort` verb for safe-local revert. Pure logic lives in a new testable `continueRun.ts`; tmux/git glue reuses existing helpers in `startOrchestrator.ts`.

**Tech Stack:** TypeScript (VSCode extension, compiled with `tsc`), `bun:test` for unit tests, bash (`orches-integrate.sh`), tmux, git, `gh` CLI.

## Global Constraints

- Tests run with `bun test <file>` from `extension/`; compile check is `npm run compile` (`tsc -p ./`) — copied from `extension/package.json`.
- Test files use `import { expect, test } from "bun:test"` — match existing `commands/*.test.ts` style.
- MERGE_MODE is read by `orches-drive` from Settings (default `online`) — the button MUST NOT pass or hardcode a merge mode.
- `orches-drive` is bash-only, never edits maw code — the `--once` change stays prose/bash inside the skill.
- Marker file name is exactly `.orches-run.json`, one per project at repo root, gitignored.
- Never force-push already-merged history on cancel (user decision: safe-local revert only).
- New extension code follows existing patterns: message-passing via `panel.webview.onDidReceiveMessage` switch + client `post(type, data)`; re-render via `pushProjectsScreen(panel)`.

---

## File Structure

- **Create** `extension/src/commands/continueRun.ts` — pure logic + marker fs: types, `parseRunMarker`, `serializeRunMarker`, `runMarkerPath`, `readRunMarker`, `writeRunMarker` (atomic), `pendingSprints`, `resolveButtonState`, `resolveContinueTarget`, `decideCancelOutcome`.
- **Create** `extension/src/commands/continueRun.test.ts` — bun:test for every pure function above.
- **Modify** `extension/src/commands/teams.ts` — add `buildContinueKickoff(...)`; add `attach` param to `buildTmuxLaunchCommand`.
- **Modify** `extension/src/commands/teams.test.ts` — tests for `buildContinueKickoff` + detached command.
- **Modify** `extension/src/commands/startOrchestrator.ts` — add exported `sessionCreatedAt`, `launchContinueRun`, `cancelContinueRun` (reuse `readSessionPin`/`tmuxHasSession`/`nextTwinSession`).
- **Modify** `extension/src/webview/orchestrator.ts` — render `continue` button per card, client `post('continue_run'|'cancel_run')`, host cases, spin poll timer, button-state in `screen_projects` items.
- **Modify** `~/.claude/skills/orches-drive/SKILL.md` (repo `orches-skills`) — `--once` mode + Step 0 gitignore `.orches-run.json`.
- **Modify** `~/.claude/skills/orches-drive/orches-integrate.sh` — add `abort` verb.
- **Create** `orches-skills/test/abort.test.sh` — shell test for `abort` using a temp git repo + `gh` PATH-shim.

---

## Task 1: Run-marker module — parse / serialize / read / write (atomic + tolerant)

**Files:**
- Create: `extension/src/commands/continueRun.ts`
- Test: `extension/src/commands/continueRun.test.ts`

**Interfaces:**
- Produces: `type RunStatus = "running"|"done"|"error"|"cancelled"`; `interface RunMarker { status: RunStatus; sprint?: number; session: string; sessionCreatedAt?: number; baseMainSha?: string; startedAt: string; errorMsg?: string }`; `parseRunMarker(raw: string): RunMarker | null`; `serializeRunMarker(m: RunMarker): string`; `runMarkerPath(projectPath: string): string`; `readRunMarker(projectPath: string): RunMarker | null`; `writeRunMarker(projectPath: string, m: RunMarker): void`.

- [ ] **Step 1: Write the failing test**

```ts
// extension/src/commands/continueRun.test.ts
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseRunMarker,
  serializeRunMarker,
  runMarkerPath,
  readRunMarker,
  writeRunMarker,
  type RunMarker,
} from "./continueRun";

const RUNNING: RunMarker = {
  status: "running",
  sprint: 3,
  session: "claude-foreman",
  sessionCreatedAt: 1_700_000_000,
  baseMainSha: "abc1234",
  startedAt: "2026-07-10T08:00:00.000Z",
};

test("parseRunMarker: valid JSON round-trips", () => {
  expect(parseRunMarker(serializeRunMarker(RUNNING))).toEqual(RUNNING);
});

test("parseRunMarker: malformed/garbage → null (never throws)", () => {
  expect(parseRunMarker("{not json")).toBeNull();
  expect(parseRunMarker("")).toBeNull();
  expect(parseRunMarker("[1,2,3]")).toBeNull(); // not an object with status
  expect(parseRunMarker('{"foo":1}')).toBeNull(); // no status
});

test("runMarkerPath: joins .orches-run.json at project root", () => {
  expect(runMarkerPath("/x/proj")).toBe(join("/x/proj", ".orches-run.json"));
});

test("read/write: missing file → null; written file reads back", () => {
  const dir = mkdtempSync(join(tmpdir(), "orun-"));
  try {
    expect(readRunMarker(dir)).toBeNull();
    writeRunMarker(dir, RUNNING);
    expect(readRunMarker(dir)).toEqual(RUNNING);
    // atomic write leaves NO stray temp file
    expect(existsSync(join(dir, ".orches-run.json.tmp"))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readRunMarker: corrupt file → null (tolerant)", () => {
  const dir = mkdtempSync(join(tmpdir(), "orun-"));
  try {
    writeFileSync(join(dir, ".orches-run.json"), "{half-written");
    expect(readRunMarker(dir)).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && bun test src/commands/continueRun.test.ts`
Expected: FAIL — `Cannot find module "./continueRun"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// extension/src/commands/continueRun.ts
import * as fs from "node:fs";
import * as path from "node:path";

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && bun test src/commands/continueRun.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add extension/src/commands/continueRun.ts extension/src/commands/continueRun.test.ts
git commit -m "feat(continue): run-state marker (atomic write, tolerant read)"
```

---

## Task 2: pendingSprints + resolveButtonState (spin logic + zombie guard)

**Files:**
- Modify: `extension/src/commands/continueRun.ts`
- Test: `extension/src/commands/continueRun.test.ts`

**Interfaces:**
- Consumes: `RunMarker`, `ResumableProject` (from `./orchestratorResume`).
- Produces: `pendingSprints(p: Pick<ResumableProject,"plannedTotal"|"plannedDone"|"openWorktrees">): number`; `type ButtonState = "hidden"|"idle"|"spinning"|"stale"|"error"`; `interface Live { alive: boolean; createdAt?: number }`; `resolveButtonState(pending: number, marker: RunMarker|null, live: Live): { state: ButtonState; errorMsg?: string }`.

- [ ] **Step 1: Write the failing test** (append to `continueRun.test.ts`)

```ts
import { pendingSprints, resolveButtonState } from "./continueRun";

test("pendingSprints: plan wins (total-done); else open worktrees; never <0", () => {
  expect(pendingSprints({ plannedTotal: 5, plannedDone: 2, openWorktrees: 9 })).toBe(3);
  expect(pendingSprints({ plannedDone: 0, openWorktrees: 2 })).toBe(2); // no plannedTotal
  expect(pendingSprints({ plannedTotal: 3, plannedDone: 5, openWorktrees: 0 })).toBe(0);
});

const alive = (createdAt?: number) => ({ alive: true, createdAt });
const dead = { alive: false as const };

test("running + alive + matching session → spinning", () => {
  const m = { status: "running", session: "s", sessionCreatedAt: 100, startedAt: "x" } as const;
  expect(resolveButtonState(2, m, alive(100)).state).toBe("spinning");
});

test("running + session dead → stale", () => {
  const m = { status: "running", session: "s", sessionCreatedAt: 100, startedAt: "x" } as const;
  expect(resolveButtonState(2, m, dead).state).toBe("stale");
});

test("running + session name reused (created differs) → stale (zombie guard)", () => {
  const m = { status: "running", session: "s", sessionCreatedAt: 100, startedAt: "x" } as const;
  expect(resolveButtonState(2, m, alive(999)).state).toBe("stale");
});

test("error → error + message", () => {
  const m = { status: "error", session: "s", startedAt: "x", errorMsg: "STOP:gh" } as const;
  expect(resolveButtonState(2, m, dead)).toEqual({ state: "error", errorMsg: "STOP:gh" });
});

test("done/cancelled/null → idle if pending, hidden if none", () => {
  const done = { status: "done", session: "s", startedAt: "x" } as const;
  expect(resolveButtonState(1, done, dead).state).toBe("idle");
  expect(resolveButtonState(0, done, dead).state).toBe("hidden");
  expect(resolveButtonState(0, null, dead).state).toBe("hidden");
  expect(resolveButtonState(3, null, dead).state).toBe("idle");
});

test("unknown-but-running-ish preserved: alive session with running keeps spinning even if createdAt unknown", () => {
  const m = { status: "running", session: "s", startedAt: "x" } as const; // no sessionCreatedAt
  expect(resolveButtonState(2, m, alive(undefined)).state).toBe("spinning");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && bun test src/commands/continueRun.test.ts`
Expected: FAIL — `pendingSprints`/`resolveButtonState` not exported.

- [ ] **Step 3: Write minimal implementation** (append to `continueRun.ts`)

```ts
import type { ResumableProject } from "./orchestratorResume";

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && bun test src/commands/continueRun.test.ts`
Expected: PASS (all Task 1 + Task 2 tests).

- [ ] **Step 5: Commit**

```bash
git add extension/src/commands/continueRun.ts extension/src/commands/continueRun.test.ts
git commit -m "feat(continue): pending count + button-state resolver with zombie guard"
```

---

## Task 3: resolveContinueTarget (team/orchestrator auto-resolve, no-ask)

**Files:**
- Modify: `extension/src/commands/continueRun.ts`
- Test: `extension/src/commands/continueRun.test.ts`

**Interfaces:**
- Consumes: `ResumableProject`, `OracleTeam` (from `./teams`).
- Produces: `resolveContinueTarget(project: Pick<ResumableProject,"metaTeam">, teams: OracleTeam[]): { team: OracleTeam; orch: string } | { error: string }`.

- [ ] **Step 1: Write the failing test** (append)

```ts
import { resolveContinueTarget } from "./continueRun";
import type { OracleTeam } from "./teams";

const team = (name: string, orchestrators: string[]): OracleTeam =>
  ({ name, members: [], orchestrators }) as unknown as OracleTeam;

test("resolveContinueTarget: metaTeam + single orchestrator → that orch", () => {
  const r = resolveContinueTarget({ metaTeam: "brew" }, [team("brew", ["foreman"])]);
  expect(r).toEqual({ team: team("brew", ["foreman"]), orch: "foreman" });
});

test("resolveContinueTarget: >1 orchestrator → orchestrators[0] deterministic", () => {
  const r = resolveContinueTarget({ metaTeam: "brew" }, [team("brew", ["foreman", "mike"])]);
  expect("orch" in r && r.orch).toBe("foreman");
});

test("resolveContinueTarget: metaTeam not among teams → error", () => {
  const r = resolveContinueTarget({ metaTeam: "ghost" }, [team("brew", ["foreman"])]);
  expect("error" in r).toBe(true);
});

test("resolveContinueTarget: no metaTeam → error (never asks/blocks)", () => {
  const r = resolveContinueTarget({}, [team("brew", ["foreman"])]);
  expect("error" in r).toBe(true);
});

test("resolveContinueTarget: team has no orchestrators → error", () => {
  const r = resolveContinueTarget({ metaTeam: "brew" }, [team("brew", [])]);
  expect("error" in r).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && bun test src/commands/continueRun.test.ts`
Expected: FAIL — `resolveContinueTarget` not exported.

- [ ] **Step 3: Write minimal implementation** (append)

```ts
import type { OracleTeam } from "./teams";

/** Resolve which team + orchestrator to launch WITHOUT asking the user.
 *  Uses the project's last-driven team (.orches-meta.json → metaTeam) and the
 *  team's first orchestrator. Returns an error string for the rare edge where a
 *  pending project has no resolvable team (caller shows a toast, never a picker). */
export function resolveContinueTarget(
  project: Pick<ResumableProject, "metaTeam">,
  teams: OracleTeam[],
): { team: OracleTeam; orch: string } | { error: string } {
  if (!project.metaTeam) {
    return { error: "ไม่รู้ว่าจะใช้ทีมไหน (project นี้ยังไม่มี .orches-meta.json) — เปิดด้วย ⏮ ทำต่อ สักครั้งก่อน" };
  }
  const team = teams.find((t) => t.name === project.metaTeam);
  if (!team) return { error: `ไม่พบทีม '${project.metaTeam}' ใน ~/.maw/teams` };
  if (!team.orchestrators.length) {
    return { error: `ทีม '${team.name}' ไม่มี orchestrator — tag ก่อน` };
  }
  return { team, orch: team.orchestrators[0] };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && bun test src/commands/continueRun.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/src/commands/continueRun.ts extension/src/commands/continueRun.test.ts
git commit -m "feat(continue): no-ask team/orchestrator resolver"
```

---

## Task 4: decideCancelOutcome (done wins over cancel)

**Files:**
- Modify: `extension/src/commands/continueRun.ts`
- Test: `extension/src/commands/continueRun.test.ts`

**Interfaces:**
- Produces: `decideCancelOutcome(statusAfterKill: RunStatus | undefined, alreadyMerged: boolean): "keep_done" | "revert"`.

- [ ] **Step 1: Write the failing test** (append)

```ts
import { decideCancelOutcome } from "./continueRun";

test("decideCancelOutcome: status became done → keep_done (no revert)", () => {
  expect(decideCancelOutcome("done", false)).toBe("keep_done");
});
test("decideCancelOutcome: sprint already merged → keep_done", () => {
  expect(decideCancelOutcome("running", true)).toBe("keep_done");
});
test("decideCancelOutcome: still running, not merged → revert", () => {
  expect(decideCancelOutcome("running", false)).toBe("revert");
  expect(decideCancelOutcome(undefined, false)).toBe("revert");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && bun test src/commands/continueRun.test.ts`
Expected: FAIL — `decideCancelOutcome` not exported.

- [ ] **Step 3: Write minimal implementation** (append)

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && bun test src/commands/continueRun.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/src/commands/continueRun.ts extension/src/commands/continueRun.test.ts
git commit -m "feat(continue): cancel-outcome decider (done wins)"
```

---

## Task 5: teams.ts — buildContinueKickoff + detached buildTmuxLaunchCommand

**Files:**
- Modify: `extension/src/commands/teams.ts` (add `buildContinueKickoff`; add `attach` param near line 192-219)
- Test: `extension/src/commands/teams.test.ts`

**Interfaces:**
- Consumes: existing `buildResumeKickoff` style.
- Produces: `buildContinueKickoff(projectName: string, projectPath: string, team: string, orch: string, workers: string[]): string`; `buildTmuxLaunchCommand(orch, repoPath, kickoff, session?, workers?, attach?: boolean): string` (new final optional param, default `true`).

- [ ] **Step 1: Write the failing test** (append to `teams.test.ts`)

```ts
import { buildContinueKickoff, buildTmuxLaunchCommand } from "./teams";

test("buildContinueKickoff: names the project path + drives ONE sprint via --once", () => {
  const k = buildContinueKickoff("demo", "/p/demo", "brew", "foreman", ["mike"]);
  expect(k).toContain("/p/demo");
  expect(k).toContain("--once");
  expect(k).toContain("/orches-drive");
});

test("buildTmuxLaunchCommand: attach=false omits the trailing tmux attach", () => {
  const cmd = buildTmuxLaunchCommand("foreman", "/x", "hi", "claude-foreman", [], false);
  expect(cmd).toContain("new-session");
  expect(cmd).not.toContain("tmux attach");
});

test("buildTmuxLaunchCommand: default still attaches (unchanged behavior)", () => {
  const cmd = buildTmuxLaunchCommand("foreman", "/x", "hi", "claude-foreman", []);
  expect(cmd).toContain("tmux attach");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && bun test src/commands/teams.test.ts`
Expected: FAIL — `buildContinueKickoff` not exported; attach param ignored.

- [ ] **Step 3: Write minimal implementation**

Add `buildContinueKickoff` after `buildResumeKickoff` (near teams.ts:120). Model the wording on `buildResumeKickoff` but pin one sprint + marker contract:

```ts
/** Kickoff for the "continue" BUTTON: resume this project and run exactly ONE
 *  sprint headless, then stop. No requirement discussion, no --ask. The marker
 *  contract (.orches-run.json done/error) is what the extension polls. */
export function buildContinueKickoff(
  projectName: string,
  projectPath: string,
  team: string,
  orch: string,
  workers: string[],
): string {
  return (
    `/orches-drive --once ` +
    `resume project "${projectName}" ที่ ${projectPath} (team ${team}, ผม=${orch}). ` +
    `ทำ sprint ถัดไปใน docs/plan.md อันเดียวแล้วหยุด — ห้ามวน sprint ต่อ. ` +
    `MERGE_MODE อ่านจาก Settings (อย่าถาม). worker: ${workers.join(", ") || "(none)"}. ` +
    `เมื่อจบ 1 sprint เขียน .orches-run.json {"status":"done"} แล้ว exit; ` +
    `ถ้าล้ม เขียน {"status":"error","errorMsg":"<เหตุผล>"} แล้ว exit.`
  );
}
```

Then make the attach tail conditional. Change the signature and the final lines (teams.ts:192, 216-219):

```ts
export function buildTmuxLaunchCommand(
  orch: string,
  repoPath: string,
  kickoff: string,
  session = `claude-${orch}`,
  workers: string[] = [],
  attach = true, // continue-button passes false → detached, no attach
): string {
  // ...existing body unchanged up to the new-session line...
  return (
    `{ ` +
    /* ...existing layout-init + */
    `tmux new-session -A -d -s ${shSingleQuote(session)} ${/* existing args */ ""} ; ` +
    (attach ? `tmux attach -t ${shSingleQuote(`=${session}`)} ; ` : ``) +
    `}`
  );
}
```

> Implementer: keep every existing argument to `new-session` verbatim; the ONLY behavioral change is gating the `tmux attach` line behind `attach`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd extension && bun test src/commands/teams.test.ts && npm run compile`
Expected: PASS + clean `tsc`.

- [ ] **Step 5: Commit**

```bash
git add extension/src/commands/teams.ts extension/src/commands/teams.test.ts
git commit -m "feat(continue): continue kickoff + detached launch option"
```

---

## Task 6: startOrchestrator.ts — sessionCreatedAt, launchContinueRun, cancelContinueRun

**Files:**
- Modify: `extension/src/commands/startOrchestrator.ts` (add near existing tmux helpers ~line 309-340)

**Interfaces:**
- Consumes: `readSessionPin`, `tmuxHasSession`, `nextTwinSession` (internal); `buildContinueKickoff`, `buildTmuxLaunchCommand(...,false)` (Task 5); `resolveContinueTarget`, `writeRunMarker`, `readRunMarker`, `decideCancelOutcome` (Tasks 1-4); `gitOps`.
- Produces: `sessionCreatedAt(session: string): number | undefined`; `launchContinueRun(project: ResumableProject): { error?: string; session?: string }`; `cancelContinueRun(project: ResumableProject): Promise<void>`.

**Testability note:** these are tmux/git side-effect wrappers — not bun-unit-tested. Their pure inputs (`resolveContinueTarget`, marker fns, `decideCancelOutcome`) are covered by Tasks 1-4. Verification here is `npm run compile` + the end-to-end manual check in Task 7.

- [ ] **Step 1: Implement `sessionCreatedAt`**

```ts
/** tmux #{session_created} (epoch seconds) for a session, or undefined. */
export function sessionCreatedAt(session: string): number | undefined {
  try {
    const out = cp
      .execFileSync("tmux", ["display-message", "-p", "-t", `=${session}`, "#{session_created}"], {
        encoding: "utf8",
      })
      .trim();
    const n = Number(out);
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 2: Implement `launchContinueRun`**

```ts
export function launchContinueRun(project: ResumableProject): { error?: string; session?: string } {
  // guard: already running for THIS project → no double-launch
  const existing = readRunMarker(project.path);
  const base = `claude-${/* resolved orch below */ ""}`;
  const teams = listOrchestratorTeams();
  const target = resolveContinueTarget(project, teams);
  if ("error" in target) return { error: target.error };

  const baseSession = readSessionPin(target.orch)?.trim() || `claude-${target.orch}`;
  if (existing?.status === "running" && tmuxHasSession(existing.session)) {
    return { session: existing.session }; // already spinning → no-op
  }
  const session = tmuxHasSession(baseSession) ? nextTwinSession(baseSession) : baseSession;

  const workers = target.team.members
    .filter((m) => m.role !== "orchestrator")
    .map((m) => m.oracle)
    .filter(isSafeOracleName);
  const kickoff = buildContinueKickoff(project.name, project.path, target.team.name, target.orch, workers);
  const command = buildTmuxLaunchCommand(target.orch, project.path, kickoff, session, workers, false);

  let baseMainSha = "";
  try {
    baseMainSha = cp.execFileSync("git", ["-C", project.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    /* fresh repo with no commit — abort revert will simply skip the reset */
  }
  try {
    cp.execFileSync("bash", ["-lc", command]);
  } catch (e) {
    return { error: `launch ล้มเหลว: ${String(e)}` };
  }
  writeRunMarker(project.path, {
    status: "running",
    sprint: (project.plannedDone ?? 0) + 1,
    session,
    sessionCreatedAt: sessionCreatedAt(session),
    baseMainSha,
    startedAt: new Date().toISOString(),
  });
  return { session };
}
```

- [ ] **Step 3: Implement `cancelContinueRun`**

```ts
export async function cancelContinueRun(project: ResumableProject): Promise<void> {
  const marker = readRunMarker(project.path);
  if (!marker) return;
  try {
    cp.execFileSync("tmux", ["kill-session", "-t", `=${marker.session}`]);
  } catch {
    /* already gone */
  }
  const after = readRunMarker(project.path); // re-read AFTER kill (done may have landed)
  const intg = `${homedir()}/.claude/skills/orches-drive/orches-integrate.sh`;
  let alreadyMerged = false;
  try {
    const r = cp.execFileSync("bash", [intg, "sync", project.path], { encoding: "utf8" }).trim();
    alreadyMerged = r.includes("ALREADY_MERGED");
  } catch {
    /* best-effort */
  }
  if (decideCancelOutcome(after?.status, alreadyMerged) === "keep_done") {
    writeRunMarker(project.path, { ...(after ?? marker), status: "done" });
    return;
  }
  try {
    cp.execFileSync("bash", [intg, "abort", project.path, marker.baseMainSha ?? ""]);
  } catch {
    /* abort best-effort; still mark cancelled so the button frees up */
  }
  writeRunMarker(project.path, { ...marker, status: "cancelled" });
}
```

- [ ] **Step 4: Verify compile**

Run: `cd extension && npm run compile`
Expected: no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add extension/src/commands/startOrchestrator.ts
git commit -m "feat(continue): detached launch + safe-cancel host helpers"
```

---

## Task 7: orchestrator.ts webview — button render + continue/cancel messages + spin poll

**Files:**
- Modify: `extension/src/webview/orchestrator.ts` (item shape in `pushProjectsScreen` ~57-81; `renderProjects` card ~482-530; client `post` ~420; host switch ~182-320)

**Interfaces:**
- Consumes: `resolveButtonState`, `pendingSprints`, `readRunMarker` (Task 1-2); `sessionCreatedAt`, `launchContinueRun`, `cancelContinueRun` (Task 6); existing `pushProjectsScreen`, `gitOps.fetchRepo`.

**Testability note:** webview render + timer is integration — verified by launching the Extension Development Host (F5) and driving the real button. Pure state logic is already covered (Task 2).

- [ ] **Step 1: Add button-state to each item** in `pushProjectsScreen` (compute host-side)

```ts
// inside pushProjectsScreen, when building each item (orchestrator.ts ~69):
const marker = readRunMarker(p.path);
const live = marker
  ? { alive: tmuxHasSessionExported(marker.session), createdAt: sessionCreatedAt(marker.session) }
  : { alive: false };
const pending = pendingSprints(p);
const btn = resolveButtonState(pending, marker, live);
// add to the item object:
//   run: { state: btn.state, errorMsg: btn.errorMsg }
```

> `tmuxHasSession` is currently module-private in `startOrchestrator.ts`; export it (rename usage to `tmuxHasSessionExported` or just `export`) so the webview host can call it. One-line `export` change + import.

- [ ] **Step 2: Render the button in `renderProjects`** (add inside the card, after the `.pick` block, before `gitCell`)

```js
// it.run = { state, errorMsg }
var run = it.run || { state: 'hidden' };
var contBtn =
  run.state === 'spinning' ? '<button class="cont spin" title="กำลังทำต่อ — คลิกเพื่อยกเลิก">⟳</button>' :
  run.state === 'idle'     ? '<button class="cont" title="ทำต่อ 1 sprint (auto)">▶ continue</button>' :
  run.state === 'stale'    ? '<button class="cont stale" title="run หลุด — คลิกเพื่อล้าง/เริ่มใหม่">⚠ ทำต่อ</button>' :
  run.state === 'error'    ? '<button class="cont err" title="'+esc(run.errorMsg||'error')+'">⚠ error</button>' : '';
```

Insert `+contBtn` into the card HTML (between the `.pick` `</button>`+`gitEditor` div and the `git-cell` span at ~509). Wire clicks in the per-card handler (after the `.star` handler ~524):

```js
var cEl = card.querySelector('.cont');
if (cEl) cEl.addEventListener('click', function(e){
  e.stopPropagation(); // NOT the card → don't attach; this button is continue/cancel
  if (cEl.classList.contains('spin')) post('cancel_run', { path: path });
  else post('continue_run', { path: path });
});
```

- [ ] **Step 3: Add host cases** (in the `onDidReceiveMessage` switch, ~line 318)

```ts
case "continue_run": {
  const p = _st.projects.find((x) => x.path === msg.path);
  if (!p) return;
  const r = launchContinueRun(p);
  if (r.error) vscode.window.showWarningMessage(`Continue: ${r.error}`);
  await pushProjectsScreen(panel);
  startSpinPoll(panel);
  return;
}
case "cancel_run": {
  const p = _st.projects.find((x) => x.path === msg.path);
  if (!p) return;
  await cancelContinueRun(p);
  await pushProjectsScreen(panel);
  return;
}
```

- [ ] **Step 4: Add the spin poll timer** (module scope in orchestrator.ts)

```ts
let _spinPoll: ReturnType<typeof setInterval> | undefined;
function startSpinPoll(panel: vscode.WebviewPanel) {
  if (_spinPoll) return;
  _spinPoll = setInterval(async () => {
    const projs = _st?.projects ?? [];
    const anyRunning = projs.some((p) => readRunMarker(p.path)?.status === "running");
    // done just landed → fetch so the right-hand git panel updates
    for (const p of projs) {
      const m = readRunMarker(p.path);
      if (m?.status === "done") await gitOps.fetchRepo(p.path);
    }
    if (_panel) await pushProjectsScreen(_panel);
    if (!anyRunning && _spinPoll) { clearInterval(_spinPoll); _spinPoll = undefined; }
  }, 2500);
}
```

Call `startSpinPoll(panel)` once at the end of `pushProjectsScreen` when any item is `spinning`, and `clearInterval` in the panel's `onDidDispose`.

- [ ] **Step 5: Add minimal CSS** for `.cont` (in the `<style>` block of the webview HTML): green idle, amber stale/err, a `@keyframes spin` rotation for `.cont.spin`.

- [ ] **Step 6: Verify compile + manual E2E**

Run: `cd extension && npm run compile`
Then F5 (Extension Development Host) → open "📁 Projects" → on a project with "🔨 ค้าง N sprint":
- Idle shows `▶ continue`; click → button becomes `⟳` spinner, a detached `tmux` session exists (`tmux ls`), NO editor terminal opened.
- Click the CARD (not the button) → attaches into that session.
- Refresh the panel / reload window → button still spinning (persisted).
- Let one sprint finish → spinner clears, git panel refreshes, PR merged on GitHub, button gone if no sprint left.
- Click `⟳` mid-run → session killed, working tree back to pre-click (local), button back to `▶ continue`.

- [ ] **Step 7: Commit**

```bash
git add extension/src/webview/orchestrator.ts extension/src/commands/startOrchestrator.ts
git commit -m "feat(continue): inline continue/cancel button + spin poll"
```

---

## Task 8: orches-drive skill — `--once` mode + gitignore `.orches-run.json`

**Files:**
- Modify: `orches-skills` repo `orches-drive/SKILL.md` (Step 0 gitignore ~line 64-65; Step 5 cadence ~line 390-399)

**Testability note:** the skill is prose the orchestrator follows — behavior is integration-verified via Task 7's E2E. Two mechanical checks here: (a) gitignore line is idempotent, (b) anchors exist.

- [ ] **Step 1: Add `.orches-run.json` to the setup gitignore** (Step 0, after the existing `.orches-preview.*` line ~65)

```bash
grep -q '.orches-run.json' <project>/.gitignore 2>/dev/null || printf '.orches-run.json\n' >> <project>/.gitignore
```

- [ ] **Step 2: Add the `--once` contract** near the top-rules + Step 5 cadence. Add a bullet to the cadence list (next to the existing `auto:` bullet ~399):

```markdown
- **`--once` (ปุ่ม continue):** ทำ **sprint ถัดไปอันเดียว** (อันแรกที่ยัง `- [ ]` ใน plan.md) ให้ครบ Step 4.7+4.8 → **หยุด ห้ามขึ้น sprint ถัดไป · ไม่โชว์ปุ่ม checkpoint** → เขียน marker แล้ว exit:
  - สำเร็จ: `printf '{"status":"done"}' > "$PROJ/.orches-run.json.tmp" && mv "$PROJ/.orches-run.json.tmp" "$PROJ/.orches-run.json"`
  - ล้ม (`STOP:*`/verify fail terminal): `printf '{"status":"error","errorMsg":"<เหตุผล>"}' > "$PROJ/.orches-run.json.tmp" && mv ...`
  - ⛔ ห้าม downgrade online→local เงียบ; gh ไม่พร้อม = เขียน error marker ตาม `STOP:online-needs-gh`
```

- [ ] **Step 3: Verify anchors + gitignore idempotency**

```bash
grep -c '\-\-once' ~/.claude/skills/orches-drive/SKILL.md   # expect >= 1
d=$(mktemp -d); : > "$d/.gitignore"
for i in 1 2; do grep -q '.orches-run.json' "$d/.gitignore" || printf '.orches-run.json\n' >> "$d/.gitignore"; done
test "$(grep -c orches-run.json "$d/.gitignore")" = 1 && echo OK; rm -rf "$d"
```
Expected: prints a count ≥ 1, then `OK` (added exactly once).

- [ ] **Step 4: Commit** (in `orches-skills` repo)

```bash
git -C ~/Desktop/soulbrew/github.com/fufu-2345/orches-skills add orches-drive/SKILL.md
git -C ~/Desktop/soulbrew/github.com/fufu-2345/orches-skills commit -m "feat(orches-drive): --once single-sprint mode + .orches-run.json gitignore"
```

---

## Task 9: orches-integrate.sh — `abort` verb (safe local revert)

**Files:**
- Modify: `orches-skills` repo `orches-drive/orches-integrate.sh` (add `cmd_abort` + dispatch entry ~line 266-276)
- Create: `orches-skills/test/abort.test.sh`

**Interfaces:**
- Produces: `orches-integrate.sh abort <project> <baseSha>` → drops unmerged `agents/*` worktrees+branches (local; remote+PR if present), then `git reset --hard <baseSha>` on main ONLY if `origin/main` is not already at/ahead of HEAD (never rewrites pushed history). Idempotent. Prints `ABORTED` / `ABORT_SKIP_PUSHED`.

- [ ] **Step 1: Write the failing shell test**

```bash
# orches-skills/test/abort.test.sh
set -euo pipefail
INTG="$(cd "$(dirname "$0")/.." && pwd)/orches-drive/orches-integrate.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
export PATH="$TMP/shim:$PATH"; mkdir -p "$TMP/shim"
printf '#!/usr/bin/env bash\necho "gh $*" >> "%s/gh.log"\n' "$TMP" > "$TMP/shim/gh"; chmod +x "$TMP/shim/gh"

P="$TMP/proj"; mkdir -p "$P"; git -C "$P" init -q -b main
git -C "$P" config user.email t@t; git -C "$P" config user.name t
echo base > "$P/f"; git -C "$P" add -A; git -C "$P" commit -qm base
BASE="$(git -C "$P" rev-parse HEAD)"
# simulate an in-flight (unpushed, unmerged) sprint commit on main
echo work >> "$P/f"; git -C "$P" commit -qam wip

bash "$INTG" abort "$P" "$BASE"
test "$(git -C "$P" rev-parse HEAD)" = "$BASE" && echo "PASS: main reset to base"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash orches-skills/test/abort.test.sh`
Expected: FAIL — unknown verb `abort` (dispatch has no case) → HEAD ≠ BASE.

- [ ] **Step 3: Implement `cmd_abort` + dispatch**

Add the function (near other `cmd_*`) and a dispatch case beside `cleanup)` (~line 275):

```bash
cmd_abort() {
  local proj base; proj="$(cd "$1" && pwd)"; base="${2:-}"
  # 1) drop unmerged agents/* worktrees + branches (local; remote+PR if any)
  if [ -d "$proj/agents" ]; then
    for wt in "$proj"/agents/*; do
      [ -d "$wt" ] || continue
      local role br; role="$(basename "$wt")"; br="agents/$role"
      # merged into main already? leave it (safe mode)
      if git -C "$proj" merge-base --is-ancestor "$br" main 2>/dev/null; then continue; fi
      git -C "$proj" worktree remove --force "$wt" 2>/dev/null || true
      git -C "$proj" branch -D "$br" 2>/dev/null || true
      if git -C "$proj" ls-remote --exit-code origin "$br" >/dev/null 2>&1; then
        git -C "$proj" push origin --delete "$br" 2>/dev/null || true
        gh pr close "$br" -R "$(git -C "$proj" remote get-url origin 2>/dev/null)" 2>/dev/null || true
      fi
    done
  fi
  # 2) reset main to base ONLY if we haven't pushed past it (never rewrite pushed history)
  if [ -n "$base" ]; then
    git -C "$proj" fetch origin main 2>/dev/null || true
    if git -C "$proj" rev-parse origin/main >/dev/null 2>&1 \
       && ! git -C "$proj" merge-base --is-ancestor origin/main "$base"; then
      echo "ABORT_SKIP_PUSHED"; return 0   # origin/main is ahead of base → merged upstream, leave it
    fi
    git -C "$proj" reset --hard "$base" 2>/dev/null || true
  fi
  echo "ABORTED"
}
```

Dispatch (add beside existing verbs ~275):

```bash
  abort)         shift; cmd_abort "$@" ;;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash orches-skills/test/abort.test.sh`
Expected: `PASS: main reset to base`.

- [ ] **Step 5: Commit**

```bash
git -C ~/Desktop/soulbrew/github.com/fufu-2345/orches-skills add orches-drive/orches-integrate.sh test/abort.test.sh
git -C ~/Desktop/soulbrew/github.com/fufu-2345/orches-skills commit -m "feat(orches-integrate): abort verb (safe local revert) + test"
```

---

## Self-Review

**Spec coverage:**
- §1.1 one sprint + online PR → Task 5 (`--once` kickoff), Task 8 (`--once` behavior). ✓
- §1.2 no-ask auto-resolve → Task 3 (`resolveContinueTarget`), Task 6 (`launchContinueRun`). ✓
- §1.3 background + attachable → Task 5 (`attach=false`), Task 6 (detached bash exec, no terminal), Task 7 (card-click attaches). ✓
- §1.4 safe local revert → Task 9 (`abort`), Task 6 (`cancelContinueRun`). ✓
- §1.5 marker not SQLite → Task 1. ✓
- §1.6 session collision reuse → Task 6 (`tmuxHasSession`/`nextTwinSession`, double-launch guard). ✓
- §3 marker schema + atomic/tolerant → Task 1. ✓  §3.2 B4 gitignore → Task 8. ✓
- §4 spin-state table + zombie → Task 2, Task 7 Step 1. ✓
- §6 cancel done-wins → Task 4 + Task 6 Step 3. ✓
- §11 edge cases: torn JSON (T1), zombie (T2), cancel/done (T4/T6), double-launch (T6), error toast (T7 Step 2/3), gitignore (T8), gh-missing (T8). ✓

**Placeholder scan:** No TBD/TODO. The only prose-not-code deliverables are Task 8 (a skill markdown, inherently prose) and the clearly-labelled manual E2E in Task 7 Step 6 — both have concrete mechanical checks. `buildTmuxLaunchCommand` body edit shows the exact changed lines; implementer preserves existing args verbatim (called out explicitly).

**Type consistency:** `RunMarker`/`RunStatus`/`ButtonState`/`Live` defined in Task 1-2 and consumed with identical shapes in Tasks 6-7. `resolveContinueTarget` return `{team,orch}|{error}` matched in Task 6. `sessionCreatedAt`/`launchContinueRun`/`cancelContinueRun` signatures match between Task 6 (def) and Task 7 (use). `abort <project> <baseSha>` matches between Task 9 (def) and Task 6 (call).

---

## Execution Handoff

Two execution options — Subagent-Driven (fresh subagent per task, review between) or Inline (batch with checkpoints).

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
  pendingSprints,
  resolveButtonState,
  resolveContinueTarget,
  decideCancelOutcome,
  decideContinueAction,
  finishedSessions,
  clampSprintCount,
  type RunMarker,
} from "./continueRun";
import type { OracleTeam } from "./teams";

const RUNNING: RunMarker = {
  status: "running",
  sprint: 3,
  session: "claude-foreman",
  sessionCreatedAt: 1_700_000_000,
  baseMainSha: "abc1234",
  startedAt: "2026-07-10T08:00:00.000Z",
};

// --- Task 1: marker parse / serialize / read / write ---

test("parseRunMarker: valid JSON round-trips", () => {
  expect(parseRunMarker(serializeRunMarker(RUNNING))).toEqual(RUNNING);
});

test("parseRunMarker: malformed/garbage → null (never throws)", () => {
  expect(parseRunMarker("{not json")).toBeNull();
  expect(parseRunMarker("")).toBeNull();
  expect(parseRunMarker("[1,2,3]")).toBeNull(); // not an object with status
  expect(parseRunMarker('{"foo":1}')).toBeNull(); // no status
});

test("parseRunMarker: bare terminal marker from `/orches-drive --once` parses", () => {
  // orches-drive writes these on completion (no session/startedAt) — they MUST
  // parse so the extension detects the sprint finished and auto-refreshes.
  expect(parseRunMarker('{"status":"done"}')).toEqual({ status: "done" });
  expect(parseRunMarker('{"status":"error","errorMsg":"STOP:gh"}')).toEqual({
    status: "error",
    errorMsg: "STOP:gh",
  });
});

test("parseRunMarker: a RUNNING marker still requires session + startedAt", () => {
  expect(parseRunMarker('{"status":"running"}')).toBeNull(); // no session/startedAt
  expect(parseRunMarker('{"status":"running","session":"s"}')).toBeNull(); // no startedAt
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

// --- Task 2: pendingSprints + resolveButtonState ---

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

// --- Task 3: resolveContinueTarget ---

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

// --- Task 4: decideCancelOutcome ---

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

// --- Task 5: decideContinueAction (▶ ทำต่อ collision guard, state-based) ---
// Decided from the ONE detector's DrivenState so the button never forks a twin
// onto a project already being driven (incl. checkpoint-pause = "owner").

test("decideContinueAction: run→already-running (this button's own live run) ", () => {
  expect(decideContinueAction("run")).toBe("already-running");
});

test("decideContinueAction: worker|owner|labeled → attach (a session already drives it)", () => {
  expect(decideContinueAction("worker")).toBe("attach"); // worker pane grinding
  expect(decideContinueAction("owner")).toBe("attach"); // orchestrator session alive (e.g. checkpoint pause)
  expect(decideContinueAction("labeled")).toBe("attach"); // @orches_label session
});

test("decideContinueAction: none → launch (nothing live)", () => {
  expect(decideContinueAction("none")).toBe("launch");
});

// --- Task 6: finishedSessions (reap a headless run's session once it completes) ---
// The done/error marker is rewritten bare (drops .session), so the session name
// must be captured WHILE the run is live (prev tick) and reaped on the transition.

test("finishedSessions: sessions of runs that left 'running' since last tick (skips blank session)", () => {
  const prev = new Map([
    ["/a", "sa"], // still running → not reaped
    ["/b", "sb"], // finished → reap sb
    ["/c", ""], // finished but no session captured → skip
  ]);
  expect(finishedSessions(prev, new Set(["/a"]))).toEqual(["sb"]);
});

test("finishedSessions: nothing left running-set → empty", () => {
  expect(finishedSessions(new Map([["/a", "sa"]]), new Set(["/a"]))).toEqual([]);
  expect(finishedSessions(new Map(), new Set(["/a"]))).toEqual([]);
});

// --- Task 7: clampSprintCount (multi-sprint "ทำหลาย sprint" popup input) ---

test("clampSprintCount: parses + caps at remaining", () => {
  expect(clampSprintCount("2", 4)).toBe(2);
  expect(clampSprintCount("4", 4)).toBe(4);
  expect(clampSprintCount("9", 4)).toBe(4); // more than remaining → cap
  expect(clampSprintCount("1", 4)).toBe(1);
  expect(clampSprintCount("  3 ", 4)).toBe(3); // trims
});

test("clampSprintCount: <1 / NaN / empty → null (invalid)", () => {
  expect(clampSprintCount("0", 4)).toBeNull();
  expect(clampSprintCount("-2", 4)).toBeNull();
  expect(clampSprintCount("abc", 4)).toBeNull();
  expect(clampSprintCount("", 4)).toBeNull();
  expect(clampSprintCount("2.5", 4)).toBe(2); // parseInt floors
});

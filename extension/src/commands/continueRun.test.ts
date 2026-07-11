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

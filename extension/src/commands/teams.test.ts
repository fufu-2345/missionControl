import { expect, test } from "bun:test";

import {
  buildKickoffPrompt,
  buildWakeAttachCommand,
  isSafeOracleName,
  parseTeamRoster,
} from "./teams";

test("parseTeamRoster: valid roster with an orchestrator", () => {
  const raw = JSON.stringify({
    name: "carbon",
    members: [
      { oracle: "bob", role: "member" },
      { oracle: "jack", role: "member" },
      { oracle: "foreman", role: "orchestrator" },
    ],
  });
  const t = parseTeamRoster("carbon", raw);
  expect(t).not.toBeNull();
  expect(t!.name).toBe("carbon");
  expect(t!.members.length).toBe(3);
  expect(t!.orchestrators).toEqual(["foreman"]);
});

test("parseTeamRoster: multiple orchestrators", () => {
  const raw = JSON.stringify({
    members: [
      { oracle: "foreman", role: "orchestrator" },
      { oracle: "captain", role: "orchestrator" },
      { oracle: "bob", role: "member" },
    ],
  });
  const t = parseTeamRoster("x", raw);
  expect(t!.orchestrators).toEqual(["foreman", "captain"]);
});

test("parseTeamRoster: no orchestrator → empty list", () => {
  const raw = JSON.stringify({ members: [{ oracle: "bob", role: "member" }] });
  const t = parseTeamRoster("x", raw);
  expect(t!.orchestrators).toEqual([]);
});

test("parseTeamRoster: bad JSON → null", () => {
  expect(parseTeamRoster("x", "{not json")).toBeNull();
});

test("parseTeamRoster: missing members array → null", () => {
  expect(parseTeamRoster("x", JSON.stringify({ name: "x" }))).toBeNull();
});

test("parseTeamRoster: skips members without a string oracle field", () => {
  const raw = JSON.stringify({
    members: [{ oracle: "bob", role: "member" }, { role: "orphan" }, null, 42],
  });
  const t = parseTeamRoster("x", raw);
  expect(t!.members.map((m) => m.oracle)).toEqual(["bob"]);
});

test("parseTeamRoster: member without role defaults to empty string", () => {
  const t = parseTeamRoster("x", JSON.stringify({ members: [{ oracle: "bob" }] }));
  expect(t!.members[0].role).toBe("");
});

test("isSafeOracleName: whitelist", () => {
  expect(isSafeOracleName("foreman")).toBe(true);
  expect(isSafeOracleName("orch-lead_2.0")).toBe(true);
  expect(isSafeOracleName("")).toBe(false);
  expect(isSafeOracleName("bad name")).toBe(false);
  expect(isSafeOracleName("evil;rm -rf")).toBe(false);
  expect(isSafeOracleName("$(whoami)")).toBe(false);
});

test("buildWakeAttachCommand: single-quoted + --attach (no kickoff)", () => {
  expect(buildWakeAttachCommand("foreman")).toBe("maw wake 'foreman' --attach");
});

test("buildWakeAttachCommand: with kickoff → adds -p (single-quoted)", () => {
  expect(buildWakeAttachCommand("foreman", "hi there")).toBe(
    "maw wake 'foreman' --attach -p 'hi there'",
  );
});

test("buildWakeAttachCommand: kickoff with a single quote is shell-escaped", () => {
  expect(buildWakeAttachCommand("foreman", "it's fine")).toBe(
    "maw wake 'foreman' --attach -p 'it'\\''s fine'",
  );
});

test("buildKickoffPrompt: names team/orchestrator/workers + runs drive not bootstrap", () => {
  const p = buildKickoffPrompt("carbon", "foreman", ["bob", "jack"]);
  expect(p).toContain("carbon");
  expect(p).toContain("foreman");
  expect(p).toContain("bob, jack");
  expect(p).toContain("/orches-drive");
  expect(p).toContain("อย่ารัน /orches"); // must NOT re-bootstrap
});

test("buildKickoffPrompt: no workers → hint text", () => {
  expect(buildKickoffPrompt("orch-dev", "foreman", [])).toContain("ยังไม่มี worker");
});

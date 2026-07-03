import { expect, test } from "bun:test";

import {
  buildKickoffPrompt,
  buildTmuxLaunchCommand,
  isSafeOracleName,
  parseOraclePath,
  parseSessionPin,
  parseTeamRoster,
} from "./teams";

test("parseSessionPin: finds pinned session for an oracle", () => {
  const cfg = JSON.stringify({ sessions: { foreman: "09-foreman", bob: "05-bob" } });
  expect(parseSessionPin(cfg, "foreman")).toBe("09-foreman");
  expect(parseSessionPin(cfg, "bob")).toBe("05-bob");
});

test("parseSessionPin: missing oracle / empty / bad JSON → null", () => {
  expect(parseSessionPin(JSON.stringify({ sessions: {} }), "foreman")).toBeNull();
  expect(parseSessionPin(JSON.stringify({}), "foreman")).toBeNull();
  expect(parseSessionPin(JSON.stringify({ sessions: { foreman: "  " } }), "foreman")).toBeNull();
  expect(parseSessionPin(JSON.stringify({ sessions: { foreman: 42 } }), "foreman")).toBeNull();
  expect(parseSessionPin("{bad", "foreman")).toBeNull();
});

test("buildTmuxLaunchCommand: pinned session name wins over claude-<orch>", () => {
  const cmd = buildTmuxLaunchCommand("foreman", "/p/foreman-oracle", "hi", "09-foreman");
  expect(cmd.startsWith("tmux new-session -A -s '09-foreman' '")).toBe(true);
  expect(cmd).not.toContain("claude-foreman");
});

test("buildTmuxLaunchCommand: blank pin falls back to claude-<orch>", () => {
  const cmd = buildTmuxLaunchCommand("foreman", "/p/foreman-oracle", "hi", "  ");
  expect(cmd.startsWith("tmux new-session -A -s 'claude-foreman' '")).toBe(true);
});

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

test("buildTmuxLaunchCommand: tmux new-session -A wrapping cd + fresh claude", () => {
  const cmd = buildTmuxLaunchCommand("foreman", "/p/foreman-oracle", "hello");
  expect(cmd.startsWith("tmux new-session -A -s 'claude-foreman' '")).toBe(true);
  expect(cmd).toContain("cd "); // inner: cd into the oracle repo
  expect(cmd).toContain("/p/foreman-oracle");
  expect(cmd).toContain("claude --dangerously-skip-permissions");
  expect(cmd).toContain("hello");
});

test("buildTmuxLaunchCommand: NO --continue (fresh session, not resume)", () => {
  expect(buildTmuxLaunchCommand("foreman", "/x", "hi")).not.toContain("--continue");
});

test("buildTmuxLaunchCommand: inner single-quotes survive shell round-trip", () => {
  // Structural check: the inner command's quotes must be escaped for the outer
  // single-quoted tmux arg — bash unwraps '\'' back into a literal '.
  const cmd = buildTmuxLaunchCommand("foreman", "/x", "it's (fine)");
  expect(cmd).toContain("'\\''"); // escaped inner quote present
  expect(cmd).toContain("it"); // kickoff text carried through
  expect(cmd).toContain("(fine)");
});

test("parseOraclePath: finds local_path by name", () => {
  const raw = JSON.stringify({
    oracles: [
      { name: "bob", local_path: "/p/bob-oracle" },
      { name: "foreman", local_path: "/p/foreman-oracle" },
    ],
  });
  expect(parseOraclePath(raw, "foreman")).toBe("/p/foreman-oracle");
  expect(parseOraclePath(raw, "nope")).toBeNull();
});

test("parseOraclePath: bad JSON → null", () => {
  expect(parseOraclePath("{bad", "foreman")).toBeNull();
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

import { test, expect } from "bun:test";

import { buildAttachCommand, isSafeSessionName, parseTmuxSessions } from "./sessions";

test("parseTmuxSessions parses tab-separated session lines", () => {
  const raw = "carbon\t2\t1\tclaude\t/home/u/bob\n" + "soulbrew\t1\t0\tbash\t/home/u/sb";
  expect(parseTmuxSessions(raw)).toEqual([
    { name: "carbon", windows: 2, attached: true, cmd: "claude", cwd: "/home/u/bob" },
    { name: "soulbrew", windows: 1, attached: false, cmd: "bash", cwd: "/home/u/sb" },
  ]);
});

test("parseTmuxSessions tolerates empty and non-format output", () => {
  expect(parseTmuxSessions("")).toEqual([]);
  expect(parseTmuxSessions("no server running on /tmp/tmux-1000/default")).toEqual([]);
  expect(parseTmuxSessions("\n\n")).toEqual([]);
});

test("isSafeSessionName accepts normal names, rejects injection", () => {
  expect(isSafeSessionName("carbon")).toBe(true);
  expect(isSafeSessionName("my-team_1")).toBe(true);
  expect(isSafeSessionName("")).toBe(false);
  expect(isSafeSessionName("a'; rm -rf ~ #")).toBe(false);
  expect(isSafeSessionName("a\nb")).toBe(false);
  expect(isSafeSessionName('q"x')).toBe(false);
});

test("buildAttachCommand single-quotes the name", () => {
  expect(buildAttachCommand("carbon")).toBe("tmux attach -t 'carbon'");
});

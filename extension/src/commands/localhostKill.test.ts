import { expect, test } from "bun:test";

import { isProtectedComm, canKillGroup, buildKillCmd } from "./localhostKill";

const ROOT = "/home/u/github.com/owner/projects";

test("isProtectedComm: shells / editor / tmux / init are protected", () => {
  ["code", "tmux", "bash", "-bash", "zsh", "sh", "systemd", "init"].forEach((c) =>
    expect(isProtectedComm(c)).toBe(true),
  );
  ["node", "next-server", "uvicorn", "python3"].forEach((c) =>
    expect(isProtectedComm(c)).toBe(false),
  );
});

test("canKillGroup: only pgid>1, non-protected leader, leader cwd under project", () => {
  expect(canKillGroup(15371, `${ROOT}/learningPlatform`, "node", ROOT)).toBe(true);
  expect(canKillGroup(15371, null, "node", ROOT)).toBe(true); // leader gone → allow (pgid>1)
  expect(canKillGroup(1, `${ROOT}/x`, "node", ROOT)).toBe(false); // pgid<=1
  expect(canKillGroup(0, `${ROOT}/x`, "node", ROOT)).toBe(false);
  expect(canKillGroup(15371, "/home/u", "node", ROOT)).toBe(false); // cwd outside project
  expect(canKillGroup(15371, `${ROOT}/x`, "code", ROOT)).toBe(false); // protected comm
});

test("buildKillCmd: TERM / KILL to the negative pgid (whole group)", () => {
  expect(buildKillCmd(15371, false)).toBe("kill -TERM -15371");
  expect(buildKillCmd(15371, true)).toBe("kill -KILL -15371");
});

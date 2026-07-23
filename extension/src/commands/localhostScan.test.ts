import { expect, test } from "bun:test";

import {
  parseSsListeners,
  parsePsOutput,
  projectFromCwd,
  guessRole,
  groupListeners,
  type RawListener,
} from "./localhostScan";

const ROOT = "/home/u/github.com/owner/projects";

test("parseSsListeners: extracts port+pid for ipv4/ipv6, skips root-owned (no pid)", () => {
  const ss = [
    'LISTEN 0 2048  0.0.0.0:8000  0.0.0.0:*  users:(("python3",pid=15740,fd=3))',
    'LISTEN 0 511   127.0.0.1:3000 0.0.0.0:*  users:(("next-server",pid=15648,fd=21))',
    "LISTEN 0 4096  [::1]:6379    [::]:*",
    'LISTEN 0 128   [::]:3350     [::]:*      users:(("xrdp",pid=900,fd=11))',
  ].join("\n");
  expect(parseSsListeners(ss)).toEqual([
    { port: 8000, pid: 15740 },
    { port: 3000, pid: 15648 },
    { port: 3350, pid: 900 },
  ]);
});

test("parsePsOutput: parses pid/pgid/comm incl. a comm with a space", () => {
  const out = "15740 15371 python3\n15648 15371 next-server v1\n";
  const m = parsePsOutput(out);
  expect(m.get(15740)).toEqual({ pgid: 15371, comm: "python3" });
  expect(m.get(15648)).toEqual({ pgid: 15371, comm: "next-server v1" });
});

test("projectFromCwd: inside → name, outside/null → null", () => {
  expect(projectFromCwd(`${ROOT}/learningPlatform/apps/api`, ROOT)).toBe("learningPlatform");
  expect(projectFromCwd(`${ROOT}/shopApp`, ROOT)).toBe("shopApp");
  expect(projectFromCwd("/home/u", ROOT)).toBeNull();
  expect(projectFromCwd(null, ROOT)).toBeNull();
  expect(projectFromCwd(`${ROOT}`, ROOT)).toBeNull(); // root itself, no project segment
});

test("guessRole: api vs web fallback", () => {
  expect(guessRole("uvicorn", 8000)).toBe("api");
  expect(guessRole("next-server", 3000)).toBe("web");
  expect(guessRole("node", 5173)).toBe("web");
  expect(guessRole("something", 9999)).toBe("srv");
});

test("groupListeners: groups by project, sorts, drops unattributable", () => {
  const raws: RawListener[] = [
    { port: 8000, pid: 2, cwd: `${ROOT}/learningPlatform/apps/api`, pgid: 100, comm: "uvicorn" },
    { port: 3000, pid: 1, cwd: `${ROOT}/learningPlatform/apps/web`, pgid: 100, comm: "next-server" },
    { port: 5173, pid: 3, cwd: `${ROOT}/shopApp`, pgid: 200, comm: "node" },
    { port: 9, pid: 4, cwd: "/home/u", pgid: 300, comm: "code" }, // dropped
  ];
  const groups = groupListeners(raws, ROOT);
  expect(groups.map((g) => g.project)).toEqual(["learningPlatform", "shopApp"]);
  expect(groups[0].entries.map((e) => e.port)).toEqual([3000, 8000]); // sorted by port
  expect(groups[0].entries[0]).toEqual({ port: 3000, pid: 1, pgid: 100, comm: "next-server", role: "web" });
});

import { expect, test } from "bun:test";

import { buildResumeKickoff } from "./teams";
import {
  defaultTeamForProject,
  isResumable,
  parseOrchesMeta,
  type ResumableProject,
  serializeOrchesMeta,
  sortResumable,
} from "./orchestratorResume";

test("parseOrchesMeta: valid", () => {
  expect(parseOrchesMeta('{"team":"brew","lastRun":123}')).toEqual({
    team: "brew",
    lastRun: 123,
  });
});

test("parseOrchesMeta: bad JSON / wrong shape → null-ish", () => {
  expect(parseOrchesMeta("not json")).toBeNull();
  expect(parseOrchesMeta("[]")).toEqual({}); // object-ish array → no fields
  expect(parseOrchesMeta('{"team":42}')).toEqual({}); // wrong type dropped
  expect(parseOrchesMeta('{"team":"  "}')).toEqual({}); // blank trimmed away
});

test("serializeOrchesMeta round-trips", () => {
  const s = serializeOrchesMeta("carbon", 999);
  expect(parseOrchesMeta(s)).toEqual({ team: "carbon", lastRun: 999 });
  expect(s.endsWith("\n")).toBe(true);
});

test("isResumable: sprint docs OR open worktrees", () => {
  expect(isResumable({ sprintDocs: 0, openWorktrees: 0 })).toBe(false);
  expect(isResumable({ sprintDocs: 2, openWorktrees: 0 })).toBe(true);
  expect(isResumable({ sprintDocs: 0, openWorktrees: 1 })).toBe(true);
});

test("defaultTeamForProject: only when team exists in the list", () => {
  expect(defaultTeamForProject({ team: "brew" }, ["brew", "carbon"])).toBe("brew");
  expect(defaultTeamForProject({ team: "gone" }, ["brew"])).toBeNull();
  expect(defaultTeamForProject(null, ["brew"])).toBeNull();
});

test("sortResumable: recent lastRun first, then sprint count, then name", () => {
  const p = (name: string, lastRun?: number, sprintDocs = 0): ResumableProject => ({
    name,
    path: "/x/" + name,
    sprintDocs,
    openWorktrees: 0,
    lastRun,
  });
  const out = sortResumable([
    p("morse", 100, 1),
    p("expense", 200, 3),
    p("aaa", undefined, 5),
    p("bbb", undefined, 5),
  ]);
  expect(out.map((x) => x.name)).toEqual(["expense", "morse", "aaa", "bbb"]);
});

test("buildResumeKickoff: names project + tells it NOT to ask a new requirement", () => {
  const k = buildResumeKickoff(
    "expense-tracker",
    "/home/u/projects/expense-tracker",
    "brew",
    "foreman",
    ["bob", "jack"],
  );
  expect(k).toContain("expense-tracker");
  expect(k).toContain("/home/u/projects/expense-tracker");
  expect(k).toContain("RESUME");
  expect(k).toContain("อย่าถาม build requirement ใหม่");
  expect(k).toContain("foreman");
  expect(k).toContain("bob, jack");
});

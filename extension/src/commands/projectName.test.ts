import { expect, test } from "bun:test";
import {
  ORG, isValidName, sanitizeName, bumpBase, nextCandidate,
  checkProjectName, isNameFree, suggestDefaultName,
} from "./projectName";

test("ORG const", () => { expect(ORG).toBe("MyMissionControl"); });

test("isValidName", () => {
  expect(isValidName("agentskill-marketplace-v9")).toBe(true);
  expect(isValidName("a_b.c-1")).toBe(true);
  expect(isValidName("")).toBe(false);
  expect(isValidName("has space")).toBe(false);
  expect(isValidName("bad/slash")).toBe(false);
});

test("sanitizeName", () => {
  expect(sanitizeName("  My Project! ")).toBe("My-Project");
  expect(sanitizeName("a//b__c")).toBe("a-b__c");
});

test("bumpBase strips trailing -vN only", () => {
  expect(bumpBase("x-v8")).toBe("x");
  expect(bumpBase("x")).toBe("x");
  expect(bumpBase("a-v2-v3")).toBe("a-v2");
});

test("nextCandidate", () => {
  expect(nextCandidate("x", 1)).toBe("x");
  expect(nextCandidate("x", 2)).toBe("x-v2");
  expect(nextCandidate("x", 9)).toBe("x-v9");
});

test("checkProjectName: local taken", () => {
  const c = checkProjectName("rpn", ["rpn", "ttt"], () => false);
  expect(c).toEqual({ valid: true, localTaken: true, githubChecked: true, githubTaken: false });
});

test("checkProjectName: github taken", () => {
  const c = checkProjectName("foo", [], (n) => n === "foo");
  expect(c.githubTaken).toBe(true);
});

test("checkProjectName: gh unavailable → githubChecked=false", () => {
  const c = checkProjectName("foo", [], () => null);
  expect(c.githubChecked).toBe(false);
  expect(c.githubTaken).toBe(false);
});

test("checkProjectName: invalid name", () => {
  expect(checkProjectName("bad name", [], () => false).valid).toBe(false);
});

test("isNameFree", () => {
  expect(isNameFree({ valid: true, localTaken: false, githubChecked: true, githubTaken: false })).toBe(true);
  expect(isNameFree({ valid: true, localTaken: true, githubChecked: true, githubTaken: false })).toBe(false);
  expect(isNameFree({ valid: true, localTaken: false, githubChecked: true, githubTaken: true })).toBe(false);
  expect(isNameFree({ valid: true, localTaken: false, githubChecked: false, githubTaken: false })).toBe(true);
  expect(isNameFree({ valid: false, localTaken: false, githubChecked: false, githubTaken: false })).toBe(false);
});

test("suggestDefaultName: bump past taken in both sources", () => {
  const local = ["agentskill-marketplace", "agentskill-marketplace-v2"];
  const ghTaken = new Set(["agentskill-marketplace-v3"]);
  const name = suggestDefaultName(
    ["agentskill-marketplace-v2"], local, (n) => ghTaken.has(n),
  );
  expect(name).toBe("agentskill-marketplace-v4");
});

test("suggestDefaultName: no projects → my-project", () => {
  expect(suggestDefaultName([], [], () => false)).toBe("my-project");
});

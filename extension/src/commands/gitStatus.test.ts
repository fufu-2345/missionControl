import { expect, test } from "bun:test";

import { countDirty, parseGitButtonState, type GitRawStatus } from "./gitStatus";

const clean: GitRawStatus = {
  isRepo: true,
  porcelain: "",
  hasRemote: true,
  hasUpstream: true,
  ahead: 0,
  behind: 0,
};

test("countDirty ignores blank lines", () => {
  expect(countDirty("")).toBe(0);
  expect(countDirty(" M a.ts\n?? b.ts\n")).toBe(2);
  expect(countDirty("\n\n")).toBe(0);
});

test("dirty tree → Commit with count (wins over everything)", () => {
  const s = { ...clean, porcelain: " M a.ts\n?? b.ts\n M c.ts", ahead: 3 };
  const r = parseGitButtonState(s);
  expect(r.kind).toBe("commit");
  expect(r.label).toBe("Commit (3)");
  expect(r.dirtyCount).toBe(3);
});

test("clean + no remote → Create & Push", () => {
  const r = parseGitButtonState({ ...clean, hasRemote: false, hasUpstream: false });
  expect(r.kind).toBe("create-push");
  expect(r.label).toBe("Create & Push");
});

test("clean + remote but no upstream → Push", () => {
  const r = parseGitButtonState({ ...clean, hasUpstream: false });
  expect(r.kind).toBe("push");
  expect(r.label).toBe("Push");
});

test("clean + ahead of upstream → Push with count", () => {
  const r = parseGitButtonState({ ...clean, ahead: 4 });
  expect(r.kind).toBe("push");
  expect(r.label).toBe("Push (4)");
});

test("clean + in sync → up to date", () => {
  expect(parseGitButtonState(clean).kind).toBe("uptodate");
});

test("clean + behind only (no ahead) → Pull with count (safe fast-forward)", () => {
  const r = parseGitButtonState({ ...clean, behind: 2 });
  expect(r.kind).toBe("pull");
  expect(r.label).toBe("Pull (2)");
  expect(r.behind).toBe(2);
});

test("clean + diverged (behind AND ahead) → diverged info, not push/pull", () => {
  const r = parseGitButtonState({ ...clean, behind: 2, ahead: 1 });
  expect(r.kind).toBe("diverged");
  expect(r.label).toContain("diverged");
  expect(r.behind).toBe(2);
  expect(r.ahead).toBe(1);
});

test("dirty wins over behind (commit before pull)", () => {
  const r = parseGitButtonState({ ...clean, porcelain: " M a.ts", behind: 5 });
  expect(r.kind).toBe("commit");
});

test("not a repo → init (offer git init)", () => {
  const r = parseGitButtonState({ ...clean, isRepo: false });
  expect(r.kind).toBe("init");
  expect(r.label).toBe("Git init");
});

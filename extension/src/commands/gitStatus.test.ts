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

test("clean + behind only (no ahead) still reads up to date (pull out of scope)", () => {
  expect(parseGitButtonState({ ...clean, behind: 2 }).kind).toBe("uptodate");
});

test("not a repo → none", () => {
  expect(parseGitButtonState({ ...clean, isRepo: false }).kind).toBe("none");
});

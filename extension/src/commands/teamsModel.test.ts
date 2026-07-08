import { expect, test } from "bun:test";

import {
  createArgs,
  deleteArgs,
  diffMembers,
  findDuplicateOracleNames,
  inviteArgs,
  isSafeTeamName,
  mergeTeamStores,
  normalizeOracle,
  reconcileToolMembers,
  removeArgs,
  type TeamMember,
} from "./teamsModel";

test("isSafeTeamName whitelist", () => {
  expect(isSafeTeamName("brew")).toBe(true);
  expect(isSafeTeamName("orch-dev_2.0")).toBe(true);
  expect(isSafeTeamName("")).toBe(false);
  expect(isSafeTeamName("bad name")).toBe(false);
  expect(isSafeTeamName("evil;rm")).toBe(false);
  expect(isSafeTeamName("../escape")).toBe(false);
});

test("mergeTeamStores fills model/color from tool store, defaults role", () => {
  const merged = mergeTeamStores(
    [{ oracle: "bob", role: "member" }, { oracle: "foreman", role: "orchestrator" }, { oracle: "jack" }],
    [{ name: "bob", model: "claude", color: "blue" }],
  );
  expect(merged).toEqual([
    { oracle: "bob", role: "member", model: "claude", color: "blue" },
    { oracle: "foreman", role: "orchestrator", model: undefined, color: undefined },
    { oracle: "jack", role: "member", model: undefined, color: undefined }, // blank role → default
  ]);
});

test("mergeTeamStores appends tool-store-only members (divergent stores)", () => {
  // Oracle store {orches,dev1} but tool store {foreman,bob} — the stores diverged.
  // Every member from BOTH must survive so the divergence is visible/editable.
  const merged = mergeTeamStores(
    [{ oracle: "orches", role: "orchestrator" }, { oracle: "dev1", role: "builder" }],
    [{ name: "foreman", model: "claude-opus-4-8" }, { name: "bob", model: "claude-sonnet-5", color: "green" }],
  );
  expect(merged).toEqual([
    { oracle: "orches", role: "orchestrator", model: undefined, color: undefined },
    { oracle: "dev1", role: "builder", model: undefined, color: undefined },
    { oracle: "foreman", role: "member", model: "claude-opus-4-8", color: undefined },
    { oracle: "bob", role: "member", model: "claude-sonnet-5", color: "green" },
  ]);
});

test("inviteArgs / removeArgs / createArgs / deleteArgs", () => {
  expect(inviteArgs("bob", "brew", "builder")).toEqual([
    "team", "oracle-invite", "bob", "--team", "brew", "--role", "builder",
  ]);
  expect(inviteArgs("bob", "brew", "")).toEqual(["team", "oracle-invite", "bob", "--team", "brew"]);
  expect(removeArgs("bob", "brew")).toEqual(["team", "oracle-remove", "bob", "--team", "brew"]);
  expect(createArgs("x", "hi there")).toEqual(["team", "create", "x", "--description", "hi there"]);
  expect(createArgs("x", "  ")).toEqual(["team", "create", "x"]);
  expect(deleteArgs("x")).toEqual(["team", "delete", "x"]);
});

const M = (oracle: string, role: string, model?: string, color?: string): TeamMember => ({
  oracle, role, model, color,
});

test("diffMembers: add / remove / role change / config change", () => {
  const original = [M("bob", "member", "claude", "blue"), M("jack", "member"), M("old", "member")];
  const edited = [
    M("bob", "builder", "claude", "blue"), // role changed
    M("jack", "member", "claude", "green"), // config changed (color added)
    M("newbie", "orchestrator"), // added
    // "old" removed
  ];
  const d = diffMembers(original, edited);
  expect(d.added.map((m) => m.oracle)).toEqual(["newbie"]);
  expect(d.removed).toEqual(["old"]);
  expect(d.roleChanged.map((m) => m.oracle)).toEqual(["bob"]);
  expect(d.configChanged.map((m) => m.oracle)).toEqual(["jack"]);
});

test("diffMembers: no changes → all empty", () => {
  const same = [M("bob", "member", "claude", "blue")];
  const d = diffMembers(same, [M("bob", "member", "claude", "blue")]);
  expect(d.added).toEqual([]);
  expect(d.removed).toEqual([]);
  expect(d.roleChanged).toEqual([]);
  expect(d.configChanged).toEqual([]);
});

test("diffMembers: a member both role- and config-changed appears in both lists", () => {
  const d = diffMembers([M("bob", "member", "claude", "blue")], [M("bob", "builder", "claude", "red")]);
  expect(d.roleChanged.map((m) => m.oracle)).toEqual(["bob"]);
  expect(d.configChanged.map((m) => m.oracle)).toEqual(["bob"]);
});

test("reconcileToolMembers drops removed members (the delete-reappears bug)", () => {
  // config.json had jack; oracle-remove cleaned the maw store but not this one.
  // Reconcile MUST prune jack, or mergeTeamStores re-appends him after save.
  const existing = [
    { name: "foreman", model: "claude-opus-4-8" },
    { name: "bob", model: "claude-sonnet-5" },
    { name: "jack", model: "claude-sonnet-5" },
    { name: "john", model: "claude-sonnet-5" },
  ];
  const out = reconcileToolMembers(existing, { remove: ["jack"] });
  expect(out.map((m) => m.name)).toEqual(["foreman", "bob", "john"]);
});

test("reconcileToolMembers removes AND upserts in one pass", () => {
  const existing = [
    { name: "bob", model: "claude-sonnet-5" },
    { name: "jack", model: "claude-sonnet-5" },
  ];
  const out = reconcileToolMembers(existing, {
    remove: ["jack"],
    upsert: [M("bob", "member", "claude-opus-4-8", "green"), M("newbie", "member", "claude-haiku-4-5")],
  });
  expect(out).toEqual([
    { name: "bob", model: "claude-opus-4-8", color: "green" }, // updated in place
    { name: "newbie", model: "claude-haiku-4-5" }, // appended
  ]);
});

test("reconcileToolMembers preserves unknown keys and ignores a remove miss", () => {
  const existing = [{ name: "bob", model: "claude-sonnet-5", note: "keep me" }];
  const out = reconcileToolMembers(existing, { remove: ["ghost"], upsert: [M("bob", "member", undefined, "blue")] });
  expect(out).toEqual([{ name: "bob", model: "claude-sonnet-5", color: "blue", note: "keep me" }]);
});

test("reconcileToolMembers with no opts is a passthrough copy", () => {
  const existing = [{ name: "bob", model: "claude-sonnet-5" }];
  const out = reconcileToolMembers(existing, {});
  expect(out).toEqual(existing);
  expect(out).not.toBe(existing); // new array, not the same reference
});

test("normalizeOracle: trims and strips ONE trailing -oracle (matches sanitizeMembers)", () => {
  expect(normalizeOracle("jack")).toBe("jack");
  expect(normalizeOracle("  jack  ")).toBe("jack");
  expect(normalizeOracle("jack-oracle")).toBe("jack"); // maw bud would strip this too
  expect(normalizeOracle("  fusion-oracle  ")).toBe("fusion");
  expect(normalizeOracle("data-oracle-oracle")).toBe("data-oracle"); // only ONE suffix
  expect(normalizeOracle("-oracle")).toBe(""); // degenerate → empty
  expect(normalizeOracle("")).toBe("");
});

test("findDuplicateOracleNames: exact repeats", () => {
  expect(findDuplicateOracleNames(["foreman", "bob", "john", "jack", "jack"])).toEqual(["jack"]);
  expect(findDuplicateOracleNames(["jack", "jack", "jack"])).toEqual(["jack"]);
});

test("findDuplicateOracleNames: no duplicates → empty", () => {
  expect(findDuplicateOracleNames(["foreman", "bob", "john"])).toEqual([]);
});

test("findDuplicateOracleNames: normalizes before comparing (jack vs jack-oracle, whitespace)", () => {
  expect(findDuplicateOracleNames(["jack", "jack-oracle"])).toEqual(["jack"]);
  expect(findDuplicateOracleNames([" jack ", "jack"])).toEqual(["jack"]);
});

test("findDuplicateOracleNames: ignores empty/blank rows, case-sensitive, sorts groups", () => {
  expect(findDuplicateOracleNames(["", "  ", "a"])).toEqual([]); // blanks never a dup
  expect(findDuplicateOracleNames(["Bob", "bob"])).toEqual([]); // case-sensitive, like the fs registry
  expect(findDuplicateOracleNames(["b", "b", "a", "a"])).toEqual(["a", "b"]); // multiple groups, sorted
});

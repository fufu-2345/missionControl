import { expect, test } from "bun:test";

import {
  createArgs,
  deleteArgs,
  diffMembers,
  inviteArgs,
  isSafeTeamName,
  mergeTeamStores,
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

import { expect, test } from "bun:test";

import { parseTeamModels, serializeTeamModels, teamModelsFile } from "./teamModels";

test("parseTeamModels: oracle→model map, drops empty/non-string, tolerates bad JSON", () => {
  expect(parseTeamModels('{"foreman":"claude-sonnet-5","john":"claude-haiku-4-5"}')).toEqual({
    foreman: "claude-sonnet-5",
    john: "claude-haiku-4-5",
  });
  expect(parseTeamModels('{"a":"x","b":"","c":42,"d":null}')).toEqual({ a: "x" });
  expect(parseTeamModels("not json")).toEqual({});
  expect(parseTeamModels("[1,2,3]")).toEqual({}); // array, not a map
});

test("serializeTeamModels: prunes empty picks, round-trips through parse", () => {
  const s = serializeTeamModels({ foreman: "claude-sonnet-5", bob: "", jack: "claude-sonnet-5" });
  expect(parseTeamModels(s)).toEqual({ foreman: "claude-sonnet-5", jack: "claude-sonnet-5" });
});

test("teamModelsFile: sidecar sits beside config.json under the team dir", () => {
  expect(teamModelsFile("brew")).toMatch(/\/\.claude\/teams\/brew\/models\.json$/);
});

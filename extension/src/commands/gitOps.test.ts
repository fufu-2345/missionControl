import { expect, test } from "bun:test";

import { toGithubWebUrl } from "./gitOps";

test("toGithubWebUrl: ssh scp-like remote → https page", () => {
  expect(toGithubWebUrl("git@github.com:fufu-2345/agentskill-marketplace.git")).toBe(
    "https://github.com/fufu-2345/agentskill-marketplace",
  );
  expect(toGithubWebUrl("git@github.com:fufu-2345/agentskill-marketplace")).toBe(
    "https://github.com/fufu-2345/agentskill-marketplace",
  );
});

test("toGithubWebUrl: https remote → normalized page (strips .git, credentials, trailing slash)", () => {
  expect(toGithubWebUrl("https://github.com/fufu-2345/missionControl.git")).toBe(
    "https://github.com/fufu-2345/missionControl",
  );
  expect(toGithubWebUrl("https://github.com/fufu-2345/missionControl/")).toBe(
    "https://github.com/fufu-2345/missionControl",
  );
  expect(toGithubWebUrl("https://token@github.com/fufu-2345/missionControl.git")).toBe(
    "https://github.com/fufu-2345/missionControl",
  );
});

test("toGithubWebUrl: ssh:// url form", () => {
  expect(toGithubWebUrl("ssh://git@github.com/owner/repo.git")).toBe(
    "https://github.com/owner/repo",
  );
});

test("toGithubWebUrl: non-github or empty remote → null (button hidden)", () => {
  expect(toGithubWebUrl("git@gitlab.com:owner/repo.git")).toBeNull();
  expect(toGithubWebUrl("https://bitbucket.org/owner/repo.git")).toBeNull();
  expect(toGithubWebUrl("")).toBeNull();
  expect(toGithubWebUrl("   ")).toBeNull();
});

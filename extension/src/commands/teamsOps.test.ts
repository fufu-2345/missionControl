import { expect, test } from "bun:test";

import { firstLine } from "./teamsOps";
import { type RunResult } from "./gitOps";

const R = (stderr: string, stdout = "", ok = false): RunResult => ({ ok, stdout, stderr });

test("firstLine skips maw's stderr banner and returns the real error", () => {
  // What maw prints WITHOUT MAW_QUIET on a duplicate create — the real error is
  // line 3, behind the two-line plugin-loading banner.
  const r = R(
    [
      "loaded config: 0 triggers, 0 declared plugins, 0 peers",
      "loaded 122 plugins (122 symlink)",
      "team 'test' already exists at /home/u/ψ/memory/mailbox/teams/test",
    ].join("\n"),
  );
  expect(firstLine(r)).toBe("team 'test' already exists at /home/u/ψ/memory/mailbox/teams/test");
});

test("firstLine returns the sole error line when MAW_QUIET already suppressed the banner", () => {
  const r = R("team 'test' already exists at /home/u/ψ/memory/mailbox/teams/test");
  expect(firstLine(r)).toBe("team 'test' already exists at /home/u/ψ/memory/mailbox/teams/test");
});

test("firstLine falls back to stdout, then to 'failed'", () => {
  expect(firstLine(R("", "some stdout line\nsecond"))).toBe("some stdout line");
  expect(firstLine(R("", ""))).toBe("failed");
});

test("firstLine never returns an empty string even if only banner lines are present", () => {
  const r = R("loaded config: 0 triggers, 0 declared plugins, 0 peers\nloaded 122 plugins (122 symlink)");
  // No non-banner line exists → fall back to the first line rather than "".
  expect(firstLine(r)).toBe("loaded config: 0 triggers, 0 declared plugins, 0 peers");
});

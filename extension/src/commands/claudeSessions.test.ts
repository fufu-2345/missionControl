import { test, expect } from "bun:test";

import { buildClaudeTmuxCommand, projectSessionName } from "./claudeSessions";

test("projectSessionName prefixes claude- and keeps clean names", () => {
  expect(projectSessionName("ttt")).toBe("claude-ttt");
  expect(projectSessionName("agentskill-marketplace")).toBe("claude-agentskill-marketplace");
  expect(projectSessionName("agentskill-marketplace-v2")).toBe("claude-agentskill-marketplace-v2");
});

test("projectSessionName sanitizes spaces, symbols, and edge hyphens", () => {
  expect(projectSessionName("expense tracker!!")).toBe("claude-expense-tracker");
  expect(projectSessionName("  weird  ")).toBe("claude-weird");
  expect(projectSessionName("a/b:c")).toBe("claude-a-b-c");
  expect(projectSessionName("***")).toBe("claude-project"); // all stripped -> fallback
  expect(projectSessionName("")).toBe("claude-project");
});

test("projectSessionName output always passes the session-name whitelist", () => {
  for (const n of ["ttt", "expense tracker!!", "a/b:c", "***", "x".repeat(60)]) {
    expect(/^claude-[A-Za-z0-9._-]+$/.test(projectSessionName(n))).toBe(true);
  }
});

test("buildClaudeTmuxCommand quotes session and cwd", () => {
  expect(buildClaudeTmuxCommand("claude-ttt", "/home/u/projects/ttt")).toBe(
    "tmux new-session -A -s 'claude-ttt' -c '/home/u/projects/ttt' claude",
  );
});

test("buildClaudeTmuxCommand escapes single quotes in cwd (no shell break-out)", () => {
  expect(buildClaudeTmuxCommand("claude-x", "/tmp/o'neil")).toBe(
    "tmux new-session -A -s 'claude-x' -c '/tmp/o'\\''neil' claude",
  );
});

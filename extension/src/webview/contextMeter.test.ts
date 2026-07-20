import { test, expect } from "bun:test";

import {
  contextBucket,
  contextFillPercent,
  contextTokensFromUsage,
  encodeProjectDir,
  parseLastContextTokens,
  resolveAutoCompactWindow,
} from "./contextMeter";

test("encodeProjectDir turns / and . into -", () => {
  expect(encodeProjectDir("/home/u/Desktop/soulbrew")).toBe("-home-u-Desktop-soulbrew");
  expect(encodeProjectDir("/home/u/.claude/projects")).toBe("-home-u--claude-projects");
});

test("contextTokensFromUsage sums the input side, missing = 0", () => {
  expect(
    contextTokensFromUsage({ input_tokens: 100, cache_read_input_tokens: 5000, cache_creation_input_tokens: 200 }),
  ).toBe(5300);
  expect(contextTokensFromUsage({ input_tokens: 42 })).toBe(42);
  expect(contextTokensFromUsage(null)).toBe(0);
});

test("parseLastContextTokens returns the LAST usage line's input-side tokens", () => {
  const jsonl = [
    JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 10, cache_read_input_tokens: 1000 } } }),
    JSON.stringify({ type: "user", message: { content: "more" } }),
    JSON.stringify({
      type: "assistant",
      message: { usage: { input_tokens: 20, cache_read_input_tokens: 5000, cache_creation_input_tokens: 300 } },
    }),
    "",
  ].join("\n");
  expect(parseLastContextTokens(jsonl)).toBe(5320);
  expect(parseLastContextTokens("")).toBeNull();
  expect(parseLastContextTokens(JSON.stringify({ type: "user" }))).toBeNull();
});

test("resolveAutoCompactWindow: first numeric, most-specific first; else fallback", () => {
  expect(resolveAutoCompactWindow([{ autoCompactWindow: 300000 }, { autoCompactWindow: 700000 }], 200000)).toBe(300000);
  expect(resolveAutoCompactWindow([null, {}, { autoCompactWindow: 180000 }], 200000)).toBe(180000);
  expect(resolveAutoCompactWindow([null, {}], 200000)).toBe(200000);
  expect(resolveAutoCompactWindow([{ autoCompactWindow: 0 }], 200000)).toBe(200000);
});

test("contextFillPercent = tokens/window, clamped", () => {
  expect(contextFillPercent(350000, 700000)).toBe(50);
  expect(contextFillPercent(686000, 700000)).toBe(98);
  expect(contextFillPercent(900000, 700000)).toBe(100);
  expect(contextFillPercent(1000, 0)).toBe(0);
});

test("contextBucket: ok <75, warn 75–90, crit >90", () => {
  expect(contextBucket(0)).toBe("ok");
  expect(contextBucket(74)).toBe("ok");
  expect(contextBucket(75)).toBe("warn");
  expect(contextBucket(90)).toBe("warn");
  expect(contextBucket(91)).toBe("crit");
  expect(contextBucket(100)).toBe("crit");
});

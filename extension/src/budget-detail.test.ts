import { describe, expect, test } from "bun:test";

import { buildDetail, fmtBreakdownLine, fmtTokCompact, fmtUsd3 } from "./budget-detail";

describe("formatters", () => {
  test("fmtUsd3 trims trailing zeros, up to 3 dp", () => {
    expect(fmtUsd3(37.942)).toBe("37.942");
    expect(fmtUsd3(5.2)).toBe("5.2");
    expect(fmtUsd3(8.5)).toBe("8.5");
    expect(fmtUsd3(12)).toBe("12");
    expect(fmtUsd3(0)).toBe("0");
    expect(fmtUsd3(1.23456)).toBe("1.235"); // rounds to 3
  });
  test("fmtTokCompact", () => {
    expect(fmtTokCompact(2_100_000)).toBe("2.1M");
    expect(fmtTokCompact(950_000)).toBe("950K");
    expect(fmtTokCompact(0)).toBe("0");
  });
  test("fmtBreakdownLine", () => {
    expect(fmtBreakdownLine(2_100_000, 37.942)).toBe("2.1M (37.942 usd)");
  });
});

describe("buildDetail", () => {
  const bd = {
    inTok: 2_100_000, outTok: 1_200_000, cacheReadTok: 128_000_000, cacheWriteTok: 6_800_000,
    inCost: 2.32, outCost: 5.2, cacheReadCost: 38.4, cacheWriteCost: 8.5,
  };
  test("slices sorted by cost desc; parts sum to total; format", () => {
    const d = buildDetail(bd);
    expect(d.hasCost).toBe(true);
    expect(d.slices.map((s) => s.key)).toEqual(["cacheRead", "cacheWrite", "output", "input"]);
    const sum = d.slices.reduce((a, s) => a + s.cost, 0);
    expect(sum).toBeCloseTo(54.42, 6);
    expect(Math.round(d.slices.reduce((a, s) => a + s.pct, 0))).toBe(100);
    expect(d.slices[0].text).toBe("128M (38.4 usd)");
    expect(d.totalText).toBe(fmtBreakdownLine(138_100_000, 54.42));
    // every slice carries a non-empty color + Thai meaning for the tooltip
    expect(d.slices.every((s) => s.color.length > 0 && s.meaning.length > 0)).toBe(true);
  });
  test("all-zero -> hasCost false, pct 0", () => {
    const z = buildDetail({
      inTok: 0, outTok: 0, cacheReadTok: 0, cacheWriteTok: 0,
      inCost: 0, outCost: 0, cacheReadCost: 0, cacheWriteCost: 0,
    });
    expect(z.hasCost).toBe(false);
    expect(z.slices.every((s) => s.pct === 0)).toBe(true);
  });
});

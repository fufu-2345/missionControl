import { describe, expect, test } from "bun:test";

import { addBreakdown, emptyBreakdown, priceLine } from "./usage";

describe("priceLine", () => {
  test("opus split + cost (no 5m/1h)", () => {
    const r = priceLine("claude-opus-4-8", {
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_input_tokens: 10000,
      cache_creation_input_tokens: 2000,
    })!;
    expect(r).not.toBeNull();
    expect(r.bd.inTok).toBe(1000);
    expect(r.bd.cacheWriteTok).toBe(2000);
    expect(r.bd.inCost).toBeCloseTo(0.005, 9);
    expect(r.bd.outCost).toBeCloseTo(0.0125, 9);
    expect(r.bd.cacheReadCost).toBeCloseTo(0.005, 9);
    expect(r.bd.cacheWriteCost).toBeCloseTo(0.0125, 9);
    expect(r.cost).toBeCloseTo(0.035, 9);
    expect(r.tokens).toBe(13500);
    // invariant: parts sum to whole
    expect(r.bd.inCost + r.bd.outCost + r.bd.cacheReadCost + r.bd.cacheWriteCost).toBeCloseTo(r.cost, 9);
  });

  test("uses 5m/1h split when present (ccTot still = cacheWriteTok)", () => {
    const r = priceLine("claude-opus-4-8", {
      cache_creation_input_tokens: 3000,
      cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 },
    })!;
    expect(r.bd.cacheWriteCost).toBeCloseTo(1000 * 6.25e-6 + 2000 * 10e-6, 9); // 0.02625
    expect(r.bd.cacheWriteTok).toBe(3000);
  });

  test("synthetic model -> null", () => {
    expect(priceLine("<synthetic>", { input_tokens: 5 })).toBeNull();
  });
});

describe("Breakdown helpers", () => {
  test("empty is zeros; add is field-wise", () => {
    const e = emptyBreakdown();
    expect(e.inTok).toBe(0);
    expect(e.cacheWriteCost).toBe(0);
    const a = {
      inTok: 1, outTok: 2, cacheReadTok: 3, cacheWriteTok: 4,
      inCost: 5, outCost: 6, cacheReadCost: 7, cacheWriteCost: 8,
    };
    const s = addBreakdown(a, a);
    expect(s.inTok).toBe(2);
    expect(s.cacheWriteCost).toBe(16);
  });
});

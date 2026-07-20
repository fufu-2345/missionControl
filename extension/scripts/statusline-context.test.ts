import { test, expect } from "bun:test";

import { contextPct, fillHue, hslToRgb, renderBar } from "./statusline-context.mjs";

test("contextPct = tokens/window, clamped 0..100", () => {
  expect(contextPct(350000, 700000)).toBe(50);
  expect(contextPct(686000, 700000)).toBe(98);
  expect(contextPct(900000, 700000)).toBe(100); // clamp
  expect(contextPct(0, 700000)).toBe(0);
  expect(contextPct(1000, 0)).toBe(0); // unknown window
});

test("fillHue fades green→red, non-increasing, honoring the zones", () => {
  expect(fillHue(0)).toBe(130);
  expect(fillHue(100)).toBe(0);
  expect(fillHue(75)).toBe(80);
  expect(fillHue(90)).toBe(40);
  let prev = 999;
  for (let p = 0; p <= 100; p += 5) {
    const h = fillHue(p);
    expect(h).toBeLessThanOrEqual(prev);
    prev = h;
  }
});

test("hslToRgb: low fill is green-dominant, high fill is red-dominant", () => {
  const green = hslToRgb(fillHue(10), 0.7, 0.55); // hue ~123
  expect(green.g).toBeGreaterThan(green.r);
  expect(green.g).toBeGreaterThan(green.b);
  const red = hslToRgb(fillHue(100), 0.7, 0.55); // hue 0
  expect(red.r).toBeGreaterThan(red.g);
  expect(red.r).toBeGreaterThan(red.b);
});

test("renderBar draws a block bar, the %, and truecolor ANSI", () => {
  const s = renderBar(60);
  expect(s).toContain("ctx [");
  expect(s).toContain("60%");
  expect(s).toContain("\x1b[38;2;"); // truecolor foreground
  expect(s).toContain("\x1b[0m"); // reset
  // 60% of a 10-cell bar = 6 filled, 4 empty
  expect((s.match(/█/g) || []).length).toBe(6);
  expect((s.match(/░/g) || []).length).toBe(4);
  // no color emoji used
  expect(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(s)).toBe(false);
});

test("renderBar clamps the bar cells at the ends", () => {
  expect((renderBar(0).match(/█/g) || []).length).toBe(0);
  expect((renderBar(100).match(/█/g) || []).length).toBe(10);
});

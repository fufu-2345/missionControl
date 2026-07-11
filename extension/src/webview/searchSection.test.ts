import { describe, expect, test } from "bun:test";
import {
  docsFromStats,
  indexFromStatus,
  searchSectionBody,
  searchSectionScript,
  searchSectionStyle,
} from "./searchSection";

describe("asset strings", () => {
  test("body has the container the script renders into", () => {
    expect(searchSectionBody()).toContain('id="search-oracle"');
  });

  test("style is non-empty CSS", () => {
    expect(searchSectionStyle()).toContain(".so-");
  });

  test("client script is FREE of backtick and backslash (webview foot-gun)", () => {
    const s = searchSectionScript();
    expect(s.includes("`")).toBe(false);
    expect(s.includes("\\")).toBe(false);
    expect(s).toContain("searchState"); // listens for the host push
  });
});

describe("docsFromStats", () => {
  test("sums count fields defensively", () => {
    expect(docsFromStats({ "bge-m3": { count: 300 }, nomic: { count: 182 } })).toBe(482);
    expect(docsFromStats(null)).toBe(0);
    expect(docsFromStats({ models: [{ count: 5 }, { count: 7 }] })).toBe(12);
  });
});

describe("indexFromStatus", () => {
  test("defaults to idle on null", () => {
    expect(indexFromStatus(null).status).toBe("idle");
  });
  test("passes through indexing fields", () => {
    const i = indexFromStatus({ status: "indexing", current: 10, total: 100, eta: 42 });
    expect(i.status).toBe("indexing");
    expect(i.current).toBe(10);
    expect(i.total).toBe(100);
    expect(i.eta).toBe(42);
  });
});

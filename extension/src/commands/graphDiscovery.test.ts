import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { findGraphHtml, graphifyBaseDir } from "./graphDiscovery";

describe("findGraphHtml", () => {
  let base: string;
  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "mc-graph-"));
  });
  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  function seedGraph(repo: string): void {
    const dir = path.join(base, repo);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "graph.html"), "<html></html>");
  }

  test("one entry per repo dir that has graph.html, sorted by repo", () => {
    seedGraph("zed-repo");
    seedGraph("arra-oracle-v3");
    const got = findGraphHtml(base);
    expect(got.map((g) => g.repo)).toEqual(["arra-oracle-v3", "zed-repo"]);
    expect(got[0].htmlPath).toBe(
      path.join(base, "arra-oracle-v3", "graph.html"),
    );
  });

  test("skips subdirs without graph.html", () => {
    seedGraph("has-graph");
    fs.mkdirSync(path.join(base, "no-graph"), { recursive: true });
    expect(findGraphHtml(base).map((g) => g.repo)).toEqual(["has-graph"]);
  });

  test("returns [] when base dir does not exist", () => {
    expect(findGraphHtml(path.join(base, "nope"))).toEqual([]);
  });

  test("returns [] when base dir is empty", () => {
    expect(findGraphHtml(base)).toEqual([]);
  });
});

describe("graphifyBaseDir", () => {
  test("points at ~/.oracle/graphify", () => {
    expect(graphifyBaseDir().endsWith(path.join(".oracle", "graphify"))).toBe(
      true,
    );
  });
});

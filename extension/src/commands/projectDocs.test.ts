import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  listProjectDocs,
  renderMarkdown,
  resolveDocPath,
  sanitizeHtml,
} from "./projectDocs";

function tmpProject(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mc-docs-"));
  fs.mkdirSync(path.join(base, "docs", "wiki", "decisions"), { recursive: true });
  return base;
}

test("listProjectDocs: wiki priority order then alpha, plan, sprints numeric", () => {
  const p = tmpProject();
  const w = path.join(p, "docs", "wiki");
  for (const f of ["overview.md", "architecture.md", "setup.md", "README.md", "zeta.md"])
    fs.writeFileSync(path.join(w, f), "# " + f);
  fs.writeFileSync(path.join(w, "decisions", "0001-db.md"), "# d");
  fs.writeFileSync(path.join(p, "docs", "plan.md"), "# plan");
  // sprint docs: <basename>-sprint-N.md AND legacy sprint-N.md, out of order
  fs.writeFileSync(path.join(p, "docs", path.basename(p) + "-sprint-10.md"), "s10");
  fs.writeFileSync(path.join(p, "docs", path.basename(p) + "-sprint-2.md"), "s2");
  fs.writeFileSync(path.join(p, "docs", "sprint-1.md"), "s1");

  const d = listProjectDocs(p);
  expect(d.wiki.map((x) => x.label)).toEqual([
    "README", "overview", "architecture", "setup", "zeta", "decisions/0001-db",
  ]);
  expect(d.wiki[0].rel).toBe("docs/wiki/README.md");
  expect(d.plan?.rel).toBe("docs/plan.md");
  expect(d.sprints.map((x) => x.rel)).toEqual([
    "docs/sprint-1.md",
    "docs/" + path.basename(p) + "-sprint-2.md",
    "docs/" + path.basename(p) + "-sprint-10.md",
  ]);
});

test("listProjectDocs: missing docs dir yields empty groups, no throw", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mc-docs-empty-"));
  const d = listProjectDocs(base);
  expect(d.wiki).toEqual([]);
  expect(d.plan).toBeNull();
  expect(d.sprints).toEqual([]);
});

test("resolveDocPath: accepts a real file under docs/, rejects traversal + missing", () => {
  const p = tmpProject();
  fs.writeFileSync(path.join(p, "docs", "plan.md"), "# plan");
  fs.writeFileSync(path.join(p, "secret.txt"), "nope");
  expect(resolveDocPath(p, "docs/plan.md")).toBe(path.join(p, "docs", "plan.md"));
  expect(resolveDocPath(p, "../secret.txt")).toBeNull();
  expect(resolveDocPath(p, "docs/../secret.txt")).toBeNull();
  expect(resolveDocPath(p, "docs/nope.md")).toBeNull();
});

test("renderMarkdown: headings, lists, and inline code become HTML", () => {
  const html = renderMarkdown("# Title\n\n- one\n- two\n\n`code`");
  expect(html).toContain("<h1");
  expect(html).toContain("<li>one</li>");
  expect(html).toContain("<code>code</code>");
});

test("sanitizeHtml: strips <script>, on* handlers, and javascript: hrefs", () => {
  const dirty =
    '<p onclick="steal()">x</p><script>evil()</script>' +
    '<a href="javascript:alert(1)">l</a><iframe src="http://x"></iframe>';
  const clean = sanitizeHtml(dirty);
  expect(clean).not.toContain("<script");
  expect(clean).not.toContain("onclick");
  expect(clean).not.toContain("javascript:");
  expect(clean).not.toContain("<iframe");
});

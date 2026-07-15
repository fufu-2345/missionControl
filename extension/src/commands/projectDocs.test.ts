import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  listProjectDocs,
  listProjectTree,
  renderMarkdown,
  resolveDocPath,
  resolveProjectFile,
  sanitizeHtml,
  type TreeNode,
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

function names(nodes: TreeNode[]): string[] {
  return nodes.map((n) => (n.kind === "dir" ? n.name + "/" : n.name));
}

test("listProjectTree: dirs first then files (alpha), .md-only, empty branches pruned", () => {
  const p = tmpProject(); // makes docs/wiki/decisions
  fs.writeFileSync(path.join(p, "README.md"), "# r");
  fs.writeFileSync(path.join(p, "notes.txt"), "not markdown"); // non-.md → excluded
  fs.writeFileSync(path.join(p, "docs", "plan.md"), "# plan");
  fs.writeFileSync(path.join(p, "docs", "wiki", "overview.md"), "# o");
  fs.writeFileSync(path.join(p, "docs", "wiki", "decisions", "0001.md"), "# d");
  fs.mkdirSync(path.join(p, "empty-dir"), { recursive: true }); // no .md → pruned
  fs.mkdirSync(path.join(p, "src"), { recursive: true });
  fs.writeFileSync(path.join(p, "src", "index.ts"), "code"); // dir with no .md → pruned
  fs.mkdirSync(path.join(p, "node_modules", "x"), { recursive: true });
  fs.writeFileSync(path.join(p, "node_modules", "x", "readme.md"), "# ignored"); // ignored dir
  fs.mkdirSync(path.join(p, "agents", "1-bob"), { recursive: true });
  fs.writeFileSync(path.join(p, "agents", "1-bob", "README.md"), "# worktree"); // orches worktree → ignored
  fs.mkdirSync(path.join(p, ".git"), { recursive: true });
  fs.writeFileSync(path.join(p, ".git", "config.md"), "# ignored"); // dot-dir → skipped

  const t = listProjectTree(p);
  // top level: docs/ (dir) before README.md (file); node_modules/.git/src/empty-dir all gone
  expect(names(t)).toEqual(["docs/", "README.md"]);
  const docs = t.find((n) => n.name === "docs")!;
  expect(docs.rel).toBe("docs");
  // inside docs: wiki/ (dir) before plan.md (file)
  expect(names(docs.children!)).toEqual(["wiki/", "plan.md"]);
  const wiki = docs.children!.find((n) => n.name === "wiki")!;
  // wiki keeps decisions/ (has a .md) then overview.md; a file carries its full rel
  expect(names(wiki.children!)).toEqual(["decisions/", "overview.md"]);
  const ov = wiki.children!.find((n) => n.name === "overview.md")!;
  expect(ov.rel).toBe("docs/wiki/overview.md");
});

test("listProjectTree: missing project dir yields empty array, no throw", () => {
  expect(listProjectTree(path.join(os.tmpdir(), "mc-no-such-" + process.pid))).toEqual([]);
});

test("resolveProjectFile: accepts any .md under project, rejects traversal, non-md, missing", () => {
  const p = tmpProject();
  fs.writeFileSync(path.join(p, "README.md"), "# r");
  fs.writeFileSync(path.join(p, "docs", "plan.md"), "# plan");
  fs.writeFileSync(path.join(p, "secret.txt"), "nope");
  expect(resolveProjectFile(p, "README.md")).toBe(path.join(p, "README.md"));
  expect(resolveProjectFile(p, "docs/plan.md")).toBe(path.join(p, "docs", "plan.md"));
  expect(resolveProjectFile(p, "../secret.txt")).toBeNull(); // escapes project
  expect(resolveProjectFile(p, "secret.txt")).toBeNull(); // not .md
  expect(resolveProjectFile(p, "docs/nope.md")).toBeNull(); // missing
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

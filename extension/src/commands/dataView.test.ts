import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { buildProjectRow, parseFrontmatter, parseSprintDoc } from "./dataView";

function tmpProject(name = "proj"): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mc-dv-"));
  const p = path.join(base, name);
  fs.mkdirSync(path.join(p, "docs"), { recursive: true });
  return p;
}
function writeDoc(p: string, rel: string, body: string) {
  const abs = path.join(p, "docs", rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
}

// ---- parseFrontmatter ----

test("parseFrontmatter: none → empty", () => {
  expect(parseFrontmatter("# แผน build\n\n- [x] Sprint 1")).toEqual({});
});
test("parseFrontmatter: category + inline tags", () => {
  const raw = "---\ncategory: marketplace\ntags: [nextjs, prisma]\n---\n# plan";
  expect(parseFrontmatter(raw)).toEqual({ category: "marketplace", tags: ["nextjs", "prisma"] });
});
test("parseFrontmatter: quoted + comma list without brackets", () => {
  const raw = `---\ncategory: "web app"\ntags: a, b ,c\n---\n`;
  expect(parseFrontmatter(raw)).toEqual({ category: "web app", tags: ["a", "b", "c"] });
});

// ---- parseSprintDoc ----

test("parseSprintDoc: heading, date, done status", () => {
  const raw = "# Sprint 3 — Browse\n_2026-07-16 · สถานะ: เสร็จครบ_\n";
  expect(parseSprintDoc("proj-sprint-3.md", raw)).toMatchObject({
    n: 3,
    name: "Browse",
    date: "2026-07-16",
    done: true,
  });
});
test("parseSprintDoc: not-done status", () => {
  const raw = "# Sprint 4 — Timeline\n_2026-07-18 · สถานะ: ยังไม่เสร็จ_\n";
  expect(parseSprintDoc("sprint-4.md", raw)?.done).toBe(false);
});
test("parseSprintDoc: legacy format (no status line) counts as done", () => {
  // older orches docs had no `สถานะ:` line, just a merged-commit marker
  const raw = "# Sprint 1 — backend-core\n**merged:** `cd6252e`\n## Built\n- doing stuff";
  expect(parseSprintDoc("sprint-1.md", raw)?.done).toBe(true);
});
test("parseSprintDoc: non-sprint filename → null", () => {
  expect(parseSprintDoc("plan.md", "x")).toBeNull();
});

// ---- buildProjectRow ----

test("buildProjectRow: plan.md checklist drives total/done + in-progress", () => {
  const p = tmpProject("agentskill-v10");
  writeDoc(p, "plan.md", "# แผน\n\n- [x] Sprint 1\n- [x] Sprint 2\n- [ ] Sprint 3\n");
  writeDoc(p, "agentskill-v10-sprint-1.md", "# Sprint 1 — Foundation\n_2026-07-15 · สถานะ: เสร็จครบ_");
  writeDoc(p, "agentskill-v10-sprint-2.md", "# Sprint 2 — Upload\n_2026-07-16 · สถานะ: เสร็จครบ_");
  const row = buildProjectRow(p)!;
  expect(row.name).toBe("agentskill-v10");
  expect(row.category).toBe("uncategorized");
  expect(row.sprintsTotal).toBe(3);
  expect(row.sprintsDone).toBe(2);
  expect(row.percentDone).toBe(67);
  expect(row.status).toBe("in-progress");
  expect(row.latestSprint).toMatchObject({ n: 2, name: "Upload", date: "2026-07-16" });
  expect(row.updated).toBe("2026-07-16");
  expect(row.githubUrl).toBeNull();
});

test("buildProjectRow: no plan.md → fallback to sprint docs + done", () => {
  const p = tmpProject("lumen");
  writeDoc(p, "sprint-1.md", "# Sprint 1 — Core\n_2026-07-10 · สถานะ: เสร็จครบ_");
  writeDoc(p, "sprint-2.md", "# Sprint 2 — API\n_2026-07-12 · สถานะ: เสร็จครบ_");
  const row = buildProjectRow(p)!;
  expect(row.sprintsTotal).toBe(2);
  expect(row.sprintsDone).toBe(2);
  expect(row.status).toBe("done");
  expect(row.percentDone).toBe(100);
});

test("buildProjectRow: frontmatter category/tags picked up", () => {
  const p = tmpProject("shop");
  writeDoc(p, "plan.md", "---\ncategory: marketplace\ntags: [nextjs]\n---\n# แผน\n- [ ] Sprint 1\n");
  const row = buildProjectRow(p)!;
  expect(row.category).toBe("marketplace");
  expect(row.tags).toEqual(["nextjs"]);
  expect(row.status).toBe("not-started");
  expect(row.sprintsDone).toBe(0);
});

test("buildProjectRow: no docs/ dir → null", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mc-dv-empty-"));
  expect(buildProjectRow(base)).toBeNull();
});

// ---- backup merge ----

import { buildDataIndex, loadBackupRows } from "./dataView";
import { snapshotProjectDocs } from "./docsBackup";
import { afterEach, beforeEach } from "bun:test";

let bkpRoot: string;
beforeEach(() => {
  bkpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mc-dv-bkp-"));
  process.env.MC_DOCS_BACKUP_DIR = bkpRoot;
});
afterEach(() => {
  delete process.env.MC_DOCS_BACKUP_DIR;
  fs.rmSync(bkpRoot, { recursive: true, force: true });
});

test("loadBackupRows: backed-up project → tagged deleted row pointing at the backup", () => {
  const p = tmpProject("gone");
  writeDoc(p, "plan.md", "# แผน\n- [x] Sprint 1\n- [ ] Sprint 2\n");
  writeDoc(p, "gone-sprint-1.md", "# Sprint 1 — Core\n_2026-07-10 · สถานะ: เสร็จครบ_");
  snapshotProjectDocs(p, "2026-07-20T00:00:00.000Z");

  const rows = loadBackupRows();
  expect(rows).toHaveLength(1);
  expect(rows[0].name).toBe("gone");
  expect(rows[0].deleted).toBe(true);
  expect(rows[0].deletedAt).toBe("2026-07-20T00:00:00.000Z");
  expect(rows[0].path).toBe(path.join(bkpRoot, "gone"));
  expect(rows[0].githubUrl).toBeNull();
  expect(rows[0].sprintsTotal).toBe(2); // parsed from the backed-up plan.md
});

test("buildDataIndex: merges deleted projects, skips names still live", async () => {
  // an owner root with one LIVE project named 'live1'
  const owner = fs.mkdtempSync(path.join(os.tmpdir(), "mc-owner-"));
  const projects = path.join(owner, "projects");
  const live1 = path.join(projects, "live1");
  fs.mkdirSync(path.join(live1, "docs"), { recursive: true });
  fs.writeFileSync(path.join(live1, "docs", "plan.md"), "# แผน\n- [ ] Sprint 1\n");

  // back up 'gone1' (not live) AND 'live1' (still live → must be skipped)
  const goneSrc = tmpProject("gone1");
  writeDoc(goneSrc, "plan.md", "# แผน\n- [x] Sprint 1\n");
  snapshotProjectDocs(goneSrc, "2026-07-19T00:00:00.000Z");
  snapshotProjectDocs(live1, "2026-07-18T00:00:00.000Z");

  const rows = await buildDataIndex(owner);
  const byName = (n: string) => rows.filter((r) => r.name === n);
  expect(byName("live1")).toHaveLength(1); // not duplicated by its backup
  expect(byName("live1")[0].deleted).toBeUndefined();
  expect(byName("gone1")).toHaveLength(1);
  expect(byName("gone1")[0].deleted).toBe(true);

  fs.rmSync(owner, { recursive: true, force: true });
});

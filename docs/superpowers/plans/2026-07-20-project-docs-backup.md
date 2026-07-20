# Project docs backup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Before a project is deleted via the Orchestrator screen, snapshot its `README.md` + `docs/` to a durable cache; surface deleted projects (read-only) in Data View's timeline and in a toggled "deleted projects" view in the Orchestrator.

**Architecture:** A new vscode-free module `docsBackup.ts` mirrors the project's docs into `~/.cache/mission-control/docs-backup/<name>/` and records a name-keyed manifest, following the durable-ledger pattern in `usage.ts`. `removeProjectDir` calls it before `fs.rmSync` and refuses to delete if the snapshot throws. Because the backup is real files on disk, the existing readers (`buildProjectRow`, `listDetailDocs`, `resolveProjectFile`, `renderMarkdown`) work against a backup folder unchanged — Data View and Project Detail just get pointed at `backupDir`.

**Tech Stack:** TypeScript (VS Code extension, CommonJS out), `bun test` for vscode-free modules, `marked@^4`, Node `fs.cpSync` (Node ≥18).

## Global Constraints

- **Tested modules must not import `vscode`.** `docsBackup.ts`, `deleteProject.ts`, `commands/dataView.ts` stay vscode-free so `bun test` can load them. Webview files (`webview/*.ts`) import `vscode` and are therefore compile-verified (`tsc`), not bun-tested — matching the existing codebase.
- **Backup root is env-overridable for tests:** `process.env.MC_DOCS_BACKUP_DIR || path.join(os.homedir(), ".cache", "mission-control", "docs-backup")`. Tests set the env var to a tmpdir; never write to real `$HOME` in a test.
- **Manifest shape mirrors the Budget ledger** (`usage.ts:305-336`): `{ v: 1, entries: Record<name, BackupEntry> }`, keyed by project **name** (unique per GitHub repo — see spec).
- **No emoji as a meaning-carrier in any user-visible string** (the user's terminal renders emoji as blank). Use plain Thai text labels; existing decorative emoji in the file may stay but new state must read in text.
- **UI copy is Thai**, matching the surrounding webview.
- **Node ≥18** — `fs.cpSync(src, dest, { recursive: true })` is available and is the copy primitive.
- Run tests from the extension dir: `cd /home/chillox-intern/Desktop/soulbrew/github.com/fufu-2345/missionControl/extension`.
- Compile check: `cd .../missionControl/extension && npx tsc -p ./ --noEmit` (expected: no output, exit 0).

---

### Task 1: `docsBackup.ts` core module (snapshot + manifest)

**Files:**
- Create: `extension/src/commands/docsBackup.ts`
- Test: `extension/src/commands/docsBackup.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module; `node:fs`, `node:os`, `node:path` only).
- Produces:
  - `interface BackupEntry { name: string; backupDir: string; deletedAt: string }`
  - `snapshotProjectDocs(projectPath: string, deletedAt?: string): void` — throws on any fs failure.
  - `listBackedUpProjects(): BackupEntry[]`

- [ ] **Step 1: Write the failing test**

Create `extension/src/commands/docsBackup.test.ts`:

```ts
import { expect, test, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { snapshotProjectDocs, listBackedUpProjects } from "./docsBackup";

let backupRoot: string;
let srcBase: string;

beforeEach(() => {
  backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mc-bkp-root-"));
  srcBase = fs.mkdtempSync(path.join(os.tmpdir(), "mc-bkp-src-"));
  process.env.MC_DOCS_BACKUP_DIR = backupRoot;
});
afterEach(() => {
  delete process.env.MC_DOCS_BACKUP_DIR;
  fs.rmSync(backupRoot, { recursive: true, force: true });
  fs.rmSync(srcBase, { recursive: true, force: true });
});

function makeProject(name: string): string {
  const p = path.join(srcBase, name);
  fs.mkdirSync(path.join(p, "docs", "wiki"), { recursive: true });
  fs.writeFileSync(path.join(p, "README.md"), "# " + name);
  fs.writeFileSync(path.join(p, "docs", "plan.md"), "# แผน\n- [x] Sprint 1\n");
  fs.writeFileSync(path.join(p, "docs", "wiki", "overview.md"), "overview");
  return p;
}

test("snapshotProjectDocs: copies README + full docs tree + writes manifest", () => {
  const p = makeProject("foo");
  snapshotProjectDocs(p, "2026-07-20T00:00:00.000Z");

  const dest = path.join(backupRoot, "foo");
  expect(fs.readFileSync(path.join(dest, "README.md"), "utf8")).toBe("# foo");
  expect(fs.existsSync(path.join(dest, "docs", "plan.md"))).toBe(true);
  expect(fs.readFileSync(path.join(dest, "docs", "wiki", "overview.md"), "utf8")).toBe("overview");

  const list = listBackedUpProjects();
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({ name: "foo", backupDir: dest, deletedAt: "2026-07-20T00:00:00.000Z" });
});

test("snapshotProjectDocs: same name overwrites the older backup", () => {
  const p1 = makeProject("dup");
  snapshotProjectDocs(p1, "2026-07-01T00:00:00.000Z");
  // second project, same name, different content
  fs.rmSync(path.join(srcBase, "dup"), { recursive: true, force: true });
  const p2 = path.join(srcBase, "dup");
  fs.mkdirSync(path.join(p2, "docs"), { recursive: true });
  fs.writeFileSync(path.join(p2, "docs", "plan.md"), "NEW");
  snapshotProjectDocs(p2, "2026-07-20T00:00:00.000Z");

  expect(fs.readFileSync(path.join(backupRoot, "dup", "docs", "plan.md"), "utf8")).toBe("NEW");
  expect(fs.existsSync(path.join(backupRoot, "dup", "README.md"))).toBe(false); // p2 had none → clean overwrite
  const list = listBackedUpProjects();
  expect(list).toHaveLength(1);
  expect(list[0].deletedAt).toBe("2026-07-20T00:00:00.000Z");
});

test("snapshotProjectDocs: project with no docs/ and no README → empty backup, still recorded", () => {
  const p = path.join(srcBase, "bare");
  fs.mkdirSync(p, { recursive: true });
  snapshotProjectDocs(p, "2026-07-20T00:00:00.000Z");
  expect(fs.existsSync(path.join(backupRoot, "bare"))).toBe(true);
  expect(listBackedUpProjects().map((e) => e.name)).toEqual(["bare"]);
});

test("listBackedUpProjects: no manifest → empty array", () => {
  expect(listBackedUpProjects()).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd .../missionControl/extension && bun test src/commands/docsBackup.test.ts`
Expected: FAIL — `Cannot find module "./docsBackup"`.

- [ ] **Step 3: Write minimal implementation**

Create `extension/src/commands/docsBackup.ts`:

```ts
// Durable snapshot of a project's docs, taken right before the project is
// deleted (deleteProject.ts). Mirrors the Budget ledger pattern (usage.ts):
// a name-keyed manifest under ~/.cache/mission-control/, surviving the delete.
// NO vscode import — unit-tested standalone with `bun test`.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const MANIFEST_VERSION = 1;

export interface BackupEntry {
  name: string; // project name — manifest key and backup folder name
  backupDir: string; // absolute path to the backup folder
  deletedAt: string; // ISO date the snapshot was taken
}

/** Root of the backup area. Overridable via MC_DOCS_BACKUP_DIR (tests). */
function backupRoot(): string {
  return (
    process.env.MC_DOCS_BACKUP_DIR ||
    path.join(os.homedir(), ".cache", "mission-control", "docs-backup")
  );
}
function manifestPath(): string {
  return path.join(backupRoot(), "manifest.json");
}

function readManifest(): Record<string, BackupEntry> {
  try {
    const obj = JSON.parse(fs.readFileSync(manifestPath(), "utf8")) as {
      v?: number;
      entries?: Record<string, BackupEntry>;
    };
    if (obj?.v === MANIFEST_VERSION && obj.entries) return obj.entries;
  } catch {
    /* no/corrupt manifest → treated as empty (spec: no auto-repair) */
  }
  return {};
}
function writeManifest(entries: Record<string, BackupEntry>): void {
  fs.mkdirSync(backupRoot(), { recursive: true });
  fs.writeFileSync(manifestPath(), JSON.stringify({ v: MANIFEST_VERSION, entries }));
}

/** Copy <project>/README.md + <project>/docs/ into the backup area and record
 *  the manifest entry (keyed by project name). THROWS on any fs failure — the
 *  caller treats a throw as "do not proceed with the delete". A same-name
 *  backup is overwritten (project names are unique per GitHub repo; see spec). */
export function snapshotProjectDocs(
  projectPath: string,
  deletedAt: string = new Date().toISOString(),
): void {
  const name = path.basename(projectPath);
  const dest = path.join(backupRoot(), name);
  fs.rmSync(dest, { recursive: true, force: true }); // clean overwrite of any older same-name backup
  fs.mkdirSync(dest, { recursive: true });
  const readme = path.join(projectPath, "README.md");
  if (fs.existsSync(readme)) fs.copyFileSync(readme, path.join(dest, "README.md"));
  const docs = path.join(projectPath, "docs");
  if (fs.existsSync(docs)) fs.cpSync(docs, path.join(dest, "docs"), { recursive: true });
  const entries = readManifest();
  entries[name] = { name, backupDir: dest, deletedAt };
  writeManifest(entries);
}

/** Every recorded backup. Empty if nothing has been backed up yet. */
export function listBackedUpProjects(): BackupEntry[] {
  return Object.values(readManifest());
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd .../missionControl/extension && bun test src/commands/docsBackup.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/chillox-intern/Desktop/soulbrew/github.com/fufu-2345/missionControl
rtk proxy git add extension/src/commands/docsBackup.ts extension/src/commands/docsBackup.test.ts
rtk proxy git commit -m "feat: docsBackup module — snapshot project docs + manifest"
```

---

### Task 2: Hook backup into `removeProjectDir` (block delete on failure)

**Files:**
- Modify: `extension/src/commands/deleteProject.ts:40-45` (the `removeProjectDir` function)
- Modify: `extension/src/commands/deleteProject.test.ts` (existing "ลบ dir จริงหาย" test + 2 new tests)

**Interfaces:**
- Consumes: `snapshotProjectDocs(projectPath: string): void` from Task 1.
- Produces: `removeProjectDir(projectPath: string, snapshot?: (p: string) => void): { deleted: boolean; reason?: string }` — snapshot defaults to the real one; injectable for tests. Behavior: returns `{ deleted:false, reason }` if the guard fails OR the snapshot throws; only `fs.rmSync` after a successful snapshot.

- [ ] **Step 1: Write the failing tests**

In `extension/src/commands/deleteProject.test.ts`, REPLACE the existing test `removeProjectDir: ลบ dir จริงหาย` (lines 56-64) with a no-op-snapshot version, and ADD two new tests. The replacement + additions:

```ts
test("removeProjectDir: ลบ dir จริงหาย (snapshot no-op)", () => {
  const base = tmpProjects();
  const p = path.join(base, "projects", "foo");
  fs.mkdirSync(path.join(p, "agents", "r"), { recursive: true });
  fs.writeFileSync(path.join(p, "file.txt"), "x");
  const r = removeProjectDir(p, () => {}); // inject no-op → no real ~/.cache write
  expect(r.deleted).toBe(true);
  expect(fs.existsSync(p)).toBe(false);
});

test("removeProjectDir: snapshot ล้มเหลว → ไม่ลบ + reason", () => {
  const base = tmpProjects();
  const p = path.join(base, "projects", "foo");
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, "keep.txt"), "x");
  const r = removeProjectDir(p, () => {
    throw new Error("disk full");
  });
  expect(r.deleted).toBe(false);
  expect(r.reason).toContain("backup");
  expect(fs.existsSync(p)).toBe(true); // ← project untouched
});

test("removeProjectDir: snapshot ได้รับ path ของ project แล้วค่อยลบ", () => {
  const base = tmpProjects();
  const p = path.join(base, "projects", "foo");
  fs.mkdirSync(p, { recursive: true });
  let seen = "";
  const r = removeProjectDir(p, (proj) => {
    seen = proj;
  });
  expect(r.deleted).toBe(true);
  expect(fs.realpathSync(seen)).toBe(fs.realpathSync(p));
  expect(fs.existsSync(p)).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd .../missionControl/extension && bun test src/commands/deleteProject.test.ts`
Expected: FAIL — `removeProjectDir` currently takes one arg; the injected-throw test still deletes (no backup gate yet) so `expect(fs.existsSync(p)).toBe(true)` fails.

- [ ] **Step 3: Write the implementation**

In `extension/src/commands/deleteProject.ts`, add the import at the top (after the existing `node:path` import):

```ts
import { snapshotProjectDocs } from "./docsBackup";
```

Replace `removeProjectDir` (lines 39-45) with:

```ts
/** Guard → snapshot docs → ลบโฟลเดอร์ (recursive). ไม่ผ่าน guard หรือ snapshot
 *  ล้มเหลว = ไม่ลบ + reason. snapshot injectable เพื่อเทส (default = ตัวจริง). */
export function removeProjectDir(
  projectPath: string,
  snapshot: (p: string) => void = snapshotProjectDocs,
): { deleted: boolean; reason?: string } {
  const g = canDeleteProjectPath(projectPath);
  if (!g.ok) return { deleted: false, reason: g.reason };
  const resolved = fs.realpathSync(projectPath);
  try {
    snapshot(resolved); // back up BEFORE the destructive delete
  } catch (e) {
    return { deleted: false, reason: `backup ไม่สำเร็จ: ${e instanceof Error ? e.message : String(e)}` };
  }
  fs.rmSync(resolved, { recursive: true, force: true });
  return { deleted: true };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd .../missionControl/extension && bun test src/commands/deleteProject.test.ts`
Expected: PASS (all tests, including the 3 changed/added).

- [ ] **Step 5: Commit**

```bash
cd /home/chillox-intern/Desktop/soulbrew/github.com/fufu-2345/missionControl
rtk proxy git add extension/src/commands/deleteProject.ts extension/src/commands/deleteProject.test.ts
rtk proxy git commit -m "feat: back up project docs before delete; block delete if backup fails"
```

---

### Task 3: `ProjectRow` backup fields + merge backups into `buildDataIndex`

**Files:**
- Modify: `extension/src/commands/dataView.ts` — `ProjectRow` interface (after line 26), new `loadBackupRows()` export, merge inside `buildDataIndex` (after line 249, before the sort at 251)
- Test: `extension/src/commands/dataView.test.ts` (add tests)

**Interfaces:**
- Consumes: `listBackedUpProjects()` from Task 1; existing `buildProjectRow`, `buildDataIndex`.
- Produces:
  - `ProjectRow` gains `deleted?: boolean; deletedAt?: string | null`.
  - `loadBackupRows(): ProjectRow[]` — one tagged row per backup that has parseable docs.

- [ ] **Step 1: Write the failing tests**

Append to `extension/src/commands/dataView.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd .../missionControl/extension && bun test src/commands/dataView.test.ts`
Expected: FAIL — `loadBackupRows` is not exported.

- [ ] **Step 3: Write the implementation**

In `extension/src/commands/dataView.ts`, add two fields to `ProjectRow` (right after `githubUrl: string | null;`, line 26):

```ts
  githubUrl: string | null;
  deleted?: boolean; // true = reconstructed from a backup, not a live project on disk
  deletedAt?: string | null; // ISO date the project was deleted (backups only)
```

Add the import near the other `./` imports at the top (after line 5):

```ts
import { listBackedUpProjects } from "./docsBackup";
```

Add `loadBackupRows` (place it just above `buildDataIndex`, ~line 227):

```ts
/** One tagged ProjectRow per durable backup whose docs still parse. The row
 *  points at the backup folder (so a click opens the preserved copy) and is
 *  flagged `deleted` so the UI can mark it. Backups with no parseable docs
 *  (e.g. README-only) are skipped here — they still appear in the Orchestrator's
 *  deleted-projects list, which reads listBackedUpProjects() directly. */
export function loadBackupRows(): ProjectRow[] {
  const out: ProjectRow[] = [];
  for (const entry of listBackedUpProjects()) {
    let row: ProjectRow | null = null;
    try {
      row = buildProjectRow(entry.backupDir);
    } catch {
      /* corrupt backup → skip, never sink the index */
    }
    if (!row) continue;
    row.name = entry.name; // trust the manifest name over the folder basename
    row.path = entry.backupDir; // click → open the backup copy
    row.githubUrl = null; // a backup has no .git
    row.deleted = true;
    row.deletedAt = entry.deletedAt;
    out.push(row);
  }
  return out;
}
```

In `buildDataIndex`, insert the merge AFTER the `await Promise.all(...)` git block and BEFORE `rows.sort(...)` (between current lines 249 and 250):

```ts
  );
  // merge in deleted projects from the durable backup — skip any whose name is
  // still live on disk (the live row is authoritative).
  const liveNames = new Set(rows.map((r) => r.name));
  for (const br of loadBackupRows()) if (!liveNames.has(br.name)) rows.push(br);
  // most-recently-updated first, then name
  rows.sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? "") || a.name.localeCompare(b.name));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd .../missionControl/extension && bun test src/commands/dataView.test.ts`
Expected: PASS (existing + 2 new tests).

- [ ] **Step 5: Commit**

```bash
cd /home/chillox-intern/Desktop/soulbrew/github.com/fufu-2345/missionControl
rtk proxy git add extension/src/commands/dataView.ts extension/src/commands/dataView.test.ts
rtk proxy git commit -m "feat: merge backed-up (deleted) projects into the Data View index"
```

---

### Task 4: Data View webview — tag deleted rows in table/kanban/timeline

**Files:**
- Modify: `extension/src/webview/dataView.ts` (row rendering in all three views + a small CSS rule)

**Interfaces:**
- Consumes: `ProjectRow.deleted` / `ProjectRow.deletedAt` from Task 3 (already embedded in the `JSON.stringify(rows)` payload — no host change needed).
- Produces: nothing consumed downstream. Compile-verified (webview imports `vscode` → no bun test).

- [ ] **Step 1: Locate the render functions**

Run: `cd .../missionControl/extension && grep -nE "function tlRow|function renderTimeline|function row\(|function renderTable|function renderKanban|deleted" src/webview/dataView.ts`
Expected: prints the line numbers of `tlRow`, `renderTimeline`, and the table/kanban row builders. Read those functions before editing so the tag insertion matches their existing markup.

- [ ] **Step 2: Add a reusable deleted-badge helper in the inline client script**

In the inline `<script>` of `src/webview/dataView.ts`, next to the existing `esc(...)` helper, add:

```js
  // deleted (backed-up) project → a plain-text tag; no emoji (terminal renders them blank)
  function delTag(r){
    return r && r.deleted
      ? ' <span class="deltag" title="โปรเจกต์นี้ถูกลบจากเครื่องแล้ว — กำลังดูจากสำเนาสำรอง">(ลบแล้ว '
        + esc(r.deletedAt ? String(r.deletedAt).slice(0,10) : '') + ')</span>'
      : '';
  }
```

- [ ] **Step 3: Append `delTag(r)` to each view's project-name cell**

For each of the three renderers (table row, kanban card, and `tlRow`), find where the project name is emitted (e.g. `esc(r.name)`) and append `+ delTag(r)` immediately after it. Also add a `deleted` class to the row/card container so it can be dimmed, e.g. change the container's `class="..."` to include `+ (r.deleted ? ' deleted' : '')`. Exact edit per renderer:
- Table row: `...>'+esc(r.name)+delTag(r)+'</...` and container `class="row'+(r.deleted?' deleted':'')+'"`.
- Kanban card: `...>'+esc(r.name)+delTag(r)+'</...` and container `class="kcard'+(r.deleted?' deleted':'')+'"`.
- `tlRow`: `...>'+esc(r.name)+delTag(r)+'</...` and container `class="tl-row'+(r.deleted?' deleted':'')+'"`.

(Use the ACTUAL class names found in Step 1 — the names above are the expected ones; match what the file uses.)

- [ ] **Step 4: Add CSS for the tag + dimming**

In the `<style>` block of `src/webview/dataView.ts`, add:

```css
  .deltag { font-size: 10px; color: #e3a13a; opacity: 0.9; }
  .deleted { opacity: 0.6; }
```

- [ ] **Step 5: Compile-verify**

Run: `cd .../missionControl/extension && npx tsc -p ./ --noEmit`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
cd /home/chillox-intern/Desktop/soulbrew/github.com/fufu-2345/missionControl
rtk proxy git add extension/src/webview/dataView.ts
rtk proxy git commit -m "feat: tag deleted projects in Data View (table/kanban/timeline)"
```

---

### Task 5: Orchestrator host — deleted-projects list + archived Detail plumbing

**Files:**
- Modify: `extension/src/webview/orchestrator.ts` — `WizState` (line 53-59), `_screen` union (line 64), new `pushArchivedScreen`, archived branch in `pushDetailScreen` (318-334), new message cases + guards.

**Interfaces:**
- Consumes: `listBackedUpProjects()` + `BackupEntry` from Task 1; existing `listDetailDocs`, `resolveProjectFile`, `renderMarkdown`.
- Produces: host handling for client messages `toggle_archived`, `pick_archived`, and an `archived:true` field on the `screen_detail` payload. No new exports.

- [ ] **Step 1: Extend state + screen union**

Add the import (after line 40's `projectName` import group, near `listDetailDocs` import at line 22 — put it with the commands imports):

```ts
import { listBackedUpProjects, type BackupEntry } from "../commands/docsBackup";
```

In `WizState` (after `newName?: string;`, line 58) add:

```ts
  archivedView?: boolean; // showing the deleted-projects list instead of live projects
  archived?: boolean; // currently viewing a deleted project's docs (read-only)
```

Change the `_screen` union (line 64) to include `"archived"`:

```ts
let _screen: "projects" | "detail" | "teams" | "orch" | "archived" = "projects";
```

- [ ] **Step 2: Add `pushArchivedScreen` (host → client render payload)**

Add this function right after `pushProjectsScreen` (after line 186):

```ts
/** The deleted-projects list — every durable backup, read-only. Reuses the
 *  projects screen's client renderer via a distinct message type. */
function pushArchivedScreen(panel: vscode.WebviewPanel) {
  _screen = "archived";
  const backups: BackupEntry[] = listBackedUpProjects().sort((a, b) =>
    (b.deletedAt ?? "").localeCompare(a.deletedAt ?? ""),
  );
  if (_st) _st.backups = backups; // cache for pick_archived (typed below)
  panel.webview.postMessage({
    type: "screen_archived",
    title: "โปรเจกต์ที่ลบไปแล้ว",
    subtitle: backups.length
      ? "สำเนาสำรอง (README + docs) ตอนกดลบ — อ่านอย่างเดียว · กดปุ่มเดิมเพื่อกลับหน้าปกติ"
      : "ยังไม่มีโปรเจกต์ที่ถูกลบผ่านปุ่มลบในโปรแกรม",
    items: backups.map((b) => ({ name: b.name, path: b.backupDir, deletedAt: b.deletedAt })),
  });
}
```

Add `backups?: BackupEntry[];` to `WizState` (with the fields from Step 1):

```ts
  backups?: BackupEntry[]; // cached deleted-projects list for pick_archived
```

- [ ] **Step 3: Archived branch in `pushDetailScreen`**

Replace `pushDetailScreen` (lines 318-334) with a version that skips git/preview when archived and forwards the flag + deletedAt:

```ts
async function pushDetailScreen(panel: vscode.WebviewPanel) {
  const p = _st?.project;
  if (!p) return;
  _screen = "detail";
  const archived = _st?.archived === true;
  const githubUrl = archived ? null : await gitOps.getGithubWebUrl(p.path);
  const docs = listDetailDocs(p.path);
  const deletedAt = archived
    ? (_st?.backups?.find((b) => b.backupDir === p.path)?.deletedAt ?? null)
    : null;
  panel.webview.postMessage({
    type: "screen_detail",
    title: `📁 ${p.name}`,
    subtitle: archived ? `ลบไปแล้วเมื่อ ${deletedAt ?? "?"}` : `project: ${p.name}`,
    path: p.path,
    githubUrl,
    archived, // client hides git/preview/continue/delete when true
    preview: archived
      ? { available: false, running: false }
      : { available: isPreviewAvailable(p.path), running: isPreviewRunning(p.path) },
    tree: docs.tree,
    readme: docs.readme,
  });
}
```

- [ ] **Step 4: Add message cases + archived guards**

In the `onDidReceiveMessage` switch, add two new cases (put them next to `to_projects`, ~line 537):

```ts
      case "toggle_archived": {
        _st.archivedView = !_st.archivedView;
        _st.project = undefined;
        _st.archived = false;
        if (_st.archivedView) pushArchivedScreen(panel);
        else await pushProjectsScreen(panel);
        return;
      }
      case "pick_archived": {
        const b = _st.backups?.find((x) => x.backupDir === msg.path);
        if (!b) return;
        // synthetic ResumableProject pointing at the backup folder
        _st.project = {
          name: b.name,
          path: b.backupDir,
          sprintDocs: 0,
          openWorktrees: 0,
        };
        _st.archived = true;
        await pushDetailScreen(panel);
        return;
      }
```

In the `to_projects` case (line 531-536), also clear archived state so leaving Detail returns correctly:

```ts
      case "to_projects": {
        _st.project = undefined;
        _st.team = undefined;
        _st.archived = false;
        if (_st.archivedView) pushArchivedScreen(panel);
        else await pushProjectsScreen(panel);
        return;
      }
```

Guard the destructive/live handlers against archived mode. At the very top of `continue_to_team`, `run_localhost`, and `open_github` (right after their `const p = _st.project;` / entry), add:

```ts
        if (_st.archived) return; // read-only backup — no continue/preview/github
```

(These buttons are hidden client-side in Task 6, but this is the host-side guard-twice, matching the existing delete/git guard convention.)

- [ ] **Step 5: Compile-verify**

Run: `cd .../missionControl/extension && npx tsc -p ./ --noEmit`
Expected: no output, exit 0. (If TS complains that `msg.path` is untyped, mirror the existing pattern: `const pth = typeof msg.path === "string" ? msg.path : ""` then compare — match how neighboring cases read `msg.path`.)

- [ ] **Step 6: Commit**

```bash
cd /home/chillox-intern/Desktop/soulbrew/github.com/fufu-2345/missionControl
rtk proxy git add extension/src/webview/orchestrator.ts
rtk proxy git commit -m "feat: orchestrator host — deleted-projects list + archived Detail plumbing"
```

---

### Task 6: Orchestrator client — toggle button + archived rendering

**Files:**
- Modify: `extension/src/webview/orchestrator.ts` — inline client script: `actionsHtml`/`wireActions` (1072-1095), a `renderArchived` renderer, `renderDetail`/`detailActionsHtml` archived branch, message router (1522-1531).

**Interfaces:**
- Consumes: host messages `screen_archived` (items: `{name, path, deletedAt}[]`) and the `archived` flag on `screen_detail`, both from Task 5.
- Produces: client messages `toggle_archived`, `pick_archived`. Compile-verified.

- [ ] **Step 1: Add the toggle button to the projects header**

In `actionsHtml` (line 1072), add a trailing button when `showEdit` is set (the Projects screen). Change the final return line to append:

```ts
      + (showEdit ? '<button id="editBtn" title="เปิดเพื่อลบโปรเจคที่ไม่ใช้">Edit</button>' : '')
      + (showEdit ? '<button id="archBtn" title="ดู/ซ่อนโปรเจกต์ที่ลบไปแล้ว (อ่านอย่างเดียว)">ที่ลบไปแล้ว</button>' : '');
```

In `wireActions` (line 1086), wire it (after the `editBtn` wiring at line 1093-1094):

```ts
    var arb=el("archBtn"); if(arb) arb.addEventListener('click',function(){post('toggle_archived');});
```

- [ ] **Step 2: Add the `renderArchived` client renderer**

Add this function next to `renderProjects` (after it ends, ~line 1382). It renders the deleted-projects list as simple clickable rows (no git/continue/delete controls):

```js
  function renderArchived(m){
    _lastProjKey = null;                 // returning to live projects must re-render
    el("title").textContent = m.title; el("subtitle").textContent = m.subtitle;
    // reuse the projects action bar so the toggle button is present to switch back
    el("actions").innerHTML = actionsHtml(false, false, false, true, true, false); wireActions(false);
    var arb=el("archBtn"); if(arb) arb.classList.add('on');
    var items = m.items||[];
    el("content").innerHTML = items.length ? items.map(function(it){
      var when = it.deletedAt ? String(it.deletedAt).slice(0,10) : '';
      return '<div class="card" data-path="'+esc(it.path)+'">'
        +'<div style="flex:1"><button class="pick"><span class="cname">'+esc(it.name)+'</span>'
        +'<span class="csub">ลบไปแล้วเมื่อ '+esc(when)+'</span></button></div></div>';
    }).join('') : '<div class="empty">'+esc(m.subtitle)+'</div>';
    el("content").querySelectorAll('.card').forEach(function(card){
      var path=card.dataset.path;
      card.addEventListener('click',function(){ post('pick_archived',{path:path}); });
    });
  }
```

- [ ] **Step 3: Archived branch in `renderDetail` + `detailActionsHtml`**

In `renderDetail` (line 1172), capture the archived flag so the action bar can read it. After `_detail = {...}` (line 1175), set:

```ts
    _detail.archived = !!m.archived;
```

In `detailActionsHtml` (line 1148), when archived, render only the read-only nav (back/close + a badge), hiding localhost/continue/GitHub. Wrap the body:

```ts
  function detailActionsHtml(githubUrl){
    if(_detail.archived){
      return (_navStack.length ? backBtnHtml() : '')
        + '<button id="closeBtn">✕ ปิด</button>'
        + '<span class="archbadge" title="สำเนาสำรองของโปรเจกต์ที่ถูกลบ">อ่านอย่างเดียว (ลบไปแล้ว)</span>';
    }
    var lh = _previewAvail
      ? '<button id="lhBtn" title="รัน dev server แล้วเปิด browser (กดซ้ำ = หยุด)">'
          + (_previewRunning ? '⏹ หยุด' : '🌐 localhost') + '</button>'
      : '<button id="lhBtn" class="disabled" disabled title="โปรเจคนี้ไม่มี .orches-preview.sh — เปิด localhost ไม่ได้">🌐 localhost</button>';
    return (_navStack.length ? backBtnHtml() : '')
      + '<button id="closeBtn">✕ ปิด</button>'
      + lh
      + '<button id="contBtn" title="ไปเลือกทีม / เข้า session ที่ทำอยู่" style="border-color:#2ea043;color:#3fb950;">▶ ทำต่อ</button>'
      + '<button id="dvBtn" title="ดูสถานะทุกโปรเจกต์ (table / kanban / timeline จากไฟล์ .md)">Data View</button>'
      + (githubUrl ? '<button id="ghBtn" title="เปิด repo นี้ใน GitHub (browser)">🔗 GitHub</button>' : '');
  }
```

`wireDetailActions` (line 1161) already null-checks each button (`if(lh)…`, `if(ct)…`), so hidden buttons wire nothing — no change needed there. The `..`/close buttons still wire because they're present in both branches.

- [ ] **Step 4: Route the new message + add badge CSS**

In the client message router (lines 1522-1531), add a branch:

```ts
    if(m.type==="screen_projects") renderProjects(m);
    else if(m.type==="screen_archived") renderArchived(m);
```

In the `<style>` block, add:

```css
  .archbadge { font-size: 11px; color: #e3a13a; align-self: center; margin-left: 4px; }
  #archBtn.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
```

Also declare `archived` on the client `_detail` object's type-free usage — it's a plain JS object so no declaration is needed; just ensure `_detail.archived` is set in `renderDetail` (Step 3).

- [ ] **Step 5: Compile-verify + full test suite**

Run: `cd .../missionControl/extension && npx tsc -p ./ --noEmit && bun test src/commands/`
Expected: tsc clean (exit 0); bun test — all pass, including `docsBackup.test.ts`, `deleteProject.test.ts`, `dataView.test.ts`.

- [ ] **Step 6: Commit**

```bash
cd /home/chillox-intern/Desktop/soulbrew/github.com/fufu-2345/missionControl
rtk proxy git add extension/src/webview/orchestrator.ts
rtk proxy git commit -m "feat: orchestrator client — deleted-projects toggle + read-only archived view"
```

---

## Self-Review

**Spec coverage:**
- Snapshot README + full docs/ before delete → Task 1. ✓
- Durable location `~/.cache/mission-control/`, manifest keyed by name → Task 1. ✓
- Block delete if backup fails → Task 2. ✓
- Data View (all three tabs) shows deleted projects, tagged → Tasks 3 + 4. ✓
- Toggle on the projects list: off = normal, on = deleted-only, read-only detail → Tasks 5 + 6. ✓
- Archived detail hides git/preview/continue/delete, shows deleted-at badge → Tasks 5 (host guard + payload) + 6 (client hide + badge). ✓
- Same-name overwrite (GitHub name uniqueness) → Task 1 (`fs.rmSync` before copy) + test. ✓
- No-docs project → empty backup, still recorded → Task 1 test. ✓
- Corrupt/missing manifest → no auto-repair (treated empty) → Task 1 `readManifest` catch. ✓
- Automated tests only (3 logic areas) → Tasks 1-3 (bun test); webview tasks compile-gated. ✓

**Placeholder scan:** none — every code step shows complete code; webview edits reference exact functions/line numbers with the actual code to insert.

**Type consistency:** `snapshotProjectDocs(projectPath, deletedAt?)`, `listBackedUpProjects(): BackupEntry[]`, `BackupEntry{name,backupDir,deletedAt}`, `loadBackupRows(): ProjectRow[]`, `ProjectRow.deleted/deletedAt`, and the message types (`screen_archived`, `toggle_archived`, `pick_archived`, `archived` on `screen_detail`) are used identically across host (Task 5) and client (Task 6). The synthetic `ResumableProject` in `pick_archived` supplies all required fields (`name`, `path`, `sprintDocs`, `openWorktrees`) per the interface at `orchestratorResume.ts:16`.

**One risk to watch (Task 6):** the exact class names for table/kanban/timeline rows in `webview/dataView.ts` must be confirmed in Step 1 of Task 4 before editing — the plan lists the expected names but the implementer should match whatever the file actually uses.

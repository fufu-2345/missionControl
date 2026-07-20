# Project docs backup — design

## Problem

Deleting a project via the Orchestrator screen's "Delete Project" button (`deleteProject.ts`'s `removeProjectDir`) recursively removes the entire project directory, including `docs/` (plan.md, sprint docs, wiki) and `README.md`. If that project was never pushed to GitHub — or was pushed but the user just wants the local docs preserved regardless — that documentation is gone permanently. This also means two views that read from `docs/` live off local disk lose their data for that project:

- **Project Detail** (Orchestrator screen → open a project → wiki/plan/sprint accordion), reads via `projectDocs.ts`.
- **Data View → Timeline tab** (and Table/Kanban, which share the same row data), reads via `commands/dataView.ts`.

A prior audit of this extension's delete flows found the Budget Detail page already solves an analogous problem for spend data via a durable ledger at `~/.cache/mission-control/project-ledger.json` that outlives project deletion. This spec applies the same pattern to project docs.

## Goals

1. Before a project is actually deleted, snapshot its `README.md` + full `docs/` tree to a durable location outside the project directory.
2. Data View (Table/Kanban/Timeline) can show a deleted project's sprint history, clearly tagged as deleted.
3. A toggle in the Orchestrator project list switches between "normal view" (no deleted projects shown) and "deleted-only view" (browse and open a deleted project's docs read-only).
4. If the backup itself fails, the delete must NOT proceed — no destructive delete without a snapshot.

## Non-goals

- Backing up `agents/*` worktrees or any unmerged/uncommitted work — established in prior audit as accepted, expected loss (worktree = unmerged branch by definition).
- Backing up anything outside `README.md` + `docs/` (no git history, no other project files).
- A "restore" button that reconstitutes a full project directory from a backup — out of scope; the backup is for reading, not un-deleting a project.
- Periodic/background backup — the only write trigger is the delete-confirm flow itself (see Trigger, below).

## Architecture

### New module: `src/commands/docsBackup.ts`

No `vscode` import — stays unit-testable standalone with `bun test`, matching the existing convention in `deleteProject.ts`.

```ts
interface BackupEntry {
  name: string;       // project name — also the manifest key and the backup folder name
  backupDir: string;  // absolute path to the backup folder
  deletedAt: string;  // ISO date
}

function snapshotProjectDocs(projectPath: string): void;  // throws on failure
function listBackedUpProjects(): BackupEntry[];
```

`snapshotProjectDocs`:
1. Computes `name = path.basename(projectPath)`.
2. Backup folder = `~/.cache/mission-control/docs-backup/<name>/`.
3. If a backup folder for this name already exists, remove it first (overwrite — see "Same-name backups" below), then create fresh.
4. Copies `<projectPath>/README.md` (if present) into the backup folder root.
5. Copies `<projectPath>/docs/` (if present) recursively into `<backupDir>/docs/` via `fs.cpSync(..., { recursive: true })` — the whole tree, not filtered to `.md` files, so images or other assets referenced by wiki pages are preserved too.
6. Writes/overwrites the manifest entry for `name` with `{ name, backupDir, deletedAt: new Date().toISOString() }`.
7. Any `fs` error at any step propagates (throws) — this function has no "best-effort" swallowing, unlike the Budget ledger's writer.

Manifest file: `~/.cache/mission-control/docs-backup/manifest.json`, same shape convention as the Budget ledger:
```json
{ "v": 1, "entries": { "<name>": { "name": "...", "backupDir": "...", "deletedAt": "..." } } }
```
Keyed by **project name**, not by resolved path or a hash. Project names are already unique per the GitHub repo they correspond to (GitHub rejects duplicate repo names under the same owner), so name collisions between two genuinely different, simultaneously-existing projects cannot happen. The only way the same name is backed up twice is: project "foo" is deleted, then a new project also named "foo" is later created and deleted again — an edge case rare enough that "the newer backup replaces the older one" (see step 3 above) is an acceptable simplification; no dual-storage/hash-suffix scheme is needed.

### Hook point: `deleteProject.ts`

`removeProjectDir(projectPath)` — after the existing `canDeleteProjectPath` guard passes and before `fs.rmSync`:

```ts
export function removeProjectDir(projectPath: string): { deleted: boolean; reason?: string } {
  const g = canDeleteProjectPath(projectPath);
  if (!g.ok) return { deleted: false, reason: g.reason };
  try {
    snapshotProjectDocs(projectPath);
  } catch (e) {
    return { deleted: false, reason: `backup ไม่สำเร็จ: ${String(e)}` };
  }
  fs.rmSync(fs.realpathSync(projectPath), { recursive: true, force: true });
  return { deleted: true };
}
```

This is the single choke point `deleteProjectFlow()` (`webview/orchestrator.ts`) already calls — no other code path deletes a project directory, so there's no way to bypass the backup.

### Why mirroring real files (not a JSON blob) pays off twice

Because the backup folder has a genuine `docs/` directory on disk, the existing read-side functions work against it completely unmodified, just by pointing them at `backupDir` instead of a live project path:
- `buildProjectRow(backupDir)` (`commands/dataView.ts`) — parses `docs/plan.md` + sprint docs exactly as it does for a live project.
- `listDetailDocs(backupDir)`, `resolveDocPath(backupDir, rel)`, `renderMarkdown(...)` (`commands/projectDocs.ts`) — same, unmodified.
- Data View's existing row-click behavior (`openProject()` in `webview/dataView.ts`, which does `showTextDocument` on a real file path) also works unmodified, since the backup path contains real files.

No parallel "virtual filesystem" reader needs to be written.

## Data model changes

**`ProjectRow`** (`commands/dataView.ts`) gains two optional fields:
```ts
deleted?: boolean;      // true = this row was reconstructed from a backup, not a live project
deletedAt?: string | null;
```
Existing live-project rows leave these `undefined` — no change to any code that doesn't know about them.

## Data View / Timeline integration

In `buildDataIndex(ownerRoot)`:
1. Build rows for live projects as today.
2. Call `listBackedUpProjects()`.
3. For each entry whose `name` does NOT match any live project's `name` already in the rows (skip if it does — treat the live one as authoritative), call `buildProjectRow(entry.backupDir)`, then set on the returned row: `deleted = true`, `deletedAt = entry.deletedAt`, `path = entry.backupDir`, `githubUrl = null` (skip the GitHub lookup — a backup folder has no `.git`).
4. Push into the same array, sort as today (by `updated` desc). A deleted project's row sorts in naturally by its own last sprint date.

Because Table/Kanban/Timeline are three renders of this one array, this single change surfaces deleted projects in all three views. Rows with `deleted: true` get a visual tag in `webview/dataView.ts` (e.g. "(ลบแล้ว `<deletedAt>`)"), styled dimmer than live rows, in all three tabs.

## Project Detail: archived (read-only) view + toggle

**Toggle button** in the Orchestrator project-list screen (`webview/orchestrator.ts`), e.g. "ดูโปรเจกต์ที่ลบไปแล้ว":
- **Off (default):** page behaves exactly as today — no deleted-project data appears anywhere in this screen.
- **On:** the project list is replaced by a list built from `listBackedUpProjects()` only. Each entry opens the existing Project Detail screen, pointed at `entry.backupDir` as the "project path," with a new `archived: true` flag threaded through.
- Toggling back off restores the normal live-project list.

**Archived mode in Project Detail:**
- `listDetailDocs`/`resolveDocPath`/`renderMarkdown` are called against `backupDir` exactly as they would be for a live project — no code changes needed there.
- Hidden when `archived: true`: git buttons (commit/push/pull), preview toggle, the delete-project button itself, resume/drive actions — none of these are meaningful against a backup folder with no `.git`.
- Shown: a badge at the top, e.g. "ลบไปแล้วเมื่อ `<deletedAt>`", so it's unambiguous this is archived, read-only content and not a live, drivable project.

## Error handling & edge cases

- **Backup write fails during delete** (e.g. disk full, permission error) → `removeProjectDir` returns `{ deleted: false, reason: "backup ไม่สำเร็จ: ..." }`. The project directory is NOT touched. The user sees the reason and must resolve it before retrying delete.
- **Same name backed up twice over time** → see "Same-name backups" above: the newer snapshot silently replaces the older one under the same manifest key. This is an accepted simplification, not a bug — see rationale above (GitHub name uniqueness).
- **Project has no `docs/` directory** → `snapshotProjectDocs` still backs up `README.md` if present; if neither exists, it writes an empty backup folder + manifest entry. Not an error — there's simply nothing to preserve.
- **`~/.cache` unwritable** → `snapshotProjectDocs` throws like any other fs failure → delete is blocked (same path as "backup write fails," above).
- **`manifest.json` becomes corrupt or is deleted externally** → no automatic repair is attempted. Accepted risk: it's a single small JSON file, low likelihood of corruption, and repairing it is out of scope for this feature.

## Testing (automated only — `bun test`, no `vscode` import required)

1. `docsBackup.ts`: `snapshotProjectDocs` copies `README.md` + the full `docs/` tree correctly into the backup folder, and writes a correct manifest entry.
2. `deleteProject.ts`: with `snapshotProjectDocs` mocked to throw, `removeProjectDir` returns `{ deleted: false, ... }` and the original project directory is verified to still exist on disk, untouched.
3. `dataView.ts`: `buildDataIndex` merges backup entries into the row array correctly — a deleted project's row appears exactly once, tagged `deleted: true`/`deletedAt`, and is skipped if a live project with the same name is present.

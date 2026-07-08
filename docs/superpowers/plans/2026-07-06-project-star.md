# Project Star / Favorite — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the "⏮ ทำต่อ — เลือก project ค้าง" list, let the user star a project so it always floats to the top; the star is a per-user preference stored in VSCode `globalState`.

**Architecture:** Two pure helpers (`toggleStar`, `partitionStarred`) in `orchestratorResume.ts` (unit-tested with bun). The webview host (`orchestrator.ts`) reads/writes a `globalState` string[] of starred paths, partitions the already-`sortResumable`-ordered list starred-first at render time (never touching `sortResumable`), sends a `starred` flag per card, and handles a `toggle_star` round-trip. The webview renders a ☆/★ toggle as the first child of each card (not inside the `.pick` button) that stops propagation so it never selects the project.

**Tech Stack:** TypeScript VSCode extension, vanilla-JS webview (template string + `postMessage`), `bun test`, `tsc` build.

## Global Constraints

- Build / typecheck: `bun run compile` (= `tsc -p ./`), run from the `extension/` dir. Must exit 0.
- Unit tests: `bun test src/commands/orchestratorResume.test.ts`, run from the `extension/` dir (`bun:test`; there is no `test` npm script).
- Repo path: all paths below are relative to `.../fufu-2345/missionControl/extension/` unless noted.
- **Commits use scoped `git add <exact files listed in the task>` — NEVER `git add -A`.** The `missionControl` repo has unrelated pending changes the user commits himself via the extension's Commit button; do not sweep them. (If the user prefers, skip the commit steps and leave working-tree changes for him.)
- globalState key (named module const, single consumer): `STARRED_KEY = "missioncontrol.starredProjects"`.
- Feature applies ONLY to the "⏮ ทำต่อ" (continue) project list. "▶ เริ่มใหม่" has no project list (goes straight to team picker) — no code needed there.
- Star element must be a **non-button** (`<span role="button">`) and a **sibling of `.pick`** (first child of `.card`) — never nested inside the `.pick` `<button>` (invalid HTML).

---

### Task 1: Pure helpers `toggleStar` + `partitionStarred`

**Files:**
- Modify: `src/commands/orchestratorResume.ts` (append two exported functions)
- Test: `src/commands/orchestratorResume.test.ts` (append two tests + extend the import)

**Interfaces:**
- Consumes: `ResumableProject` (already exported from `orchestratorResume.ts`).
- Produces:
  - `toggleStar(list: string[], path: string): string[]` — add if absent, remove if present, returns a new array (no mutation).
  - `partitionStarred(list: ResumableProject[], starred: ReadonlySet<string>): ResumableProject[]` — stable partition, starred first, sub-order preserved.

- [ ] **Step 1: Write the failing tests**

Extend the existing import block in `src/commands/orchestratorResume.test.ts` (currently importing `defaultTeamForProject … sortResumable`) to also pull the two new helpers:

```ts
import {
  defaultTeamForProject,
  isProjectLive,
  isResumable,
  parseOrchesMeta,
  parsePlan,
  partitionStarred,
  type ResumableProject,
  serializeOrchesMeta,
  sortResumable,
  toggleStar,
} from "./orchestratorResume";
```

Append these tests to the end of the file:

```ts
test("toggleStar: add if absent, remove if present, never mutates input", () => {
  const base = ["/x/one"];
  expect(toggleStar(base, "/x/two")).toEqual(["/x/one", "/x/two"]); // add
  expect(toggleStar(["/x/one", "/x/two"], "/x/one")).toEqual(["/x/two"]); // remove
  expect(base).toEqual(["/x/one"]); // input untouched
  expect(toggleStar(toggleStar(base, "/x/two"), "/x/two")).toEqual(["/x/one"]); // round-trip
});

test("partitionStarred: starred float to top, sub-order preserved within groups", () => {
  const p = (name: string): ResumableProject => ({
    name,
    path: "/x/" + name,
    sprintDocs: 0,
    openWorktrees: 0,
  });
  const list = [p("a"), p("b"), p("c"), p("d")];
  expect(partitionStarred(list, new Set(["/x/b", "/x/d"])).map((x) => x.name)).toEqual([
    "b",
    "d",
    "a",
    "c",
  ]);
  expect(partitionStarred(list, new Set()).map((x) => x.name)).toEqual(["a", "b", "c", "d"]); // none → unchanged
  expect(
    partitionStarred(list, new Set(["/x/a", "/x/b", "/x/c", "/x/d"])).map((x) => x.name),
  ).toEqual(["a", "b", "c", "d"]); // all → order unchanged
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd extension && bun test src/commands/orchestratorResume.test.ts`
Expected: FAIL — the two new tests error with something like `TypeError: toggleStar is not a function` / `partitionStarred is not a function` (the named exports don't exist yet). Existing tests still pass.

- [ ] **Step 3: Implement the helpers**

Append to the end of `src/commands/orchestratorResume.ts`:

```ts
/** Toggle a project path in the starred list: add if absent, remove if present.
 *  Pure — returns a new array, never mutates the input. */
export function toggleStar(list: string[], path: string): string[] {
  return list.includes(path) ? list.filter((p) => p !== path) : [...list, path];
}

/** Stable-partition resumable projects so starred ones float to the top, while
 *  preserving the incoming (sortResumable) order within each group. Pure. */
export function partitionStarred(
  list: ResumableProject[],
  starred: ReadonlySet<string>,
): ResumableProject[] {
  const top: ResumableProject[] = [];
  const rest: ResumableProject[] = [];
  for (const p of list) (starred.has(p.path) ? top : rest).push(p);
  return [...top, ...rest];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd extension && bun test src/commands/orchestratorResume.test.ts`
Expected: PASS — all tests green (existing + the two new).

- [ ] **Step 5: Commit**

```bash
cd extension && git add src/commands/orchestratorResume.ts src/commands/orchestratorResume.test.ts \
  && git commit -m "feat(orchestrator): pure toggleStar + partitionStarred helpers"
```

---

### Task 2: Host wiring — thread context, star globalState, partition + toggle handler

**Files:**
- Modify: `src/webview/orchestrator.ts` (import, module state, `pushProjectsScreen`, `openOrchestratorPanel`, message handler)
- Modify: `src/extension.ts:49-54` (pass `context` to both callers)

**Interfaces:**
- Consumes: `partitionStarred`, `toggleStar` (Task 1).
- Produces:
  - `openOrchestratorPanel(mode: "new" | "continue", context: vscode.ExtensionContext): vscode.WebviewPanel` (new 2nd param).
  - Webview `screen_projects` items now carry `starred: boolean`.
  - Host handles inbound message `{ type: "toggle_star", path: string }`.

- [ ] **Step 1: Extend the orchestratorResume import**

In `src/webview/orchestrator.ts`, replace the type-only import (currently line 13):

```ts
import type { ResumableProject } from "../commands/orchestratorResume";
```

with a value+type import:

```ts
import { partitionStarred, toggleStar, type ResumableProject } from "../commands/orchestratorResume";
```

- [ ] **Step 2: Add the globalState key, `_ctx`, and accessors**

Immediately after the `let _st: WizState | undefined;` line (currently line 31), add:

```ts
const STARRED_KEY = "missioncontrol.starredProjects";
let _ctx: vscode.ExtensionContext | undefined;

/** Starred project paths from per-user globalState (empty if context missing). */
function starredList(): string[] {
  return _ctx?.globalState.get<string[]>(STARRED_KEY, []) ?? [];
}
async function setStarred(list: string[]): Promise<void> {
  await _ctx?.globalState.update(STARRED_KEY, list);
}
```

- [ ] **Step 3: Partition + emit `starred` in `pushProjectsScreen`**

Replace the whole `pushProjectsScreen` function (currently lines 47-68) with:

```ts
async function pushProjectsScreen(panel: vscode.WebviewPanel, fetch = false) {
  const projects = _st?.projects ?? [];
  annotateLiveState(projects); // refresh the live "doing" flag each render (cheap: one tmux call)
  const starred = new Set(starredList());
  const ordered = partitionStarred(projects, starred); // starred float to top; sub-order preserved
  const states = await computeGitStates(ordered, fetch);
  panel.webview.postMessage({
    type: "screen_projects",
    title: "⏮ ทำต่อ — เลือก project ค้าง",
    subtitle: projects.length
      ? "⠋ กำลังทำ = worker run อยู่ตอนนี้ · 🔨 ค้าง = sprint ที่ยังไม่เสร็จ (จากแผน หรือ worktree ที่เปิดค้าง) · 'ทำ X/N' = เสร็จกี่ sprint · ปุ่มขวา = git"
      : "ไม่พบงานค้าง — ต้องมี docs/plan.md, docs/*sprint-*.md หรือ worktree agents/* เปิดอยู่",
    items: ordered.map((p) => ({
      path: p.path,
      name: p.name,
      sprints: p.sprintDocs,
      worktrees: p.openWorktrees,
      plannedTotal: p.plannedTotal,
      plannedDone: p.plannedDone,
      doing: p.doing,
      starred: starred.has(p.path),
      git: { path: p.path, ...states[p.path] },
    })),
  });
}
```

- [ ] **Step 4: Thread `context` into `openOrchestratorPanel`**

Replace the signature + first line of `openOrchestratorPanel` (currently lines 143-144):

```ts
export function openOrchestratorPanel(mode: "new" | "continue"): vscode.WebviewPanel {
  _st = { mode, projects: mode === "continue" ? scanResumableProjects() : [] };
```

with:

```ts
export function openOrchestratorPanel(
  mode: "new" | "continue",
  context: vscode.ExtensionContext,
): vscode.WebviewPanel {
  _ctx = context;
  _st = { mode, projects: mode === "continue" ? scanResumableProjects() : [] };
```

- [ ] **Step 5: Handle the `toggle_star` message**

In the `panel.webview.onDidReceiveMessage` switch, add a new case right after the `pick_project` case closes (after the `}` that ends `case "pick_project": { … }`, currently around line 189):

```ts
      case "toggle_star": {
        const p = typeof msg.path === "string" ? msg.path : "";
        if (!p || !_ctx) return;
        await setStarred(toggleStar(starredList(), p)); // await update: durable; Memento.get reflects it synchronously so the re-sort below is already correct
        await pushProjectsScreen(panel);
        return;
      }
```

- [ ] **Step 6: Pass `context` at both call sites in `extension.ts`**

In `src/extension.ts`, replace lines 49-54:

```ts
    vscode.commands.registerCommand("missioncontrol.orchestratorNew", () =>
      openOrchestratorPanel("new"),
    ),
    vscode.commands.registerCommand("missioncontrol.orchestratorContinue", () =>
      openOrchestratorPanel("continue"),
    ),
```

with:

```ts
    vscode.commands.registerCommand("missioncontrol.orchestratorNew", () =>
      openOrchestratorPanel("new", context),
    ),
    vscode.commands.registerCommand("missioncontrol.orchestratorContinue", () =>
      openOrchestratorPanel("continue", context),
    ),
```

- [ ] **Step 7: Typecheck**

Run: `cd extension && bun run compile`
Expected: exit 0, no errors. (If a call site to `openOrchestratorPanel` was missed, tsc reports "Expected 2 arguments, but got 1" — fix it.)

- [ ] **Step 8: Commit**

```bash
cd extension && git add src/webview/orchestrator.ts src/extension.ts \
  && git commit -m "feat(orchestrator): thread context + star globalState wiring (host side)"
```

---

### Task 3: Webview render — star toggle on each card + CSS + click

**Files:**
- Modify: `src/webview/orchestrator.ts` (`renderShell` `<style>`, `renderProjects` card template + `.card` click loop)

**Interfaces:**
- Consumes: the `starred: boolean` item field and `toggle_star` handler (Task 2).
- Produces: no code interface — this is the visible UI; verified by manual E2E.

- [ ] **Step 1: Add `.star` CSS**

In the `<style>` block of `renderShell`, add these rules immediately after the `.badge-last { … }` rule (currently lines 321-322):

```css
  .star { flex: 0 0 auto; font-size: 15px; line-height: 1; cursor: pointer; user-select: none;
    opacity: 0.35; padding: 0 2px; }
  .star:hover { opacity: 0.7; }
  .star.on { color: #e3b341; opacity: 1; }
```

- [ ] **Step 2: Render the star as the first child of each card**

In `renderProjects`, replace the card template return (currently lines 425-428):

```js
      return '<div class="card" data-path="'+esc(it.path)+'">'
        +'<div style="flex:1"><button class="pick"><span class="cname">'+esc(it.name)+chip+'</span>'
        +'<span class="csub">'+sub+'</span></button>'+gitEditor(it.git)+'</div>'
        +'<span class="git-cell">'+gitCell(it.git)+'</span></div>';
```

with (star added as the FIRST child of `.card`, before the `flex:1` div — NOT inside `.pick`):

```js
      return '<div class="card" data-path="'+esc(it.path)+'">'
        +'<span class="star'+(it.starred?' on':'')+'" role="button" title="ปักดาว / เอาดาวออก">'+(it.starred?'★':'☆')+'</span>'
        +'<div style="flex:1"><button class="pick"><span class="cname">'+esc(it.name)+chip+'</span>'
        +'<span class="csub">'+sub+'</span></button>'+gitEditor(it.git)+'</div>'
        +'<span class="git-cell">'+gitCell(it.git)+'</span></div>';
```

- [ ] **Step 3: Wire the star click + extend the row-click skip guard**

In `renderProjects`, replace the `.card` loop (currently lines 430-439):

```js
    el("content").querySelectorAll('.card').forEach(function(card){
      var path=card.dataset.path;
      // Whole row selects the project — except clicks on the git button or its
      // inline form (those do their own thing).
      card.addEventListener('click',function(e){
        if (e.target.closest('.git-act') || e.target.closest('.git-editor')) return;
        post('pick_project',{path:path});
      });
      wireGit(card, path);
    });
```

with:

```js
    el("content").querySelectorAll('.card').forEach(function(card){
      var path=card.dataset.path;
      // Whole row selects the project — except clicks on the git button, its
      // inline form, or the star toggle (those do their own thing).
      card.addEventListener('click',function(e){
        if (e.target.closest('.git-act') || e.target.closest('.git-editor') || e.target.closest('.star')) return;
        post('pick_project',{path:path});
      });
      var starEl=card.querySelector('.star');
      if(starEl) starEl.addEventListener('click',function(e){ e.stopPropagation(); post('toggle_star',{path:path}); });
      wireGit(card, path);
    });
```

- [ ] **Step 4: Typecheck**

Run: `cd extension && bun run compile`
Expected: exit 0, no errors.

- [ ] **Step 5: Manual end-to-end verification**

1. Launch/reload the extension: from the main VSCode window press **F5** ("Run Extension"), or in the existing **[Extension Development Host]** window run `Ctrl+Shift+P → Developer: Reload Window`.
2. Open the Mission Control sidebar → click **⏮ Orchestrator — ทำต่อ**.
3. **Every project card shows a `☆`** at the far left (name + git button unchanged, in place).
4. Click the `☆` on a project (e.g. `rpn`): it turns into a gold **`★`** AND the card **jumps to the top** of the list. It must **NOT** open/select the project (no team-picker screen).
5. Star a second project (e.g. `lumen-exchange`): it also floats up; within the starred group the order follows the existing sort (more-recent / more-sprints first).
6. Click a `★` again: it un-stars and the card **drops back** to its normal sorted position.
7. Close the panel, reopen via **⏮ ทำต่อ**: the previously starred projects are **still starred and still on top** (globalState persisted across panel open/close).

- [ ] **Step 6: Commit**

```bash
cd extension && git add src/webview/orchestrator.ts \
  && git commit -m "feat(orchestrator): render star toggle on project cards, float starred to top"
```

---

## Self-review

- **Spec coverage:** globalState persistence (Task 2 key+accessors) · starred-first partition at push time, `sortResumable` untouched, display-only `ordered` local (Task 2 Step 3) · await `update` (Task 2 Step 5) · thread context (Task 2 Steps 4/6) · pure helpers + tests (Task 1) · star as sibling `<span role="button">` not inside `.pick` (Task 3 Step 2) · stopPropagation + skip guard (Task 3 Step 3) · CSS (Task 3 Step 1) · continue-only scope = inherent (new mode has `projects: []`). All spec sections map to a task.
- **Placeholders:** none — every code step shows full code; every run step shows the exact command + expected output.
- **Type consistency:** `starredList(): string[]` → `toggleStar(string[], string): string[]` → `setStarred(string[])`; `new Set(starredList())` → `partitionStarred(ResumableProject[], ReadonlySet<string>)`; `STARRED_KEY` used identically in `starredList`/`setStarred`; item field `starred` emitted in Task 2 Step 3, read as `it.starred` in Task 3 Step 2; `openOrchestratorPanel(mode, context)` new signature matched at both call sites (Task 2 Steps 4 + 6). Consistent.

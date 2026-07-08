# Project Star / Favorite — Design Spec

_2026-07-06 · Mission Control VSCode extension_

## Goal

On the **"⏮ ทำต่อ — เลือก project ค้าง"** project-selection list, let the user **star (favorite)** a project. Starred projects always float to the **top** of the list. A star is a **per-user preference**, not project data.

## Current state (before)

- The screen is rendered by `pushProjectsScreen()` → posts `screen_projects` → client `renderProjects(m)`.
  - `pushProjectsScreen`: `extension/src/webview/orchestrator.ts:47-68`
  - `renderProjects`: `extension/src/webview/orchestrator.ts:406-440`
- The project list = `_st.projects`, produced by `scanResumableProjects()` (filesystem walk) and already sorted by `sortResumable()` (lastRun ↓ → sprintDocs ↓ → name).
  - `sortResumable`: `extension/src/commands/orchestratorResume.ts:106-113`
- Each card is a `.card[data-path]`; **whole-row click** posts `pick_project`, except when the click hits `.git-act` / `.git-editor` (guard at `orchestrator.ts:435`). Git buttons already use `e.stopPropagation()` (`orchestrator.ts:443`).
- **No star feature exists.** There is a `badge-last` "⭐ ทำล่าสุด" + `.default` float-to-top **only on the team picker** (`pushTeamsScreen` reorder at `orchestrator.ts:74-76`, badge at `orchestrator.ts:473`) — a direct precedent to mirror, but nothing at the project level.
- `openOrchestratorPanel(mode)` (`orchestrator.ts:143`) does **not** receive `ExtensionContext`. Called at `extension.ts:49-54`. Module-level state: `_panel`, `_st`.
- The webview is a stateless HTML template string re-rendered from `postMessage` each time (no `getState`/`localStorage`), so any toggle must round-trip to the extension host to persist.

## Design (after)

### 1. Persistence — VSCode `globalState`
- One key: **`missioncontrol.starredProjects`** = `string[]` of absolute project paths (`p.path`). Naming matches existing keys (`missioncontrol.currentProjectId`, `missioncontrol.setupCompleted`, `missioncontrol.monthlyCapUsd`). Define it as an **exported constant** (e.g. `STARRED_PROJECTS_KEY`), matching the stronger precedent `PROJECT_STATE_KEY` (`projectState.ts:35`) / `MONTHLY_CAP_KEY` — not an inline string.
- Rationale: a star is the user's personal "show this on top" preference — not a property of the project. globalState keeps it per-user, off the project files, out of git commits, and stable even if `.orches-meta.json` is rewritten. (Chosen over `.orches-meta.json` per-project.)
- Trade-off accepted: per-machine (not synced across machines).

### 2. Thread `ExtensionContext` in
- `openOrchestratorPanel(mode)` → `openOrchestratorPanel(mode, context)`. Store in a module var `_ctx: vscode.ExtensionContext | undefined`.
- `extension.ts:49-54`: pass `context` in both `orchestratorNew` / `orchestratorContinue` registrations (`context` is in scope in `activate`).

### 3. Sort — starred-first partition at push time (NOT in `sortResumable`)
- In `pushProjectsScreen`, **after** the `annotateLiveState(projects)` call (`orchestrator.ts:49`), read the starred set, then **stable-partition** into `[...starred, ...unstarred]`, preserving each group's existing order — **generalizing** the team-picker float (`orchestrator.ts:74-76`) from one default team to a *set* of starred paths (structurally the same stable two-group partition, not identical code).
- Partition into a **display-only local const**; leave `_st.projects` in its canonical `sortResumable` order. `pick_project` resolves by path (`_st.projects.find(x => x.path === msg.path)`, `orchestrator.ts:174`), so display order is irrelevant to selection — no functional risk.
- `sortResumable` (pure, unit-tested) is **left untouched** — the user-preference concern stays in the render layer only.
- Pure helper in `orchestratorResume.ts` (keeps the "no vscode/fs, unit-testable" ethos of that file): `partitionStarred(list, starredSet) → ResumableProject[]`. This one earns a test (stable-sub-order invariant). `toggleStar` (below) is thinner — kept for symmetry with the file's convention, but inlining it in the handler is an acceptable alternative.

### 4. Toggle flow
```
click ☆/★ on a card
  → e.stopPropagation()  (do NOT trigger pick_project)
  → post('toggle_star', { path })
host handler "toggle_star":
  → read globalState list → toggleStar(list, path) → await globalState.update(...)
  → await pushProjectsScreen(panel)   // re-render; starred card floats to top
```
- **`await`** the `globalState.update(...)` (durability; consistent with `budget.ts:77`). Note: `Memento.get()` reflects the update synchronously from its in-memory cache, so the immediate re-partition is already correct — the `await` is for persistence, not ordering. (Stated so an implementer doesn't chase a phantom ordering bug elsewhere.)
- `toggleStar(list: string[], path: string): string[]` — pure helper in `orchestratorResume.ts` (add if absent, remove if present; returns a new array).
- Because **every existing action** (`git_*`, `back`) already re-calls `pushProjectsScreen`, the star ordering is preserved automatically after any of them — no extra wiring.

### 5. Wire-item + render
- Add `starred: boolean` to the mapped item in `pushProjectsScreen` (`orchestrator.ts:57-66`): `starred: starred.has(p.path)`.
- `renderProjects` (`orchestrator.ts:425-428`): add the star as the **first child of `.card`** — a **sibling of the `<div style="flex:1">`** that wraps `.pick` (i.e. at the far-left of the whole row, matching the mock). **⚠️ NOT inside the `.pick` `<button>`** — a nested interactive element is invalid HTML (`orchestrator.ts:426` renders the name inside a real `<button class="pick">`, styled at `:309`) and the browser would auto-close the outer button and corrupt the card.
  - Use a **non-button** element: `<span class="star" role="button" aria-pressed="…" title="ปักดาว / เอาดาวออก">★|☆</span>`.
  - `★` gold when starred, `☆` muted when not. Add a `.star` CSS rule (mirror the chip/badge vibe).
- Click wiring (in the `.card` loop, `orchestrator.ts:430-439`): add the star's own click listener with `e.stopPropagation()` → `post('toggle_star',{path})`. The `stopPropagation` alone already prevents the row's `pick_project` (the row listener is on the ancestor `.card`); adding `.star` to the skip guard at `orchestrator.ts:435` is redundant but matches the house style (git buttons do both). Optional — keep for consistency.

### 6. UI mock
```
★  lumen-exchange       ทำไปแล้ว 7 sprint                    ✓ up to date   ← starred group (gold)
★  rpn                  ทำไปแล้ว 1 sprint                    Commit (1) ▾       (sub-order = lastRun, unchanged)
────────────────────────────────────────────────────────────────────────────
☆  agentskill-marketplace-v4   🔨 ค้าง 4 sprint · ทำ 1/5     Commit (1) ▾   ← unstarred group (muted)
☆  scientific-calculator       ทำ 3/3 sprint                 ✓ up to date       (existing order preserved)
☆  missionControl              🔨 ค้าง 3 sprint              Commit (12) ▾
```

## Files changed (4)
| File | Change |
|---|---|
| `extension/src/extension.ts` (49-54) | pass `context` → `openOrchestratorPanel("new"/"continue", context)` |
| `extension/src/webview/orchestrator.ts` | add `_ctx`; `openOrchestratorPanel(mode, context)`; in `pushProjectsScreen` read set + `partitionStarred` + `starred` wire field; render star button; `.star` skip guard; `toggle_star` handler |
| `extension/src/commands/orchestratorResume.ts` | pure helpers `toggleStar(list, path)` + `partitionStarred(list, starredSet)` |
| `extension/src/commands/orchestratorResume.test.ts` | unit tests for both helpers |

## Edge cases
- **Path matching:** exact string equality on `p.path` (absolute); both scan and `data-path`/toggle use the same source string, so no normalization needed.
- **git ops / back:** already re-call `pushProjectsScreen`; star order re-applies for free.
- **`annotateLiveState` mutates `_st.projects` in place** each render — partition operates on the same objects; fine.
- **Stale starred paths** (project deleted/renamed): `has()` just returns false; the dead entry sits unused in globalState. Not pruned (YAGNI).
- **Multiple Extension Development Host windows:** globalState is shared per-user, but another window only reflects a toggle on its next render. Acceptable.
- **`_ctx` undefined** (defensive): if context somehow missing, treat starred set as empty and skip persistence — never throw.

## Testing
- **Pure unit (bun, `orchestratorResume.test.ts`):**
  - `toggleStar`: adds when absent, removes when present, idempotent round-trip, does not mutate input.
  - `partitionStarred`: starred-first; preserves sub-order within each group; empty set → unchanged order; all-starred / none-starred.
- **Manual:** reload Extension Development Host → open "⏮ ทำต่อ" → click ☆ on a project → it becomes ★ and jumps to top → close & reopen the panel → star persists (globalState). Un-star → drops back into its normal sorted position. Clicking the star never selects the project.

## Out of scope (YAGNI)
- Drag-reorder, multiple priority levels, star groups/labels.
- Cross-machine sync of stars.
- Stars on "▶ เริ่มใหม่" (that flow has no project list — it goes straight to the team picker).
- Pruning stale starred paths.

## Review provenance

Adversarially reviewed (2026-07-06) against the real source by 3 independent lenses — correctness/edge-cases, code-fit (file:line accuracy), and simplicity/scope. All three verdicts: **sound and implementable, references accurate**. One `should-fix` (nested-`<button>` in the render step) and the `nice-to-have` polish (await `update`, display-only partition, exported key constant, "generalizing" wording) are folded above. Verified non-issues: click-propagation double-defense, path identity, `annotateLiveState` in-place mutation, toggle-driven re-sort, empty list, `_ctx` singleton threading.

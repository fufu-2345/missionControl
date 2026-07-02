# /orches v2 (Oracle-as-Orchestrator) — Implementation Plan

> **For agentic workers:** implement task-by-task. Steps use `- [ ]` checkboxes.

**Goal:** Redesign `/orches` so a real oracle (not the main Claude chat) is the orchestrator, per `docs/superpowers/specs/2026-07-02-orches-oracle-orchestrator-design.md`.

**Architecture:** Split into `/orches` (chat bootstrap shim) + `/orches-drive` (oracle-run loop). Both live in a new `fufu-2345/orches-skills` git repo, symlinked into `~/.claude/skills/`. The orchestrator is a budded oracle tagged `role: orchestrator` in a team.

**Tech Stack:** Markdown skills (Claude Code SKILL.md), bash (git/tmux/maw), maw CLI verbs only.

## Global Constraints
- **ZERO maw source changes.** Existing verbs/primitives only. If a gap needs maw source edits → STOP and re-scope.
- **Do not disrupt the live `brew` team** (bob/jack/john are running in tmux session `brew`). Do not `bring`/`up` `carbon` (same members) during dev.
- **During dev: offline only** — no GitHub repo creation/push (deferred to user; gh lacks `delete_repo` scope). Use local `git init` + `maw oracle scan`.
- **Reversible:** back up anything live before replacing (esp. `~/.claude/skills/orches`).
- Preserve v1 guardrails: verify gate/sprint, dispatch via `maw hey`/`tmux send-keys` (never `maw team send`), explicit cross-repo memory capture, `shutdown --merge` (not kill), absolute worktree paths, orchestrator excluded from its own worker pool.

---

### Task 1: Scaffold `orches-skills` repo (local)

**Files:**
- Create dir `~/Desktop/soulbrew/github.com/fufu-2345/orches-skills/` with `git init -b main`
- Create `orches-skills/skills/orches/SKILL.md`, `orches-skills/skills/orches-drive/SKILL.md`, `orches-skills/README.md`

- [ ] **Step 1:** `mkdir -p` the repo + `skills/orches` + `skills/orches-drive`; `git -C <repo> init -b main`.
- [ ] **Step 2:** Write `README.md` (what this repo is, symlink instructions, "no maw code" note).
- [ ] **Step 3 (verify):** `git -C <repo> status` shows the tree; dir layout correct.

### Task 2: Write `/orches-drive` skill (the loop)

**Files:** Create `orches-skills/skills/orches-drive/SKILL.md`

Content = the driving loop moved out of v1 (Steps 4–6 + final capture), rewritten for an oracle to run on itself:
- Frontmatter: `name: orches-drive`, description ("the orchestrator-oracle's build loop: discuss → sprint → dispatch → verify → merge → capture").
- Sections: (0) receive requirement directly from user; (1) **discuss** requirement first; (2) decompose → sprints (oracle decides count); (3) **plan gate** (semi-auto: print plan + block at prompt for yes/not-yet); (4) per role: `git worktree add`, dispatch via `maw hey <member>` (fallback `tmux send-keys`), poll `.orches-done` + `rev-list`, verify gate (tests), `git merge`, harvest, checkpoint, cleanup; (5) between-sprint **cadence** (auto self-loop vs checkpoint report+wait — user-selectable); (6) close: integration test, ask push, `shutdown --merge`; (7) **explicit** `oracle_trace`+`oracle_learn`+`/rrr` into own ψ.
- Guardrails block (copy from spec §8), incl. exclude-self-from-workers + absolute paths + `maw hey` not `team send`.

- [ ] **Step 1:** Write the SKILL.md with all sections above.
- [ ] **Step 2 (verify):** frontmatter has `name`+`description`; the loop references `.orches-done`, verify gate, `shutdown --merge`, explicit capture. `grep` confirms each guardrail keyword present.

### Task 3: Write `/orches` v2 bootstrap skill (thin shim)

**Files:** Create `orches-skills/skills/orches/SKILL.md`

Content = thin bootstrap (chat runs it):
- Frontmatter `name: orches`, description (v2: bootstrap that hands off to an orchestrator oracle).
- Steps: (1) `/orches` with no requirement → list teams (`ls ~/.maw/teams/*/oracle-members.json`), choice-box which team; (2) read roster, filter `role: orchestrator` → 0=offer bud/borrow, 1=auto, >1=choice-box; (3) ensure project repo under `soulbrew/github.com/fufu-2345/projects/<name>/`; (4) `maw team bring <team>`; (5) open terminal attached to orchestrator pane (extension attach / `maw attach`); (6) **detach** — report + stop (no polling).
- Note: the orchestrator runs `/orches-drive` from its own persona/CLAUDE.md when handed a build (documented in Task 5 persona).

- [ ] **Step 1:** Write the SKILL.md.
- [ ] **Step 2 (verify):** frontmatter valid; steps end at "detach" (no drive loop in this file — it's in orches-drive). `grep` confirms `maw team bring` + `role: orchestrator` + no `git merge` (drive-only).

### Task 4: Symlink into `~/.claude/skills/` (new skill only; defer /orches cutover)

**Files:** `~/.claude/skills/orches-drive` (new symlink)

- [ ] **Step 1:** Back up current live v1: `cp -r ~/.claude/skills/orches <scratchpad>/orches-v1-backup`.
- [ ] **Step 2:** `ln -s <repo>/skills/orches-drive ~/.claude/skills/orches-drive` (new, no conflict).
- [ ] **Step 3 (verify):** `ls -l ~/.claude/skills/orches-drive` resolves to the repo file; `readlink -f` correct.
- [ ] **Step 4 (DEFER — do NOT run):** `/orches` cutover = `mv ~/.claude/skills/orches{,.v1}; ln -s <repo>/skills/orches ~/.claude/skills/orches`. Leave for user (replaces working v1). Document the exact command.

### Task 5: Scaffold orchestrator oracle (offline, no GitHub)

**Files:** `~/Desktop/soulbrew/github.com/fufu-2345/foreman-oracle/` (local repo) + a team roster

Offline scaffold (avoid `maw bud`'s `gh repo create`):
- [ ] **Step 1:** `mkdir -p foreman-oracle/ψ/memory/{learnings,retrospectives,traces,resonance,collaborations}` + `ψ/{inbox,outbox,plans}`; `git init -b main`.
- [ ] **Step 2:** Write `foreman-oracle/CLAUDE.md` = orchestrator identity/persona: "I am foreman, an orchestrator oracle. When handed a build requirement, I run `/orches-drive`." + Oracle principles + inbox/rrr discipline + the driving guardrails.
- [ ] **Step 3:** Write `foreman-oracle/.claude/settings.json` mirroring bob-oracle's (SessionStart+Stop → status-reporter.sh + oracle-memory.sh). Copy from bob-oracle as template.
- [ ] **Step 4:** `git -C foreman-oracle add -A && commit` (local only, no push).
- [ ] **Step 5:** `maw oracle scan` → foreman appears in `~/.maw/oracles.json` (`has_psi:true`).
- [ ] **Step 6:** Create a dev team roster (NOT carbon): `maw team oracle-invite foreman --team orch-dev --role orchestrator` (creates roster if needed). Do NOT invite bob/jack/john (avoid brew collision) — workers TBD by user later.
- [ ] **Step 7 (verify):** `maw oracle ls` shows foreman; `~/.maw/teams/orch-dev/oracle-members.json` lists foreman with role orchestrator.

### Task 6: Static/dry smoke test

**Files:** `<scratchpad>/orches-v2-smoke.sh`

- [ ] **Step 1:** Write a smoke script asserting: both SKILL.md have valid frontmatter (name+description); `~/.claude/skills/orches-drive` symlink resolves to repo; `orches-skills` git tree clean/committed; foreman in `maw oracle ls`; foreman tagged `role:orchestrator` in orch-dev roster; a fresh isolated throwaway tmux+claude is NOT launched (skip — too heavy/risky); `brew`/`carbon` untouched (`maw ls` still shows brew intact).
- [ ] **Step 2:** Run it; all assertions pass.
- [ ] **Step 3 (verify):** exit 0; print a checklist of what passed.

### Task 7 (DEFERRED — needs user): GitHub + cutover + live e2e
Document (do NOT execute):
- [ ] Create + push GitHub repos: `orches-skills`, `foreman-oracle` (confirm names; gh needs `delete_repo` if mis-created).
- [ ] `/orches` live cutover (Task 4 Step 4).
- [ ] First live end-to-end run (real requirement, watch capture-pane; STOP if a gap needs maw source).

---

## Self-Review
- **Spec coverage:** G1 (foreman = oracle w/ ψ, Task 5) · G2 (role-tagged member, multiple by name, Task 5/3) · G3 (gate + cadence in orches-drive, Task 2) · G4 (bring+attach+detach, Task 3) · zero-maw (all tasks) · storage (repo+symlink, Task 1/4).
- **No live disruption:** Tasks avoid carbon/brew; offline scaffolding; v1 backed up + cutover deferred.
- **Placeholders:** none — each task has concrete commands + verify.

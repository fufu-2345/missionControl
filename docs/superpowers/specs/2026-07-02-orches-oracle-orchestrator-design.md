# /orches v2 — Oracle-as-Orchestrator — Design

**Status:** Design approved (brainstorming complete) · awaiting user spec review → implementation plan
**Date:** 2026-07-02
**Supersedes:** the current `/orches` where the *main Claude chat session* is the orchestrator.

> **TL;DR (TH):** ยกเครื่อง `/orches` ให้ตัว "orchestrator" ไม่ใช่แชทอีกต่อไป แต่เป็น **oracle จริง** ที่ขับ build เอง มี ψ/memory/identity ของมัน · แชทเหลือแค่ "จุดติดเครื่อง" (เลือกทีม → ปลุก → attach → ถอย) · **ไม่แก้ source ของ maw เลย** (verified read-only investigation, 5 probes).

---

## 1. Motivation

The current `/orches` makes the **main Claude chat** the orchestrator: it reads the requirement, breaks it into sprints, dispatches to worker oracles via `tmux send-keys`, polls, verifies, and merges. This couples every build to a live chat session — close the chat and the build stops; the orchestrator has no persistent memory of how it worked with the user; and there can only ever be "one" orchestrator (the chat).

We want the orchestrator to be a **first-class oracle**: a persistent, named agent with its own ψ memory that improves across runs, that the user can wake and talk to directly, decoupled from any chat session. This was validated as feasible with **zero maw source changes** (see §10).

## 2. Goals & Non-Goals

**Goals (locked with user):**
- **G1 — Orchestrator has its own identity + memory.** It is a real budded oracle with a ψ vault; its `oracle_learn`/`oracle_trace`/`/rrr` persist across runs so it gets better at orchestrating *and* remembers how it works with the user.
- **G2 — Multiple orchestrators per project.** A project/team can have more than one orchestrator (including temporarily *borrowed* ones). You select one per run. **v1 runs exactly one active orchestrator per run, used until it closes** — no parallel orchestrators yet (disjoint git worktrees if ever parallelized later).
- **G3 — Semi-autonomous with an unattended mode.** Default is a per-sprint gate: the orchestrator asks "drive sprint N now?" and blocks. The user can also run it unattended (auto-loop through N sprints back-to-back, e.g. overnight).
- **G4 — Decoupled from the chat.** The orchestrator is a persistent tmux/inbox entity the user wakes and talks to directly. The chat is needed **only for the very first cold-start**; steady-state has the chat fully out of the loop.

**Non-Goals (v1):**
- Parallel/concurrent orchestrators coordinating on one project.
- A dedicated crontab/scheduled-kickoff mode (**backlog** — do not preclude it, but do not build it).
- A formal approval-queue UI for the gate (rejected: the natural pane-blocking prompt is enough; a UI re-couples the chat).
- **Any change to maw's source code** (hard constraint).

## 3. Architecture Overview

Split the single `/orches` skill into two:

| Skill | Runs in | Role |
|---|---|---|
| **`/orches`** (bootstrap shim) | the main Claude **chat** | pick team → pick orchestrator → `maw team bring` → attach the user to the orchestrator's pane → **detach** |
| **`/orches-drive`** (drive loop) | the **orchestrator oracle** (its own pane) | discuss requirement → break into sprints → dispatch/poll/verify/merge → capture memory |

**Entities:**
- **orchestrator = an oracle** created with `maw bud <name> --org fufu-2345`, tagged in a team roster with `role: orchestrator`.
- **team = worker oracles + orchestrator(s)** as members (this is the `oracle-council` shape, which already has an `orchestrator-oracle` member).
- **workers** = the team's other oracle-members (e.g. `carbon` = bob/jack/john), reincarnated via `maw team bring` (persistent, memory-bearing).

**Storage:** both skills live in a **new dedicated git repo `fufu-2345/orches-skills`** (backed up to GitHub) and are **symlinked** into `~/.claude/skills/` (so every oracle pane sees them, and there is no copy-drift — the drift that already produced a stray un-git `soulbrew/claude-skills/orches` copy).

## 4. Detailed Flow

### 4.1 Cold-start (chat runs `/orches`)
1. User runs `/orches` **with no requirement argument**.
2. Chat lists oracle-teams (`ls ~/.maw/teams/*/oracle-members.json`) and asks **which team** (choice box).
3. Chat reads the roster; filters members with `role: orchestrator`:
   - **0 orchestrators** → offer to `maw bud <name> --org fufu-2345` a fresh one (guided) + invite it to the team, or borrow/promote an existing oracle. (Do not auto-create silently.)
   - **1 orchestrator** → auto-select it.
   - **>1** → ask which (choice box).
4. Chat ensures the project repo exists at `soulbrew/github.com/fufu-2345/projects/<name>/` (`git init -b main` + `.gitignore` incl. `agents/`, `.orches-notes.md`, `.worktrees/`) — or defers this into the orchestrator's first task.
5. Chat `maw team bring <team>` (wake persistent members: orchestrator + workers).
6. Chat **opens a terminal attached to the orchestrator's pane** (reuse the extension's "Open Claude" attach mechanism / `maw attach <orchestrator>` / `tmux attach`).
7. Chat **detaches** — reports "orchestrator `<name>` is live at tmux `<session>`" and stops. It does not poll.

### 4.2 Drive (orchestrator runs `/orches-drive`)
The hand-off prompt (injected by `maw wake <orch> -p "..."` or typed by the user after attach) tells the orchestrator to run `/orches-drive`. Then, in its own pane:
1. **Receive requirement directly from the user** (inline / file / URL).
2. **Discuss** the requirement with the user first — clarify scope, constraints, acceptance — before decomposing.
3. **Decompose** into tasks and group into sprints. **The orchestrator decides the number of sprints itself.**
4. **Plan gate (HARD GATE):** present the plan (project, sprints, role→worker assignment) and — in semi-auto mode — **block at its own prompt** for the user's `yes` / `not-yet (discuss)`. The user reaches the prompt by attaching the pane or via `maw hey <orch> "yes go"`.
5. **Per role in the sprint:**
   - `git -C <project> worktree add agents/<role> -b agents/<role>`
   - Dispatch to the assigned worker via `maw hey <member> "<task + absolute worktree path + acceptance>"` (signed, identity-aware pane injection) — raw `tmux send-keys` is the fallback for answering mid-task questions.
   - **Poll** the `.orches-done` sentinel file at the worktree root (+ `tmux capture-pane` tail); `git rev-list --count main..agents/<role>` > 0 confirms real commits.
   - **Verify gate:** worktree clean + run tests/acceptance. Fail → `send-keys` a fix request into the same pane; do **not** merge.
   - **Merge:** `git -C <project> merge agents/<role> --no-edit` → main.
   - Harvest `.orches-notes.md`; ensure the worker captured to its own ψ (`oracle_learn`/`oracle_trace`/`/rrr`).
   - Checkpoint `docs/sprint-N.md`; clean up the worktree.
6. **Between sprints (hybrid cadence, user-selectable per run):**
   - **checkpoint mode** (= the gate): report the finished sprint, block, wait for the user to say "next".
   - **auto mode**: skip the gate and self-loop into the next sprint immediately (the orchestrator runs permission-free, so it just continues) — this is the unattended/overnight path.
7. **Close:** integration test on main → ask the user (choice box) whether to push to GitHub (`gh repo create`/`git push`) → each member `/rrr` → `maw team shutdown <team> --merge` (preserve memory, **do not kill**).
8. **Orchestrator memory capture (mandatory):** `oracle_trace` + `oracle_learn` + `/rrr` into **its own ψ** (explicit capture — see §5). This is where G1's cross-run learning accrues.

## 5. Memory Model (G1)

The orchestrator uses the **standard oracle memory layers** exactly like any oracle — there is **no dedicated "orch-lead" vault** (that concept was rejected and the empty scaffold was removed). Its `oracle_learn`/`oracle_trace` land in the central `~/.oracle` store (indexed, searchable via `oracle_search`); its `/rrr` retros land in its ψ vault.

**Cross-repo capture caveat (carried over):** the `oracle-memory.sh` Stop hook keys off the cwd's ψ vault. The orchestrator drives from the *project* repo (not its own oracle repo), so the passive hook will not auto-capture into its own ψ. Therefore `/orches-drive` **must** perform **explicit** `oracle_learn`/`oracle_trace`/`/rrr` at sprint and run boundaries (the current skill already mandates this for workers; it now also binds the orchestrator).

## 6. Interaction Model (G3 + G4)

- **Gate (G3 semi-auto):** the orchestrator is a Claude session; to "ask and wait" it simply prints the question and blocks at its prompt. The user answers by attaching the pane (types directly) or remotely via `maw hey <orch> "..."`. No maw primitive needed; no chat needed.
- **Unattended (G3):** "auto mode" = the drive skill skips the gate and self-loops sprint→sprint. crontab-triggered scheduling is a **backlog** third mode.
- **Decoupled (G4):** find it with `maw ls` / `maw oracle ls`; talk to it with `maw attach <orch>` or `maw hey <orch> "..."`; resume a slept orchestrator with `maw wake <orch> -p "..."` (it reloads its ψ, so it remembers prior sprints). The chat is only needed to cold-start the very first run.

## 7. Orchestrator Lifecycle & Multiplicity (G1 + G2)

- **Create (primary path):** `maw bud <name> --org fufu-2345` scaffolds a full oracle (GitHub repo `<name>-oracle`, ψ vault, `.claude/settings.json` with hooks, fleet config). Give it an orchestrator persona via `/awaken` or by editing its `CLAUDE.md`. Invite to a team with `maw team oracle-invite <name> --team <t> --role orchestrator`.
- **Borrow (temporary):** tag an existing oracle as orchestrator for one run via `oracle-invite --role orchestrator`, then `oracle-remove` after. Pure JSON roster edits.
- **Multiplicity:** multiple orchestrators may be *registered/available*; the user picks one per run. **v1: exactly one active orchestrator per run**, used until it closes. No parallel orchestration. "Main vs borrowed" is **pure convention** (naming + team membership) — maw enforces no such distinction.

## 8. Constraints & Guardrails

**Hard constraint:** **zero maw source changes.** Everything uses existing verbs/primitives (`maw bud`, `maw team bring/oracle-invite/shutdown --merge`, `maw wake -p`, `maw hey`, `maw attach`, raw `tmux`, `git`). If the first live run reveals a gap that *requires* editing maw source, **STOP and re-scope** — do not edit maw.

**Guardrails preserved from v1:**
- Verify gate every sprint — no merge / no next sprint on failure.
- Dispatch live via `maw hey` / `tmux send-keys` — **never** `maw team send` (that is inbox-only, does not inject).
- Explicit memory capture (cross-repo) — passive hooks won't fire from the project repo.
- Teardown = `maw team shutdown --merge` (preserve memory), **not** kill-by-PID.
- Worker prompts pin the **absolute** worktree path.
- Orchestrator is **excluded from its own worker pool** (recursion/self-dispatch hazard; `maw hey` filters `agentType: team-lead`, scheduler guards `target==self`, but the skill must also enforce it).

**Operational preconditions:**
- Oracles must launch with `--dangerously-skip-permissions` (the live `maw.config.50.json` `commands.default` already does this) — do **not** run oracles as root (uid-0 strips the flag), or autonomy breaks on permission prompts.
- `maw serve` (localhost:3456) should be up for reliable busy-guard/DispatchEngine auto-delivery during unattended runs.

## 9. Testing Approach

The oracle-driven loop has **never run end-to-end** (the v1 chat-driven loop hasn't either). The **first oracle-driven run is a live-test**, watched closely via `tmux capture-pane`:
1. Unit-ish: bootstrap shim picks team/orchestrator, brings, attaches, detaches correctly (dry-run the maw commands first).
2. Integration (the real test): one small requirement, one orchestrator (`foreman`), a 1–2 sprint build, semi-auto gate, verify + merge, memory capture. Watch every dispatch/poll/merge.
3. Then exercise auto mode (2+ sprints unattended) on a throwaway build.
- If any step needs a maw source change → stop (per §8).

## 10. Feasibility Evidence (read-only investigation, 2026-07-02)

Verified against maw source (`Soul-Brews-Studio/maw-js` v26.6.14-alpha) + live panes:
- **Oracles run `claude --dangerously-skip-permissions --continue`** (live proof: the running `bob` pane shows "bypass permissions on"); no permission wall → an oracle can freely run `tmux`, `git`, tests, `maw`.
- **No tmux pane isolation** (one per-user server) → an orchestrator-oracle can `send-keys`/`capture-pane` to any sibling worker pane, exactly like the chat does today.
- **Dispatch primitives already exist:** `maw hey`/`maw team hey`/`broadcast` inject into panes; `maw team send` is inbox-only (do not use for live dispatch). Server-side `DispatchEngine` auto-delivers queued work to idle workers.
- **arra-oracle MCP** is loaded top-level in `~/.claude.json` (no auth wall) → every oracle has `oracle_learn`/`oracle_trace`/etc.
- **`maw bud`** scaffolds a complete oracle (identity + ψ + hooks + fleet config) with no code change. Team rosters are plain JSON with arbitrary `role` strings; `oracle-council` already lists an `orchestrator-oracle` member — the G2 shape exists as data today.
- **`maw wake <oracle> -p "<prompt>"`** injects a prompt into the woken pane → the bootstrap→drive hand-off seam.
- **Global skills** are visible to every oracle pane (38 global skills confirmed) → a `/orches-drive` global skill works without editing any oracle's config.

**Residual risks:** capture-pane "done" detection is brittle (the `.orches-done` sentinel is load-bearing); unattended autonomy is timer/idle-based (no `sprint-complete` event in `maw on`); the whole loop is unproven end-to-end.

## 11. Open Items / Future

- **crontab mode (backlog):** a third, scheduled-kickoff mode. Leave room; do not build in v1.
- **Parallel orchestrators (future):** disjoint worktrees; needs cross-orchestrator coordination logic (maw has no primitive).
- **`orches-skills` repo bootstrapping:** create the repo, move `/orches` + add `/orches-drive`, set up the symlink into `~/.claude/skills/`, retire the stray `soulbrew/claude-skills/orches` copy.

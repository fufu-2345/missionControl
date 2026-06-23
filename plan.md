# Plan — Consolidate agent memory (ψ) into one repo

> **Status: DECISION PENDING** — not decided yet (2026-06-22). This doc captures the
> options so we can pick later. Detailed Thai version: `mdFile/agent-memory-one-repo-th.md`.

---

## The goal

Push the memory (`ψ/`) of every agent into **one single repo**, **without changing the
current structure** (don't move `ψ/`, don't restructure the oracle repos).

---

## Current state (the facts)

`~/Desktop/soulbrew/github.com/fufu-2345/` holds 4 independent oracle repos, each with its
own `.git` + GitHub remote, and a `ψ/` memory folder:

```
bob-oracle/   .git → fufu-2345/bob-oracle    + ψ/   + agents/ (subagents)
jack-oracle/  .git → fufu-2345/jack-oracle   + ψ/
john-oracle/  .git → fufu-2345/john-oracle   + ψ/
mike-oracle/  .git → fufu-2345/mike-oracle   + ψ/
```

⚠️ **Right now every `ψ/` is UNTRACKED** (`git status` → `?? ψ/`, not even gitignored).
So **agent memory is NOT pushed anywhere — it only exists on this machine.**
Consolidating it is also the first real backup.

---

## The blocker (why the "obvious" way fails)

Tried: one overlay git repo whose work-tree is the parent `fufu-2345/`, tracking all four
`ψ/` in place. **Verified it does NOT work.** Git treats each oracle dir as an embedded
repo (it contains `.git`) and refuses to descend into it → `git add bob-oracle/ψ` adds nothing.

➡️ A single *live* git index over all four `ψ/` folders **in place** is not cleanly possible
while each `ψ/` sits inside its own oracle repo. So we have two realistic options:

---

## Option A — Central repo + sync  ✅ (recommended)

A new repo `oracle-memory` with a subfolder per agent. A small script `rsync`s each `ψ/`
into it, then commits + pushes. Original `ψ/` folders and oracle repos are **never touched**.

```
bob-oracle/ψ/   ─┐  rsync (copy contents)     ~/.oracle-memory/
jack-oracle/ψ/  ─┤  ─────────────────────────▶  ├── bob/ψ/
john-oracle/ψ/  ─┼─                             ├── jack/ψ/   ──push──▶ fufu-2345/oracle-memory
mike-oracle/ψ/  ─┘  (originals stay in place)   ├── john/ψ/
                                                └── mike/ψ/
```

**Why it works:** `rsync` copies only the *contents* of `ψ/` (the oracle's `.git` lives
*outside* `ψ/`, so it's never copied). The destination has **zero nested `.git`** → it's a
plain working tree with one `.git` at the top → git tracks it normally. We sidestep the
repo-in-repo rule instead of fighting it.

Sync script:
```bash
#!/usr/bin/env bash
set -euo pipefail
SRC=~/Desktop/soulbrew/github.com/fufu-2345
DST=~/.oracle-memory
for o in bob jack john mike; do
  mkdir -p "$DST/$o"
  rsync -a --delete "$SRC/$o-oracle/ψ/" "$DST/$o/ψ/"
done
cd "$DST" && git add -A && git commit -m "memory sync $(date +%F_%H%M)" || true
git push
```

- **Pros:** one flat browsable repo (all agents side-by-side); oracle repos untouched;
  scales trivially to new/sub agents (add one line to the loop); matches the existing
  auto-index-hook pattern (can be automated on a `Stop` hook).
- **Cons:** it's a **copy**, so you end up with 2 copies of each `ψ/` (original = source of
  truth; copy = mirror that gets pushed). Disk cost is negligible (~40–140 KB each). GitHub
  reflects memory as of the last sync, not live.

---

## Option B — One repo, branch per agent (in place)

Give each oracle a **second git-dir** (e.g. `~/.mem/bob.git`) with work-tree = the oracle
folder, tracking **only `ψ/`**. Each pushes to the same `oracle-memory` repo on its own
branch (`bob`, `jack`, …). Add `ψ/` to each oracle's `.gitignore` so its own repo ignores it.

```
bob-oracle/
├── .git           → tracks CODE → fufu-2345/bob-oracle  (ignores ψ/)
└── ~/.mem/bob.git → tracks ONLY ψ/ → oracle-memory, branch "bob"
```

- **Pros:** live, commits in place, **no copy / no duplicate**.
- **Cons:** 4 separate git-dirs to manage; "see all memory" = switching branches (not a flat
  tree); needs a new git-dir + branch for every new agent; most maw/oracle tooling assumes a
  single working tree.

---

## Rejected — submodule / symlink

Both **change the structure** (`ψ/` becomes a submodule or a symlink) and tend to break
maw/oracle tooling that expects `ψ/` to be a real folder. Violates the "don't change
structure" requirement → not considered.

---

## Subagents — how each plan behaves

Today, subagents live under e.g. `bob-oracle/agents/1-cli`, `1-core`, `1-tests`. Key facts:
they are **their own nested git repos** and have **no `ψ/` of their own** — the memory about
them lives in the parent's `ψ/` (`ψ/teams/`, `ψ/memory/collaborations/`).

- **Both plans only handle the top-level oracle's `ψ/`.** Subagent code in `agents/` is not
  memory and is out of scope; their nested `.git` is simply ignored (neither plan tries to
  reach into it), so nothing breaks. The parent's record of the team IS captured (it's in `ψ/`).
- **Future "what if" — a subagent gets its OWN `ψ/`** (e.g. a permanent budded oracle):
  - **Plan A:** add one line to the loop → handled. The copy sidesteps the nested `.git`.
  - **Plan B:** needs another git-dir + branch, and the nested-`.git` wall returns (the
    subagent's `ψ/` sits behind its own `.git`, so it needs its own memory brain too).
  - ➡️ For a bud-style setup where agents appear over time, **A scales more gracefully.**

---

## Recommendation & next step

**Lean Plan A.** When ready to proceed:
1. Create an empty GitHub repo `fufu-2345/oracle-memory`.
2. Then: clone to `~/.oracle-memory/`, drop in the sync script, run it once, optionally wire
   it to a `Stop` hook. (Can be set up on request.)

(If "no duplicate / live commits" turns out to matter more than easy browsing + scaling,
switch to Plan B.)

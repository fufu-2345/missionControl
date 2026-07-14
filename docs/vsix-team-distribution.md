# MissionControl — .vsix packaging & team distribution

> Handoff note for a future AI/dev. Written 2026-07-14 during a "will there be
> problems?" scoping chat. NOTHING here has been implemented yet — this is the
> analysis + plan only. Read this before starting the actual packaging work.

## Goal (as stated by the owner)

Package the MissionControl VSCode extension as a `.vsix` and hand it to the
company team so each teammate gets **the same experience as on the owner's
machine** ("full parity"). All teammates are on **Linux**. Everyone already has
Claude Code (`claude` CLI + token) installed.

## The one thing to understand first

MissionControl is **not a self-contained program**. It is a thin UI / remote
that shells out to host CLIs and reads/writes files in the user's home dir.
Pressing a button runs `maw` / `tmux` / `claude` / `gh` / `git` or reads
`~/.maw`, `~/.oracle`, `~/.claude`, `~/Desktop/soulbrew`. So "make it work on a
teammate's machine" is mostly a **provisioning problem**, not a packaging one.

**The `.vsix` is ~20% of parity. The other ~80% is provisioning the stack
(maw + oracle + soulbrew scaffold + skills + oracle identities) on each box.**

## Facts verified on the owner's machine (2026-07-14)

- Extension lives at `missionControl/extension/`. `agents/*/extension` are
  per-oracle worktree copies — ignore them, package only the top one.
- `out/` is compiled and newer than `src/` (main = `./out/extension.js`). OK.
- Code uses `os.homedir()` **everywhere** — it does NOT hardcode
  `/home/chillox-intern`. So paths auto-adapt to each teammate's home. Good.
- The ONLY hardcoded non-portable value is the GitHub org **`fufu-2345`**
  (`src/commands/teamsOps.ts:40`, `src/commands/claude.ts:19`). It is baked into
  `out/*.js` — a setup script cannot change it; only a code edit can.
  **If the team shares one GitHub org, this is fine and needs no change.**
- Common CLIs present on owner machine: `git`, `tmux`, `gh`, `bun`, `ollama`,
  `claude`. All installable via a script.
- `maw` is a **dev symlink**: `~/.bun/bin/maw -> .../maw-js/src/cli.ts` (runs TS
  source directly, dev-linked to the soulbrew tree). NOT a shippable build.
- `oracle` / `oracle-remove` / `oracle-invite` are **not on PATH even on the
  owner's machine** — so the extension buttons that shell them
  (`src/commands/teamsModel.ts`) are already broken locally. Parity bar is lower
  than it looks here; don't treat these as must-work.
- ollama has `qwen2.5:3b` + `nomic-embed-text`, **no `bge-m3`** → oracle vector
  search is already off (FTS only). Teammates will match this degraded state.
- WS backend (`:7001`) already removed — `src/ws.ts` is a no-op stub;
  `install`/`setup` commands are no-ops that show "backend disabled".

## Tier A — packaging blockers (must fix regardless of scope; ~10 min)

These make `vsce package` fail or produce a bad artifact:

1. **No `publisher` in `extension/package.json`** — `vsce package` hard-errors
   "Missing publisher name". Add `"publisher": "<something>"`.
2. **No `.vscodeignore`** — without it vsce tries to pack the whole 237MB dir
   (node_modules 235MB, `src/`, `*.test.ts`, `*.js.map`, `docs/`, `scripts/`,
   and **`ψ/memory/` = internal oracle notes**). Add a `.vscodeignore` to
   exclude source, tests, maps, ψ/, docs/, lockfiles.
3. **No `vscode:prepublish` script** — vsce won't auto-compile. Add
   `"vscode:prepublish": "npm run compile"` so the vsix never ships stale `out/`.
4. **Dead dependency `ws` + `@types/ws`** — `ws.ts` no longer imports it. Remove
   from `package.json`.
5. `@vscode/vsce` not installed — use `npx @vscode/vsce package`.

Non-blockers (warnings only): missing README.md / LICENSE / marketplace icon.
`"private": true` does NOT block `vsce package` (only blocks `npm publish`).
`"node": ">=18"` in `engines` is ignored by VSCode (harmless).

## Tier B — full parity requires provisioning each machine

A "Setup" button running a provision script is the right vehicle and covers
MOST of this. What it CAN and CANNOT do:

### Script CAN do
- Install CLIs: `git`, `tmux`, `gh`, `bun`, `ollama` (claude already present).
- Clone / scaffold `~/Desktop/soulbrew` (needs `.maw/teams/`, `ψ/teams/`,
  `github.com/fufu-2345/projects/`).
- Install skills into `~/.claude/skills/` — a starter exists at
  `soulbrew/claude-skills/install.sh`, but it currently installs only `orches`.
  **Must also install `orches-drive`**, since the extension calls
  `~/.claude/skills/orches-drive/orches-integrate.sh`
  (`src/commands/startOrchestrator.ts:565`).
- Create `~/.maw`, `~/.config/maw`, `~/.mission-control`.

### Script CANNOT do — prerequisites / decisions
1. **Make `maw` installable** (biggest blocker, and it is OUTSIDE the
   extension). Today maw is a dev symlink to the source tree. Until maw is
   published/packaged as a real artifact (`bun add -g maw-js` from a real
   source, or a bundled build), the setup button has nothing to install.
   Do this FIRST — everything else is empty without it.
2. **Oracle identity story.** Oracles (foreman/john/mike/bob/jack) have
   hand-crafted ψ soul files that are LOCAL-ONLY (only CLAUDE.md is pushed).
   Decide one:
   - Ship copies of the owner's soul files → every teammate gets identical
     oracle "souls" (true parity at t=0, then memories diverge per machine).
   - Each teammate `/awaken`s fresh oracles → different identities; the team
     member names the extension assumes may not match.
   Note: do NOT run `/awaken` over existing hand-edited identities — it clobbers
   them.
3. **`gh auth login`** — each teammate authenticates themselves; a credential
   can't be scripted. Also decide whether everyone operates on the shared
   `fufu-2345` org (if not, Tier C code change needed).

## Tier C — code changes (only if teammates need a DIFFERENT org)

If the team will NOT share the `fufu-2345` org, make the org a setting
(`~/.mission-control/config.json` already read by `src/commands/settingsOps.ts`)
and replace the two hardcoded constants. If the org IS shared, skip this.

## Recommended sequence

1. Make `maw` installable (un-dev-link, publish/package). Outside the extension,
   biggest piece. Verify a fresh machine can `install maw` and run `maw team`.
2. Decide the oracle-identity story (ship copies vs fresh awaken).
3. Write the provision script (install CLIs + maw + scaffold dirs + install
   skills incl. orches-drive).
4. Wire a real "Setup" button that runs the script — replace the current no-op
   `src/commands/setup.ts` / `install.ts`.
5. Do Tier A fixes and `npx @vscode/vsce package`.
6. (Optional) Tier C if org differs per teammate.

## Reality check to raise with the owner before building

"Parity on N machines" = N independent, stateful oracle+maw stacks, each with
its own ollama models, watchers, and diverging memory — heavier to maintain than
it sounds, and the backend was removed so there is no central/shared option
right now. If maintenance cost matters, reconsider whether a Claude-centric
subset (usage/budget dashboard + launch claude sessions in tmux + git ops) would
deliver most of the value with a setup script that genuinely covers 100%.

# Mission Control — tmux Sessions panel (design)

- Date: 2026-06-30
- Status: approved (brainstorming)
- Scope: single feature, single file (`extension/src/webview/dashboard.ts`)

## Overview

Add a **"Sessions"** section to the Mission Control dashboard webview that lists
running tmux sessions and lets the user click one to open a VSCode **editor-area**
terminal already **attached** to that session. Pure-local: it shells out to `tmux`
via `child_process` only — no backend, fits the frontend-only build.

Purpose: a "projects launcher" — each tmux session typically runs `claude`/`maw`
for a project, so the panel is a one-click way to jump into any of them.

## Goals

- List live tmux sessions in the dashboard, refreshed automatically.
- Click a session → open (or focus) an editor-area terminal attached to it.

## Non-goals (v1)

- No create/new session, no kill, no rename. (Sessions are created elsewhere:
  a terminal, or the workspace-up boot script.)
- The panel is **attach-only** — it never mutates session lifecycle.

## Placement

A new `Sessions` group inside the dashboard webview HTML in `dashboard.ts`, using
the existing `.card`/`.tile`/`.group-label` styling. Position: its own group near
the top (above `Workflow`). Each session renders as a clickable row.

## Data source (host side)

`pushSessions(panel)` in `dashboard.ts`:

- Run `tmux list-sessions -F '<fmt>'` via `child_process` with a short timeout
  (~700ms, mirroring `isPortUp`), where `<fmt>` is tab-separated:
  `#{session_name}\t#{session_windows}\t#{session_attached}\t#{pane_current_command}\t#{pane_current_path}`
  (tab delimiter avoids `|`-in-name collisions; tmux names rarely contain tabs).
- Non-zero exit / `no server running` → **empty list** (not an error).
- Parse into `Session[] = { name, windows: number, attached: boolean, cmd, cwd }`.
- Post `{ type: "sessions", sessions }` to the webview.
- Keep the last-pushed **set of names** in host memory for click validation.

## Interaction: click → attach (host side)

- Webview posts `{ type: "attach_session", name }`.
- Host **validates** `name` is in the last-pushed set (exact match); reject
  otherwise (guards against injection and stale rows).
- Maintain `Map<string, vscode.Terminal>` keyed by session name:
  - Entry exists and `exitStatus === undefined` → `.show()` (reuse/focus; no dup).
  - Otherwise `createTerminal({ name: "tmux: " + name, location: Editor })`, then
    run `tmux attach -t <name>` using the **clean-launch pattern from
    `claude.ts`** (`shellIntegration.executeCommand` when ready, else a delayed
    `sendText`, to avoid the double-echo race). Store the terminal in the map.
  - `onDidCloseTerminal` → delete the entry.

## Refresh

Piggyback the dashboard's existing 10s poll (`refreshLiveCards`) plus the existing
`Refresh` button and the initial `ready` message. **No new timer.**

## Row layout

```
SESSIONS
● carbon      2 win · claude     ~/…/bob-oracle
○ soulbrew    1 win · bash       ~/Desktop/soulbrew
```

- `●` green = a client is attached; `○` grey = detached.
- Secondary text = active pane's command + abbreviated cwd (helps identify the
  project). The whole row is clickable.
- Empty state when no sessions / no server: `(no tmux sessions running)`.

## Durability note (why this is safe)

tmux sessions are owned by the **tmux server** process whose parent is **pid 1
(systemd/init)** — not VSCode or this extension. Therefore:

- Closing the opened terminal, closing VSCode, or closing the dashboard only
  **detaches**; sessions survive.
- v1 has **no kill**, so the panel cannot end a session by mistake.
- Sessions vanish only if the tmux server dies (reboot / `kill-server` / OOM).
  This VM is configured `KillUserProcesses=no` + `Linger=yes`, so logout does not
  reap them; only a reboot does (handled separately by a workspace-up boot hook,
  out of scope here).

## Security / robustness

- Attach only to names present in the last-pushed set; reject any name containing
  a single quote. Single-quote the name in the `tmux attach -t '<name>'` command.
- Short tmux timeout; any failure → empty list; never throw into the webview poll.
- HTML-escape `name` / `cmd` / `cwd` on render (reuse the existing `escapeHtml`).

## Files touched

- `extension/src/webview/dashboard.ts` **only**: HTML section + client JS
  (render + row click) + `pushSessions` + `attach_session` handler + terminal map.
- No `package.json` change, no new command, no backend.

## Testing (manual)

1. Create 2-3 tmux sessions (some attached, some not) → open dashboard → all
   listed with correct attached dot + cmd/cwd.
2. Click a row → editor terminal opens attached; click again → focuses the same
   terminal (no duplicate).
3. Kill a session externally → it disappears within ~10s (next poll).
4. No tmux server → empty state, no error, dashboard unaffected.

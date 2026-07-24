# Mission Control — Bento UI redesign (main + left sidebar)

Date: 2026-07-24
Source design: `~/Downloads/Mission_Control_UI_Design.zip` → `design_handoff_mission_control/README.md` (Bento Grid, dark/light).

## Goal
Recreate the handed-off **Bento Grid** look for the two surfaces the user asked for:
- **main** = the "Mission Control" editor webview → `extension/src/webview/dashboard.ts` (`renderHtml`)
- **left tab** = the activity-bar view `missioncontrol.panel` → `extension/src/webview/sidebar.ts` (`panelHtml`)

Pixel-close to the design tokens (colors/spacing/typography) in the README. Reuse existing data plumbing; add only what the design needs that has no real data source yet.

## Non-goals
- The in-panel "Claude Chat" tab / tab-strip in the mock — the extension keeps Claude Chat as its **separate** webview (`mirror.ts`). Only main + left tab change.
- VS Code chrome (title bar, traffic lights, activity bar) — not ours.
- No new backend; frontend-only build stays frontend-only.

## Locked decisions (from user)
1. **Budget card = fully WEEKLY, all real data, drop the mock `$8,000` entirely.**
   - Big number = real Claude $ spent **last 7 days** (from transcripts).
   - Breakdown = **Top 3 projects by last-7-days spend (USD)**, as bars.
   - Progress bar + `% used` chip = **weekly quota** `seven_day.utilization` from the Claude usage endpoint (real), with "resets in Nd" from `resets_at`.
2. **Sessions rows expand** → on expand, fetch **real** `tmux list-windows` (lazy, only when a row opens).
3. **Theme** = custom **Bento palette** (fixed hex tokens) + a **dark/light toggle** on the dashboard title bar; default follows VS Code's current theme kind; manual choice persisted in webview state. The sidebar (no room for a toggle) auto-follows the VS Code theme kind.
4. Icons = **inline stroke SVGs** (home / folder / search / gear / bolt / chevron), NOT emoji — avoids blank-glyph rendering.

## Sidebar (`sidebar.ts`, `panelHtml`) — 226px column
- Eyebrow label "MISSION CONTROL".
- Search box (icon + "Search…") → **local filter** over the nav items (real, cheap).
- Two identical gradient primary buttons: **Home** (→ open dashboard, current `open_dashboard` msg) · **Projects** (→ `missioncontrol.orchestratorContinue`).
- 1px divider.
- Nav list (icon + label, active = accent left-bar + `accentSoft` bg, hover = `accentSoft`):
  1. **Start maw ui** — keep the live `maw` toggle behavior (label flips Start/Stop via the existing `maw` message).
  2. **Skills** → `missioncontrol.skills`
  3. **Accounts** → `missioncontrol.accounts`
  4. **Localhosts** → `missioncontrol.localhosts`
  5. **Settings** → `missioncontrol.settings`
- `activeNavItem` highlight is client-side.
- First-run `setupHtml` keeps its buttons; restyle to the palette so it matches.
- Palette applied via CSS vars in `head()`; dark/light chosen from `document.body` VS Code theme class.

## Dashboard (`dashboard.ts`, `renderHtml`) — Bento grid
- Bento CSS vars (dark default + light block) + dot-grid background + title-bar dark/light pill toggle (persist via `vscode.getState/setState`; default from body theme class).
- **Header row**: bolt icon badge + "Mission Control" title + spacer + two pill chips:
  - Chip 1: green glow dot + "N active" (N = visible sessions count).
  - Chip 2: "P% of weekly limit used" (P from `seven_day` quota; hidden if quota unavailable).
- **Grid** `1.3fr 1fr 1fr` / rows `auto 1fr` / gap 14px:
  - **A — Sessions** (col 1, spans both rows): "SESSIONS" eyebrow + a small **"Open Claude"** action (keeps `missioncontrol.claude` reachable) + session rows.
  - **B — Budget** (cols 2–4, top row): weekly card (see below).
  - **C — Resources** (row 2, col 2): Team Config · Accounts (existing tile targets, restyled to the 2-row card).
  - **D — Data** (row 2, col 3): Data View · Open in Obsidian.

### Sessions rows (Cell A)
- Collapsed: status dot (glow), name, meta line (`label · N win · cmd`, ellipsis), chevron, and a persistent one-line preview `$ tmux attach -t <name> · <cwd>`.
- **Click row = toggle expand** (per design). Expanded reveals the real tmux window list (each `▸ <index>:<name> <cmd>`), card border → accent.
- **Attach** = click the `$ tmux attach…` preview line (it literally is the attach command) → existing `attach_session` message. Keep the `✕` kill button.
- **Idle filter**: hide sessions whose active pane command is a bare shell (`bash`/`zsh`/`sh`/`-bash`/login shell) with a single window — i.e. no live process. Keep everything else.

### Budget card (Cell B) — WEEKLY, all real
- Header: "Budget" + right-aligned "· last 7 days".
- Big amount = `buildBudgetView(u).last7Fmt` (reuse).
- Progress bar + caption: fill = weekly-quota `used%` (`100 - sevenDay.remaining`); caption "P% of weekly limit used · resets in Nd". If no active token / offline / 429 → **hide the bar + chip**, show only the $ amount + breakdown (degrade honestly).
- Breakdown = **Top 3 projects, last-7-days $** (new helper), mini bars (bar width = project$ / top1$).
- If `providerNote` is non-empty (a provider on disk not summed yet), show it as a faint one-line note (honesty; reuse).

## Data / plumbing changes
- **`usage.ts`**: add a pure, tested helper `topProjectsByRange(u, cutoffMs, n)` — fold `byProjectHour` (cwd→hour bucket) onto project roots via `resolveProject`, sum buckets on/after `cutoffMs` (local-day compare like `buildBudgetView.last7`), return top-N `{name, cost}`. Reuse `resolveProject`.
- **`dashboard.ts` `pushBudget`**: replace the month-only `spent_usd` payload with a weekly payload:
  `{ type:"budget", last7Fmt, top:[{name,costFmt,frac}], quota:{usedPct, resetsAt}|null, providerNote }`.
  Build $ + projects from `buildBudgetView`/`topProjectsByRange`; build `quota` from the active token (see below). Keep the stale-while-revalidate pattern (`getInstantUsage`→`refreshUsage`).
- **Weekly quota**: read the active OAuth token from `~/.claude/.credentials.json` via the existing `accountsOps` extractor, then `fetchClaudeUsage(token).sevenDay`. All failures → `quota:null` (card degrades). Respects the 180s cache already in `commands/usage.ts`.
- **Sessions expand**: new host handler for `{type:"expand_session", name}` → run `tmux list-windows -t <name> -F "#{window_index}:#{window_name} #{pane_current_command}"` (name validated by `isSafeSessionName`) → post `{type:"session_windows", name, windows:[...]}`. Client renders into the open row. Add a pure parser (tested).
- **Idle filter**: pure predicate on `TmuxSession` (tested), applied in `renderSessions` (client) or before `postMessage` (host). Prefer host-side so "N active" chip matches.

## Files touched
- `extension/src/webview/dashboard.ts` — `renderHtml` (full Bento markup/CSS/JS), `pushBudget` (weekly payload), sessions expand handler + message wiring.
- `extension/src/webview/sidebar.ts` — `head` (palette), `panelHtml` (new layout), light `setupHtml` restyle.
- `extension/src/usage.ts` — add `topProjectsByRange` (pure).
- `extension/src/webview/sessions.ts` — add tmux-window parser + idle predicate (pure).
- (reuse, no change) `budget.ts` `buildBudgetView`/`fmt`, `commands/usage.ts` `fetchClaudeUsage`, `commands/accountsOps.ts` token extractor.

## Testing
- `bun test` for the new pure helpers: `topProjectsByRange` (ranking + range cutoff + grouping), tmux-window parser, idle predicate.
- `tsc -p ./` compiles clean.
- Manual in VS Code: dashboard Bento renders; dark/light toggle swaps all tokens live; sessions expand shows real windows; budget shows real last-7 $, top-3, and weekly quota bar (and degrades when logged-out); sidebar new layout + nav active states + search filter + maw toggle still live.

## Risks / open
- The usage endpoint is undocumented — already guarded (UA gate, 180s cache, graceful degrade). Quota simply hidden on any failure.
- `byProjectHour` must exist in the cached summary (CACHE_VERSION 7 has it); a stale older cache recomputes on first scan.
- Top-3 "last 7 days" is rolling 7 local days (matches `buildBudgetView.last7`), not the exact quota-window boundary — close enough and consistent with the headline number.

# Localhosts section in the Mission Control sidebar

**Date:** 2026-07-23
**Status:** Approved (chat review)
**Repo:** missionControl (extension)

## Goal

Add a "Localhosts" section to the Mission Control activity-bar sidebar
(`missioncontrol.panel`) that lists the dev servers currently listening on
localhost, **grouped by project**. Each entry opens its URL in a browser; each
group has a **Stop all** button that shuts down every port belonging to that
project.

## Why this shape

- MC already has a per-project preview mechanism (`.orches-preview.{sh,pid,log}`,
  see `commands/previewOps.ts`) and a first-class notion of "project"
  (project picker + `projectState`). Grouping localhosts by project maps onto
  the existing model.
- Filtering by parent process does **not** work: preview servers are spawned
  `detached:true` + `unref()` (`previewOps.togglePreview`) so they survive a
  VS Code reload; the OS reparents them to init (verified: the dev-tree root has
  `ppid=1`). They are not children of the extension host.
- So detection is **port-centric**: enumerate what is actually listening, then
  derive the project from each listener's working directory.

## Detection — `commands/localhostScan.ts`

1. Run `ss -ltnp` once → every LISTEN socket with `port` and `pid`.
2. For each pid: `readlink /proc/<pid>/cwd` and `ps -o ppid=,pgid=,comm= -p <pid>`.
   - Parse ppid/pgid via `ps` (or `/proc/<pid>/status`), **never** `awk` on
     `/proc/<pid>/stat` — the `comm` field contains parens/spaces and shifts
     columns.
3. Match cwd against `<projectsRoot>/<name>/...` → `project = <name>`.
   Listeners whose cwd is not under the projects root, or whose pid is
   unreadable (owned by root: redis/postgres/ollama/ssh), are dropped.
4. Return listeners grouped by project:
   `{ project, entries: [{ port, pid, pgid, comm, role }] }`.
   `role` is a light guess from comm/port (next/vite → "web", uvicorn/fastapi →
   "api"); best-effort label only, not load-bearing.

Verified on a live tree: `:web` next-server and its whole `npm run dev` chain
all share one `pgid`, cwd inside `.../projects/learningPlatform/...`, top of tree
`ppid=1`.

## UI — edit `webview/sidebar.ts`

New section appended after the existing controls in the same webview:

```
LOCALHOSTS              [refresh]
▼ learningPlatform      [Stop all]
   :3000  web   [open]
   :8000  api   [open]
```

- webview ↔ extension via `postMessage` (existing sidebar pattern).
- Only projects with at least one live listener are shown. No "Other" group.
- No emoji (user's terminal cannot render them).

## Open — click `[open]`

`vscode.env.openExternal(vscode.Uri.parse("http://localhost:<port>"))`
(external browser, matching the previewOps convention).

## Stop all — `commands/localhostKill.ts`

- Confirm first: `Stop N servers in <project>?` (modal).
- Kill by **process group**: for each distinct `pgid` in the group,
  `kill -TERM -<pgid>`, wait ~2s, then `kill -KILL -<pgid>` for survivors.
- A process group cannot reach VS Code / tmux / the shell — they live in other
  groups/sessions. This is bounded by the OS, not by walking ppid.
- Guardrails (belt and suspenders): refuse `pgid <= 1`; refuse a group whose
  leader's cwd is not under the project; refuse when leader `comm` is
  `code`/`tmux`/a login shell.
- Refresh the section after killing.

## Refresh

Piggyback on the sidebar's existing ~10s poll, plus a manual `[refresh]` button.

## Error handling

- `ss`/`ps` missing or failing → section renders "unavailable" quietly; the rest
  of the sidebar is unaffected.
- Unreadable pid (root-owned) → skipped.
- Kill failure → surface a `showErrorMessage`, leave the section as-is.

## Testing

Unit tests (`*.test.ts`, matching existing pattern), all mocked — no real kills:
- `ss` output parser → ports + pids.
- cwd → project matcher (inside / outside / nested paths).
- ppid/pgid parse via `ps` mock (incl. a comm with parens).
- Stop-all guardrails: refuses pgid<=1, refuses cwd-outside-project, refuses
  protected comm names; builds the correct `kill -TERM -<pgid>` command set.

## Out of scope (YAGNI)

- Listing infra services (redis/postgres/ollama) — not project webs.
- Starting servers from this section (start stays in the existing preview flow).
- A machine-wide "all ports" view including non-project listeners.

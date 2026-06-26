/**
 * Central singleton for the extension's "currently selected project_id".
 *
 * The backend now supports multi-project — every HTTP request can carry an
 * `X-Project-Id` header to target a specific project (race-safe via per-
 * request contextvar) and WebSocket clients can send `{set_project_ids:[…]}`
 * to filter the event stream. This module holds the single "what is the user
 * looking at right now?" value and notifies subscribers on change.
 *
 *   - api.ts                — reads `getCurrentProjectId()` on every fetch
 *                             and injects it as `X-Project-Id` if non-null.
 *   - ws.ts                 — subscribes via `onProjectChange()`; sends a
 *                             `{set_project_ids:[pid]}` after the WS opens,
 *                             and re-sends whenever the selection changes.
 *   - sidebar webview       — calls `setCurrentProjectId(pid)` when the user
 *                             picks from the dropdown (also persists to
 *                             `context.globalState` for next session).
 *   - extension.activate()  — restores the last-used pid from globalState.
 *
 * `null` means "no explicit selection" → backend falls back to its global
 * active project (legacy single-project behavior), so unchanged single-
 * project users see no difference.
 */

type Listener = (pid: string | null) => void;

/**
 * The globalState key under which the active project_id is persisted across
 * sessions. Single source of truth — sidebar.ts, dashboard.ts and
 * extension.ts all import it from here. (Previously each file declared its
 * own literal, and a comment begged them to "stay identical" with no compiler
 * guard.) projectState.ts has no imports, so importing it can never create a
 * circular dependency.
 */
export const PROJECT_STATE_KEY = "missioncontrol.currentProjectId";

let _pid: string | null = null;
const _listeners: Listener[] = [];

export function getCurrentProjectId(): string | null {
  return _pid;
}

/** Updates the in-memory pid and notifies every subscribed listener. */
export function setCurrentProjectId(pid: string | null): void {
  const next = pid && pid.trim() ? pid.trim() : null;
  if (next === _pid) return;
  _pid = next;
  for (const fn of _listeners) {
    try {
      fn(_pid);
    } catch {
      /* one listener failing must not block the others */
    }
  }
}

/** Subscribe to changes. Listener is also called once with the current value. */
export function onProjectChange(fn: Listener): () => void {
  _listeners.push(fn);
  try {
    fn(_pid);
  } catch {
    /* swallow */
  }
  return () => {
    const i = _listeners.indexOf(fn);
    if (i >= 0) _listeners.splice(i, 1);
  };
}

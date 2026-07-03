// Pure helpers for the dashboard Sessions panel. NO vscode import here so the
// parsing + validation logic can be unit-tested standalone with `bun test`.

export interface TmuxSession {
  name: string;
  windows: number;
  attached: boolean;
  cmd: string; // active pane's current command (claude / maw / bash …)
  cwd: string; // active pane's current path
}

// `tmux list-sessions -F` format string. Tab-separated because a tab is far
// less likely than `|`/space to appear inside a session name or path.
export const TMUX_FMT =
  "#{session_name}\t#{session_windows}\t#{session_attached}\t#{pane_current_command}\t#{pane_current_path}";

/** Parse stdout of `tmux list-sessions -F TMUX_FMT`. Tolerant: blank input or a
 *  "no server running" message yields []; lines without 5 fields are skipped. */
export function parseTmuxSessions(raw: string): TmuxSession[] {
  const out: TmuxSession[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 5) continue;
    const name = parts[0];
    if (!name) continue;
    out.push({
      name,
      windows: Number.parseInt(parts[1], 10) || 0,
      attached: parts[2] === "1",
      cmd: parts[3] ?? "",
      cwd: parts.slice(4).join("\t"),
    });
  }
  return out;
}

/** True when a name is safe to interpolate (single-quoted) into a shell
 *  `tmux attach -t '<name>'`. Whitelist only. */
export function isSafeSessionName(name: string): boolean {
  if (!name || name.length > 200) return false;
  // Whitelist: letters, digits, dot, underscore, hyphen. Anything else (spaces,
  // quotes, control chars, shell metacharacters) is rejected, so the name is
  // safe to single-quote into `tmux attach -t '<name>'`.
  return /^[A-Za-z0-9._-]+$/.test(name);
}

/** Shell command to attach to a session. Caller MUST validate with
 *  isSafeSessionName first; the name is single-quoted. The `=` prefix forces
 *  an EXACT session-name match — without it tmux falls back to prefix/fnmatch
 *  matching, so if the named session died you could silently attach to (or,
 *  in the kill path, destroy) a different session sharing the prefix. */
export function buildAttachCommand(name: string): string {
  return `tmux attach -t '=${name}'`;
}

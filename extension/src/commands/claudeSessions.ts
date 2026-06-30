// Pure helpers for the "Open Claude" project picker. NO vscode/fs import here
// so the sanitization + command-building logic can be unit-tested standalone
// with `bun test`. The fs-backed project discovery lives in claude.ts.

export interface ClaudeTarget {
  /** Display label in the quick-pick (the project folder name, or "soulbrew"). */
  label: string;
  /** Absolute working directory claude is launched in. */
  cwd: string;
  /** tmux session name — whitelist-safe, "claude-" prefixed. */
  session: string;
}

/** Turn a project folder name into a safe tmux session name: "claude-<slug>".
 *  Any char outside [A-Za-z0-9._-] collapses to a single "-"; leading/trailing
 *  hyphens are trimmed. The result always matches /^claude-[A-Za-z0-9._-]+$/,
 *  so the Sessions panel's isSafeSessionName whitelist accepts it and it is
 *  safe to single-quote into a shell command. */
export function projectSessionName(projectName: string): string {
  const slug = projectName
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-") // non-whitelist runs -> one hyphen
    .replace(/-+/g, "-") // collapse hyphen runs
    .replace(/^-+|-+$/g, ""); // trim edge hyphens
  return "claude-" + (slug || "project");
}

/** Single-quote a string for POSIX sh, escaping embedded single quotes via the
 *  '\'' idiom. Robust even if a path contains quotes/spaces/metacharacters. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Build the create-or-attach tmux command. `-A` attaches if the session
 *  already exists, otherwise creates it running `claude` in `cwd`. Both the
 *  session name and cwd are shell-quoted. */
export function buildClaudeTmuxCommand(session: string, cwd: string): string {
  return `tmux new-session -A -s ${shQuote(session)} -c ${shQuote(cwd)} claude`;
}

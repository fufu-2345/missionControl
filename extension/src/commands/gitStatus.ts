// Pure helper: turn a project's raw git facts into the single action button the
// resume list should show. NO vscode/node import — the git commands that gather
// these facts run in gitOps.ts (extension side); this file only DECIDES, so the
// button logic is unit-testable with `bun test`.

export type GitButtonKind =
  | "commit" // working tree dirty → needs a commit
  | "push" // clean, local commits ahead of (or no) upstream → needs a push
  | "create-push" // clean, no remote at all → create GitHub repo + push
  | "uptodate" // clean, in sync with upstream → nothing to do
  | "none"; // not a git repo / unknown

export interface GitButtonState {
  kind: GitButtonKind;
  label: string;
  dirtyCount: number;
  ahead: number;
  behind: number;
}

/** Raw facts gathered by gitOps.readGitStatus (all from `git`). */
export interface GitRawStatus {
  isRepo: boolean;
  porcelain: string; // `git status --porcelain -uall` output
  hasRemote: boolean; // any remote configured
  hasUpstream: boolean; // current branch tracks an upstream
  ahead: number; // commits HEAD is ahead of upstream (0 if no upstream)
  behind: number; // commits HEAD is behind upstream
}

/** Count real change lines in porcelain output (blank lines ignored). */
export function countDirty(porcelain: string): number {
  return porcelain.split(/\r?\n/).filter((l) => l.trim().length > 0).length;
}

/** Decide the one action button for a project from its raw git facts.
 *  Precedence: dirty (commit) > no-remote (create-push) > ahead / no-upstream
 *  (push) > in-sync (up to date). "behind" is out of scope (no pull button):
 *  a clean, non-ahead tree reads as up to date. */
export function parseGitButtonState(s: GitRawStatus): GitButtonState {
  const base = { dirtyCount: 0, ahead: s.ahead || 0, behind: s.behind || 0 };
  if (!s.isRepo) return { ...base, kind: "none", label: "—" };

  const dirtyCount = countDirty(s.porcelain);
  if (dirtyCount > 0) {
    return { ...base, kind: "commit", label: `Commit (${dirtyCount})`, dirtyCount };
  }
  // Clean working tree from here on.
  if (!s.hasRemote) return { ...base, kind: "create-push", label: "Create & Push" };
  if (!s.hasUpstream) return { ...base, kind: "push", label: "Push" };
  if (s.ahead > 0) return { ...base, kind: "push", label: `Push (${s.ahead})` };
  return { ...base, kind: "uptodate", label: "✓ up to date" };
}

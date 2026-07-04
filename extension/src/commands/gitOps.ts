import * as cp from "node:child_process";
import * as path from "node:path";

import { type GitRawStatus } from "./gitStatus";

// Extension-side git/gh/claude runners for the resume list's per-project action
// buttons. Everything uses execFile with an ARG ARRAY (never a shell string), so
// a repo path or commit message can't inject. All are best-effort: a failure
// resolves to a typed error the caller surfaces to the webview, never throws.

const GIT_TIMEOUT = 8000;
const FETCH_TIMEOUT = 20000;
const CLAUDE_TIMEOUT = 60000;

export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeout?: number; maxBuffer?: number; input?: string } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = cp.execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeout ?? GIT_TIMEOUT,
        maxBuffer: opts.maxBuffer ?? 4 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        resolve({ ok: !err, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
    if (opts.input !== undefined) {
      child.stdin?.end(opts.input);
    }
  });
}

const git = (dir: string, args: string[], timeout?: number) =>
  run("git", ["-C", dir, ...args], { timeout });

/** Gather the raw git facts parseGitButtonState needs. Never throws. */
export async function readGitStatus(dir: string): Promise<GitRawStatus> {
  const off: GitRawStatus = {
    isRepo: false,
    porcelain: "",
    hasRemote: false,
    hasUpstream: false,
    ahead: 0,
    behind: 0,
  };
  const inside = await git(dir, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.stdout.trim() !== "true") return off;

  const [porc, remotes, upstream] = await Promise.all([
    git(dir, ["status", "--porcelain", "-uall"]),
    git(dir, ["remote"]),
    git(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]),
  ]);
  const hasRemote = remotes.stdout.trim().length > 0;
  const hasUpstream = upstream.ok && upstream.stdout.trim().length > 0;
  let ahead = 0;
  let behind = 0;
  if (hasUpstream) {
    const lr = await git(dir, ["rev-list", "--left-right", "--count", "@{u}...HEAD"]);
    if (lr.ok) {
      const m = lr.stdout.trim().split(/\s+/);
      behind = parseInt(m[0] ?? "0", 10) || 0;
      ahead = parseInt(m[1] ?? "0", 10) || 0;
    }
  }
  return { isRepo: true, porcelain: porc.stdout, hasRemote, hasUpstream, ahead, behind };
}

/** `git fetch` (quiet) so ahead/behind is accurate. Best-effort. */
export function fetchRepo(dir: string): Promise<RunResult> {
  return git(dir, ["fetch", "--quiet"], FETCH_TIMEOUT);
}

/** Stage everything + commit with the given message (arg array — no shell). */
export async function commitAll(dir: string, message: string): Promise<RunResult> {
  const add = await git(dir, ["add", "-A"]);
  if (!add.ok) return add;
  return git(dir, ["commit", "-m", message]);
}

/** Push current branch. Sets upstream on first push when none is configured. */
export async function pushRepo(dir: string, hasUpstream: boolean): Promise<RunResult> {
  return hasUpstream
    ? git(dir, ["push"], FETCH_TIMEOUT)
    : git(dir, ["push", "-u", "origin", "HEAD"], FETCH_TIMEOUT);
}

/** Create a GitHub repo from this local repo and push (external — caller
 *  confirms first). Uses gh; requires gh auth. */
export function createAndPush(
  dir: string,
  repoName: string,
  isPrivate: boolean,
): Promise<RunResult> {
  return run(
    "gh",
    [
      "repo",
      "create",
      repoName,
      "--source",
      dir,
      "--remote",
      "origin",
      "--push",
      isPrivate ? "--private" : "--public",
    ],
    { cwd: dir, timeout: FETCH_TIMEOUT },
  );
}

/** Default repo name for Create & Push = the folder basename. */
export function defaultRepoName(dir: string): string {
  return path.basename(dir.replace(/\/+$/, ""));
}

/** Ask `claude -p` to READ the diff and propose ONE commit-message line — used
 *  only to draft the message a human then reviews. Diff is bounded to keep the
 *  token cost tiny. Returns "" if claude is unavailable or produced nothing. */
export async function autoCommitMessage(dir: string): Promise<string> {
  // Bounded context: status summary + a truncated diff of tracked changes.
  const [stat, diff] = await Promise.all([
    git(dir, ["status", "--short"]),
    git(dir, ["diff", "--stat", "HEAD"]),
  ]);
  let body = git(dir, ["diff", "HEAD"], GIT_TIMEOUT);
  const diffText = (await body).stdout.slice(0, 6000);
  const context = [
    "Changed files:",
    stat.stdout.trim(),
    "",
    "Diffstat:",
    diff.stdout.trim(),
    "",
    "Diff (truncated):",
    diffText,
  ].join("\n");
  const prompt =
    "Write ONE concise git commit message line (Conventional Commits style, " +
    "<=72 chars, imperative). Output ONLY the message, no quotes, no explanation.\n\n" +
    context;
  const res = await run("claude", ["-p", prompt], {
    timeout: CLAUDE_TIMEOUT,
    maxBuffer: 512 * 1024,
  });
  if (!res.ok) return "";
  // Take the first non-empty line, strip surrounding quotes/backticks.
  const line = res.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return (line ?? "").replace(/^["'`]+|["'`]+$/g, "").slice(0, 120);
}

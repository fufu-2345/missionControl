const PROTECTED_COMM = new Set([
  "code",
  "tmux",
  "tmux: server",
  "bash",
  "-bash",
  "zsh",
  "-zsh",
  "sh",
  "-sh",
  "login",
  "systemd",
  "init",
]);

/** Never signal a shell, the editor, tmux, or init. */
export function isProtectedComm(comm: string): boolean {
  return PROTECTED_COMM.has(comm.trim());
}

/** A process group is safe to kill only if it is a real group (pgid>1), its
 *  leader is not a protected process, and — when the leader is still readable —
 *  its cwd is under the projects root. A missing leader (reparented/exited) is
 *  allowed because the group was discovered via a listener whose cwd was already
 *  confirmed inside the project. */
export function canKillGroup(
  pgid: number,
  leaderCwd: string | null,
  leaderComm: string,
  projectsRoot: string,
): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  if (leaderComm && isProtectedComm(leaderComm)) return false;
  if (leaderCwd) {
    const prefix = projectsRoot.replace(/\/+$/, "") + "/";
    if (!leaderCwd.startsWith(prefix)) return false;
  }
  return true;
}

/** Signal the whole process group: `kill -SIG -<pgid>`. */
export function buildKillCmd(pgid: number, force: boolean): string {
  return `kill -${force ? "KILL" : "TERM"} -${pgid}`;
}

// Pure helpers for the "Start Orchestrator" command. NO vscode import here so
// the parsing + validation logic can be unit-tested standalone with `bun test`.
// The filesystem directory-walk lives in startOrchestrator.ts (vscode side).

export interface OracleMember {
  oracle: string;
  role: string;
}

export interface OracleTeam {
  name: string;
  members: OracleMember[];
  orchestrators: string[]; // member names whose role === "orchestrator"
}

/** Parse one `~/.maw/teams/<name>/oracle-members.json` file's content into an
 *  OracleTeam. Tolerant: bad JSON or missing `members` → null. */
export function parseTeamRoster(name: string, raw: string): OracleTeam | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const rawMembers = (data as { members?: unknown })?.members;
  if (!Array.isArray(rawMembers)) return null;
  const members: OracleMember[] = [];
  for (const m of rawMembers) {
    if (!m || typeof (m as { oracle?: unknown }).oracle !== "string") continue;
    const oracle = (m as { oracle: string }).oracle;
    const role =
      typeof (m as { role?: unknown }).role === "string"
        ? (m as { role: string }).role
        : "";
    members.push({ oracle, role });
  }
  const orchestrators = members
    .filter((m) => m.role === "orchestrator")
    .map((m) => m.oracle);
  return { name, members, orchestrators };
}

/** True when a name is safe to single-quote into a shell `maw wake '<name>'`.
 *  Whitelist only — letters, digits, dot, underscore, hyphen. */
export function isSafeOracleName(name: string): boolean {
  if (!name || name.length > 200) return false;
  return /^[A-Za-z0-9._-]+$/.test(name);
}

/** Shell command to wake + attach an orchestrator oracle. Caller MUST validate
 *  with isSafeOracleName first; the name is single-quoted. `maw wake --attach`
 *  reuses the oracle's own session if already awake, so re-runs are safe. */
export function buildWakeAttachCommand(orchestrator: string): string {
  return `maw wake '${orchestrator}' --attach`;
}

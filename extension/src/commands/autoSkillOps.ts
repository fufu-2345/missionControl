import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// On/off switch for the global "auto-skill" behaviour (agents auto-create skills
// at the end of a task). The source of truth is NOT config.json — it is the
// presence of a marked block in ~/.claude/CLAUDE.md (which Claude Code loads into
// every session). This module adds/removes that block so the Settings toggle can
// drive it. Pure fs + a path override (MC_CLAUDE_MD_PATH) so it is unit-testable,
// mirroring settingsOps.
//
// The block text is kept byte-identical to what is deployed by hand, and is
// wrapped in BEGIN/END markers so removal is a clean line splice.

export function claudeMdPath(): string {
  return (
    process.env.MC_CLAUDE_MD_PATH ||
    path.join(os.homedir(), ".claude", "CLAUDE.md")
  );
}

export const BEGIN_MARKER = "<!-- BEGIN auto-skill";
export const END_MARKER = "<!-- END auto-skill -->";

// Built as a joined array (NOT a template literal) so the bash command can be a
// plain line with no backslashes/backticks to corrupt.
export const AUTO_SKILL_BLOCK = [
  "<!-- BEGIN auto-skill · Mission Control toggle · delete this block to turn OFF -->",
  "# Skill Discipline — auto-capture reusable procedures (auto-skill)",
  "",
  "At the END of a task, before finishing your turn, silently self-judge whether what you just did is worth saving as a reusable skill. Save one ONLY when it would genuinely help a FUTURE task — routine work saves NOTHING.",
  "",
  "Trigger on ANY of: (1) a complex task over several tool steps that is worth repeating, (2) you recovered from a real error/dead-end via a non-obvious working path, (3) the user corrected HOW you did something, (4) you discovered a reusable multi-step workflow.",
  "",
  "Quality bar (most turns save nothing): it must be a PROCEDURE (steps/commands), not a fact — facts go to /rrr or oracle_learn, never here. Write it GENERIC — not tied to one team/oracle/project; use placeholders (e.g. <proj>/<role>, NN-foreman) instead of literal names so any team or project can follow it. Ask \"would a specific future task actually load and follow this?\" If unsure, skip.",
  "",
  "On a hit, save NON-BLOCKING (never stop to ask). Write the skill body to a temp file, then run: python3 ~/.claude/skills/auto-skill/scripts/auto_skill.py create --name <kebab-name> --desc \"one line: what + when\" --trigger <complex-task|error-recovery|user-correction|reusable-workflow> --source <your identity: your oracle id if you are an oracle, else your handle> [--category <one-word area>] --body-file /tmp/<name>.SKILL.md",
  "",
  "Lands in ~/.claude/skills (global) so it shows in the Skills panel and works in every project. A same-name / different-content skill is refused — pick a new name. Then note in one line that you saved a skill, and finish.",
  "<!-- END auto-skill -->",
].join("\n");

/** True when the marked block is present in CLAUDE.md. */
export function isAutoSkillEnabled(): boolean {
  try {
    return fs.readFileSync(claudeMdPath(), "utf8").includes(BEGIN_MARKER);
  } catch {
    return false;
  }
}

/** Add (on) or remove (off) the block. Idempotent. Returns the resulting state. */
export function setAutoSkillEnabled(on: boolean): boolean {
  const p = claudeMdPath();
  let text = "";
  try {
    text = fs.readFileSync(p, "utf8");
  } catch {
    text = "";
  }
  const present = text.includes(BEGIN_MARKER);

  if (on) {
    if (present) return true; // already on — do not duplicate
    const trimmed = text.replace(/\s*$/, "");
    const next = (trimmed ? trimmed + "\n\n" : "") + AUTO_SKILL_BLOCK + "\n";
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, next, "utf8");
    return true;
  }

  // off — splice out the block by markers (inclusive), collapse the gap
  if (!present) return false;
  const lines = text.split("\n");
  const begin = lines.findIndex((l) => l.includes(BEGIN_MARKER));
  let end = lines.findIndex((l) => l.includes(END_MARKER));
  if (begin === -1) return false;
  if (end === -1 || end < begin) end = lines.length - 1;
  lines.splice(begin, end - begin + 1);
  // drop trailing blank lines left behind, keep a single terminating newline
  let out = lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s*$/, "");
  out = out ? out + "\n" : "";
  fs.writeFileSync(p, out, "utf8");
  return false;
}

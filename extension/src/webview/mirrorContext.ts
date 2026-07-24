// Best-effort context-window meter for the Mirror webview. Reuses the SAME
// signals the in-REPL statusLine (scripts/statusline-context.mjs) already
// computes, read from the extension host instead of Claude's stdin:
//
//   • the pane's claude session id  → tmux user-option @claude_session
//     (set by the SessionStart capture-session.sh hook)
//   • the transcript for that id    → ~/.claude/projects/<enc>/<id>.jsonl
//   • current context size          → last assistant turn's usage (input +
//     cache_read + cache_creation)
//   • the 100% point (auto-compact) → this session's last compactMetadata
//     trigger:"auto" preTokens (the REAL point IT compacted at); else a window
//     inferred from the observed tokens − reserve. We deliberately do NOT use the
//     old globally-learned trigger cache (~/.claude/.mc-ctx-trigger): it is a single
//     MODEL-BLIND number (~147k, learned from whatever session compacted last), so a
//     large-window ([1m]) pane whose real context is 300k+ was divided by 147k and
//     PEGGED at a FALSE 100% (and never auto-compacted, because it was nowhere near
//     full). The transcript does NOT carry the true window (message.model is the base
//     id, no "[1m]"), so we INFER it: a session past the 200k-model compact point
//     (~167k) WITHOUT having auto-compacted must have a bigger window → treat as [1m].
//
// Never throws to the caller — returns null when anything is missing so the
// meter degrades to "ctx —" rather than lying. No vscode import (unit-testable).

import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { isSafeSessionName } from "./sessions";

const DEFAULT_WINDOW = 200000; // non-1M models
const BIG_WINDOW = 1000000; // [1m] models
const COMPACT_RESERVE = 33000; // keep in sync with statusline-context.mjs
const SMALL_TRIGGER = DEFAULT_WINDOW - COMPACT_RESERVE; // 167000 = the 200k-model compact point
const TAIL_BYTES = 512 * 1024;

export interface ContextInfo {
  pct: number; // 0..100, where 100 == the auto-compact trigger
  tokens: number; // current context size (input + cache)
  trigger: number; // token count that maps to 100%
}

/** The claude session UUID stamped on the tmux session, or null. */
function claudeSessionId(session: string): string | null {
  if (!isSafeSessionName(session)) return null;
  try {
    const v = cp
      .execFileSync("tmux", ["show-options", "-t", session, "-qv", "@claude_session"], {
        encoding: "utf8",
      })
      .trim();
    return /^[A-Za-z0-9._-]+$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** Locate <id>.jsonl under ~/.claude/projects/<*>/ (shallow scan). */
export function transcriptPath(sessionId: string): string | null {
  const root = path.join(os.homedir(), ".claude", "projects");
  let dirs: string[];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return null;
  }
  const fname = sessionId + ".jsonl";
  for (const d of dirs) {
    const p = path.join(root, d, fname);
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {
      /* keep scanning */
    }
  }
  return null;
}

/** Read the last TAIL_BYTES of a file as utf8 (whole file if smaller). */
function tail(file: string): string {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.allocUnsafe(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

/** Effective autoCompactWindow for a cwd: walk up to $HOME collecting each level's
 *  .claude/settings.local.json then settings.json (most-specific first), then global
 *  ~/.claude/settings.json. First numeric autoCompactWindow wins; null when unset. Ported
 *  from statusline-context.mjs so the two meters agree. Cached per cwd (settings are stable
 *  for a session — never re-walk on the hot poll path). */
const _acwCache = new Map<string, number | null>();
function resolveAutoCompactWindow(cwd: string): number | null {
  if (!cwd) return readAcw(os.homedir());
  const hit = _acwCache.get(cwd);
  if (hit !== undefined) return hit;
  const home = os.homedir();
  const files: string[] = [];
  let dir = cwd;
  for (let i = 0; i < 40; i++) {
    files.push(path.join(dir, ".claude", "settings.local.json"));
    files.push(path.join(dir, ".claude", "settings.json"));
    if (dir === home) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  files.push(path.join(home, ".claude", "settings.json"));
  let out: number | null = null;
  for (const f of files) {
    const v = readAcwFile(f);
    if (v !== null) { out = v; break; }
  }
  _acwCache.set(cwd, out);
  return out;
}
function readAcw(dir: string): number | null {
  return readAcwFile(path.join(dir, ".claude", "settings.json"));
}
function readAcwFile(f: string): number | null {
  try {
    const v = JSON.parse(fs.readFileSync(f, "utf8")).autoCompactWindow;
    return typeof v === "number" && v > 0 ? v : null;
  } catch {
    return null;
  }
}

/** Parse tail lines from newest→oldest, extracting current tokens, the last auto-compact
 *  trigger seen in THIS transcript, and the session cwd (for autoCompactWindow resolution).
 *  Pure; exported for tests. */
export function scanTranscript(text: string): { tokens: number; autoTrigger: number; cwd: string } {
  const lines = text.split("\n");
  let tokens = 0;
  let autoTrigger = 0;
  let cwd = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line[0] !== "{") continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // a partial first line from tail slicing, or non-JSON
    }
    if (!cwd && typeof obj?.cwd === "string") cwd = obj.cwd;
    if (!autoTrigger) {
      const cm = obj?.compactMetadata ?? obj?.message?.compactMetadata;
      if (cm && cm.trigger === "auto" && Number(cm.preTokens) > 0) {
        autoTrigger = Number(cm.preTokens);
      }
    }
    if (!tokens) {
      const u = obj?.message?.usage ?? obj?.usage;
      if (u) {
        const t =
          (Number(u.input_tokens) || 0) +
          (Number(u.cache_read_input_tokens) || 0) +
          (Number(u.cache_creation_input_tokens) || 0);
        if (t > 0) tokens = t;
      }
    }
    if (tokens && autoTrigger && cwd) break;
  }
  return { tokens, autoTrigger, cwd };
}

/** The token count that maps to 100% (auto-compact) for a session, given its current
 *  tokens, its own last AUTO compact point (0 if never), and cwd. Exported for tests. */
export function resolveTrigger(tokens: number, autoTrigger: number, cwd: string): number {
  if (autoTrigger > 0) return autoTrigger; // the session's REAL compact point — authoritative
  // Infer the window: past the 200k-model compact point WITHOUT compacting ⇒ bigger window.
  const modelWindow = tokens > SMALL_TRIGGER ? BIG_WINDOW : DEFAULT_WINDOW;
  const acw = resolveAutoCompactWindow(cwd);
  const effective = acw ? Math.min(modelWindow, acw) : modelWindow;
  return Math.max(1, effective - COMPACT_RESERVE);
}

/** Read the live context fill for a tmux session, or null when unknowable. */
export function sessionContextPercent(session: string): ContextInfo | null {
  const id = claudeSessionId(session);
  if (!id) return null;
  return contextFromCsid(id);
}

/** Read the live context fill directly from a claude session id (the Mirror
 *  grid's control-mode bridge already reports each pane's @claude_session, so
 *  the host skips the tmux lookup and goes straight to the transcript). Returns
 *  null — never a wrong number — when the id is empty/unsafe, no transcript
 *  exists, or no usage row has been written yet (meter shows "—"). */
export function contextFromCsid(csid: string): ContextInfo | null {
  if (!csid || !/^[A-Za-z0-9._-]+$/.test(csid)) return null;
  const file = transcriptPath(csid);
  if (!file) return null;
  let text: string;
  try {
    text = tail(file);
  } catch {
    return null;
  }
  const { tokens, autoTrigger, cwd } = scanTranscript(text);
  if (!tokens) return null;
  const trigger = resolveTrigger(tokens, autoTrigger, cwd);
  const pct = Math.max(0, Math.min(100, Math.round((tokens / trigger) * 100)));
  return { pct, tokens, trigger };
}

import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  contextFillPercent,
  encodeProjectDir,
  parseLastContextTokens,
  resolveAutoCompactWindow,
} from "../webview/contextMeter";
import { isSafeSessionName } from "../webview/sessions";

// Resolve the context fullness of ONE tmux session's active claude pane, for the
// status-bar pill. Maps session → its active pane's @claude_session (pane-scoped
// tmux option, set by the SessionStart hook) → transcript → last assistant usage
// tokens → % of the effective auto-compact window. All reads are bounded
// (tail-only) and mtime-cached. Pure math lives in webview/contextMeter.ts.

const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
const GLOBAL_SETTINGS = path.join(os.homedir(), ".claude", "settings.json");
const DEFAULT_WINDOW = 200000;
const TAIL_CAP = 1_000_000;

export interface ClaudeContext {
  pct: number;
  tokens: number;
  limit: number;
}

/** The session's active pane's @claude_session uuid + cwd (one tmux call). */
function paneInfo(session: string): Promise<{ uuid: string; cwd: string } | null> {
  return new Promise((resolve) => {
    cp.execFile(
      "tmux",
      ["display-message", "-p", "-t", session, "#{@claude_session}\t#{pane_current_path}"],
      { timeout: 900 },
      (err, stdout) => {
        if (err) return resolve(null);
        const s = stdout.toString();
        const i = s.indexOf("\t");
        if (i < 0) return resolve(null);
        resolve({ uuid: s.slice(0, i).trim(), cwd: s.slice(i + 1).trim() });
      },
    );
  });
}

const _tokenCache = new Map<string, { mtimeMs: number; size: number; tokens: number | null }>();

/** Context tokens for a transcript, tail-read + mtime-cached. */
function tokensForTranscript(file: string): number | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  const hit = _tokenCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.tokens;
  let tokens: number | null = null;
  try {
    const start = Math.max(0, st.size - TAIL_CAP);
    const len = st.size - start;
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, buf, 0, len, start);
    } finally {
      fs.closeSync(fd);
    }
    tokens = parseLastContextTokens(buf.toString("utf8"));
  } catch {
    tokens = null;
  }
  _tokenCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, tokens });
  return tokens;
}

/** Exact `<uuid>.jsonl` in the cwd's project dir, else newest `.jsonl` there. */
function transcriptFor(cwd: string, uuid: string): string | null {
  const dir = path.join(PROJECTS_DIR, encodeProjectDir(cwd));
  if (uuid) {
    const exact = path.join(dir, uuid + ".jsonl");
    if (fs.existsSync(exact)) return exact;
  }
  try {
    let newest: string | null = null;
    let newestMs = -1;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const p = path.join(dir, f);
      try {
        const m = fs.statSync(p).mtimeMs;
        if (m > newestMs) {
          newestMs = m;
          newest = p;
        }
      } catch {
        /* skip */
      }
    }
    return newest;
  } catch {
    return null;
  }
}

function readJsonSafe(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Effective autoCompactWindow for a cwd: walk up to $HOME collecting each
 *  level's .claude/settings.local.json then settings.json, then global. */
function effectiveWindow(cwd: string): number {
  const home = os.homedir();
  const chain: Array<Record<string, unknown> | null> = [];
  let dir = cwd;
  for (let i = 0; i < 40; i++) {
    chain.push(readJsonSafe(path.join(dir, ".claude", "settings.local.json")));
    chain.push(readJsonSafe(path.join(dir, ".claude", "settings.json")));
    if (dir === home) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  chain.push(readJsonSafe(GLOBAL_SETTINGS));
  return resolveAutoCompactWindow(chain, DEFAULT_WINDOW);
}

/** Context fullness of a tmux session's active claude pane, or null when it isn't
 *  a resolvable claude session (no @claude_session, no transcript, unsafe name). */
export async function focusedClaudeContext(session: string): Promise<ClaudeContext | null> {
  if (!isSafeSessionName(session)) return null;
  const info = await paneInfo(session);
  if (!info || !info.cwd) return null;
  const file = transcriptFor(info.cwd, info.uuid);
  if (!file) return null;
  const tokens = tokensForTranscript(file);
  if (tokens == null) return null;
  const limit = effectiveWindow(info.cwd);
  return { pct: contextFillPercent(tokens, limit), tokens, limit };
}

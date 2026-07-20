// Pure helpers for the Claude context status-bar pill — the clickable indicator
// that shows how full the FOCUSED claude REPL's context window is. NO vscode/fs
// here so the math is unit-testable with `bun test`; the tmux/fs glue lives in
// commands/focusedContext.ts and the UI in commands/claudeContextStatusBar.ts.
//
// "Context used" = the input side of the last assistant turn (input + cache_read
// + cache_creation). "Effective window" = min(model window, resolved
// autoCompactWindow) — auto-compact fires near the top of that, so the pct is
// "% until auto-compact".

/** How Claude Code encodes a cwd into its ~/.claude/projects/<dir> folder: every
 *  "/" and "." becomes "-". */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

/** Input-side tokens of one assistant `usage` object = context sent that turn. */
export function contextTokensFromUsage(u: {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
} | null | undefined): number {
  if (!u) return 0;
  return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
}

/** Current context size from a transcript's JSONL text: input-side tokens of the
 *  LAST line carrying a `message.usage` (or top-level `usage`). null when none
 *  (fresh session). Scans from the end so large transcripts stay cheap. */
export function parseLastContextTokens(jsonl: string): number | null {
  const lines = jsonl.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line.indexOf('"usage"') === -1) continue;
    try {
      const obj = JSON.parse(line) as {
        message?: { usage?: Parameters<typeof contextTokensFromUsage>[0] };
        usage?: Parameters<typeof contextTokensFromUsage>[0];
      };
      const u = obj.message?.usage ?? obj.usage;
      if (u) return contextTokensFromUsage(u);
    } catch {
      /* garbled line — keep scanning */
    }
  }
  return null;
}

/** First numeric autoCompactWindow from settings files ordered most-specific
 *  first; else `fallback`. */
export function resolveAutoCompactWindow(
  settingsChain: Array<Record<string, unknown> | null | undefined>,
  fallback: number,
): number {
  for (const s of settingsChain) {
    const v = s?.autoCompactWindow;
    if (typeof v === "number" && v > 0) return v;
  }
  return fallback;
}

/** Context fill 0–100 as % of the effective window (auto-compact fires ~98%). */
export function contextFillPercent(tokens: number, window: number): number {
  if (!(window > 0)) return 0;
  return Math.max(0, Math.min(100, Math.round((tokens / window) * 100)));
}

/** Severity bucket for the pill's color: ok (<75) / warn (75–90) / crit (>90).
 *  Maps to no background / warningBackground / errorBackground in the UI. */
export function contextBucket(pct: number): "ok" | "warn" | "crit" {
  if (pct > 90) return "crit";
  if (pct >= 75) return "warn";
  return "ok";
}

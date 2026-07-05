// Fetch Claude subscription usage for an account's OAuth token. This is the
// SAME private endpoint the `claude` CLI's own `/usage` command calls; it
// returns per-window utilization + reset times and does NOT consume message
// quota (it's a metadata read). Undocumented → always degrade gracefully.
//
// Constraints (from reverse-engineering the claude binary + community repro):
//   - Must send `User-Agent: claude-code/<ver>` or you hit a 429 bucket instantly.
//   - Rate-limited PER access-token → poll no faster than ~180s/token; we cache.
//   - Response fields: five_hour / seven_day / seven_day_opus / seven_day_sonnet,
//     each { utilization: 0..100 (percent CONSUMED), resets_at: ISO }.
import { execFileSync } from "child_process";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA = "oauth-2025-04-20";
const MIN_INTERVAL_MS = 180_000; // per-token poll floor
const TIMEOUT_MS = 5_000;

export interface UsageWindow {
  remaining: number; // percent remaining (0..100) = 100 - utilization
  resetsAt: string; // ISO 8601, or "" if absent
}
export interface Usage {
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
  sevenDayOpus?: UsageWindow;
  sevenDaySonnet?: UsageWindow;
}

// The User-Agent version gate: use the installed CLI's real version if we can
// read it, else a plausible fallback (the endpoint keys off the UA prefix, not
// an exact version).
let _ver: string | null = null;
function claudeCodeVersion(): string {
  if (_ver) return _ver;
  try {
    const out = execFileSync("claude", ["--version"], { timeout: 3000, encoding: "utf8" });
    const m = out.match(/(\d+\.\d+\.\d+)/);
    _ver = m ? m[1] : "1.0.0";
  } catch {
    _ver = "1.0.0";
  }
  return _ver;
}

function win(o: unknown): UsageWindow | undefined {
  if (!o || typeof o !== "object") return undefined;
  const util = (o as Record<string, unknown>).utilization;
  const reset = (o as Record<string, unknown>).resets_at;
  if (typeof util !== "number") return undefined;
  return {
    remaining: Math.max(0, Math.min(100, Math.round(100 - util))),
    resetsAt: typeof reset === "string" ? reset : "",
  };
}

// Cache keyed by the exact access-token string. A refreshed active account gets
// a new token value → a fresh fetch is allowed; a stable token reuses the cache
// so we never breach the 180s floor.
const cache = new Map<string, { u: Usage; at: number }>();

/** Fetch remaining usage for one OAuth access token. Throws on network / non-2xx
 *  (caller maps to a graceful per-account status). Never logs the token. */
export async function fetchClaudeUsage(accessToken: string): Promise<Usage> {
  const now = Date.now();
  const c = cache.get(accessToken);
  if (c && now - c.at < MIN_INTERVAL_MS) return c.u;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(USAGE_URL, {
      method: "GET",
      headers: {
        Authorization: "Bearer " + accessToken,
        "anthropic-beta": OAUTH_BETA,
        "User-Agent": "claude-code/" + claudeCodeVersion(),
        "Content-Type": "application/json",
      },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error("usage HTTP " + res.status);
    const j = (await res.json()) as Record<string, unknown>;
    const u: Usage = {
      fiveHour: win(j.five_hour),
      sevenDay: win(j.seven_day),
      sevenDayOpus: win(j.seven_day_opus),
      sevenDaySonnet: win(j.seven_day_sonnet),
    };
    cache.set(accessToken, { u, at: now });
    return u;
  } finally {
    clearTimeout(timer);
  }
}

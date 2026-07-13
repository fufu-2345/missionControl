// HTTP client for the oracle vector API (arra-oracle-v3, http://127.0.0.1:47778).
// Node-only, uses global fetch with an AbortController timeout (mirrors usage.ts).
// getConfig/getHealth/getStats/indexStatus swallow connection failures into a
// null/offline result so the UI can show "oracle offline" instead of crashing;
// the mutating calls (patchConfig/startIndex/stopIndex) throw on failure so the
// host can surface an error toast.

export const ORACLE_BASE = "http://127.0.0.1:47778";
const TIMEOUT_MS = 4000;

// Injectable fetch for tests. undefined → real global fetch.
type FetchFn = (url: string, init: RequestInit) => Promise<Response>;
let _fetch: FetchFn | undefined;
/** Test hook — override the fetch used by this module (undefined resets). */
export function __setFetch(fn: FetchFn | undefined): void {
  _fetch = fn;
}
function doFetch(url: string, init: RequestInit): Promise<Response> {
  return (_fetch || (globalThis.fetch as unknown as FetchFn))(url, init);
}

async function req(path: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await doFetch(ORACLE_BASE + path, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init.headers || {}) },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** GET that returns null on any network/parse failure (offline-tolerant). */
async function getSafe(path: string): Promise<any | null> {
  try {
    const res = await req(path, { method: "GET" });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function getConfig(): Promise<{ online: boolean; config: any | null }> {
  const config = await getSafe("/api/vector/config");
  return { online: config !== null, config };
}

export function getHealth(): Promise<any | null> {
  return getSafe("/api/health");
}

export function getStats(): Promise<any | null> {
  return getSafe("/api/vector/stats");
}

export function indexStatus(): Promise<any | null> {
  return getSafe("/api/vector/index/status");
}

export type PatchBody = { enabled?: boolean; collections?: Record<string, { primary?: boolean }> };

/** Thrown when a mutating call can't reach the server (connection refused /
 *  timeout), as opposed to the server answering with an HTTP error. Lets the
 *  host fall back to a direct file write instead of surfacing an error. */
export class OracleOfflineError extends Error {
  constructor(cause?: unknown) {
    super("oracle offline");
    this.name = "OracleOfflineError";
    (this as { cause?: unknown }).cause = cause;
  }
}

/** Mutating calls throw OracleOfflineError when the server is unreachable, or a
 *  plain Error carrying the server's message on a non-2xx response. */
async function mutate(path: string, method: string, body?: unknown): Promise<any> {
  let res: Response;
  try {
    res = await req(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (e) {
    // fetch rejects (ECONNREFUSED) or the AbortController fires on timeout →
    // the server isn't there. Distinct from an HTTP error the server returned.
    throw new OracleOfflineError(e);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const m = (json && (json as any).error) || ("HTTP " + res.status);
    throw new Error(String(m));
  }
  return json;
}

export function patchConfig(body: PatchBody): Promise<any> {
  return mutate("/api/vector/config", "PATCH", body);
}

export function startIndex(model?: string): Promise<any> {
  return mutate("/api/vector/index/start", "POST", model ? { model } : {});
}

export function stopIndex(): Promise<any> {
  return mutate("/api/vector/index/stop", "POST", {});
}

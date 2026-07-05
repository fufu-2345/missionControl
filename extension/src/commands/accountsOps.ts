// Pure-ish file ops for the multi-provider Accounts panel. NO vscode import here
// so the validation + vault logic can be unit-tested standalone with `bun test`.
//
// UNIFORM subscription model: every provider is a subscription-login CLI that
// stores its OAuth session in a credentials FILE. Managing accounts is the same
// three moves for all of them, only the file path differs:
//
//   capture — copy the CLI's live credentials file into the vault under a label
//   switch  — write a saved copy back over the live file (back it up first)
//   delete  — drop a saved copy from the vault
//
// Only NEWLY-started CLI processes pick up a switch (a running claude/codex holds
// its token in memory until restart). Adding a provider = one row in PROVIDERS.
//
//   claude — ~/.claude/.credentials.json   (Claude Pro/Max via Claude Code)
//   openai — ~/.codex/auth.json            (ChatGPT sub via Codex CLI)
//
// SECURITY: vault files hold live session tokens. The vault dir is 0700, every
// file 0600, and NO token value is ever logged or sent to a webview — only
// metadata (subscription type / captured date).
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export type Provider = "claude" | "openai";
export const PROVIDERS: Provider[] = ["claude", "openai"];

export function isProvider(p: unknown): p is Provider {
  return p === "claude" || p === "openai";
}

// Honor each CLI's own config-dir override so the vault tracks the exact file
// the CLI reads. Read live (not cached) so tests can point them at temp dirs.
function claudeDir(): string {
  const e = process.env.CLAUDE_CONFIG_DIR;
  return e && e.trim() ? e.trim() : path.join(os.homedir(), ".claude");
}
function codexDir(): string {
  const e = process.env.CODEX_HOME;
  return e && e.trim() ? e.trim() : path.join(os.homedir(), ".codex");
}

/** Absolute path to a provider's LIVE credentials file. */
function credFile(p: Provider): string {
  return p === "claude"
    ? path.join(claudeDir(), ".credentials.json")
    : path.join(codexDir(), "auth.json");
}
function credBackupFile(p: Provider): string {
  return credFile(p) + ".mc-bak";
}

/** How to obtain a login when a provider has no live credentials yet. */
export function loginHint(p: Provider): string {
  return p === "claude"
    ? "รัน claude /login ก่อน"
    : "ติดตั้ง Codex CLI แล้ว codex login ก่อน (ยังไม่พบ ~/.codex/auth.json)";
}

/** Does a captured/live credentials object actually carry a session? Claude has
 *  a known shape (claudeAiOauth.accessToken); other providers fall back to
 *  "non-empty JSON object" so we stay structure-agnostic for CLIs we can't
 *  verify on this machine. */
function hasAuth(p: Provider, cred: Record<string, unknown> | null): boolean {
  if (!cred) return false;
  if (p === "claude") {
    const o = cred.claudeAiOauth;
    const t = o && typeof o === "object" ? (o as Record<string, unknown>).accessToken : undefined;
    return typeof t === "string" && t.length > 0;
  }
  return Object.keys(cred).length > 0;
}

/** Display metadata pulled from a credentials object. Never includes a token.
 *  Only Claude has a shape we know; others show nothing extra. */
function credMeta(p: Provider, cred: Record<string, unknown> | null): {
  primary: string;
  secondary: string;
} {
  if (p === "claude" && cred) {
    const o = (cred.claudeAiOauth as Record<string, unknown>) ?? {};
    return {
      primary: typeof o.subscriptionType === "string" ? o.subscriptionType : "?",
      secondary: typeof o.rateLimitTier === "string" ? o.rateLimitTier : "",
    };
  }
  return { primary: "", secondary: "" };
}

// ---- vault paths (one central vault under claudeDir, keyed by provider) -----

function accountsDir(): string {
  return path.join(claudeDir(), ".mc-accounts");
}
function providerDir(p: Provider): string {
  return path.join(accountsDir(), p);
}
function indexFile(): string {
  return path.join(accountsDir(), "_index.json");
}
function acctFile(p: Provider, label: string): string {
  return path.join(providerDir(p), label + ".json");
}
function metaKey(p: Provider, label: string): string {
  return p + "/" + label;
}

export interface AccountMeta {
  provider: Provider;
  label: string;
  capturedAt: string; // ISO 8601, or "" if unknown
  primary: string; // e.g. subscription type (claude); "" for generic providers
  secondary: string; // e.g. rate-limit tier (claude)
}

export interface ProviderState {
  provider: Provider;
  active: string | null;
  loginHint: string;
  live: { present: boolean; primary: string; secondary: string };
  accounts: AccountMeta[];
}

export interface AccountsView {
  providers: ProviderState[];
}

export interface OpResult {
  ok: boolean;
  error?: string;
}

const LABEL_RE = /^[A-Za-z0-9._-]+$/;

/** A label is safe to use as a filename + index key. Whitelist only; `_index`
 *  is reserved so it can never collide with the index file. */
export function isSafeLabel(label: unknown): label is string {
  return (
    typeof label === "string" &&
    label.length > 0 &&
    label.length <= 60 &&
    label !== "_index" &&
    LABEL_RE.test(label)
  );
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* best-effort; a shared FS may not honor chmod */
  }
}
function writeSecure(file: string, data: string): void {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, data, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best-effort */
  }
}

interface IndexFile {
  active: Record<string, string | null>; // provider -> label
  meta: Record<string, { capturedAt: string }>; // "provider/label" -> {capturedAt}
}
function readIndex(): IndexFile {
  const j = readJson(indexFile());
  const active =
    j && typeof j.active === "object" && j.active ? (j.active as IndexFile["active"]) : {};
  const meta = j && typeof j.meta === "object" && j.meta ? (j.meta as IndexFile["meta"]) : {};
  return { active, meta };
}
function writeIndex(idx: IndexFile): void {
  writeSecure(indexFile(), JSON.stringify(idx, null, 2));
}

// ---- token access (HOST-ONLY — returns secrets; never post to a webview) ----

export interface ClaudeToken {
  accessToken: string;
  expiresAt: number; // epoch ms (0 if unknown)
}
function readClaudeToken(file: string): ClaudeToken | null {
  const cred = readJson(file);
  const o = cred?.claudeAiOauth;
  if (!o || typeof o !== "object") return null;
  const rec = o as Record<string, unknown>;
  const at = rec.accessToken;
  if (typeof at !== "string" || !at) return null;
  const rawExp = rec.expiresAt;
  const exp = typeof rawExp === "number" ? rawExp : typeof rawExp === "string" ? parseInt(rawExp, 10) : 0;
  return { accessToken: at, expiresAt: Number.isFinite(exp) ? exp : 0 };
}
/** The LIVE Claude token (fresh — claude keeps it refreshed). */
export function liveClaudeToken(): ClaudeToken | null {
  return readClaudeToken(credFile("claude"));
}
/** The token stored under a saved Claude label (may be expired). */
export function savedClaudeToken(label: string): ClaudeToken | null {
  if (!isSafeLabel(label)) return null;
  return readClaudeToken(acctFile("claude", label));
}

// ---- queries ---------------------------------------------------------------

export function accountExists(provider: Provider, label: string): boolean {
  if (!isProvider(provider) || !isSafeLabel(label)) return false;
  try {
    return fs.existsSync(acctFile(provider, label));
  } catch {
    return false;
  }
}

function listProviderAccounts(p: Provider, idx: IndexFile): AccountMeta[] {
  const out: AccountMeta[] = [];
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(providerDir(p));
  } catch {
    return out; // no dir yet
  }
  for (const f of entries) {
    if (!f.endsWith(".json")) continue;
    const label = f.slice(0, -".json".length);
    const full = path.join(providerDir(p), f);
    const cred = readJson(full);
    if (!hasAuth(p, cred)) continue;
    let capturedAt = idx.meta[metaKey(p, label)]?.capturedAt ?? "";
    if (!capturedAt) {
      try {
        capturedAt = fs.statSync(full).mtime.toISOString();
      } catch {
        capturedAt = "";
      }
    }
    const m = credMeta(p, cred);
    out.push({ provider: p, label, capturedAt, primary: m.primary, secondary: m.secondary });
  }
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}

/** List every provider's saved accounts + the currently-live session metadata.
 *  Never returns tokens. */
export function listAccounts(): AccountsView {
  ensureDir(accountsDir());
  const idx = readIndex();
  const providers: ProviderState[] = PROVIDERS.map((p) => {
    const accounts = listProviderAccounts(p, idx);
    const live = readJson(credFile(p));
    const present = hasAuth(p, live);
    const m = credMeta(p, live);
    return {
      provider: p,
      active: idx.active[p] ?? null,
      loginHint: loginHint(p),
      live: { present, primary: present ? m.primary : "", secondary: present ? m.secondary : "" },
      accounts,
    };
  });
  return { providers };
}

// ---- mutations -------------------------------------------------------------

/** Save the CURRENT live credentials of `provider` into the vault under `label`
 *  (overwrites — used for first capture AND the "อัปเดต" refresh). The captured
 *  account IS the live one, so it becomes active. `at` is passed in (ISO string)
 *  to keep this clock-free for tests. */
export function captureCurrent(provider: Provider, label: string, at: string): OpResult {
  if (!isProvider(provider)) return { ok: false, error: "provider ไม่ถูกต้อง" };
  if (!isSafeLabel(label)) return { ok: false, error: "label ใช้ได้เฉพาะ A-Z a-z 0-9 . _ - (1-60 ตัว)" };
  const cred = readJson(credFile(provider));
  if (!hasAuth(provider, cred)) {
    return { ok: false, error: `ยังไม่พบ credentials ที่ใช้ได้ — ${loginHint(provider)}` };
  }
  writeSecure(acctFile(provider, label), JSON.stringify(cred, null, 2));
  const idx = readIndex();
  idx.meta[metaKey(provider, label)] = { capturedAt: at };
  idx.active[provider] = label;
  writeIndex(idx);
  return { ok: true };
}

/** Make `label` the active account for `provider`: back up the live credentials,
 *  then write the saved copy over the live file. Affects only NEWLY-started CLI
 *  processes. Intentionally does NOT sync-back the outgoing account — the OAuth
 *  blob carries no account id, so mirroring the live file could clobber a saved
 *  token with a different account's. Use captureCurrent ("อัปเดต") to refresh a
 *  label on purpose. */
export function switchTo(provider: Provider, label: string): OpResult {
  if (!isProvider(provider)) return { ok: false, error: "provider ไม่ถูกต้อง" };
  if (!isSafeLabel(label)) return { ok: false, error: "label ไม่ถูกต้อง" };
  const cred = readJson(acctFile(provider, label));
  if (!hasAuth(provider, cred)) {
    return { ok: false, error: `account '${label}' ไม่มี session ที่ใช้ได้ — login แล้วกด "อัปเดต"` };
  }
  const live = readJson(credFile(provider));
  if (live) {
    try {
      writeSecure(credBackupFile(provider), JSON.stringify(live, null, 2));
    } catch {
      /* backup best-effort */
    }
  }
  writeSecure(credFile(provider), JSON.stringify(cred, null, 2));
  const idx = readIndex();
  idx.active[provider] = label;
  writeIndex(idx);
  return { ok: true };
}

/** Remove a saved account from the vault. Never touches the real upstream
 *  account nor the live credentials file. Clears active if it was active. */
export function deleteAccount(provider: Provider, label: string): OpResult {
  if (!isProvider(provider)) return { ok: false, error: "provider ไม่ถูกต้อง" };
  if (!isSafeLabel(label)) return { ok: false, error: "label ไม่ถูกต้อง" };
  try {
    fs.unlinkSync(acctFile(provider, label));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") return { ok: false, error: String((e as Error)?.message ?? e) };
  }
  const idx = readIndex();
  delete idx.meta[metaKey(provider, label)];
  if (idx.active[provider] === label) idx.active[provider] = null;
  writeIndex(idx);
  return { ok: true };
}

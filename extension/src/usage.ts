import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Real Claude Code spend, computed locally — no backend. Claude Code writes one
// JSONL transcript per session under ~/.claude/projects/**; every assistant line
// carries message.usage (input/output/cache tokens) + message.model. We turn
// tokens × Anthropic list price into USD. Cost is COMPUTED (the transcripts have
// no costUSD field). This is the data source the removed /budget endpoint never had.
const M = 1_000_000;

export interface Bucket {
  cost: number;
  tokens: number;
}
export interface UsageSummary {
  total: Bucket;
  byDay: Record<string, Bucket>; // key "YYYY-MM-DD" in LOCAL time (matches the user's clock)
  byProject: Record<string, Bucket>; // key = cwd
  fileCount: number;
  computedAt: number;
}

// ── Local-day helpers ────────────────────────────────────────────────────────
// Transcript timestamps are UTC ISO. Budgets should align to the user's wall
// clock, so we bucket by LOCAL date and derive "today"/"this month" the same way
// — otherwise late-evening work (after 00:00 local = 17:00 UTC for UTC+7) would
// land on the wrong UTC day.
function fmtLocalDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function localDayKey(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "unknown" : fmtLocalDay(d);
}
/** Local "YYYY-MM-DD" for now. */
export function localTodayKey(): string {
  return fmtLocalDay(new Date());
}
/** Local "YYYY-MM" for now. */
export function localMonthKey(): string {
  return localTodayKey().slice(0, 7);
}

// Per-token USD rates by model family. Anthropic list pricing (per MTok):
// opus $5/$25, sonnet $3/$15, haiku $1/$5, fable $10/$50. Cache write = 1.25×in
// (5-min) / 2×in (1-hour); cache read = 0.1×in. <synthetic> lines are free.
// Matched by substring so older ids (claude-3-5-haiku-…, claude-3-opus-…) also hit.
interface Rate {
  i: number;
  o: number;
  w5: number;
  w1: number;
  r: number;
}
function ratesFor(model: string): Rate | null {
  const m = model.toLowerCase();
  if (!m || m.indexOf("synthetic") !== -1) return null;
  let inp: number;
  let out: number;
  if (m.includes("fable") || m.includes("mythos")) {
    inp = 10;
    out = 50;
  } else if (m.includes("opus")) {
    inp = 5;
    out = 25;
  } else if (m.includes("sonnet")) {
    inp = 3;
    out = 15;
  } else if (m.includes("haiku")) {
    inp = 1;
    out = 5;
  } else {
    inp = 5; // unknown → opus-tier (safe over-estimate)
    out = 25;
  }
  return {
    i: inp / M,
    o: out / M,
    w5: (inp * 1.25) / M,
    w1: (inp * 2) / M,
    r: (inp * 0.1) / M,
  };
}

interface FileAgg extends Bucket {
  mtimeMs: number;
  size: number;
  byDay: Record<string, Bucket>;
  byProject: Record<string, Bucket>;
}

// Per-file cache keyed by path → re-read a transcript only when its mtime/size
// change. In steady state only the active session's file is dirty, so a refresh
// re-reads one file and sums the rest from cache. A short TTL on the whole
// summary keeps the dashboard's 10s poll from re-stat'ing 300+ files each tick.
// All I/O is async (fs.promises) so a cold scan never blocks the extension host.
const fileCache = new Map<string, FileAgg>();
let summaryCache: UsageSummary | null = null;
let summaryAt = 0;
let inFlight: Promise<UsageSummary> | null = null;
const SUMMARY_TTL = 15_000;

// Persist the per-file cache across extension reloads (F5 / window reload).
// Without this, every reload does a cold full parse of ALL transcripts
// (~450MB / 1000+ files → several seconds); with it, only files whose
// mtime/size changed since last run get re-parsed. Best-effort: any read/write
// error just falls back to an in-memory-only cold scan.
const CACHE_FILE = path.join(os.homedir(), ".cache", "mission-control", "usage-filecache.json");
let hydrated = false;

async function hydrateFileCache(): Promise<void> {
  if (hydrated) return;
  hydrated = true; // attempt once per process; a miss just means a cold scan
  try {
    const raw = await fs.promises.readFile(CACHE_FILE, "utf8");
    const obj = JSON.parse(raw) as { v?: number; entries?: [string, FileAgg][] };
    if (obj?.v === 1 && Array.isArray(obj.entries)) {
      for (const [k, v] of obj.entries) fileCache.set(k, v);
    }
  } catch {
    // no cache yet / unreadable — the cold scan below will rebuild it
  }
}

async function saveFileCache(currentFiles: string[]): Promise<void> {
  try {
    const keep = new Set(currentFiles); // drop entries for vanished transcripts
    const entries = [...fileCache].filter(([k]) => keep.has(k));
    await fs.promises.mkdir(path.dirname(CACHE_FILE), { recursive: true });
    await fs.promises.writeFile(CACHE_FILE, JSON.stringify({ v: 1, entries }));
  } catch {
    // best-effort — a failed write just means the next reload cold-scans
  }
}

function projectsDir(): string {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  return path.join(base, "projects");
}

async function collectJsonl(dir: string, out: string[], depth = 0): Promise<void> {
  if (depth > 4) return;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await collectJsonl(p, out, depth + 1);
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
  }
}

function bump(map: Record<string, Bucket>, key: string, cost: number, tokens: number): void {
  const b = map[key] || (map[key] = { cost: 0, tokens: 0 });
  b.cost += cost;
  b.tokens += tokens;
}

async function aggregateFile(file: string): Promise<FileAgg> {
  const agg: FileAgg = { mtimeMs: 0, size: 0, cost: 0, tokens: 0, byDay: {}, byProject: {} };
  let raw: string;
  try {
    raw = await fs.promises.readFile(file, "utf8");
  } catch {
    return agg;
  }
  // Dedupe within a file on requestId:message.id — compaction re-logs assistant
  // lines, and counting them twice would inflate the bill (ccusage does the same).
  const seen = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.indexOf('"usage"') === -1) continue;
    let d: {
      type?: string;
      requestId?: string;
      timestamp?: string;
      cwd?: string;
      message?: {
        id?: string;
        model?: string;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
          cache_creation?: {
            ephemeral_5m_input_tokens?: number;
            ephemeral_1h_input_tokens?: number;
          };
        };
      };
    };
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d.type !== "assistant") continue;
    const msg = d.message;
    const usage = msg && msg.usage;
    if (!msg || !usage) continue;
    if (d.requestId || msg.id) {
      const key = `${d.requestId ?? ""}:${msg.id ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    const rate = ratesFor(String(msg.model ?? ""));
    if (!rate) continue;
    const cc = usage.cache_creation || {};
    const c5 = cc.ephemeral_5m_input_tokens ?? 0;
    const c1 = cc.ephemeral_1h_input_tokens ?? 0;
    const ccTot = usage.cache_creation_input_tokens ?? 0;
    const inp = usage.input_tokens ?? 0;
    const outp = usage.output_tokens ?? 0;
    const cr = usage.cache_read_input_tokens ?? 0;
    // Prefer the 5m/1h split when present; otherwise price all cache-creation at 5m.
    const writeCost = c5 || c1 ? c5 * rate.w5 + c1 * rate.w1 : ccTot * rate.w5;
    const cost = inp * rate.i + outp * rate.o + cr * rate.r + writeCost;
    const tokens = inp + outp + cr + ccTot;
    agg.cost += cost;
    agg.tokens += tokens;
    const day = typeof d.timestamp === "string" ? localDayKey(d.timestamp) : "unknown";
    bump(agg.byDay, day, cost, tokens);
    const proj = typeof d.cwd === "string" && d.cwd ? d.cwd : "unknown";
    bump(agg.byProject, proj, cost, tokens);
  }
  return agg;
}

async function scan(): Promise<UsageSummary> {
  const files: string[] = [];
  await collectJsonl(projectsDir(), files);
  await hydrateFileCache(); // reuse last run's per-file aggregates across reloads
  const total: Bucket = { cost: 0, tokens: 0 };
  const byDay: Record<string, Bucket> = {};
  const byProject: Record<string, Bucket> = {};
  for (const file of files) {
    let st: fs.Stats;
    try {
      st = await fs.promises.stat(file);
    } catch {
      continue;
    }
    let agg = fileCache.get(file);
    if (!agg || agg.mtimeMs !== st.mtimeMs || agg.size !== st.size) {
      agg = await aggregateFile(file);
      agg.mtimeMs = st.mtimeMs;
      agg.size = st.size;
      fileCache.set(file, agg);
    }
    total.cost += agg.cost;
    total.tokens += agg.tokens;
    for (const k of Object.keys(agg.byDay)) bump(byDay, k, agg.byDay[k].cost, agg.byDay[k].tokens);
    for (const k of Object.keys(agg.byProject)) {
      bump(byProject, k, agg.byProject[k].cost, agg.byProject[k].tokens);
    }
  }
  summaryCache = { total, byDay, byProject, fileCount: files.length, computedAt: Date.now() };
  summaryAt = summaryCache.computedAt;
  void saveFileCache(files); // persist for the next reload (fire-and-forget)
  return summaryCache;
}

/** Compute real Claude Code USD spend from local transcripts. Async (never blocks
 *  the extension host). Cached for SUMMARY_TTL; pass force=true (e.g. the Budget
 *  command) to bypass the TTL. Concurrent callers share a single in-flight scan. */
export function computeUsage(force = false): Promise<UsageSummary> {
  const now = Date.now();
  if (!force && summaryCache && now - summaryAt < SUMMARY_TTL) {
    return Promise.resolve(summaryCache);
  }
  if (inFlight) return inFlight;
  inFlight = scan().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** Sum spend for every day key whose string starts with `prefix` ("YYYY-MM" for
 *  a month, "YYYY-MM-DD" for a day) — keys are LOCAL dates. */
export function sumByPrefix(s: UsageSummary, prefix: string): number {
  let c = 0;
  for (const k of Object.keys(s.byDay)) if (k.startsWith(prefix)) c += s.byDay[k].cost;
  return c;
}

export const MONTHLY_CAP_KEY = "missioncontrol.monthlyCapUsd";

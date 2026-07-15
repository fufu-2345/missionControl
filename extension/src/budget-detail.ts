import { type Breakdown } from "./usage";

// Pure view helpers for the Budget page's per-project token breakdown popup.
// Kept vscode-free so it is unit-testable with bun (like usage.ts); budget.ts
// (which imports vscode) calls buildDetail to fill each ProjectRow.

export interface BudgetSlice {
  key: "cacheRead" | "cacheWrite" | "output" | "input";
  label: string;
  cost: number; // numeric $ — the client turns this into a pie slice angle
  pct: number; // % of the project's cost (1 decimal)
  text: string; // display line, e.g. "128M (38.4 usd)"
  color: string; // CSS value for the slice fill + legend swatch
  meaning: string; // short Thai explanation shown on hover
}
export interface ProjectDetail {
  slices: BudgetSlice[]; // sorted by cost DESC
  totalText: string; // "138.1M (54.42 usd)"
  hasCost: boolean; // false when the project has no billable spend
}

// Compact token count, no suffix: 2_100_000 -> "2.1M", 950_000 -> "950K".
const TOK = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
export function fmtTokCompact(n: number): string {
  return TOK.format(n || 0);
}

// USD to at most 3 decimals, trailing zeros trimmed: 5.2 -> "5.2", 12 -> "12".
// parseFloat drops the padding toFixed adds, giving "as many decimals as needed".
export function fmtUsd3(n: number): string {
  return String(parseFloat((n || 0).toFixed(3)));
}

// The exact legend/total format the user asked for: "<tokens> (<usd> usd)".
export function fmtBreakdownLine(tok: number, cost: number): string {
  return fmtTokCompact(tok) + " (" + fmtUsd3(cost) + " usd)";
}

interface Cat {
  key: BudgetSlice["key"];
  label: string;
  color: string;
  meaning: string;
  tokKey: keyof Breakdown;
  costKey: keyof Breakdown;
}
// VS Code chart theme vars (with hex fallbacks) so slices match the panel theme.
const CATS: Cat[] = [
  {
    key: "input",
    label: "Input",
    color: "var(--vscode-charts-green, #3fb950)",
    meaning: "โค้ด/ข้อความที่ Claude อ่านสดรอบนั้น (ไม่อยู่ใน cache)",
    tokKey: "inTok",
    costKey: "inCost",
  },
  {
    key: "output",
    label: "Output",
    color: "var(--vscode-charts-red, #f14c4c)",
    meaning: "คำตอบที่ Claude สร้าง — แพงสุดต่อ token",
    tokKey: "outTok",
    costKey: "outCost",
  },
  {
    key: "cacheWrite",
    label: "Cache write",
    color: "var(--vscode-charts-orange, #e0803f)",
    meaning: "บันทึก context ลง cache ครั้งแรก — 1.25-2x ของ input",
    tokKey: "cacheWriteTok",
    costKey: "cacheWriteCost",
  },
  {
    key: "cacheRead",
    label: "Cache read",
    color: "var(--vscode-charts-blue, #4d9de0)",
    meaning: "อ่าน context เดิมซ้ำจาก cache — ถูกสุด 0.1x ของ input; session ยิ่งยาว/ไม่ compact ยิ่งบวมตรงนี้",
    tokKey: "cacheReadTok",
    costKey: "cacheReadCost",
  },
];

// Turn a summed per-project Breakdown into display-ready slices (cost-desc),
// each with its % of the project's cost and the "tok (usd)" line. hasCost=false
// signals the popup to show an "no billable spend" message instead of a pie.
export function buildDetail(bd: Breakdown): ProjectDetail {
  const totalCost = bd.inCost + bd.outCost + bd.cacheReadCost + bd.cacheWriteCost;
  const totalTok = bd.inTok + bd.outTok + bd.cacheReadTok + bd.cacheWriteTok;
  const slices = CATS.map((c): BudgetSlice => {
    const cost = bd[c.costKey] as number;
    const tok = bd[c.tokKey] as number;
    return {
      key: c.key,
      label: c.label,
      color: c.color,
      meaning: c.meaning,
      cost,
      pct: totalCost > 0 ? Math.round((cost / totalCost) * 1000) / 10 : 0,
      text: fmtBreakdownLine(tok, cost),
    };
  }).sort((a, b) => b.cost - a.cost);
  return { slices, totalText: fmtBreakdownLine(totalTok, totalCost), hasCost: totalCost > 0 };
}

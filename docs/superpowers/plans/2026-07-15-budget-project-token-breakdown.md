# Budget per-project token breakdown — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** Click a project row on the Budget page → modal popup with a hand-drawn SVG pie chart (input/output/cache-write/cache-read by $), a legend (`2.1M (37.942 usd)` format), and a short hover tooltip per slice.

**Architecture:** All pricing + formatting math lives in pure, bun-tested functions (`priceLine` in usage.ts; `buildDetail`/formatters in new `budget-detail.ts`). budget.ts wires them into the view; the webview inline script draws the modal/pie/tooltip (verified by manual E2E, per repo convention). Spec: `docs/superpowers/specs/2026-07-15-budget-project-token-breakdown-design.md`.

**Tech Stack:** TypeScript (tsc → out/), bun:test, VS Code webview (inline SVG, no external libs).

## Global Constraints
- The `renderShell()` inline `<script>` template literal must contain NO backticks and NO backslashes (repo foot-gun; build strings with `+`, no `\n`, no regex with backslashes).
- Host sends display-ready strings; client stays dumb.
- `usage.ts` must stay free of `vscode` imports (keeps it bun-testable).
- USD format: up to 3 decimals, trailing zeros trimmed (`String(parseFloat(n.toFixed(3)))`).
- Pie is proportioned by **cost** ($), not token count.
- Anthropic list pricing already encoded in `ratesFor()` — do not change it.

---

### Task 1: `priceLine()` — pure per-line pricing + 4-way split (usage.ts)

**Files:** Modify `extension/src/usage.ts`; Test `extension/src/usage.test.ts` (create).

**Interfaces — Produces:**
```ts
export interface Breakdown {
  inTok: number; outTok: number; cacheReadTok: number; cacheWriteTok: number;
  inCost: number; outCost: number; cacheReadCost: number; cacheWriteCost: number;
}
export function emptyBreakdown(): Breakdown;                 // all zeros
export function addBreakdown(a: Breakdown, b: Breakdown): Breakdown;  // field-wise sum (new object)
interface UsageCounts {
  input_tokens?: number; output_tokens?: number;
  cache_read_input_tokens?: number; cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}
export function priceLine(model: string, u: UsageCounts):
  { cost: number; tokens: number; bd: Breakdown } | null;   // null when ratesFor()===null (synthetic)
```

- [ ] **Step 1: Failing test** — `extension/src/usage.test.ts`
```ts
import { describe, expect, test } from "bun:test";
import { priceLine, emptyBreakdown, addBreakdown } from "./usage";

describe("priceLine", () => {
  test("opus split + cost (no 5m/1h)", () => {
    const r = priceLine("claude-opus-4-8", {
      input_tokens: 1000, output_tokens: 500,
      cache_read_input_tokens: 10000, cache_creation_input_tokens: 2000,
    })!;
    expect(r).not.toBeNull();
    expect(r.bd.inTok).toBe(1000);
    expect(r.bd.cacheWriteTok).toBe(2000);
    expect(r.bd.inCost).toBeCloseTo(0.005, 9);
    expect(r.bd.outCost).toBeCloseTo(0.0125, 9);
    expect(r.bd.cacheReadCost).toBeCloseTo(0.005, 9);
    expect(r.bd.cacheWriteCost).toBeCloseTo(0.0125, 9);
    expect(r.cost).toBeCloseTo(0.035, 9);
    expect(r.tokens).toBe(13500);
    // invariant: parts sum to whole
    expect(r.bd.inCost + r.bd.outCost + r.bd.cacheReadCost + r.bd.cacheWriteCost).toBeCloseTo(r.cost, 9);
  });
  test("uses 5m/1h split when present (ccTot still = cacheWriteTok)", () => {
    const r = priceLine("claude-opus-4-8", {
      cache_creation_input_tokens: 3000,
      cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 },
    })!;
    expect(r.bd.cacheWriteCost).toBeCloseTo(1000 * 6.25e-6 + 2000 * 10e-6, 9); // 0.02625
    expect(r.bd.cacheWriteTok).toBe(3000);
  });
  test("synthetic model → null", () => {
    expect(priceLine("<synthetic>", { input_tokens: 5 })).toBeNull();
  });
});

describe("Breakdown helpers", () => {
  test("empty is zeros; add is field-wise", () => {
    const e = emptyBreakdown();
    expect(e.inTok).toBe(0); expect(e.cacheWriteCost).toBe(0);
    const a = { inTok:1,outTok:2,cacheReadTok:3,cacheWriteTok:4,inCost:5,outCost:6,cacheReadCost:7,cacheWriteCost:8 };
    const s = addBreakdown(a, a);
    expect(s.inTok).toBe(2); expect(s.cacheWriteCost).toBe(16);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`cd extension && bun test src/usage.test.ts` → "priceLine is not a function")

- [ ] **Step 3: Implement in usage.ts** — add after `ratesFor()`:
```ts
export function emptyBreakdown(): Breakdown {
  return { inTok:0,outTok:0,cacheReadTok:0,cacheWriteTok:0,inCost:0,outCost:0,cacheReadCost:0,cacheWriteCost:0 };
}
export function addBreakdown(a: Breakdown, b: Breakdown): Breakdown {
  return {
    inTok:a.inTok+b.inTok, outTok:a.outTok+b.outTok,
    cacheReadTok:a.cacheReadTok+b.cacheReadTok, cacheWriteTok:a.cacheWriteTok+b.cacheWriteTok,
    inCost:a.inCost+b.inCost, outCost:a.outCost+b.outCost,
    cacheReadCost:a.cacheReadCost+b.cacheReadCost, cacheWriteCost:a.cacheWriteCost+b.cacheWriteCost,
  };
}
export function priceLine(model: string, u: UsageCounts): { cost:number; tokens:number; bd:Breakdown } | null {
  const rate = ratesFor(model);
  if (!rate) return null;
  const cc = u.cache_creation || {};
  const c5 = cc.ephemeral_5m_input_tokens ?? 0;
  const c1 = cc.ephemeral_1h_input_tokens ?? 0;
  const ccTot = u.cache_creation_input_tokens ?? 0;
  const inp = u.input_tokens ?? 0;
  const outp = u.output_tokens ?? 0;
  const cr = u.cache_read_input_tokens ?? 0;
  const inCost = inp * rate.i, outCost = outp * rate.o, cacheReadCost = cr * rate.r;
  const cacheWriteCost = c5 || c1 ? c5 * rate.w5 + c1 * rate.w1 : ccTot * rate.w5;
  const cost = inCost + outCost + cacheReadCost + cacheWriteCost;
  const tokens = inp + outp + cr + ccTot;
  return { cost, tokens, bd: { inTok:inp,outTok:outp,cacheReadTok:cr,cacheWriteTok:ccTot,inCost,outCost,cacheReadCost,cacheWriteCost } };
}
```
Also add the `Breakdown` interface (near `Bucket`) and the `UsageCounts` interface. Keep the inline `usage` param type on the JSONL line loose (reuse existing).

- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit** — `feat(budget): add priceLine pure fn + Breakdown split`

---

### Task 2: Capture byProjectDetail through aggregate + scan (usage.ts)

**Files:** Modify `extension/src/usage.ts`.
**Interfaces — Consumes:** `priceLine`, `emptyBreakdown`, `addBreakdown` (Task 1). **Produces:** `UsageSummary.byProjectDetail: Record<string, Breakdown>`.

- [ ] **Step 1:** `FileAgg` and `UsageSummary` each gain `byProjectDetail: Record<string, Breakdown>;`. Init `byProjectDetail: {}` in `aggregateFile` and in `scan`'s locals.
- [ ] **Step 2:** In `aggregateFile`, replace the inline cost math (current lines ~272-284) with:
```ts
const pl = priceLine(String(msg.model ?? ""), usage);
if (!pl) continue;
agg.cost += pl.cost; agg.tokens += pl.tokens;
const day = typeof d.timestamp === "string" ? localDayKey(d.timestamp) : "unknown";
bump(agg.byDay, day, pl.cost, pl.tokens);
const proj = typeof d.cwd === "string" && d.cwd ? d.cwd : "unknown";
bump(agg.byProject, proj, pl.cost, pl.tokens);
agg.byProjectDetail[proj] = addBreakdown(agg.byProjectDetail[proj] ?? emptyBreakdown(), pl.bd);
```
(keep the `projectLastMs` block after this, unchanged.)
- [ ] **Step 3:** In `scan`, add `const byProjectDetail: Record<string, Breakdown> = {};` and in the merge loop:
```ts
for (const k of Object.keys(agg.byProjectDetail)) {
  byProjectDetail[k] = addBreakdown(byProjectDetail[k] ?? emptyBreakdown(), agg.byProjectDetail[k]);
}
```
Include `byProjectDetail` in the `summaryCache = { ... }` object.
- [ ] **Step 4:** Bump `const CACHE_VERSION = 3;` → `4;` and extend its comment (`v4: byProjectDetail per-project token split`).
- [ ] **Step 5:** `bun test src/usage.test.ts` still PASS; `npm run compile` exits 0.
- [ ] **Step 6: Commit** — `feat(budget): thread per-project token breakdown into UsageSummary (cache v4)`

---

### Task 3: `budget-detail.ts` — formatters + buildDetail (pure)

**Files:** Create `extension/src/budget-detail.ts`; Test `extension/src/budget-detail.test.ts`.
**Interfaces — Consumes:** `Breakdown` from `./usage`. **Produces:**
```ts
export interface BudgetSlice { key:"cacheRead"|"cacheWrite"|"output"|"input"; label:string; cost:number; pct:number; text:string; color:string; meaning:string; }
export interface ProjectDetail { slices: BudgetSlice[]; totalText:string; hasCost:boolean; }
export function fmtUsd3(n:number): string;
export function fmtTokCompact(n:number): string;
export function fmtBreakdownLine(tok:number, cost:number): string;
export function buildDetail(bd: Breakdown): ProjectDetail;
```

- [ ] **Step 1: Failing test** — `budget-detail.test.ts`
```ts
import { describe, expect, test } from "bun:test";
import { fmtUsd3, fmtTokCompact, fmtBreakdownLine, buildDetail } from "./budget-detail";

describe("formatters", () => {
  test("fmtUsd3 trims trailing zeros, up to 3 dp", () => {
    expect(fmtUsd3(37.942)).toBe("37.942");
    expect(fmtUsd3(5.2)).toBe("5.2");
    expect(fmtUsd3(8.5)).toBe("8.5");
    expect(fmtUsd3(12)).toBe("12");
    expect(fmtUsd3(0)).toBe("0");
    expect(fmtUsd3(1.23456)).toBe("1.235"); // rounds to 3
  });
  test("fmtTokCompact", () => {
    expect(fmtTokCompact(2_100_000)).toBe("2.1M");
    expect(fmtTokCompact(950_000)).toBe("950K");
    expect(fmtTokCompact(0)).toBe("0");
  });
  test("fmtBreakdownLine", () => {
    expect(fmtBreakdownLine(2_100_000, 37.942)).toBe("2.1M (37.942 usd)");
  });
});

describe("buildDetail", () => {
  const bd = { inTok:2_100_000,outTok:1_200_000,cacheReadTok:128_000_000,cacheWriteTok:6_800_000,
               inCost:2.32,outCost:5.2,cacheReadCost:38.4,cacheWriteCost:8.5 };
  test("slices sorted by cost desc; parts sum to total; format", () => {
    const d = buildDetail(bd);
    expect(d.hasCost).toBe(true);
    expect(d.slices.map(s => s.key)).toEqual(["cacheRead","cacheWrite","output","input"]);
    const sum = d.slices.reduce((a,s)=>a+s.cost,0);
    expect(sum).toBeCloseTo(54.42, 6);
    expect(Math.round(d.slices.reduce((a,s)=>a+s.pct,0))).toBe(100);
    expect(d.slices[0].text).toBe("128M (38.4 usd)");
    expect(d.totalText).toBe(fmtBreakdownLine(138_100_000, 54.42));
  });
  test("all-zero → hasCost false, pct 0", () => {
    const z = buildDetail({ inTok:0,outTok:0,cacheReadTok:0,cacheWriteTok:0,inCost:0,outCost:0,cacheReadCost:0,cacheWriteCost:0 });
    expect(z.hasCost).toBe(false);
    expect(z.slices.every(s => s.pct === 0)).toBe(true);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (module not found)

- [ ] **Step 3: Implement `budget-detail.ts`**
```ts
import { type Breakdown } from "./usage";

export interface BudgetSlice { key:"cacheRead"|"cacheWrite"|"output"|"input"; label:string; cost:number; pct:number; text:string; color:string; meaning:string; }
export interface ProjectDetail { slices: BudgetSlice[]; totalText:string; hasCost:boolean; }

const TOK = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
export function fmtTokCompact(n:number): string { return TOK.format(n || 0); }
export function fmtUsd3(n:number): string { return String(parseFloat((n || 0).toFixed(3))); }
export function fmtBreakdownLine(tok:number, cost:number): string { return fmtTokCompact(tok) + " (" + fmtUsd3(cost) + " usd)"; }

interface Cat { key:BudgetSlice["key"]; label:string; color:string; meaning:string; tokKey:keyof Breakdown; costKey:keyof Breakdown; }
const CATS: Cat[] = [
  { key:"input",      label:"Input",       color:"var(--vscode-charts-green, #3fb950)",  meaning:"โค้ด/ข้อความที่ Claude อ่านสดรอบนั้น (ไม่อยู่ใน cache)",                          tokKey:"inTok",        costKey:"inCost" },
  { key:"output",     label:"Output",      color:"var(--vscode-charts-red, #f14c4c)",    meaning:"คำตอบที่ Claude สร้าง — แพงสุดต่อ token",                                        tokKey:"outTok",       costKey:"outCost" },
  { key:"cacheWrite", label:"Cache write", color:"var(--vscode-charts-orange, #e0803f)", meaning:"บันทึก context ลง cache ครั้งแรก — 1.25-2x ของ input",                          tokKey:"cacheWriteTok",costKey:"cacheWriteCost" },
  { key:"cacheRead",  label:"Cache read",  color:"var(--vscode-charts-blue, #4d9de0)",   meaning:"อ่าน context เดิมซ้ำจาก cache — ถูกสุด 0.1x ของ input; session ยิ่งยาว/ไม่ compact ยิ่งบวมตรงนี้", tokKey:"cacheReadTok", costKey:"cacheReadCost" },
];

export function buildDetail(bd: Breakdown): ProjectDetail {
  const totalCost = bd.inCost + bd.outCost + bd.cacheReadCost + bd.cacheWriteCost;
  const totalTok = bd.inTok + bd.outTok + bd.cacheReadTok + bd.cacheWriteTok;
  const slices = CATS.map((c): BudgetSlice => {
    const cost = bd[c.costKey] as number, tok = bd[c.tokKey] as number;
    return { key:c.key, label:c.label, color:c.color, meaning:c.meaning, cost,
             pct: totalCost > 0 ? Math.round((cost / totalCost) * 1000) / 10 : 0,
             text: fmtBreakdownLine(tok, cost) };
  }).sort((a, b) => b.cost - a.cost);
  return { slices, totalText: fmtBreakdownLine(totalTok, totalCost), hasCost: totalCost > 0 };
}
```

- [ ] **Step 4: Run — expect PASS**
- [ ] **Step 5: Commit** — `feat(budget): buildDetail + token/usd formatters (pure, tested)`

---

### Task 4: Wire detail into buildBudgetView (budget.ts)

**Files:** Modify `extension/src/webview/budget.ts`.
**Interfaces — Consumes:** `buildDetail`, `ProjectDetail` (Task 3), `emptyBreakdown`, `addBreakdown`, `UsageSummary.byProjectDetail` (Task 2). **Produces:** `ProjectRow.detail: ProjectDetail`.

- [ ] **Step 1:** Imports: add `import { buildDetail, type ProjectDetail } from "../budget-detail";` and add `emptyBreakdown, addBreakdown` to the `../usage` import.
- [ ] **Step 2:** `ProjectRow` gains `detail: ProjectDetail;`.
- [ ] **Step 3:** In `buildBudgetView`, the `byKey` map value gains `det: Breakdown`. Init `det: emptyBreakdown()`; in the loop add `cur.det = addBreakdown(cur.det, u.byProjectDetail[cwd] ?? emptyBreakdown());`. When mapping to `ProjectRow`, add `detail: buildDetail(b.det),`. (Import `Breakdown` type too.)
- [ ] **Step 4:** `npm run compile` exits 0. (No new unit test — buildDetail already covered; this is glue.)
- [ ] **Step 5: Commit** — `feat(budget): attach per-project detail to each ProjectRow`

---

### Task 5: Modal + pie + legend + hover tooltip (budget.ts renderShell)

**Files:** Modify `extension/src/webview/budget.ts` (`renderShell()` CSS + body + script only).
**Interfaces — Consumes:** `ProjectRow.detail` in the posted view.

- [ ] **Step 1: CSS** — add modal, pie, legend, tooltip, and `.prow{cursor:pointer}` rules (theme vars; no backslashes).
- [ ] **Step 2: Body** — before `</div>` of `.wrap` closing, add hidden overlay:
`<div id="modal-bg"><div id="modal"><button id="modal-x">✕</button><div id="modal-head"></div><div id="modal-body"></div></div></div><div id="tip"></div>`
- [ ] **Step 3: Row key** — in `renderProjects()` row template add `data-key="'+esc(p.path)+'"` on the `.prow` div. (Sort/pager buttons are outside rows, no conflict.)
- [ ] **Step 4: Client script** — add (all `+`-concatenated, NO backtick/backslash):
```
- colorFor is unnecessary (host sends slice.color).
- function findProj(key): return (STATE.view.projects||[]).find(p=>p.path===key).
- function openModal(p): fill #modal-head with esc(p.name) + " — " + money-ish; render pie + legend into #modal-body from p.detail; show #modal-bg (style.display="flex").
- function pieSvg(slices): filter cost>0; if 0 -> return ""; if 1 -> one <circle r=90 fill=color data-k=key>; else accumulate angle from -90, per slice compute x/y via Math.cos/sin (deg*Math.PI/180), path "M100 100 L"+x1+" "+y1+" A90 90 0 "+large+" 1 "+x2+" "+y2+" Z", large=(sweep>180)?1:0, coords toFixed(2). Each element carries data-k=slice.key.
- legend: slices.map -> row with swatch(style background=color) + label + text + pct + data-k.
- if !p.detail.hasCost -> body = message "ไม่มีค่าใช้จ่ายที่คิดเงินได้".
- closeModal(): hide #modal-bg + #tip.
- tooltip: on mouseover of [data-k] inside modal, look up slice by key, show #tip = "<b>label</b><br>meaning"; position at ev.clientX/clientY on mousemove; hide on mouseout/close.
- wire clicks: delegate — closest(".prow") -> openModal(findProj(data-key)); #modal-x or #modal-bg(target===bg) -> closeModal; document keydown Escape -> closeModal.
```
- [ ] **Step 5:** `npm run compile` exits 0. Manual E2E (below).
- [ ] **Step 6: Commit** — `feat(budget): click project -> pie-chart token breakdown popup`

---

### Task 6: Verify + manual E2E

- [ ] `cd extension && bun test src/usage.test.ts src/budget-detail.test.ts` → all PASS.
- [ ] `npm run compile` → exit 0.
- [ ] Reload extension (F5). Open Budget. First open recomputes once (cache v4). Click a project:
  - pie renders with slices sized by $, legend text = `n.nM (x.xxx usd)`, matches tiles.
  - hover a slice/legend row → tooltip with the Thai meaning.
  - ✕ / click-outside / Esc all close.
  - a $0 (all-synthetic) project → "ไม่มีค่าใช้จ่าย…" message, no broken pie.
  - single-category project → full circle, no error.
- [ ] Manual E2E notes appended to top of budget.ts if warranted.

## Self-Review
- Spec coverage: data capture (T1-2), format `n.nM (x.xxx usd)` (T3), pie by $ (T5), hover meanings (T3 strings + T5 wiring), modal close paths (T5), edge cases $0/single (T3 hasCost + T5), cache v4 (T2), testing (T1/T3 pure + T6 E2E). All covered.
- Types consistent: `Breakdown`, `BudgetSlice`, `ProjectDetail`, `priceLine`, `buildDetail`, `emptyBreakdown`, `addBreakdown` used with identical signatures across tasks.
- No placeholders in pure-code tasks; T5 is browser glue described precisely (E2E-verified per repo convention).

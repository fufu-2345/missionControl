# Budget page — per-project token breakdown popup

Date: 2026-07-15
Status: design (approved verbally, pending spec review)

## Goal

On the Mission Control Budget page, clicking a project row opens a centered
modal popup with a **pie chart** breaking that project's spend into four
categories — **input / output / cache-write / cache-read** — plus a legend
below and a short hover tooltip on each slice explaining what it means. Lets the
user self-monitor *where a project's tokens/dollars went* (e.g. why v10 = $54 /
138M tok is mostly cheap cache-read while v9 = $57 / 70M tok is pricier
input/output) without asking.

## Key realization

`aggregateFile()` in `usage.ts` already computes the per-line input / output /
cache-read / cache-write token counts and their individual costs
([usage.ts:274-284](../../../extension/src/usage.ts)), then collapses them into a
single `cost` + `tokens` per cwd and discards the split. Capturing the split is
therefore nearly free — no new parsing, just stop throwing it away.

## Data layer — `extension/src/usage.ts`

1. New exported interface:
   ```ts
   export interface Breakdown {
     inTok: number; outTok: number; cacheReadTok: number; cacheWriteTok: number;
     inCost: number; outCost: number; cacheReadCost: number; cacheWriteCost: number;
   }
   ```
   Category → source (already computed per line):
   - inTok = `inp`,  inCost = `inp * rate.i`
   - outTok = `outp`, outCost = `outp * rate.o`
   - cacheReadTok = `cr`, cacheReadCost = `cr * rate.r`
   - cacheWriteTok = `ccTot` (cache_creation_input_tokens), cacheWriteCost = `writeCost`
   Invariant: the 4 costs sum to the existing per-line `cost`; the 4 tokens sum
   to the existing per-line `tokens`.

2. `FileAgg` gains `byProjectDetail: Record<string, Breakdown>` (keyed by cwd).
   `UsageSummary` gains the same. `Bucket` and `byDay` are untouched — only
   projects get the detailed split (keeps the day buckets lean).

3. In `aggregateFile()`, accumulate `byProjectDetail[proj]` alongside the
   existing `bump(agg.byProject, ...)`. Add a small `bumpDetail(map, key, b)`
   helper.

4. In `scan()`, merge `agg.byProjectDetail` across files into the summary
   (same pattern as `byProject`).

5. Bump `CACHE_VERSION` 3 → 4 (shape change → old file/summary caches discarded;
   one cold recompute on first open, non-blocking). Update the version comment.

## View layer — `extension/src/webview/budget.ts`

Host sends **display-ready** data (repo convention: "client script stays dumb").

1. `ProjectRow` gains:
   ```ts
   detail: {
     slices: BudgetSlice[];   // sorted by cost DESC
     totalText: string;       // "138.1M (54.420 usd)"
     hasCost: boolean;        // false when total cost == 0 -> popup shows "ไม่มีค่าใช้จ่าย"
   }
   ```
   ```ts
   interface BudgetSlice {
     key: "cacheRead" | "cacheWrite" | "output" | "input";
     label: string;    // "Cache read"
     cost: number;     // numeric — client computes slice angle
     pct: number;      // % of project cost (1 decimal) — legend + angle
     text: string;     // "128.0M (38.400 usd)"  <- the requested format
     color: string;    // semantic key -> client maps to --vscode-charts-*
     meaning: string;  // Thai one-liner for the hover tooltip
   }
   ```

2. In `buildBudgetView()`, extend the cwd→project collapse (`byKey` loop) to also
   sum `u.byProjectDetail[cwd]` into each project, then build `slices` (sorted by
   cost desc), `pct`, formatted `text`, and `totalText`.

3. New **pure, exported, unit-tested** formatting helpers (in usage.ts or
   budget.ts):
   - `fmtUsd3(n)`: up to 3 decimals, trailing zeros trimmed, `+ " usd"`.
     `String(parseFloat(n.toFixed(3)))` → `37.942`, `5.2`, `8.5`, `0`.
     (Edge: a tiny >0 that rounds to `0.000` shows `0` — acceptable.)
   - `fmtTokCompact(n)`: Intl compact, no suffix → `2.1M`, `128.0M`, `950K`.
   - `fmtBreakdownLine(tok, cost)` = `fmtTokCompact(tok) + " (" + fmtUsd3(cost) + ")"`.

Colors (semantic key → CSS var, mapped client-side):
input = `--vscode-charts-green`, output = `--vscode-charts-red`,
cacheWrite = `--vscode-charts-orange` (fallback yellow), cacheRead = `--vscode-charts-blue`.

Meaning strings (Thai, hover tooltip):
- cacheRead: "อ่าน context เดิมซ้ำจาก cache — ถูกสุด 0.1x ของ input; session ยิ่งยาว/ไม่ compact ยิ่งบวมตรงนี้"
- cacheWrite: "บันทึก context ลง cache ครั้งแรก — 1.25–2x ของ input"
- output: "คำตอบที่ Claude สร้าง — แพงสุดต่อ token"
- input: "โค้ด/ข้อความที่ Claude อ่านสดรอบนั้น (ไม่อยู่ใน cache)"

## Webview UI — `renderShell()` inline script

Hard constraint: the inline `<script>` template literal must stay FREE of
backticks and backslashes (existing repo foot-gun, see the NOTE at
budget.ts:273). Build all SVG/HTML strings with `+` concatenation; SVG arc path
data (`M L A Z`, flags, numbers) needs no backslashes; add no regex with
backslashes.

1. **Row click:** delegate on `.prow` (via `closest`). Rows carry `data-key`
   (project path, unique). Look the project up in `STATE.view.projects`, open the
   modal. Existing sort/pager buttons live outside rows, so no click conflict.

2. **Modal:** hidden overlay `#modal-bg` (dark, click closes) + centered
   `#modal` card (matches themed panel look). Header = project name + total
   (`totalText`) + `✕`. Close on ✕, overlay click, and `Esc`.

3. **Pie (hand-drawn SVG):** viewBox `0 0 200 200`, center (100,100), r=90.
   For each slice with cost>0, sweep angle = cost/totalCost*360; build a
   `<path d="M100 100 L x1 y1 A90 90 0 largeArc 1 x2 y2 Z">` (largeArc = 1 when
   sweep>180°). Edge cases:
   - only one slice >0 (or a slice ≥ ~99.99%) → draw a full `<circle>` instead of
     a degenerate arc.
   - total cost 0 (`hasCost=false`) → skip the pie, show "ไม่มีค่าใช้จ่าย".
   - zero-cost slice → no path, still listed in legend as its value.
   Each `<path>` fill = its color, and `mouseenter`/`mouseleave` drive the tooltip.

4. **Legend:** one row per slice = color swatch + `label` + `text` + `pct%`,
   in the same cost-desc order as the pie.

5. **Hover tooltip:** a floating themed div inside the modal, shown on slice (or
   legend-row) `mouseenter` with `label` + `meaning`, positioned near the cursor
   (`mousemove`), hidden on `mouseleave`.

## Testing (per mc-orches-dev-verify)

- `cd extension && bun test` — pure logic (RED first):
  - `fmtUsd3` / `fmtTokCompact` / `fmtBreakdownLine`: format cases incl. trailing-
    zero trim (`5.2`, `8.5`), 3-decimal round, and `0`.
  - `buildBudgetView` breakdown: with a synthetic `UsageSummary` whose cwds live
    under real `mktemp` `projects/<name>` dirs (resolveProject stat-checks the
    dir), assert each `ProjectRow.detail` slice costs sum to `row.cost`
    (float epsilon) and `pct` sums to ~100, slices sorted cost-desc.
- `npm run compile` (tsc) exits 0.
- Manual E2E: open Budget → click a project → pie renders, legend text matches
  `n.nM (x.xxx usd)`, hover shows the meaning, ✕/Esc/outside all close it; a
  zero-cost project shows the empty message; CACHE_VERSION bump recomputes once.

## Files touched
- `extension/src/usage.ts` — Breakdown type, byProjectDetail, aggregate+merge, CACHE_VERSION, format helpers.
- `extension/src/webview/budget.ts` — ProjectRow.detail, buildBudgetView collapse, modal+pie+legend+tooltip client script.
- `extension/src/*.test.ts` — new pure-fn tests.

## Out of scope (YAGNI)
- Per-model (sonnet/haiku/opus) split inside the chart.
- By-token vs by-cost toggle (pie is by **cost**; legend shows both).
- Time-series / per-day breakdown inside the popup.
- Wiring non-Claude providers.

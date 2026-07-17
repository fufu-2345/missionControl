# Project Continue Buttons — 2 ปุ่มถาวร + สัญลักษณ์ "รันไม่จบ" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** เปลี่ยนปุ่ม continue เดี่ยวในหน้า Projects เป็น 2 ปุ่มถาวร ("ทำ 1 sprint" + "ทำ N sprint") พร้อม chip + ขอบการ์ดเตือนเมื่อรอบที่แล้วรันไม่จบ (session ดับ หรือ error)

**Architecture:** การตัดสินใจ "การ์ดโชว์อะไร" ทำใน pure function `resolveCardActions` ที่ [continueRun.ts](../../extension/src/commands/continueRun.ts) (มี `bun test` คุม) · host ([orchestrator.ts](../../extension/src/webview/orchestrator.ts) ฝั่ง extension) เรียกฟังก์ชันนี้ตอนประกอบ item แล้วส่งผล (`actions`) ไป webview · webview (string template) อ่าน field ไป render — **webview import host TS ไม่ได้ จึงต้องให้ host คำนวณก่อนส่ง** · resume logic / message handlers / orches-drive ไม่แตะเลย

**Tech Stack:** TypeScript, VS Code Webview API (HTML string template), bun:test, tsc

## Global Constraints

- แตะ **extension เท่านั้น** — ห้ามแตะ skill orches-drive (โหมด `--once [N]` ครบแล้ว)
- **reuse ของเดิมทั้งหมด**: `launchContinueRun(p)` / `launchContinueRun(p, n)`, message handler `continue_run` / `continue_multi` / `cancel_run`, `resolveButtonState`, `clampSprintCount`, `pendingSprints`, multi modal
- **ข้อความปุ่ม/chip เป็น text ล้วน — ห้ามใช้ emoji เป็นตัวสื่อความหมาย** (terminal ผู้ใช้ render emoji ไม่ออก) · สัญลักษณ์เดิม `⟳` ในปุ่ม "กำลังทำ" คงไว้ได้ (ไม่ใช่ตัวสื่อความหลัก)
- ปุ่ม "ทำ N sprint": `pending >= 2` = กดได้ · `pending == 1` = disabled จริง (attribute `disabled` + pointer-events, ไม่ใช่แค่สีจาง)
- compile: `cd extension && npm run compile` (`tsc -p ./`) · test: `cd extension && bun test ./src/commands/continueRun.test.ts`
- commit: stage **เฉพาะไฟล์ที่ task นั้นแตะ** (git diff ก่อน, ห้าม `git add -A`/whole-repo)

---

## File Structure

| ไฟล์ | รับผิดชอบ | Task |
|---|---|---|
| `extension/src/commands/continueRun.ts` | + type `CardActions` + fn `resolveCardActions` (pure decision) | 1 |
| `extension/src/commands/continueRun.test.ts` | + เทสต์ `resolveCardActions` ทุก state × pending | 1 |
| `extension/src/webview/orchestrator.ts` | host: เรียก+inject `actions` · webview: render 2 ปุ่ม + chip/ขอบเตือน · CSS | 2, 3 |

---

## Task 1: `resolveCardActions` pure function + tests

**Files:**
- Modify: `extension/src/commands/continueRun.ts` (เพิ่มท้ายไฟล์ หลัง `decideCancelOutcome`, ~บรรทัด 200)
- Test: `extension/src/commands/continueRun.test.ts` (เพิ่มท้ายไฟล์ ~บรรทัด 259)

**Interfaces:**
- Consumes: `ButtonState` (มีอยู่แล้วใน continueRun.ts: `"hidden" | "idle" | "spinning" | "stale" | "error"`)
- Produces:
  - `type CardActions = { kind: "busy" } | { kind: "none" } | { kind: "actions"; runNEnabled: boolean; crash: "stale" | "error" | null }`
  - `resolveCardActions(state: ButtonState, driven: boolean, pending: number): CardActions`

- [ ] **Step 1: เขียน failing tests** — เพิ่มท้าย `continueRun.test.ts`

ก่อนอื่นเพิ่ม `resolveCardActions` เข้า import block (บรรทัด ~5–20, ในวงเล็บ `import { ... } from "./continueRun"`): เพิ่มบรรทัด `  resolveCardActions,` ต่อจาก `  clampSprintCount,`

จากนั้นเพิ่มบล็อกเทสต์ท้ายไฟล์:

```ts
// --- Task 8: resolveCardActions (2 ปุ่มถาวร + crash indicator) ---

test("resolveCardActions: spinning หรือ driven → busy (คงปุ่ม 'กำลังทำ' เดิม)", () => {
  expect(resolveCardActions("spinning", false, 3)).toEqual({ kind: "busy" });
  expect(resolveCardActions("idle", true, 3)).toEqual({ kind: "busy" }); // driven ชนะ
  expect(resolveCardActions("stale", true, 3)).toEqual({ kind: "busy" }); // driven ชนะ state
});

test("resolveCardActions: ไม่มีงานค้าง (pending<=0) → none แม้ marker stale/error", () => {
  expect(resolveCardActions("idle", false, 0)).toEqual({ kind: "none" });
  expect(resolveCardActions("stale", false, 0)).toEqual({ kind: "none" });
  expect(resolveCardActions("error", false, 0)).toEqual({ kind: "none" });
  expect(resolveCardActions("hidden", false, 0)).toEqual({ kind: "none" });
});

test("resolveCardActions: idle+ค้าง → actions ไม่มี crash; ปุ่ม N เปิดเมื่อเหลือ>=2", () => {
  expect(resolveCardActions("idle", false, 1)).toEqual({ kind: "actions", runNEnabled: false, crash: null });
  expect(resolveCardActions("idle", false, 2)).toEqual({ kind: "actions", runNEnabled: true, crash: null });
  expect(resolveCardActions("idle", false, 5)).toEqual({ kind: "actions", runNEnabled: true, crash: null });
});

test("resolveCardActions: stale → actions + crash 'stale' (session ดับ)", () => {
  expect(resolveCardActions("stale", false, 1)).toEqual({ kind: "actions", runNEnabled: false, crash: "stale" });
  expect(resolveCardActions("stale", false, 3)).toEqual({ kind: "actions", runNEnabled: true, crash: "stale" });
});

test("resolveCardActions: error → actions + crash 'error'", () => {
  expect(resolveCardActions("error", false, 2)).toEqual({ kind: "actions", runNEnabled: true, crash: "error" });
  expect(resolveCardActions("error", false, 1)).toEqual({ kind: "actions", runNEnabled: false, crash: "error" });
});
```

- [ ] **Step 2: รันเทสต์ ยืนยันว่า fail**

Run: `cd extension && bun test ./src/commands/continueRun.test.ts`
Expected: FAIL — `resolveCardActions is not a function` / import error (ยังไม่ได้ export)

- [ ] **Step 3: เขียน implementation** — เพิ่มท้าย `continueRun.ts` (หลังฟังก์ชัน `decideCancelOutcome`, ท้ายไฟล์)

```ts
/** สิ่งที่การ์ด project โชว์ จาก 2 สัญญาณเดิม (ButtonState + driven) + จำนวนงานค้าง:
 *  - busy (spinning/driven) → คงปุ่ม "กำลังทำ" เดิม (คลิกยกเลิก/เข้า session)
 *  - none (ไม่มีงานค้าง) → ไม่มีปุ่ม แม้ marker ค้าง stale/error (0 เหลือ = จบจริง)
 *  - actions → โชว์ 2 ปุ่มถาวร: "ทำ 1 sprint" เสมอ + "ทำ N sprint" (เปิดเมื่อเหลือ>=2)
 *    · crash = สาเหตุที่รอบก่อนไม่จบ (stale = session ดับกลางคัน · error = orches-drive
 *      เขียน marker error) → webview โชว์ chip + ขอบเตือน · null = ค้างปกติ
 *  Pure — host คำนวณตัวนี้ก่อนส่งการ์ดให้ webview (webview import host TS ไม่ได้). */
export type CardActions =
  | { kind: "busy" }
  | { kind: "none" }
  | { kind: "actions"; runNEnabled: boolean; crash: "stale" | "error" | null };

export function resolveCardActions(
  state: ButtonState,
  driven: boolean,
  pending: number,
): CardActions {
  if (state === "spinning" || driven) return { kind: "busy" };
  if (pending <= 0) return { kind: "none" };
  const crash = state === "stale" ? "stale" : state === "error" ? "error" : null;
  return { kind: "actions", runNEnabled: pending >= 2, crash };
}
```

- [ ] **Step 4: รันเทสต์ ยืนยันว่าผ่าน**

Run: `cd extension && bun test ./src/commands/continueRun.test.ts`
Expected: PASS — `39 pass 0 fail` (เดิม 34 + ใหม่ 5)

- [ ] **Step 5: Commit**

```bash
cd extension
git add src/commands/continueRun.ts src/commands/continueRun.test.ts
git commit -m "feat(orchestrator): resolveCardActions — decide card buttons + crash state"
```

---

## Task 2: host คำนวณ `actions` + webview render 2 ปุ่มถาวร

**Files:**
- Modify: `extension/src/webview/orchestrator.ts` — import (~บรรทัด 5–32), host item builder (~157, 163–176), webview render (~1301–1323), click selector (~1357), CSS (~809)

**Interfaces:**
- Consumes: `resolveCardActions`, `CardActions` (Task 1) · `it.actions` field ใหม่ที่ host ใส่
- Produces: การ์ด idle/stale/error โชว์ 2 ปุ่ม (`class="cont"` = ทำ 1 · `class="cont multi"` = ทำ N) — ปุ่ม N มี `disabled` เมื่อ `!runNEnabled`

- [ ] **Step 1: เพิ่ม import** — ในบล็อก `import { ... } from "../commands/continueRun"` (ปิดที่บรรทัด ~32) เพิ่มบรรทัดต่อจาก `  resolveButtonState,`:

```ts
  resolveCardActions,
```

(type `CardActions` ไม่ต้อง import ถ้าไม่ได้ใช้ชื่อ type ตรงๆ — ผลลัพธ์ถูก serialize เป็น JSON ส่ง webview)

- [ ] **Step 2: host — แยก `pending`/`driven` เป็น const แล้ว inject `actions`**

หา (บรรทัด ~157):
```ts
      const btn = resolveButtonState(pendingSprints(p), marker, live);
```
แทนด้วย:
```ts
      const pending = pendingSprints(p);
      const btn = resolveButtonState(pending, marker, live);
```

หา (บรรทัด ~163–176) — บล็อก `return { ... }` ที่มี `driven: projectDrivenState(...)`:
```ts
      return {
        path: p.path,
        name: p.name,
        sprints: p.sprintDocs,
        worktrees: p.openWorktrees,
        plannedTotal: p.plannedTotal,
        plannedDone: p.plannedDone,
        doing: p.doing,
        // green row: is a session driving this project right now? (shared list + reused runAlive)
        driven: projectDrivenState(p, { sessions, runAlive }).state !== "none",
        starred: starred.has(p.path),
        run: { state: btn.state, errorMsg: btn.errorMsg },
        git: { path: p.path, ...states[p.path] },
      };
```
แทนด้วย (แยก `driven` ออกมาก่อน เพื่อส่งเข้า `resolveCardActions` + คง field เดิม):
```ts
      const driven = projectDrivenState(p, { sessions, runAlive }).state !== "none";
      return {
        path: p.path,
        name: p.name,
        sprints: p.sprintDocs,
        worktrees: p.openWorktrees,
        plannedTotal: p.plannedTotal,
        plannedDone: p.plannedDone,
        doing: p.doing,
        // green row: is a session driving this project right now? (shared list + reused runAlive)
        driven,
        starred: starred.has(p.path),
        run: { state: btn.state, errorMsg: btn.errorMsg },
        actions: resolveCardActions(btn.state, driven, pending),
        git: { path: p.path, ...states[p.path] },
      };
```

- [ ] **Step 3: webview render — แทน logic ปุ่ม `contBtn`/`multiBtn`**

หา (บรรทัด ~1299–1323) — ตั้งแต่ comment `// continue button:` ถึงจบ `multiBtn`:
```js
      // continue button: run 1 sprint headless with the last-used team (state
      // resolved host-side). spinning = คลิกเพื่อยกเลิก · stale = run หลุด, คลิกเริ่มใหม่.
      var run = it.run || { state: 'hidden' };
      // "busy" = a session is driving this project right now (green card). The
      // .orches-run.json marker only exists for THIS dashboard's own headless runs,
      // so an INTERACTIVE orchestrator session (the ▶ เริ่มใหม่ / popup path) leaves
      // run.state at 'idle' even while a build is live. Gate every start-action on
      // !busy so a green card never shows ▶ ทำต่อ / ▶▶ ทำหลาย sprint / ลบ — it offers
      // an attach affordance instead. (spinning = own headless run; keeps cancel.)
      var busy = run.state === 'spinning' || !!it.driven;
      // การ์ดสีเขียว (มี session ขับอยู่/headless run) → สถานะคือ "กำลังทำ"
      // ไม่ใช่ "พร้อมเริ่ม" หรือ "ทำไปแล้ว X sprint" (ซึ่งสื่อว่ายังไม่ได้ทำ/หยุดแล้ว)
      if (busy) sub = 'กำลังทำ';
      var contBtn =
        run.state === 'spinning' ? '<button class="cont spin" title="กำลังทำต่อ — คลิกเพื่อยกเลิก"><span class="cont-rot">⟳</span> กำลังทำ</button>' :
        it.driven                ? '<button class="cont busy" title="กำลังทำอยู่ (มี session ขับโปรเจคนี้) — คลิกเพื่อเปิด/เข้า session"><span class="cont-rot">⟳</span> กำลังทำ</button>' :
        run.state === 'idle'     ? '<button class="cont" title="ทำต่อ 1 sprint ด้วยทีมล่าสุด (auto, background)">▶ ทำต่อ</button>' :
        run.state === 'stale'    ? '<button class="cont stale" title="run หลุด — คลิกเพื่อเริ่มใหม่">⚠ ทำต่อ</button>' :
        run.state === 'error'    ? '<button class="cont err" title="'+esc(run.errorMsg||'error')+'">⚠ error</button>' : '';
      // "ทำหลาย sprint": only when NOT busy, idle, AND ≥2 sprint left. Opens a "how
      // many?" input box; host runs N sprints headless in ONE detached run (no
      // attach, no checkpoint). Class 'cont' so the row-select guard skips it.
      var multiBtn = (!busy && run.state === 'idle' && pending >= 2)
        ? '<button class="cont multi" data-pending="'+pending+'" data-name="'+esc(it.name)+'" title="ทำหลาย sprint รวดเดียว (auto, background) — เลือกจำนวน">▶▶ ทำหลาย sprint</button>'
        : '';
```
แทนด้วย (busy คงคำนิยามเดิมผ่าน `act.kind==='busy'` = spinning||driven เป๊ะ เดิม; idle/stale/error → 2 ปุ่มถาวร):
```js
      // ปุ่มการ์ด: state resolved host-side → it.actions (resolveCardActions).
      //  busy    = มี session ขับอยู่ (spinning = headless run เราเอง / driven = interactive) → ปุ่ม "กำลังทำ" เดิม
      //  actions = idle/stale/error + ยังมีงานค้าง → 2 ปุ่มถาวร [ทำ 1 sprint][ทำ N sprint]
      //  none    = ไม่มีงานค้าง → ไม่มีปุ่ม
      var run = it.run || { state: 'hidden' };
      var act = it.actions || { kind: 'none' };
      var busy = act.kind === 'busy';  // = spinning || driven (เดิม) — delBtn/gitCell ยังใช้ตัวนี้
      if (busy) sub = 'กำลังทำ';
      var contBtn = '', multiBtn = '';
      if (busy) {
        contBtn = run.state === 'spinning'
          ? '<button class="cont spin" title="กำลังทำต่อ — คลิกเพื่อยกเลิก"><span class="cont-rot">⟳</span> กำลังทำ</button>'
          : '<button class="cont busy" title="กำลังทำอยู่ (มี session ขับโปรเจคนี้) — คลิกเพื่อเปิด/เข้า session"><span class="cont-rot">⟳</span> กำลังทำ</button>';
      } else if (act.kind === 'actions') {
        contBtn = '<button class="cont" title="ทำต่อ 1 sprint ด้วยทีมล่าสุด (auto, background)">ทำ 1 sprint</button>';
        multiBtn = act.runNEnabled
          ? '<button class="cont multi" data-pending="'+pending+'" data-name="'+esc(it.name)+'" title="ทำหลาย sprint รวดเดียว (auto, background) — เลือกจำนวน">ทำ N sprint</button>'
          : '<button class="cont multi disabled" disabled title="เหลือ sprint เดียว — ทำได้ทีละ 1">ทำ N sprint</button>';
      }
```

> หมายเหตุ: `pending` (ตัวแปร webview บรรทัด ~1287 `var pending = pt > 0 ? (pt - pd) : wt`) ยังใช้ได้ — คงไว้

- [ ] **Step 4: แก้ selector ปุ่ม multi ให้ข้ามตัว disabled**

หา (บรรทัด ~1357):
```js
      var multiEl=card.querySelector('.cont.multi');
```
แทนด้วย:
```js
      var multiEl=card.querySelector('.cont.multi:not(.disabled)');
```

- [ ] **Step 5: เพิ่ม CSS ปุ่ม N แบบ disabled**

หา (บรรทัด ~808–809):
```css
  .cont.multi { border-color: #3f7bd0; color: #6ca6ff; background: rgba(63,123,208,0.12); }
  .cont.multi:hover { background: rgba(63,123,208,0.22); }
```
เพิ่มบรรทัดต่อท้าย:
```css
  .cont.multi.disabled { opacity: 0.4; cursor: not-allowed; pointer-events: none; }
```

- [ ] **Step 6: compile ยืนยันไม่มี error**

Run: `cd extension && npm run compile`
Expected: ไม่มี error output (tsc ผ่าน) · โดยเฉพาะ `it.actions` ไม่ทำ type error (item object เป็น inferred type — ok)

- [ ] **Step 7: Manual verify (webview ไม่มี unit test — ตาม pattern โปรเจค)**

เปิดหน้า Orchestrator Projects ใน MissionControl:
1. Project ที่เหลือ **≥2 sprint** ค้าง (idle, ไม่มี session ขับ) → เห็น **2 ปุ่ม** "ทำ 1 sprint" + "ทำ N sprint" (กดได้ทั้งคู่)
2. Project ที่เหลือ **1 sprint** → เห็น 2 ปุ่ม แต่ "ทำ N sprint" **เทา กดไม่ติด**
3. กด "ทำ 1 sprint" → เริ่ม run 1 sprint (การ์ดเขียว "กำลังทำ") · กด "ทำ N sprint" → เปิด modal เลือกจำนวน
4. Project ที่กำลังทำอยู่ → ยังเห็นปุ่ม "กำลังทำ" เดิม (ไม่ใช่ 2 ปุ่ม)
5. Project ที่ไม่มีงานค้าง → ไม่มีปุ่ม continue

- [ ] **Step 8: Commit**

```bash
cd extension
git add src/webview/orchestrator.ts
git commit -m "feat(orchestrator): 2 ปุ่มถาวร ทำ 1/N sprint (ปุ่ม N เทาเมื่อเหลือ 1)"
```

---

## Task 3: crash chip + ขอบการ์ดเตือน (stale/error)

**Files:**
- Modify: `extension/src/webview/orchestrator.ts` — CSS (~795, ~757), webview render (~1312 branch `actions` + card `return`)

**Interfaces:**
- Consumes: `act.crash` (`"stale" | "error" | null`) จาก `it.actions` (Task 1/2) · `run.errorMsg` (มีอยู่แล้ว)
- Produces: การ์ด stale/error โชว์ chip `class="chip crash"` ข้างชื่อ + card เพิ่ม class `crash`

- [ ] **Step 1: เพิ่ม CSS chip เตือน + ขอบการ์ดเตือน**

หา (บรรทัด ~789–790):
```css
  .chip.act { background: rgba(196,127,26,0.22); color: #e3a13a; }
  .chip.idle { background: rgba(125,133,144,0.18); color: #9aa4af; }
```
เพิ่มบรรทัดต่อท้าย:
```css
  .chip.crash { background: rgba(248,81,73,0.2); color: #f85149; }
```

หา (บรรทัด ~756–757):
```css
  .card.live { border-color: #2ea043; background: rgba(63,185,80,0.10); }
  .card.live:hover { background: rgba(63,185,80,0.16); }
```
เพิ่มบรรทัดต่อท้าย:
```css
  .card.crash { border-color: #f85149; box-shadow: 0 0 0 1px rgba(248,81,73,0.35); }
```

- [ ] **Step 2: webview render — สร้าง crashChip + crashCls แล้วใส่ในการ์ด**

ในบล็อก `else if (act.kind === 'actions') { ... }` (จาก Task 2 Step 3) เพิ่มการคำนวณ chip เตือน **ต่อจากบรรทัด `multiBtn = ...`** (ยังอยู่ในบล็อก actions) — แต่ต้องประกาศ `crashChip`/`crashCls` ให้เห็นนอกบล็อกด้วย ดังนั้นแก้เป็น:

หา:
```js
      var contBtn = '', multiBtn = '';
      if (busy) {
```
แทนด้วย (เพิ่ม 2 ตัวแปร):
```js
      var contBtn = '', multiBtn = '', crashChip = '', crashCls = '';
      if (busy) {
```

จากนั้นภายในบล็อก `else if (act.kind === 'actions') {` ต่อจาก `multiBtn = ...;` เพิ่ม:
```js
        if (act.crash === 'stale') {
          crashChip = '<span class="chip crash">รันไม่จบ · session ดับ</span>';
          crashCls = ' crash';
        } else if (act.crash === 'error') {
          crashChip = '<span class="chip crash">error: '+esc(run.errorMsg||'?')+'</span>';
          crashCls = ' crash';
        }
```

- [ ] **Step 3: ใส่ crashChip + crashCls ลงใน HTML การ์ด**

หา (บรรทัด ~1332–1337) — บล็อก `return '<div class="card'...`:
```js
      return '<div class="card'+(it.driven?' live':'')+'" data-path="'+esc(it.path)+'">'
        +'<span class="star'+(it.starred?' on':'')+'" role="button" title="ปักดาว / เอาดาวออก">'+(it.starred?'★':'☆')+'</span>'
        +'<div style="flex:1"><button class="pick"><span class="cname">'+esc(it.name)+chip+'</span>'
        +'<span class="csub">'+sub+'</span></button>'+(busy ? '' : gitEditor(it.git))+'</div>'
        +contBtn+multiBtn+delBtn
        +'<span class="git-cell">'+(busy ? '' : gitCell(it.git))+'</span></div>';
```
แทนด้วย (เพิ่ม `crashCls` ที่ class การ์ด + `crashChip` หน้า `chip` ในชื่อ):
```js
      return '<div class="card'+(it.driven?' live':'')+crashCls+'" data-path="'+esc(it.path)+'">'
        +'<span class="star'+(it.starred?' on':'')+'" role="button" title="ปักดาว / เอาดาวออก">'+(it.starred?'★':'☆')+'</span>'
        +'<div style="flex:1"><button class="pick"><span class="cname">'+esc(it.name)+crashChip+chip+'</span>'
        +'<span class="csub">'+sub+'</span></button>'+(busy ? '' : gitEditor(it.git))+'</div>'
        +contBtn+multiBtn+delBtn
        +'<span class="git-cell">'+(busy ? '' : gitCell(it.git))+'</span></div>';
```

- [ ] **Step 4: compile ยืนยันไม่มี error**

Run: `cd extension && npm run compile`
Expected: ไม่มี error output

- [ ] **Step 5: Manual verify**

1. Project ที่ session ดับกลางคัน (marker ค้าง `running` แต่ tmux session ตาย = stale) → เห็น chip **"รันไม่จบ · session ดับ"** ข้างชื่อ + **ขอบการ์ดสีแดง** + 2 ปุ่ม ทำ 1/N ครบ
2. Project ที่ orches-drive จบด้วย error (marker `{"status":"error","errorMsg":"..."}`) → เห็น chip **"error: ‹ข้อความ›"** + ขอบแดง + 2 ปุ่ม
3. กด "ทำ 1 sprint" บนการ์ด crash → resume ต่อ (การ์ดเขียว "กำลังทำ", chip/ขอบเตือนหาย)
4. Project idle ปกติ (ไม่ crash) → ไม่มี chip เตือน/ขอบแดง (แค่ 2 ปุ่ม)

> วิธีจำลอง stale เร็วๆ (ถ้าไม่มีของจริง): เขียนไฟล์ `<project>/.orches-run.json` เป็น `{"status":"running","session":"no-such-session","sessionCreatedAt":1,"startedAt":"2026-01-01T00:00:00.000Z"}` แล้ว refresh — session ไม่มีจริง → resolveButtonState คืน stale

- [ ] **Step 6: Commit**

```bash
cd extension
git add src/webview/orchestrator.ts
git commit -m "feat(orchestrator): chip + ขอบการ์ดเตือนเมื่อรอบก่อนรันไม่จบ (session ดับ/error)"
```

---

## Self-Review (ทำแล้ว)

**1. Spec coverage:**
- Q1 (2 ปุ่มถาวร, N เทาเมื่อเหลือ 1) → Task 1 (`runNEnabled`) + Task 2 (render + disabled) ✓
- Q2 (chip + ขอบเตือน) → Task 3 ✓
- Q3 (ครอบ stale + error) → Task 1 (`crash` 2 ค่า) + Task 3 (2 branch) ✓
- resume = checkpoint เดิม → reuse `continue_run`/`continue_multi` (ไม่แตะ) ✓
- edge: stale/error + pending 0 → Task 1 (`pending<=0` → none) ✓

**2. Placeholder scan:** ไม่มี TBD/TODO — ทุก step มี code + command + expected จริง ✓

**3. Type consistency:** `CardActions.kind` = `"busy"|"none"|"actions"` · `runNEnabled` · `crash` = `"stale"|"error"|null` — ใช้ชื่อเดียวกันทั้ง Task 1 (นิยาม+เทสต์), Task 2 (`act.kind`/`act.runNEnabled`), Task 3 (`act.crash`) ✓ · `busy` webview = `act.kind==='busy'` = spinning||driven เท่าเดิม (delBtn/gitCell ไม่พัง) ✓

## Out of scope
แก้ resume logic / orches-drive · auto-retry error · force-push revert · คิว/schedule · เปลี่ยน cancel flow · busy state (คงเดิม)

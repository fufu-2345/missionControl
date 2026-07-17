# ปุ่มทำต่อในหน้า Projects — 2 ปุ่มถาวร + สัญลักษณ์ "รอบที่แล้วรันไม่จบ"

> 2026-07-17 · DESIGN · ต่อยอดจาก [continue-button](2026-07-10-continue-button-design.md) (ปุ่ม `▶ ทำต่อ` 1 sprint) + ปุ่ม `▶▶ ทำหลาย sprint` ที่เพิ่มภายหลัง

## เป้าหมาย
เลิกใช้ปุ่มเดี่ยว `▶ ทำต่อ` / `⚠ ทำต่อ` แล้วแยก concern เป็น 2 ส่วนบนการ์ด project:
1. **ปุ่ม action ถาวร 2 ปุ่ม** — `ทำ 1 sprint` + `ทำ N sprint` โชว์คู่กันเสมอ (ไม่ผูกกับสถานะ)
2. **สัญลักษณ์เตือน** — เมื่อ "รอบที่แล้วรันไม่จบ" โชว์ chip ข้างชื่อ + ขอบการ์ดสีเตือน แยกออกจากปุ่ม

กดปุ่มใดก็ resume ต่อจาก sprint ที่ค้าง (checkpoint เดิม) — พฤติกรรม resume ไม่เปลี่ยน

## ปัญหาปัจจุบัน (ที่แก้)
- ปุ่ม continue เดี่ยวเอา "action" (ทำต่อ 1 sprint) ปนกับ "สถานะ" (⚠ = run หลุด) ไว้ในปุ่มเดียว — สับสน
- ปุ่ม `▶▶ ทำหลาย sprint` โผล่**เฉพาะ** `idle && pending>=2` → ตอน session ดับ (stale) มีให้กดแค่ 1 sprint
- ไม่มีสัญลักษณ์ชัดว่า "รอบที่แล้วไม่จบเพราะ session ดับ"

## Requirement ที่ยืนยันแล้ว (Q1–Q3)
1. **Layout (Q1):** โชว์ 2 ปุ่มเสมอ · ปุ่ม `ทำ N sprint` **เทา/กดไม่ได้** เมื่อเหลือ 1 sprint (pending<2)
2. **สัญลักษณ์ crash (Q2):** chip ข้างชื่อ project **+** ขอบการ์ดสีเตือน (แบบเด่นสุด) · เป็นข้อความ ไม่พึ่ง emoji
3. **ขอบเขต (Q3):** ครอบทั้ง **session ดับ (stale)** และ **จบด้วย error (error)** · chip ข้อความต่างกัน · ทั้งคู่โชว์ 2 ปุ่ม resume

## ดีไซน์: state → หน้าตาการ์ด

สัญญาณเดิม 2 ตัว ไม่เพิ่ม state ใหม่: `ButtonState` (`resolveButtonState`, [continueRun.ts:93](../../../extension/src/commands/continueRun.ts)) + `driven` (interactive session ขับอยู่, host detector)

| สถานะ | chip ข้างชื่อ | ขอบการ์ด | ปุ่ม |
|---|---|---|---|
| กำลังทำ (`spinning` / `driven`) | "กำลังทำ" (เขียว, เดิม) | เขียว (เดิม) | ปุ่มเดียว "กำลังทำ" (คลิกยกเลิก/เข้า session) — **คงเดิม** |
| ค้างปกติ (`idle`) | "ค้าง N sprint" (เดิม) | ปกติ | **[ทำ 1 sprint] [ทำ N sprint]** |
| session ดับ (`stale`) | "ค้าง N sprint" + **"รันไม่จบ · session ดับ"** | **สีเตือน** | **[ทำ 1 sprint] [ทำ N sprint]** |
| จบด้วย error (`error`) | "ค้าง N sprint" + **"error: ‹เหตุ›"** | **สีเตือน** | **[ทำ 1 sprint] [ทำ N sprint]** |
| ไม่มีงานค้าง (`hidden` / pending 0) | — | ปกติ | ไม่มีปุ่ม (แม้ marker ค้าง stale/error แต่ pending 0 = จบแล้ว) |

กติกาปุ่ม N: `pending >= 2` = กดได้ · `pending == 1` = เทา (คลิก popup ก็ทำได้แค่ 1 อยู่ดี)

## แนวทาง A: pure decision function + test (เลือกแล้ว)
โปรเจคแยก logic บริสุทธิ์ (`continueRun.ts`, มี `bun test`) ออกจาก webview (render HTML string) → วาง decision ในชั้น pure

เพิ่มใน [continueRun.ts](../../../extension/src/commands/continueRun.ts):
```ts
export type CardActions =
  | { kind: "busy" }                                              // spinning/driven → ปุ่ม "กำลังทำ" เดิม
  | { kind: "none" }                                              // ไม่มีงานค้าง → ไม่มีปุ่ม
  | { kind: "actions"; runNEnabled: boolean; crash: "stale" | "error" | null };

/** การ์ดนี้โชว์อะไร จาก (ButtonState, driven, pending) — pure, unit-tested */
export function resolveCardActions(
  state: ButtonState, driven: boolean, pending: number,
): CardActions {
  if (state === "spinning" || driven) return { kind: "busy" };
  if (pending <= 0) return { kind: "none" };
  const crash = state === "stale" ? "stale" : state === "error" ? "error" : null;
  return { kind: "actions", runNEnabled: pending >= 2, crash };
}
```
- errorMsg ของ chip error → webview ดึงจาก `run.errorMsg` เอง (เหมือน `.cont.err` เดิม) — pure fn คืนแค่ชนิด
- `runNEnabled` ครอบ Q1 · `crash` ครอบ Q2/Q3

## ไฟล์ที่แตะ (extension เท่านั้น — ไม่แตะ orches-drive)
1. **continueRun.ts** — เพิ่ม `CardActions` + `resolveCardActions()`
2. **continueRun.test.ts** — เทสต์ทุก state × pending (busy/none/actions · runN enable/disable · crash stale/error/null)
3. **orchestrator.ts** (webview):
   - render ([~1301–1323](../../../extension/src/webview/orchestrator.ts)) — แทน `contBtn`/`multiBtn` เดิมด้วยผลจาก `resolveCardActions`; ลบปุ่มเดี่ยว `▶ ทำต่อ`/`⚠ ทำต่อ`; `kind==='actions'` → 2 ปุ่ม (N เทาเมื่อ `!runNEnabled`)
   - CSS ([~787–809](../../../extension/src/webview/orchestrator.ts)) — chip เตือน (crash), ขอบการ์ดเตือน (`.card.crash`), ปุ่ม N disabled
   - ทั้ง 2 ปุ่มยิง message เดิม: `ทำ 1` → `continue_run` · `ทำ N` → popup → `continue_multi`

## ไม่แตะ (reuse ทั้งหมด)
- `launchContinueRun(p)` / `launchContinueRun(p, n)` — resume logic เดิม (เริ่มจาก sprint แรกที่ยัง `- [ ]` ใน plan.md)
- message handler `continue_run` / `continue_multi` / `cancel_run`
- `resolveButtonState` (ยังใช้เป็น guard ที่อื่น) · `clampSprintCount` · `pendingSprints`
- orches-drive skill (`--once [N]` มีครบแล้ว)

## Edge cases
- **stale/error แต่ pending 0** → `kind:"none"` (งานจบจริง marker แค่ค้าง — ไม่โชว์ปุ่ม/ไม่เตือน)
- **error resume ไม่หาย** (เช่น `STOP:online-needs-gh`) → chip โชว์ errorMsg ให้ user รู้ต้องแก้อะไรก่อนกด; กดแล้วก็ยิง flow เดิม (ไม่มี logic กันพิเศษในรอบนี้)
- **กดซ้ำตอนกำลังทำ** → `decideContinueAction` guard เดิม (1-project-1-session) ยังคุม ไม่ fork ซ้ำ
- **N เทา** = disabled attribute จริง (กันคลิก) ไม่ใช่แค่สีจาง

## Sprint (DoD ย่อ)
- **S1** `resolveCardActions` + test เขียว (`bun test`) — ครอบทุก state × pending
- **S2** webview: 2 ปุ่มถาวร (idle) + N เทาเมื่อ pending<2 + ลบปุ่มเดี่ยว → ทั้ง idle/stale/error มี 2 ปุ่มครบ, กดยิง handler เดิมถูก
- **S3** crash indicator: chip + ขอบการ์ดเตือน (stale="session ดับ", error=errorMsg) → session ดับ/ error เห็นสัญลักษณ์ชัด, กดแล้ว resume ต่อได้

## Out of scope
- แก้ resume logic / orches-drive · auto-retry error · force-push revert · คิว/schedule · เปลี่ยน cancel flow · busy state (คงเดิม)

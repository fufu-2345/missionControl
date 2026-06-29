# Workflow Playbook — การแบ่งงานให้ agent หลายตัวทำแบบขนาน

> สรุป flow การ orchestrate งานด้วย **Workflow tool** (multi-agent fan-out) จากของจริงที่รันไป
> ครั้งหน้าก๊อป template ด้านล่างไปปรับใช้ได้เลย
>
> อ้างอิงเคสจริง: ไล่หา HTTP 500 ใน `agentskill-marketplace` (29 มิ.ย. 2026) — 6 agent, ~227k tokens, ~6 นาที, confirm root cause ด้วยหลักฐานสด

---

## 1. เมื่อไหร่ควร fan-out (และเมื่อไหร่ไม่ควร)

**ควร fan-out เป็น workflow เมื่อ:**
- งานแตกได้เป็น **หลายมุมอิสระ** ที่ไม่ต้องรอกัน เช่น audit หลายด้าน, อ่านหลาย subsystem พร้อมกัน, ลองหลายสมมติฐานพร้อมกัน
- งานใหญ่เกินจะถือใน context เดียว (migration ทั้งโปรเจกต์, review diff ก้อนใหญ่)
- อยากได้ความมั่นใจจากการ **verify แบบ adversarial** (หลาย agent ตรวจสอบ finding เดียวกันคนละมุม)

**ไม่ต้อง fan-out (ทำเองในแชทพอ):**
- คำถามตอบสั้น, แก้ไฟล์เดียวแบบ mechanical, lookup ค่าเดียวที่รู้ที่อยู่แล้ว
- งานที่มี dependency เป็นเส้นตรง ทำทีละ step อยู่แล้ว

> กติกา: fan-out ต่อเมื่อ "ความเป็นอิสระ" หรือ "สเกล" คุ้มกับค่า overhead ของการตั้งทีม agent

---

## 2. โครงสร้าง phase ที่ใช้ได้ผล (จากเคสจริง)

```
Phase A — Audit (static, read-only)   ── ขนาน N สาย ──┐
Phase B — Reproduce (runtime, สด)     ── 1 สายคุม state ─┤
                                                          ├─► barrier ─► Phase C — Synthesize
                                                          │              (รวมหลักฐาน → ข้อสรุปจัดอันดับ)
```

- **Phase A (Audit):** อ่านโค้ด/หาหลักฐานหลายมุม **พร้อมกัน** — read-only ปลอดภัย รันขนานได้เต็มที่
  - เคสจริง: 4 สาย = `backend-error-audit`, `api-contract-audit`, `proxy-config-audit`, `db-seed-startup-audit`
- **Phase B (Reproduce):** ลงมือจริง (เปิด server, ยิง endpoint) — **สายเดียว** ที่เป็นเจ้าของ runtime state เพื่อกันชนกัน
- **Phase C (Synthesize):** รวมผลทุกสาย → ให้ **น้ำหนักหลักฐาน runtime สูงสุด** → สรุป root cause จัดอันดับ + minimal fix

> ของจริง: รัน Phase A (4 สาย) + Phase B (1 สาย) **พร้อมกันทั้งหมด** แล้ว barrier ก่อน Synthesize — เพราะ synthesis ต้องเห็นผลครบทุกสายถึงสรุปได้

---

## 3. parallel vs pipeline — เลือกยังไง

| รูปแบบ | ใช้เมื่อ | พฤติกรรม |
|--------|---------|----------|
| **`pipeline()`** (default) | งานหลาย stage ต่อ item ที่ **ไม่ต้องรอ item อื่น** | item A อยู่ stage 3 ได้ขณะ item B ยัง stage 1 — ไม่มี barrier กลางทาง เร็วสุด |
| **`parallel()`** (barrier) | stage ถัดไปต้องเห็น **ผลครบทุก item** ของ stage ก่อน | รอทุก thunk เสร็จก่อน return — ใช้ตอน dedup/merge/synthesis/early-exit |

**กฎหัวแม่มือ:** default คือ `pipeline()` เสมอ ใช้ `parallel()` (barrier) เฉพาะตอน "ขั้นต่อไปต้องใช้ผลรวมของทุกอันพร้อมกัน"

**ทำไมเคสนี้ใช้ barrier:** `synthesize` ต้องอ่านผลของ audit ทั้ง 4 + runtime ก่อนถึงจะชั่งน้ำหนักและสรุปได้ → เป็น barrier ที่ legit
- ❌ อย่าใช้ barrier เพราะแค่ "อยาก flatten/map ก่อน" — ทำใน stage ของ pipeline ได้
- ❌ อย่าใช้ barrier เพราะ "โค้ดดูสะอาดกว่า" — barrier ทำให้สายที่เสร็จเร็วต้องนั่งรอสายช้า

---

## 4. การเขียน prompt ต่อ agent (หัวใจของคุณภาพ)

แต่ละ agent prompt = **3 ส่วน**:

1. **Shared context block** (ก๊อปใส่ทุก agent) — path โปรเจกต์, สถาปัตยกรรม, port, ข้อเท็จจริงที่รู้แล้ว, อาการที่ user รายงาน
2. **ROLE + ขอบเขตเฉพาะตัว** — บอกชัดว่า agent นี้ดูอะไร ตรวจอะไรบ้าง (ลิสต์เป็นข้อ a/b/c/d ให้ครบ ไม่ปล่อยให้เดา)
3. **`schema`** — บังคับ output เป็น JSON ตาม JSON Schema → ได้ data ดิบกลับมา ไม่ต้อง parse เอง, ผิด schema agent retry เอง

> เคล็ด: ใส่ "Your final message IS the return value — return raw data, not prose for a human" ในทุก prompt
> เคล็ด: ใส่หลักฐานที่หาเองได้แล้วลงใน context (เช่น "รู้แล้วว่า app.js ไม่มี error handler") เพื่อไม่ให้ agent เสียแรงค้นซ้ำ

**3 schema ที่ใช้ในเคสนี้:**
- `AUDIT_SCHEMA` — `{ component, findings[{title,file,line,severity,couldCause500,description,evidence}], summary }`
- `RUNTIME_SCHEMA` — `{ backendStarted, startupLog, endpoints[], observed500s[], proxyDownTest, rootCauseObserved, summary }`
- `SYNTH_SCHEMA` — `{ primaryRootCause, confirmedRootCauses[{rank,confidence,evidence,affectedFiles,proposedFix}], recommendation }`

---

## 5. กฎความปลอดภัย (ใส่ใน prompt เสมอ — กันพังของจริง)

- **เจ้าของ resource ชัดเจน:** "คุณ own port 4000/5173 สำหรับ task นี้" — กัน 2 agent แย่ง port (EADDRINUSE) → ให้สาย runtime เป็นสายเดียวที่แตะ server
- **kill by PID เท่านั้น ห้าม `pkill -f "pattern"`** — pattern จะ match shell ของ agent เอง ทำให้สคริปต์ฆ่าตัวเอง (exit 1 เงียบๆ) *(บทเรียนเดิมจาก memory)*
- **read-only หมายถึง read-only** — audit agent ห้ามแก้ไฟล์/ห้ามแตะ db (เช่น `sqlite3 ... .schema` อ่านได้ แต่ห้าม write)
- **cleanup ก่อนจบ:** kill ทุก process ที่เปิด, verify port ว่าง, รายงานถ้ามี side-effect ค้าง (เคสนี้ probe tag/category/group ที่สร้างตอนเทสต์)
- **อย่าลบ/แก้ db จริง** ตอน reproduce — เปิดทับของเดิม (real user scenario) ไม่ใช่ db เปล่า

---

## 6. Template ก๊อปไปใช้ได้เลย

```js
export const meta = {
  name: 'my-investigation',
  description: 'หนึ่งบรรทัด: ทำอะไร',
  phases: [
    { title: 'Audit',      detail: 'static read-only, ขนาน N สาย' },
    { title: 'Reproduce',  detail: 'runtime สด, สายเดียวคุม state' },
    { title: 'Synthesize', detail: 'รวมหลักฐาน → ข้อสรุปจัดอันดับ' },
  ],
}

const CONTEXT = `
PROJECT ROOT: <path>
- สถาปัตยกรรม / port / วิธีรัน
- ข้อเท็จจริงที่รู้แล้ว (กัน agent ค้นซ้ำ)
- อาการที่ user รายงาน
- "Your final message IS the return value — return raw data, not prose."
`
const AUDIT_SCHEMA = { type:'object', required:[...], properties:{...} }   // บังคับ output
const RUNTIME_SCHEMA = { ... }
const SYNTH_SCHEMA = { ... }

phase('Audit')
const results = await parallel([
  () => agent(`${CONTEXT}\nROLE: audit-มุม-1 ...ลิสต์ a/b/c/d...`, { phase:'Audit',     schema: AUDIT_SCHEMA }),
  () => agent(`${CONTEXT}\nROLE: audit-มุม-2 ...`,                 { phase:'Audit',     schema: AUDIT_SCHEMA }),
  () => agent(`${CONTEXT}\nROLE: audit-มุม-3 ...`,                 { phase:'Audit',     schema: AUDIT_SCHEMA }),
  () => agent(`${CONTEXT}\nROLE: runtime-repro ...STEP 1..6, own ports, kill by PID, cleanup...`,
                                                                   { phase:'Reproduce', schema: RUNTIME_SCHEMA, effort:'high' }),
])
const audits  = results.slice(0, 3).filter(Boolean)
const runtime = results[3]
log(`audits ${audits.length}/3, runtime ${runtime ? 'ok' : 'FAILED'}`)

phase('Synthesize')
const synth = await agent(`${CONTEXT}
ROLE: synthesis. ให้น้ำหนัก runtime สูงสุด สรุป root cause จัดอันดับ + minimal fix
=== AUDITS ===\n${JSON.stringify(audits, null, 2).slice(0, 14000)}
=== RUNTIME ===\n${JSON.stringify(runtime, null, 2).slice(0, 8000)}`,
  { schema: SYNTH_SCHEMA, effort:'high' })

return { synthesis: synth, runtime, audits }
```

**สั่งรัน:** เรียก Workflow tool โดยวาง script ใน `script` (มันรันเบื้องหลัง + persist script ไว้ที่ไฟล์ให้ resume ได้)

---

## 7. ข้อควรรู้เชิงเทคนิค (กับดักที่เจอจริง)

- **agent ไม่มี `Date.now()` / `Math.random()` / `new Date()`** ในสคริปต์ — จะ throw (เพื่อให้ resume ได้) → stamp เวลาหลัง workflow คืนค่า หรือส่งผ่าน `args`
- **สคริปต์เป็น JS ล้วน** ไม่ใช่ TS — ห้าม type annotation / interface / generic
- **concurrency cap** ~min(16, cores-2) ต่อ workflow — ส่ง item เยอะได้ แต่รันพร้อมกันแค่ ~10
- **`parallel()` ไม่เคย reject** — thunk ที่ throw จะกลายเป็น `null` ในผลลัพธ์ → `.filter(Boolean)` ก่อนใช้เสมอ
- **resume ได้** ถ้าแก้ script: re-invoke ด้วย `{ scriptPath, resumeFromRunId }` — agent ที่ prompt เดิมคืน cache ทันที รันใหม่เฉพาะที่แก้
- **ดู progress สด** ที่ `/workflows`; ผลเต็มอยู่ในไฟล์ `tasks/<id>.output` (ตัวแจ้งเตือนตัดมาแค่บางส่วน — อ่านไฟล์เต็มเสมอ)

---

## 8. หลังได้ผล — ปิดงานยังไง

1. **อ่านผลเต็ม** จาก `tasks/<id>.output` (อย่าเชื่อ summary ที่ถูกตัด)
2. สรุป root cause + หลักฐานให้ user ตัดสินใจ
3. **อย่าฟิกซ์ก่อน confirm root cause** (Iron Law ของ systematic-debugging) — workflow นี้จบที่ "confirm + เสนอ fix" แล้วค่อยลงมือแก้ใน step ถัดไป (เขียน failing test ก่อน → fix → verify)
4. ถ้ายังไม่ชัด → เปิด workflow รอบใหม่เจาะมุมที่ยังคลุมเครือ (loop-until-confident)

---
*Generated by Claude — based on the real `hunt-500-marketplace` workflow run, 2026-06-29*

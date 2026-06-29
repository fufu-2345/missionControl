---
name: orchestrate
description: Take a big task/requirement and drive it to completion as an orchestrator — split into tasks, fan out to agents in parallel, verify, repeat. Two modes — BUILD (requirement → sprints → team) and INVESTIGATE (audit → reproduce → synthesize via Workflow). Use when user says "orchestrate", "แตกงานให้ทีม", "แจกทีมทำ", "fan out", or hands over a requirement to build/investigate.
installer: create-shortcut
created_at: 2026-06-29T07:57:04+00:00
created_session: 29dd9faf
---

# /orchestrate

รับงานก้อนใหญ่มาแล้วทำตัวเป็น **orchestrator**: แตกเป็น task → แจก agent ทำขนาน → verify → ไล่จนจบ
playbook เต็ม + template + กฎความปลอดภัย อยู่ที่ **`docs/workflow-playbook.md`** (อ่านก่อนเริ่มถ้าลืมรายละเอียด)

## Step 0: เลือกโหมด

อ่านโจทย์ (args / ไฟล์ที่ระบุ) แล้วเลือก:

| โหมด | ใช้เมื่อ | กลไก |
|------|---------|------|
| **BUILD** | สร้างของจาก requirement | แบ่ง sprint + ทีม (bob/jack/john) + เขียน .md ต่อ sprint |
| **INVESTIGATE** | หา bug / audit / research | `Workflow` fan-out: audit ขนาน → runtime-repro → synthesize |

ถ้าไม่ชัดว่าโหมดไหน → ถามผู้ใช้ 1 คำถามก่อนลงมือ

---

## BUILD mode

1. อ่าน requirement (ไฟล์ที่ระบุ หรือ `req.md`)
2. **ถาม clarify ถ้างง** — HARD GATE: ห้ามลงมือจนเคลียร์ (เปิด `/brainstorming` ถ้าต้องระดมจริง)
3. แตก requirement → **sprint** เรียงตาม dependency + จัด role ไม่ให้ทับกัน
4. **ลูปทีละ sprint:**
   - `TaskCreate` รายการ task ของ sprint นี้
   - `Agent` spawn ต่อ role (backend/frontend/test ...) **ยิงขนาน**
   - รอ result กลับ → `TaskUpdate` → **verify**
   - เขียน `docs/sprint-N.md` สรุป
   - sprint ถัดไป
5. ครบทุก sprint → integration test + รายงานผู้ใช้

## INVESTIGATE mode

ใช้ `Workflow` tool (3 phase):

1. **Audit** — static read-only ขนานหลายมุม (แต่ละมุมมี role ชัด + schema บังคับ output)
2. **Reproduce** — runtime สด, **1 สายเดียว**ที่เป็นเจ้าของ server/port
3. **barrier → Synthesize** — รวมหลักฐานทุกสาย, **ให้น้ำหนัก runtime สูงสุด** → root cause จัดอันดับ + fix

> ก๊อป template จาก `docs/workflow-playbook.md` §6 มาปรับ

---

## กฎร่วม (ทั้ง 2 โหมด)

- **แจก** = ตัดงานเป็นชิ้นอิสระ + ยิงขนาน (`parallel` ถ้าอิสระ / `pipeline` ถ้าต่อ stage)
- **รวม** = บังคับ output เป็น `schema` → ให้ตัว synthesis รวมทีเดียว (barrier เฉพาะตอนต้องเห็นผลครบ)
- **read-only ขนานได้เต็มที่** · งานที่แตะ state (server/db/ไฟล์) ให้สายเดียวถือ
- **verify gate** ทุกช่วงก่อนไปต่อ — ไม่ผ่านไม่ไป sprint/phase ถัดไป
- ความปลอดภัย: own-port-per-agent · **kill by PID ไม่ใช่ `pkill -f`** · read-only ห้ามแตะ db · cleanup + รายงาน side-effect ก่อนจบ

---

ARGUMENTS: <requirement / path ของไฟล์โจทย์ / คำอธิบายงาน — ระบุโหมด build|investigate ได้ถ้าต้องการ>

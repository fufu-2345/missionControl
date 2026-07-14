# Design — popup ตั้งชื่อโปรเจคใหม่ + เช็คชื่อว่าง (local + GitHub org)

- วันที่: 2026-07-14
- สถานะ: approved (design ผ่าน discussion แล้ว)
- repo: `missionControl` (extension, ส่วนหลัก) + `orches-skills` (orchestrator รับชื่อ) · branch: `feat/new-project-name-popup`

## เป้าหมาย

ตอนกด "+ เริ่มโปรเจคใหม่" ให้ user **พิมพ์ชื่อโปรเจคเอง** (มีชื่อ default ที่ระบบคิดให้ pre-fill) + **เช็คชื่อซ้ำสด ทั้ง local และ GitHub org** ก่อนเริ่ม build — แทนของเดิมที่ orchestrator เดาชื่อจากโฟลเดอร์ local เอง (เห็นแค่เครื่องนี้ + ไปตายตอน `ensure-remote` push ถ้าซ้ำบน org = เหลือโฟลเดอร์ค้าง)

## Non-goals

- ไม่ทำ `.sh name-resolve` verb สาย CLI (Phase 2 ถ้าต้องการ)
- ไม่แตะ flow resume (⏮ ทำต่อ) — เฉพาะ "เริ่มใหม่"
- ไม่เปลี่ยนพฤติกรรม versioning ที่ user ตั้งใจ (แค่ทำให้ authoritative = เทียบ org ด้วย)

## UX flow

1. กด "+ เริ่มโปรเจคใหม่" → เปิด **popup ตั้งชื่อ** (in-webview center modal สไตล์เดียวกับ modal ลบ) — **ก่อน** team picker
2. ช่องชื่อ **pre-fill default** ที่ระบบคิดให้ (ดู "default name logic")
3. พิมพ์/แก้ชื่อ → **live check (debounce 400ms) 2 แหล่ง** → chip สถานะใต้ช่อง:
   - `ว่าง` (เขียว) — ว่างทั้ง local + github
   - `ซ้ำ: ในเครื่อง` / `ซ้ำ: GitHub` / `ซ้ำ: ทั้งคู่` (แดง)
   - `เช็คเฉพาะในเครื่อง (gh ไม่พร้อม)` (เหลือง) — gh ไม่มี/ไม่ได้ login/ออฟไลน์ → เช็ค local อย่างเดียว + เตือน
   - ชื่อผิดรูป (ว่าง/มีอักขระต้องห้าม) → แดง + ไม่ให้ไปต่อ
4. ปุ่ม **"ถัดไป"** enable เฉพาะเมื่อชื่อถูกรูป + ว่าง (local ต้องว่างเสมอ; github ถ้า gh พร้อมต้องว่างด้วย)
5. ยืนยัน → เก็บชื่อใน `_st.newName` → ไป team picker → launch (mode "new") ตามเดิม
6. **launch ส่งชื่อไปให้ orchestrator** (kickoff) → orchestrator ใช้ชื่อนี้ **ไม่ตั้ง/ไม่ bump เอง**

## default name logic (ระบบคิดให้)

`suggestDefaultName()`:
- หา project ล่าสุด (จาก `scanResumableProjects()` → `sortResumable()[0]`) → ตัด suffix `-vN` ออกเป็น base
- วนหา suffix ว่างถัดไปที่ **ว่างทั้ง local + github**: `base`, `base-v2`, `base-v3`, … (เริ่ม -v2 ถ้า base เปล่าไม่ว่าง; ถ้า base เองว่าง = ใช้ base)
- ไม่มี project เดิมเลย → default = `my-project` (เช็คว่าง)
- คืนชื่อว่างชื่อแรกที่เจอ (cap ~30 รอบกัน loop) — ใช้ pre-fill

> เหตุผล: user rebuild ตัวเดิมบ่อย (v2–v8 มาแล้ว) → เดา "เวอร์ชันถัดไปที่ว่าง" เป็น default ที่ตรงงานสุด · แก้เป็นชื่ออื่นได้เสมอ

## เช็คชื่อว่าง (core, reusable)

`checkProjectName(name): { localTaken: boolean; githubChecked: boolean; githubTaken: boolean }`
- **local:** `scanResumableProjects()` (หรือ readdir projects root) → มีโฟลเดอร์ชื่อตรงไหม · fast, ไม่มี network
- **github:** `gh repo view MyMissionControl/<name> --json name` ผ่าน `child_process.execFile` → exit 0 = taken · exit≠0 (404) = free · `gh` ไม่มี/ไม่ได้ login → `githubChecked=false` (ไม่บล็อก แต่เตือน)
- name sanitize/validate: `^[A-Za-z0-9._-]+$` (ตรงกับ repo name rule) — ว่าง/ผิด = invalid

`SAFE_NAME = /^[A-Za-z0-9._-]+$/` · org = `MyMissionControl` (const, ตรงกับ `ensure-remote`)

## สถาปัตยกรรม / จุดแก้ (อิงของจริง)

**`extension/src/commands/projectName.ts` (ใหม่, pure-ish):**
- `sanitizeName(raw): string` + `isValidName(name): boolean` (pure — unit test)
- `bumpBase(name): string` (strip `-vN` → base) + `nextCandidate(base, n)` (pure — unit test)
- `checkProjectName(name, localNames, ghView)` — รับ localNames[] + ghView fn (inject → testable โดยไม่ต้องมี gh จริง)
- `suggestDefaultName(projects, ghView)` — pure logic + inject ghView

**`extension/src/webview/orchestrator.ts`:**
- `case "start_new"` → เปิด name popup (แทนไป pushTeamsScreen ตรงๆ) · ส่ง default (คำนวณ server-side) ให้ popup
- `case "check_name" {name}` → เรียก `checkProjectName` (local scan + `gh repo view`) → post `name_result {name, localTaken, githubChecked, githubTaken}`
- `case "name_confirmed" {name}` → `_st.newName = name` → `pushTeamsScreen(panel)`
- name popup HTML (`#namemodal`) + client JS (debounced check, chip, enable ปุ่ม) — mirror `#delmodal`
- team-pick handler: `launchOrchestrator({..., projectName: _st.newName})`

**`extension/src/commands/startOrchestrator.ts`:**
- `launchOrchestrator` opts เพิ่ม `projectName?: string` → mode "new" + projectName → kickoff เติม "โปรเจคชื่อ `<name>` — ใช้ชื่อนี้เป๊ะ ห้ามตั้งใหม่/ห้าม bump"

**`orches-skills` (SKILL prose — orchestrator honor ชื่อ):**
- `/orches` bootstrap + `/orches-drive` Step 2: "ถ้า kickoff ระบุชื่อ project มาแล้ว → ใช้ชื่อนั้น ไม่ตั้งเอง/ไม่ bump" · guard เดิม (prep-repo, ensure-remote) คงไว้เป็น safety net

## Data flow

```
[webview] + เริ่มโปรเจคใหม่ → post start_new
[ext] suggestDefaultName() (local+gh) → post open_namemodal{default}
[webview] popup pre-fill · พิมพ์ → (debounce) post check_name{name}
[ext] checkProjectName → post name_result{...}
[webview] chip + enable "ถัดไป" เมื่อว่าง
[webview] ถัดไป → post name_confirmed{name}
[ext] _st.newName=name → pushTeamsScreen → team pick → launchOrchestrator{projectName}
[orchestrator] kickoff มีชื่อ → ใช้เลย ไม่ bump
```

## Error handling

- gh ไม่มี/ไม่ login/ออฟไลน์ → เช็ค local อย่างเดียว, chip เหลือง เตือน, ยังไปต่อได้ (local ว่างพอ) — ensure-remote จะ guard org ตอน push อยู่แล้ว (safety net)
- ชื่อผิดรูป → invalid, ปุ่ม disabled
- check ล้ม (gh timeout) → ถือว่า githubChecked=false + เตือน
- user ปิด popup (Esc/cancel) → กลับหน้า Projects ไม่ launch

## Testing

- **pure (`projectName.test.ts`, bun):** sanitizeName/isValidName (ผ่าน/ปฏิเสธอักขระ), bumpBase (`x-v8`→`x`, `x`→`x`), suggestDefaultName (inject fake projects + fake ghView → คืนชื่อว่างถูก, skip ที่ github taken, fallback my-project), checkProjectName (local taken / github taken / both / gh-unavailable)
- **webview:** manual F5 (popup, chip สี, enable ปุ่ม, default pre-fill)
- **integration:** F5 เริ่มโปรเจคใหม่ตั้งชื่อ → launch → orchestrator ใช้ชื่อที่พิมพ์ (ดูใน pane/plan.md)

## Verify (F5)

1. + เริ่มโปรเจคใหม่ → popup เด้ง + default pre-fill (เช่น `agentskill-marketplace-v9`)
2. พิมพ์ชื่อที่มี local (เช่น `rpn`) → chip แดง "ซ้ำ: ในเครื่อง" + ถัดไป disabled
3. พิมพ์ชื่อว่าง → chip เขียว → ถัดไป ได้
4. ถัดไป → team picker → launch → orchestrator ใช้ชื่อนั้น (ไม่ bump)
5. ปิด gh (mock) → chip เหลือง เช็ค local อย่างเดียว

## ผลลัพธ์

user คุมชื่อโปรเจคเองได้จาก UI พร้อมเช็คว่างสดทั้งเครื่อง+org ก่อนเริ่ม — ไม่ชนของเก่า, ไม่เหลือโฟลเดอร์ค้างจาก ensure-remote ตายกลางทาง

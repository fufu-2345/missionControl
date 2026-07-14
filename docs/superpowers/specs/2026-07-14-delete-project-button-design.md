# Design — ปุ่มลบโปรเจค (Delete-project button) ในหน้า orchestrator

- วันที่: 2026-07-14
- สถานะ: approved (พร้อมทำ implementation plan)
- repo: `missionControl` (extension) · branch: `feat/delete-project-button`

## เป้าหมาย

หน้าโปรเจค (orchestrator webview) มีโปรเจคซ้อนกันหลายเวอร์ชัน (เช่น `agentskill-marketplace-v2..v8`)
โปรเจคที่ทำเสร็จ/ทิ้งแล้วไม่มีทางลบออกจาก UI — ต้องไปลบโฟลเดอร์เองในเทอร์มินัล
เพิ่ม **ปุ่มลบต่อการ์ด** (หลังกด Edit mode) เพื่อลบโปรเจคที่ไม่ใช้แล้วออก **จากเครื่อง local** ได้จาก UI โดยตรง อย่างปลอดภัย

## ไม่อยู่ในขอบเขต (non-goals)

- **ไม่แตะ GitHub remote** — ลบเฉพาะโฟลเดอร์ในเครื่อง (ผู้ใช้ยืนยัน: "online ไม่ต้องไปยุ่ง") · repo บน GitHub ผู้ใช้ลบเองทีหลังถ้าต้องการ
- **ไม่แก้บั๊ก dashboard "ไฟเขียวขึ้นทั้ง base + v8"** — คนละเรื่อง แยกไปทีหลัง (บันทึกไว้เฉยๆ)
- ไม่เปลี่ยนพฤติกรรมการตั้งชื่อเวอร์ชัน (v-bump = ผู้ใช้ตั้งใจ)

## UX flow

1. หน้า orchestrator เพิ่มปุ่ม **"Edit"** (toggle) — ปิดเป็น default
2. เปิด Edit mode → การ์ดโปรเจคทุกใบโผล่ปุ่มลบ (ไอคอนถังขยะ)
3. การ์ดที่ **กำลัง running** (มี live session) → ปุ่มลบเป็น **กากบาทแดง disabled** กดไม่ได้ + tooltip "stop ก่อนถึงจะลบได้"
4. กดปุ่มลบ (การ์ดที่ลบได้) → **VS Code warning modal** (`showWarningMessage` แบบ `modal:true`):
   "ลบ `<ชื่อ>` ออกจากเครื่องถาวร? (ไม่แตะ GitHub)" → [ลบ] / [ยกเลิก]
5. กดยืนยัน → **`showInputBox`**: "พิมพ์ชื่อโปรเจคเพื่อยืนยัน: `<ชื่อ>`" → ต้องพิมพ์ตรงเป๊ะ (ผิด/ว่าง = ยกเลิก ไม่ลบ)
6. ผ่าน → ลบโฟลเดอร์ → การ์ดหายจากหน้า (re-render) + ข้อความยืนยันสั้นๆ

## Scope + ความปลอดภัย (หัวใจของ design)

การลบเป็น action ที่ย้อนไม่ได้ → ป้องกันหลายชั้น:

1. **ลบอะไร:** `fs.rm(project.path, { recursive: true, force: true })` — โฟลเดอร์ในเครื่องอย่างเดียว
   (`.git` + worktrees `agents/<role>` อยู่ข้างในหายไปด้วย ไม่มี repo อื่นอ้างถึง = ไม่มี worktree ค้าง) · **ไม่รัน `gh` / ไม่แตะ remote**
2. **path guard** (`canDeleteProjectPath`, ฟังก์ชันบริสุทธิ์ เทสได้):
   - resolve absolute · ปฏิเสธถ้ามี `..` หรือ symlink escape
   - ต้องเป็น **ลูกตรง**ใต้ `.../projects/` — `path.dirname(resolved)` ลงท้าย `/projects`
   - ปฏิเสธถ้า path = projects root เอง หรือ path ว่าง
   - ต้องมีจริง + เป็น directory
   - path มาจาก `ResumableProject.path` ที่ scan มาแล้ว (ไม่ใช่ string ที่ user พิมพ์) → ลด attack surface
3. **running guard 2 ชั้น:**
   - ฝั่ง webview: ปุ่มลบ disabled (กากบาทแดง) ถ้า `running`
   - ฝั่ง extension (defense-in-depth): ก่อน `rm` เช็ค running ซ้ำด้วย logic เดิม (`readRunMarker(path)?.status === "running"` + `tmuxHasSession(marker.session)` + createdAt ตรง) → ถ้า running = refuse (เผื่อ webview state เพี้ยน/แข่งกัน)
4. **type-to-confirm:** ต้องพิมพ์ basename ตรงเป๊ะ (case-sensitive) — กัน mis-click

## สถาปัตยกรรม / จุดแก้โค้ด (อิงชื่อจริงในโค้ด)

**ไฟล์ใหม่ `extension/src/commands/deleteProject.ts`:**
- `canDeleteProjectPath(path: string, projectsRootHint?: string): { ok: boolean; reason?: string }` — guard บริสุทธิ์ (ไม่แตะ fs นอกจาก realpath/stat), เทสได้เต็ม
- `isProjectRunning(path: string): boolean` — reuse `readRunMarker` + `tmuxHasSession` จาก `continueRun.ts` (logic เดียวกับ running-derivation ที่ `orchestrator.ts` บรรทัด ~98)
- `deleteProject(path: string, name: string): Promise<{deleted: boolean; reason?: string}>` — orchestrate: guard → running re-check → `showWarningMessage(modal)` → `showInputBox(type-name)` → `fs.rm` → คืนผล

**`extension/src/webview/orchestrator.ts`:**
- เพิ่ม state `editMode: boolean` + ปุ่ม "Edit" toggle — **เป็น webview-local state ล้วน** (แค่สลับ class/แสดงปุ่มถังขยะ ไม่ต้อง postMessage ไป extension) กัน round-trip เกินจำเป็น
- ตอน render การ์ด: ส่ง `deletable = !running` (running ใช้ derivation เดิม) → edit mode + deletable = ปุ่มถังขยะ active · edit mode + running = กากบาทแดง disabled
- เพิ่ม `case "delete_project"` ใน `panel.webview.onDidReceiveMessage` → เรียก `deleteProject(p.path, p.name)` → สำเร็จ = re-render project list (ตัวเดิมที่ใช้อยู่)
- ไม่แตะ logic `continue_run` / `cancel_run` / commit เดิม

**Data flow:**
```
[webview] Edit toggle → การ์ด deletable โผล่ปุ่มถังขยะ
   ↓ คลิก (การ์ด deletable)
[webview] postMessage {type:"delete_project", path, name}
   ↓
[extension] onDidReceiveMessage → deleteProject(path,name)
   ↓ canDeleteProjectPath → isProjectRunning(refuse ถ้า running)
   ↓ showWarningMessage(modal) → showInputBox(ชื่อตรง)
   ↓ fs.rm(path, recursive)
[extension] → re-render → การ์ดหาย
```

## Error handling

- guard ไม่ผ่าน → ไม่ลบ + แจ้ง reason (เช่น "path นอก projects/", "โปรเจคกำลัง run")
- ยกเลิก modal / พิมพ์ชื่อผิด → เงียบ ไม่ลบ (ไม่ถือเป็น error)
- `fs.rm` ล้ม (permission/busy) → แจ้ง error message, การ์ดยังอยู่
- running re-check เจอ running → refuse + แจ้ง "stop ก่อน"

## Testing

- **`canDeleteProjectPath` (unit, เหมือน `teamsModel.test.ts`):** ยอมรับ path ใต้ `projects/<name>` · ปฏิเสธ: projects root เอง, path มี `..`, นอก `projects/`, ไม่มีจริง, ไฟล์ (ไม่ใช่ dir)
- **type-name match (unit):** ตรง=ผ่าน · ผิด/ว่าง/เว้นวรรคเกิน=ไม่ลบ
- **`deleteProject` (integration, temp dir จริง):** สร้าง `<tmp>/projects/foo` → ลบสำเร็จหาย · project ที่ mark running → refuse ไม่ลบ · path นอก projects/ → refuse
- **webview:** edit toggle โผล่/ซ่อนปุ่ม · running = disabled (ตรวจ manual ตอน F5 + unit ถ้า render function แยกได้)

## Verify (ตาม mc-orches-dev-verify)

- `bun test` เขียว (unit)
- F5 reload extension → เปิดหน้า orchestrator → Edit → ลบโปรเจค done จริง (เช่น v5 ที่ว่าง) → ยืนยันโฟลเดอร์หายจากดิสก์ + การ์ดหาย + GitHub repo (ถ้ามี) ยังอยู่
- ลองกดลบการ์ด running → กดไม่ได้ (กากบาทแดง)

## ผลลัพธ์ที่คาดหวัง

ผู้ใช้เก็บกวาดโปรเจคเวอร์ชันเก่า/ทำเสร็จออกจากเครื่องได้จาก UI อย่างปลอดภัย โดยไม่กระทบ GitHub และลบ project ที่กำลังทำงานอยู่ไม่ได้

## Revision 2026-07-14 (หลัง F5 รอบแรก — UX feedback)

จาก F5: ฟีเจอร์ทำงานถูก แต่ปรับ 3 อย่างตามที่ user เห็นแล้วไม่ถูกใจ:

1. **เลิกใช้ native VS Code dialog → in-webview modal กลางจอ** (ตัวเดิม `showWarningMessage` เด้ง + `showInputBox` ไปโผล่บน command-palette แยกกล่อง = แย่) · ตอนนี้ **ยืนยัน + พิมพ์ชื่อ อยู่ใน popup เดียว** (`#delmodal`, reuse `.modal-card` เดียวกับ "ทำหลาย sprint") · ปุ่ม "ลบถาวร" (danger) enable เฉพาะเมื่อพิมพ์ชื่อตรง · client post `delete_project` หลังยืนยัน → host `deleteProjectFlow` เหลือแค่ **running re-check + guard + rm** (confirm ย้ายมา client)
2. **เลิกใช้ emoji → ข้อความล้วน** (เครื่อง user render emoji เป็นกล่อง tofu — กฎที่มีอยู่แล้ว) · ปุ่มลบ = **ปุ่มขอบแดง "ลบ"** (running = greyed disabled) · ปุ่ม toggle = "Edit" (ไม่มี ✏️)
3. **ปุ่ม "+ เริ่มโปรเจคใหม่" ทำให้ subtle** (เดิมเขียวใหญ่ตัวหนา → เขียวขอบ/ตัวอักษรเขียว เข้าชุดกับ fetch/Edit)

guard ฝั่ง extension (path + running) คงเดิม — type-to-confirm client-side = UX friction, ความปลอดภัยจริงอยู่ที่ guard + running re-check

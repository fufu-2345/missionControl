# แก้ CPU พุ่งจาก ψ-watcher full re-embed — วิธีทำ (สำหรับ AI/คนที่มาทำต่อ)

_2026-07-06 · diagnosed จากเหตุการณ์จริง (load 15+ บนเครื่อง 4 core, ollama ~200% ค้างเป็นชั่วโมง) · หลักฐานทุกข้อ verify แล้ว_

## อาการ

- VM (4 core) load average พุ่ง 13–16 → extension host เปิดไม่ทัน 10 วิ, ทุกอย่างอืด
- `ollama runner --model ...nomic-embed-text` กิน ~197% CPU (2 core เต็ม) ต่อเนื่องนานเป็นชั่วโมง ทุกครั้งที่มี orchestrator/oracle ทำงาน

## Root cause (2 ชั้น — ชั้นแรกคือตัวที่จะกลับมาเรื่อยๆ)

### ชั้น 1 (recurring): ψ-watcher สั่ง **re-embed ทั้งคลัง** ทุกครั้งที่ ψ มีไฟล์เปลี่ยน

Chain (ไฟล์:บรรทัด verify แล้ว):
1. `~/.claude/oracle-psi-watcher.ts` (systemd --user unit `oracle-psi-watcher.service`) เฝ้า ψ ทุก vault → ไฟล์เปลี่ยน 1 ไฟล์ → FTS reindex (เร็ว ไม่ใช่ปัญหา) → `scheduleEmbed()` รอ `EMBED_DEBOUNCE_MS = 60_000` (บรรทัด ~32) → `runEmbed()` (บรรทัด ~125)
2. `runEmbed()` spawn `INDEX_MODEL` = `~/.bun/install/global/node_modules/arra-oracle-v3/src/scripts/index-model.ts` พร้อม arg `nomic`
3. **`index-model.ts` ไม่มี incremental**: `SELECT * FROM oracle_documents JOIN oracle_fts ... ORDER BY created_at DESC` = **ทุก doc** (ตอน diagnose = 485 docs) → batch ละ 25 → ยิง ollama `nomic-embed-text` (CPU-only) → batch แรก `store.replaceDocuments(docs)` ที่เหลือ `store.addDocuments(docs)` (in-place replace เพราะ #987 ห้าม drop/recreate — LanceDB table handle ของ MCP จะพัง)
4. ระหว่าง /orches ทำงาน worker เขียน ψ ต่อเนื่อง (learn/trace/rrr) → embed pass จบก็มีของใหม่รอ (`embedPending`) → **วน full-pass ติดกันไม่หยุด**

**หลักฐาน (journalctl --user -u oracle-psi-watcher):** embed จบทุก 4–8 นาทีติดกันช่วง 01:00–07:00 (2026-07-06) · pass ช่วงบ่ายกว้าง 16:09→17:00 ≈ **50 นาที/pass** ภายใต้ contention · ต้นทุน = O(ทั้งคลัง) ต่อการเปลี่ยน 1 ไฟล์ และคลังโตทุกวัน → แย่ลงเรื่อยๆ

### ชั้น 2 (one-off): `bun test` ค้าง 7 ชม. @95% CPU (เศษจาก session เก่า — kill แล้ว) + claude 8 ตัวพร้อมกันบน 4 core ช่วยซ้ำเติม

## ⚠️ Gotcha ก่อนแก้: global ≠ dev tree (ไม่ใช่ symlink!)

- watcher เรียก index-model จาก **global**: `~/.bun/install/global/node_modules/arra-oracle-v3/` (dir จริง, verify แล้วไม่ใช่ symlink — ต่างจาก maw-js ที่ symlink ไว้)
- dev repo อยู่ที่ `~/Desktop/soulbrew/github.com/Soul-Brews-Studio/arra-oracle-v3/` — ณ 2026-07-06 ไฟล์ index-model.ts สองที่**เหมือนกัน** (diff ว่าง)
- **แก้ที่ dev tree แล้วต้อง sync ไป global ด้วย** (cp ไฟล์ตรงๆ หรือ reinstall global) — ไม่งั้น watcher ใช้ตัวเก่า · แนะนำ commit ที่ dev repo เป็นหลักแล้ว cp ไป global

## วิธีแก้ (ทำ A ทันที + B ถาวร · C เสริม)

### Fix A — ยืด debounce (1 บรรทัด, บรรเทาทันที)

ไฟล์ `~/.claude/oracle-psi-watcher.ts` บรรทัด ~32:
```ts
const EMBED_DEBOUNCE_MS = 60_000;        // เดิม
const EMBED_DEBOUNCE_MS = 20 * 60_000;   // ใหม่: 20 นาที
```
แล้ว `systemctl --user restart oracle-psi-watcher`
- ผล: จากวน full-pass แทบต่อเนื่อง → อย่างมาก ~3 pass/ชม. · **FTS/keyword search ไม่กระทบ** (index แยก ยังสดทันที) — ที่ช้าลงคือ semantic search เห็น doc ใหม่ช้าสุด ~20 นาที + เวลา pass
- ยังเป็น full-pass อยู่ → ไม่พอในระยะยาว ต้องมี B

### Fix B — incremental embed (แก้ที่ต้นเหตุ, ~30–50 บรรทัด)

แก้ `arra-oracle-v3/src/scripts/index-model.ts` (dev tree → sync global):

**แนวทางแนะนำ: watermark ตาม `created_at` + state file** (ไม่ต้องพึ่ง LanceDB query id ซึ่งอาจไม่มี API):
1. state file เช่น `~/.oracle/embed-state.json` เก็บ `{ lastEmbeddedCreatedAt: string, docCount: number }`
2. โหมด incremental (default เมื่อ state มี): `SELECT ... WHERE d.created_at > :watermark ORDER BY created_at ASC` → embed เฉพาะ docs ใหม่ → `store.addDocuments(docs)` **อย่างเดียว** (ห้าม replaceDocuments — จะทับของเก่าหาย) → อัปเดต watermark เป็น created_at สูงสุดที่ทำสำเร็จ
3. โหมด full (เดิมทั้งก้อน): เมื่อ (ก) ไม่มี state file (ข) ส่ง flag `--full` (ค) sanity เพี้ยน เช่น `docCount` ใน state > จำนวนแถวจริง (มีการลบ/supersede) — full pass จบแล้วเขียน state ใหม่
4. คง batch 25 + `ORACLE_EMBED_TIMEOUT_MS`/`BATCH_SIZE` env เดิม · คงกติกา #987 (full pass ใช้ replace-first-batch แบบเดิม)
5. **ต้องเช็คตอน implement:** (ก) docs ใน oracle_documents ถูก UPDATE เนื้อหาได้ไหม (ถ้าได้ watermark ตาม created_at ไม่พอ — ใช้ updated_at หรือ content hash) (ข) supersede/ลบ doc ทำอะไรกับแถว — ถ้าลบจริง vector เก่าค้างใน lancedb จนกว่าจะ full pass (ยอมรับได้: นัด full pass เป็นงาน hygiene รายวัน เช่น cron ตอนตี 4 หรือ `--full` มือ)
6. watcher ไม่ต้องแก้เพิ่ม (มันแค่ spawn สคริปต์เดิม) — จะได้ per-change cost = ไม่กี่ doc = ไม่กี่วินาที

**ทางเลือกสำรอง** (ถ้าอยาก exact): เพิ่ม `store.listIds()` ใน vector adapter แล้ว diff กับ id ทั้งหมดใน sqlite — แม่นกว่า (จับ update/ลบ) แต่แตะ adapter ทุกตัว

### Fix C — ครอบ ollama ด้วย CPUQuota (containment ไม่แตะ logic)

ollama เป็น system service (`/etc/systemd/system/ollama.service`, verify แล้ว):
```bash
sudo systemctl edit ollama    # สร้าง drop-in
# ใส่:
[Service]
CPUQuota=150%
sudo systemctl daemon-reload && sudo systemctl restart ollama
```
- ผล: embed ช้าลงนิดแต่เครื่องไม่โดนดูดเกิน 1.5 core → interactive งานไม่อืด · ใช้ได้แม้ยังไม่ทำ B

### เสริม (ไม่บังคับ, คนละปัญหา)
- `ollama pull bge-m3` — แก้ `oracle_learn` ที่ log `embedding:failed` มา 3 session (มันใช้ bge-m3 ซึ่งไม่มีในเครื่อง — fail เร็ว ไม่กิน CPU ไม่เกี่ยวพายุนี้ แต่ semantic ของ learn จะกลับมาทำงาน) · ระวัง: โหลดโมเดลเพิ่ม = RAM/CPU ตอน embed เพิ่ม
- กัน `bun test` ค้างข้ามวัน: ถ้าเจอ process `bun test` etime เกินชั่วโมง = ค้าง kill ได้เลย

## วิธี verify หลังแก้

1. **A:** `journalctl --user -u oracle-psi-watcher -f` → เขียนไฟล์ ψ ทดสอบ → embed ต้องยิงครั้งเดียวหลัง ~20 นาที ไม่ใช่ 60 วิ
2. **B:** เขียน learning ใหม่ 1 อัน → log ต้องโชว์ embed แค่ ~1 doc (เพิ่ม log จำนวน doc ใน pass ด้วย) → pass จบใน วินาที ไม่ใช่นาที · `ollama ps` ไม่ค้าง 100% ยาว · แล้วลอง `--full` หนึ่งครั้งดูว่า path เดิมยังทำงาน
3. **สนามจริง:** ปล่อย /orches รัน 1 sprint → `uptime` load ต้องไม่ไต่เกิน ~จำนวน core และ ollama ไม่ปักหลัก ~200% เป็นชั่วโมง

## สถานะ ณ วันที่เขียน

- ยังไม่ได้ apply fix ใดๆ (VM เพิ่ง reboot อาการหาย ชั่วคราว) · watcher autostart กลับมารันแล้ว → พายุจะกลับมาเมื่อ orchestrator เริ่มงานรอบหน้า
- `bun test` ค้าง = kill ไปแล้วก่อน reboot (ไม่เหลือ)

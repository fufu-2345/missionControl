# `maw talk-to` โหลด memory อะไรบ้าง? (อธิบายภาษาไทย)

> สร้างเมื่อ 2026-06-17 — อธิบายว่าเวลาใช้ `maw talk-to` แล้ว AI โหลดความจำ (memory) อะไร และไฟล์อยู่ที่ path ไหนบ้าง

---

## ✅ ตอบสั้นๆ ก่อน: มัน "โหลด" จริงไหม?

**โหลดครับ** — แต่ต้องแยกให้ออกว่า "ใคร" โหลด "อะไร"

ที่ผมบอกในแชทว่า "talk-to ไม่ได้โหลด memory" หมายถึงแค่ว่า **ตัวคำสั่ง `maw talk-to` เองไม่ได้ยัดไฟล์ความจำเข้าไปในหัว AI ตัวที่รับสาร** เท่านั้น

แต่จริงๆ มันไปกระตุ้นให้ **Oracle server โหลดความจำของตัวเองออกมา** (principles + patterns) — อันนี้แหละคือ memory ที่ถูกโหลด

มี memory **2 ชุดคนละระบบ** เข้ามาเกี่ยวข้อง อย่าสับสนกัน 👇

---

## 🔄 `maw talk-to <ปลายทาง> "ข้อความ"` ทำงานยังไง

ดูจากซอร์สโค้ดจริง: `/home/chillox-intern/.maw/plugins/talk-to/impl.ts`

มันทำ 2 สเต็ปเรียงกัน:

### สเต็ป 1 — ยิงข้อความเข้า Oracle thread (👈 ตรงนี้แหละที่ "โหลด memory")
```
POST http://localhost:47778/api/thread   (ห้อง channel:<ปลายทาง>)
```
- Oracle server รับข้อความ แล้ว **ค้นหาความจำของตัวเอง** ที่เกี่ยวข้อง
- ส่งกลับมาเป็น `oracle_response` ที่มี `principles_found` (หลักการที่เจอ) และ `patterns_found` (แพตเทิร์นที่เจอ)
- **นี่คือ "memory ที่ AI โหลด" ที่คุณถามถึง** — มันมาจากฐานความรู้ Oracle

### สเต็ป 2 — แทรกข้อความเข้า pane ของ AI ปลายทาง (`maw hey`)
- AI ตัวปลายทางจะเห็นข้อความโผล่ใน tmux pane ของมัน
- **สเต็ปนี้ไม่ได้โหลด memory เพิ่ม** — แค่ส่งตัวข้อความเข้าไปเฉยๆ

---

## 📁 Path ของ memory แต่ละชุด (absolute path)

### ชุดที่ 1 — Oracle knowledge base (ตัวที่ talk-to ไปค้น)
> ความจำของ Oracle: principles, patterns, threads
> ยืนยันจาก env ของ server ที่รันอยู่จริง: `ORACLE_DATA_DIR=/home/chillox-intern/.oracle`

| เก็บอะไร | Path |
|----------|------|
| Keyword search + threads (SQLite) | `/home/chillox-intern/.oracle/oracle.db` |
| Semantic / vector search (LanceDB) | `/home/chillox-intern/.oracle/lancedb/oracle_knowledge.lance` |
| รายชื่อ contacts | `/home/chillox-intern/.oracle/contacts.json` |

> ⚠️ โฟลเดอร์ `~/.arra-oracle-v2` เป็น **ของเก่าที่ค้างอยู่ (orphan)** — server ตัวจริงอ่านจาก `~/.oracle` ไม่ใช่ตัวนี้

### ชุดที่ 2 — ความจำของ AI ตัวที่รับสาร (โหลดตอนเปิด session ของมันเอง ไม่ใช่ talk-to โหลดให้)
ตัวอย่างของโปรเจกต์ soulbrew:
- `/home/chillox-intern/.claude/projects/-home-chillox-intern-Desktop-soulbrew/memory/MEMORY.md` (+ ไฟล์ memory ในโฟลเดอร์นี้)
- `/home/chillox-intern/.claude/CLAUDE.md` + `/home/chillox-intern/.claude/RTK.md`
- ไฟล์ `CLAUDE.md` ของ repo นั้นๆ เอง

### ชุดที่ 3 — log การส่งข้อความ (เป็นแค่บันทึก ไม่ได้ถูกโหลดเป็น context)
- `/home/chillox-intern/.maw/maw-log.jsonl`

---

## ⚠️ ข้อควรระวัง ณ ตอนนี้ (สำคัญ!)

ผมลองยิงเช็ค `http://localhost:47778` แล้ว — **ตอนนี้มันล่ม/ไม่ตอบ** (`HTTP 000` = ต่อไม่ติด)

โปรเซส `arra-oracle` ที่รันอยู่ 2 ตัวเป็น **MCP stdio server** ไม่ใช่ตัว HTTP server

**ผลคือ:** ตอนนี้ถ้าใช้ `maw talk-to` → สเต็ป 1 (โพสต์ thread + ให้ Oracle ค้น memory) จะ **ล้มเหลว** แล้ว fallback ไปทำแค่สเต็ป 2 (แทรกข้อความเข้า pane เฉยๆ)

➡️ แปลว่า **ตอนนี้จะไม่มี Oracle memory ถูกโหลดเลย** — AI ปลายทางได้แค่ตัวข้อความดิบๆ

ถ้าอยากให้ path "โหลด Oracle memory" ทำงานจริง ต้องเปิด HTTP API ที่ port `47778` ขึ้นมาก่อน

---

## 🧠 สรุปเป็นภาพรวม

```
คุณพิมพ์:  maw talk-to john "ข้อความ"
                │
    ┌───────────┴───────────────────────────┐
    ▼                                         ▼
[สเต็ป 1] POST /api/thread              [สเต็ป 2] แทรกเข้า pane ของ john
    │                                         │
    ▼                                         ▼
Oracle server ค้น + โหลด                 john เห็นข้อความใน tmux
principles + patterns                    (ไม่โหลด memory เพิ่ม)
จาก ~/.oracle/oracle.db
+ ~/.oracle/lancedb/
    │
    ▼
👉 "memory ที่ AI โหลด" = ตรงนี้
   (แต่ตอนนี้ล่มเพราะ :47778 ไม่ตอบ)
```

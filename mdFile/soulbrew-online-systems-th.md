# 2 ระบบ "ออนไลน์" ใน soulbrew (ฉบับภาษาไทย)

> สรุป ณ 2026-06-17 — soulbrew มีหลายชั้น แต่ระบบที่ทำงานแบบ **เครือข่าย / client–server (มี server ให้ต่อ)**
> มีอยู่ **2 ตัว** คือ **maw federation** และ **oracle vault (arra-oracle)**
> ground จากคู่มือ `คู่มือ-arra-oracle.md`, `maw-talk-to-memory.md` และโครงสร้าง repo จริงใน `github.com/Soul-Brews-Studio/`

## นิยาม "ออนไลน์" ที่ใช้ในเอกสารนี้

"ออนไลน์" = ระบบที่ **คุยผ่าน network protocol / มี server ให้เชื่อมต่อ** (ไม่ใช่แค่อ่านเขียนไฟล์ในเครื่อง)

- ✅ **ออนไลน์:** maw federation (ข้ามเครื่อง), oracle vault (HTTP server :47778)
- ❌ **ไม่ใช่ออนไลน์ (local ล้วน):** Skills (slash commands), MCP stdio tools, ไฟล์ ψ markdown ดิบ, auto-memory ของ Claude

---

## ระบบที่ 1 — maw federation (ชั้นสื่อสาร/เครือข่าย)

### คืออะไร
ระบบให้ Oracle/agent หลายตัว — แม้อยู่คนละเครื่อง — **คุยกัน, สั่งงานกัน, และ sync กันได้** เป็น "ชั้นโซเชียล + ออร์เคสเตรชัน" ของทั้ง fleet
รันอยู่บน maw server + tmux และเชื่อม peer แบบ peer-to-peer

### ทำงานยังไง
- มี **maw server** เป็นตัวกลาง รับ-ส่งข้อความระหว่าง agent
- แต่ละ Oracle มี identity `[host:handle]` → ข้อความถูก **เซ็นชื่ออัตโนมัติ**
- ปลายทางอยู่เครื่องอื่นได้ → เชื่อมผ่าน **peer** (จับคู่ด้วย `maw pair`, เช็คด้วย `maw ping`)
- ประวัติข้อความเก็บเป็น ledger (SQLite) ดูด้วย `maw messages`
- รายชื่อปลายทางเก็บใน `~/.oracle/contacts.json` (field `maw`, `thread`)

### ฟีเจอร์เด่น
| กลุ่ม | คำสั่ง/ความสามารถ |
|-------|-------------------|
| ส่งข้อความ | `maw hey`, `maw talk-to`, `maw broadcast`, `maw reply`, `maw send` |
| กล่องข้อความ | `maw inbox` (รวมคิวอนุมัติข้ามเครื่อง), `maw messages` (ledger ทั้งหมด) |
| เครือข่ายหลายเครื่อง | `maw ping`, `maw peers`, `maw pair`, `maw discover`, `maw federation` |
| ทะเบียน/ซิงค์ | `maw fleet` (ทะเบียนถาวร), `maw soul-sync` (ซิงค์วิญญาณข้าม node), `maw reunion` (ซิงค์ครอบครัวครั้งใหญ่) |
| ทีม | `maw team`, `maw swarm`, `maw assign <issue> <oracle>` |

### Repo
`github.com/Soul-Brews-Studio/maw-js` (มี src, docs, ui, packages, docker)

---

## ระบบที่ 2 — oracle vault / arra-oracle (ชั้นความรู้/ความจำ)

### คืออะไร
"สมอง" ของ Oracle — ฐานความรู้ที่ index จาก vault `ψ` (ไฟล์ markdown) เข้าเป็นฐานข้อมูลค้นหาได้
เก็บ principles, patterns, learnings, retrospectives, threads

### ทำงานยังไง
- รันเป็น **HTTP server** (`arra-oracle serve`, default port **47778**) → REST API + dashboard
- หรือรันเป็น **MCP stdio server** (`arra-oracle mcp`) ให้ Claude Code ต่อตรง
- ที่เก็บข้อมูลจริงอยู่ใน `~/.oracle/` :
  - `oracle.db` → keyword search (SQLite FTS5) + threads
  - `lancedb/oracle_knowledge.lance` → semantic / vector search
  - `contacts.json` → รายชื่อ (ใช้ร่วมกับ maw)
- env ที่ยืนยัน: `ORACLE_DATA_DIR=/home/chillox-intern/.oracle`

### ฟีเจอร์เด่น (ผ่าน MCP tools `oracle_*`)
| กลุ่ม | ความสามารถ |
|-------|------------|
| ค้นหา | `oracle_search` (hybrid: keyword + vector), `oracle_read`, `oracle_list`, `oracle_concepts` |
| จดจำ | `oracle_learn` (บันทึก learning + index), `oracle_supersede` (แทนที่ของเก่า ไม่ลบ), `oracle_stats` |
| ส่งต่อ session | `oracle_handoff`, `oracle_inbox` |
| กระทู้ (forum) | `oracle_thread`, `oracle_threads`, `oracle_thread_read`, `oracle_thread_update` |
| ตามรอย | `oracle_trace`, `oracle_trace_link`, `oracle_trace_chain` |
| อื่นๆ | `oracle_reflect`, `oracle_verify` (เทียบไฟล์ ψ กับ DB) |

### หลักการ
- **Nothing is Deleted** — เก็บถาวร ไม่ลบ (ใช้ supersede แทน)
- **Patterns Over Intentions** — artifact คือความจริง

### Repo
`github.com/Soul-Brews-Studio/arra-oracle-v3` (มี src, cli, services, web, maw-plugin)

---

## 2 ระบบนี้เชื่อมกันยังไง

ตัวอย่างชัดที่สุดคือคำสั่ง `maw talk-to <ปลายทาง> "ข้อความ"` ซึ่งใช้ **ทั้งสองระบบ** ต่อกัน:

```
maw talk-to john "ข้อความ"
        │
   ┌────┴─────────────────────────────┐
   ▼                                   ▼
[สเต็ป 1] oracle vault               [สเต็ป 2] maw federation
POST http://localhost:47778          แทรกข้อความเข้า tmux pane ของ john
/api/thread                          (maw hey)
   │                                   │
   ▼                                   ▼
Oracle ค้น principles + patterns     john เห็นข้อความ
จาก oracle.db + lancedb              (ไม่โหลด memory เพิ่ม)
= "memory ที่ถูกโหลด"
```

- **สเต็ป 1** ใช้ **oracle vault** (HTTP :47778) → ดึงความจำที่เกี่ยวข้อง
- **สเต็ป 2** ใช้ **maw federation** → ส่งข้อความถึงปลายทาง

---

## ⚠️ สถานะปัจจุบัน (สำคัญ)

ตาม `maw-talk-to-memory.md`: ขณะนั้น HTTP server `:47778` **ล่ม/ไม่ตอบ** (มีแต่ MCP stdio รันอยู่)
ผลคือ `maw talk-to` สเต็ป 1 (ดึง memory จาก vault) จะ fail แล้ว fallback ไปทำแค่สเต็ป 2 (ส่งข้อความดิบ)
ถ้าอยากให้ดึง Oracle memory ได้ ต้องเปิด `arra-oracle serve` ที่ port 47778 ก่อน

---

## สรุปตาราง

| | maw federation | oracle vault (arra-oracle) |
|---|---|---|
| หน้าที่ | สื่อสาร/ออร์เคสเตรชันระหว่าง agent | ฐานความรู้/ความจำ |
| โปรโตคอล | maw server + peer (ข้ามเครื่องได้) | HTTP REST :47778 / MCP stdio |
| ข้อมูลอยู่ที่ | ledger SQLite + contacts.json | `~/.oracle/` (oracle.db + lancedb) |
| repo | `Soul-Brews-Studio/maw-js` | `Soul-Brews-Studio/arra-oracle-v3` |
| "ออนไลน์" แบบไหน | เครือข่ายข้ามเครื่องจริง | client–server บน localhost (+ git sync ψ ขึ้น GitHub) |

> ระบบที่เหลือใน soulbrew (Skills, MCP tools ฝั่ง stdio, ไฟล์ ψ markdown, auto-memory ของ Claude) ทำงาน **local** ไม่นับเป็น "ออนไลน์"

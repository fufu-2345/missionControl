# maw Commands — จัดโซนตามความถี่ใช้จริง (Ch06B)

> อ้างอิงหน้า: https://oracle101.vercel.app/ch06b.html (Oracle 101 — Advanced maw Commands)
> ความถี่วัดจากจำนวนครั้งที่ปรากฏใน Claude Code session logs (`~/.claude/projects/*.jsonl`)
> เกณฑ์: 🔥 บ่อยมาก ≥150 · ✅ บ่อย 50–149 · ➖ นานๆ ครั้ง <50

---

## 🟦 โซน STANDARD (หน้าเพจจัดไว้ 25 ตัว)

| คำสั่ง | ครั้ง | ระดับ | ใช้ทำอะไร |
|---|---|---|---|
| `maw federation status` | 694 | 🔥 | ดูสถานะ multi-node ทั้ง federation (มีกี่ node ออนไลน์) |
| `maw ui` | 352 | 🔥 | เปิด/จัดการ web interface ดู fleet กับ session |
| `maw soul-sync` | 193 | 🔥 | sync ความจำ/memory ระหว่าง Oracle |
| `maw plugin` (init/build/install) | 176 | 🔥 | วงจรชีวิตปลั๊กอิน — สร้าง → build → ติดตั้ง |
| `maw fleet` (ls/health/doctor) | 175 | 🔥 | จัดการ fleet + เช็คสุขภาพ + auto-fix บางส่วน |
| `maw peek` (tmux peek) | 175 | 🔥 | ดูภาพ/หน้าจอ pane แบบ low-level |
| `maw pulse` (add/ls/cleanup) | 135 | 🔥 | ติดตามงานระดับทั้ง fleet (task tracking) |
| `maw kill` | 111 | ✅ | ปิด session/window/pane ที่ระบุ |
| `maw assign` | 88 | ✅ | มอบหมาย GitHub issue ให้ Oracle (`--oracle N`) |
| `maw panes` | 87 | ✅ | ลิสต์ panes พร้อม metadata |
| `maw capture` | 82 | ✅ | ดึง *ข้อความ* จาก pane (ป้อน automation ต่อ — ต่างจาก peek ที่เป็นภาพ) |
| `maw whoami` | 78 | ✅ | บอกว่า session/identity ที่รันอยู่คือใคร |
| `maw about` | 78 | ✅ | แสดง metadata ของ Oracle (role, path, identity) |
| `maw view` (attach/a) | 75 (+attach 179) | ✅ | เข้าดู/สร้าง view ของ agent |
| `maw on` | 67 | ✅ | สร้าง trigger ระดับ session (คู่กับ `--once`/`--timeout`) |
| `maw transport status` | 66 | ✅ | เช็ค transport layer ก่อนคุยข้าม node |
| `maw zoom` | 59 | ✅ | ซูม pane ใน tmux ให้โฟกัสตัวเดียว |
| `maw mega` | 59 | ✅ | ประสานทีม multi-agent งานใหญ่ |
| `maw restart` | 52 | ✅ | รีสตาร์ท maw server |
| `maw overview` (warroom/ov) | 51 | ✅ | dashboard war room |
| `maw check` | 50 | ✅ | audit เครื่องมือ ghq/gh/git/tmux/bun |
| `maw locate` | 49 | ➖ | หา path/session/fleet entry ของ Oracle |
| `maw tag` | 44 | ➖ | ตั้ง metadata ให้ pane เพื่อค้น/จัดกลุ่ม |
| `maw session` | 39 | ➖ | พิมพ์ชื่อ session ปัจจุบัน |
| `maw split` | 38 | ➖ | แยก pane แล้วผูกงานคู่กัน |

---

## 🟨 โซน EXTRA (หน้าเพจจัดไว้ 30 ตัว)

| คำสั่ง | ครั้ง | ระดับ | ใช้ทำอะไร |
|---|---|---|---|
| `maw team` (create/spawn/send) | 3069 | 🔥🔥 | สร้างทีม agent ชั่วคราวทำงานซับซ้อน — **ใช้บ่อยที่สุดในระบบ** |
| `maw inbox` | 1328 | 🔥🔥 | กล่องข้อความของ agent — รับ/ส่ง notes, tasks |
| `maw talk-to` | 152 | 🔥 | คุยแบบ thread ต่อเนื่อง (ค้นย้อนหลังได้) `maw talk-to <name> "msg"` |
| `maw incubate` *(stub)* | 137 | 🔥 | clone repo มา dev → ส่งต่อ `/incubate` |
| `maw broadcast` | 133 | 🔥 | ส่งข้อความหา Oracle ทุกตัวพร้อมกัน |
| `maw doctor` | 129 | 🔥 | ตรวจวินิจฉัย + ซ่อมอัตโนมัติบางส่วน |
| `maw peers` | 101 | ✅ | จัดการ alias ของ peer |
| `maw demo` | 96 | ✅ | รัน session จำลองโดยไม่ต้องมี API key |
| `maw avengers` | 78 | ✅ | ประสานทีมหลายบทบาท (multi-role) |
| `maw workon` | 73 | ✅ | สร้าง worktree + tmux window ไว้เขียนโค้ด |
| `maw pair` | 68 | ✅ | จับคู่ peer แบบ Bluetooth |
| `maw reunion` | 66 | ✅ | สั่ง sync federation |
| `maw cleanup --zombie-agents` | 54 | ✅ | เก็บกวาด pane ซอมบี้/surface ค้าง |
| `maw archive` | 48 | ➖ | ปลด Oracle (soul-sync แล้ว disable) |
| `maw art` (ls/get/write) | 44 | ➖ | จัดการ task artifact |
| `maw completions` | 40 | ➖ | shell completions |
| `maw costs` | 37 | ➖ | ดู token usage ต่อ agent |
| `maw rename` | 34 | ➖ | เปลี่ยนชื่อ tab/agent |
| `maw park` / `maw resume` | 32 / 32 | ➖ | พัก agent โดยเก็บ context / เปิดกลับมา |
| `maw tab` | 31 | ➖ | จัดการ tmux tabs |
| `maw project` *(stub)* | <30 | ➖ | clone/track repo → `/project` |
| `maw learn` *(stub)* | <30 | ➖ | สำรวจ codebase → `/learn` |
| `maw workspace` | <30 | ➖ | จัดการ workspace หลาย node |
| `maw triggers` | <30 | ➖ | ลิสต์ trigger ที่ active |
| `maw pr` | <30 | ➖ | สร้าง/ดู PR จาก branch ปัจจุบัน |
| `maw find "keyword"` | <30 | ➖ | ค้นข้าม fleet + memory |
| `maw consent` | <30 | ➖ | PIN-consent สำหรับ action ข้าม oracle |
| `maw signals` | <30 | ➖ | อ่าน bud/absorb signals |
| `maw cross-team-queue` *(stub)* | <30 | ➖ | inbox รวมข้าม vault (scaffold) |

---

## ⚠️ ข้อสังเกต: การจัดโซนกับการใช้จริงไม่ตรงกัน

- **2 คำสั่งที่ใช้บ่อยที่สุดทั้งระบบ (`team` 3069, `inbox` 1328) อยู่ในโซน Extra** ไม่ใช่ Standard
- Standard หลายตัว (`tag` 44, `session` 39, `split` 38, `locate` 49) ใช้น้อยกว่า Extra หลายตัวมาก
- **ข้อเสนอ:** ถ้าจะให้ "Standard = ใช้บ่อย" ควรเลื่อน `team` / `inbox` / `talk-to` / `broadcast` / `incubate` / `doctor` ขึ้น Standard และดัน `tag` / `session` / `split` / `locate` ลง

## 📌 หมายเหตุ: Core ไม่ได้อยู่บนหน้านี้

คำสั่งที่ใช้หนักจริงๆ หลายตัวไม่ได้อยู่ใน Ch06B เพราะเป็น **Core 12** (จากบท 06):

`serve` 1036 · `swarm` 926 · `hey` 856 · `bud` 1206 · `wake` 630 · `done` 338 · `config` 241

# รัน 2 โปรเจกต์พร้อมกันใน soulbrew/maw ได้ไหม (ฉบับภาษาไทย)

> สรุป ณ 2026-06-22 — ตอบคำถาม "ใช้ soulbrew (เครื่องมือ maw + agent ของเรา) ทำ 2 โปรเจกต์พร้อมกันได้ไหม"
> ground จากไฟล์จริง: `maw-js/docs/teams.md`, `maw-js/docs/codex-team-pattern.md`

---

## คำตอบบรรทัดเดียว

**ได้ — และระบบถูกออกแบบมาเพื่อสิ่งนี้โดยตรง**
สองโปรเจกต์ = สองชุด session ที่ไม่รู้จักกัน รันขนานได้สบาย

---

## ทำไมถึงทำได้

ดู layer stack ของ maw (`docs/teams.md`): ชั้นล่างสุด (**L0**) คือ **tmux** — session / window / pane
ชั้นบนแค่เพิ่ม fleet identity กับ routing เข้าไป
ดังนั้นการรันหลายอย่างพร้อมกัน **ไม่ใช่การแฮก แต่เป็นพื้นฐานของระบบ** — 2 โปรเจกต์ = 2 ชุด session ที่แยกกันอยู่แล้ว

---

## 2 วิธีทำ

### A) สองทีม / สอง charter (วิธี multi-agent ของจริง)

แต่ละโปรเจกต์มี charter YAML ของตัวเอง (`docs/codex-team-pattern.md`)
charter มี `name:` (ชื่อทีม) และ `project:` (repo) — **ตั้งชื่อทีมให้ต่างกัน** แล้ว up ทั้งคู่:

```bash
maw team up expense-sprint     # charter A → project: fufu-2345/expense-tracker
maw team up morse-sprint       # charter B → project: fufu-2345/morse
```

อยู่ร่วมกันได้สะอาดเพราะแต่ละทีมถูกแยกด้วย:
- **tmux session ของตัวเอง** (ชื่อทีมต่าง = session ต่าง)
- **builder แต่ละตัวอยู่ใน git worktree ของตัวเอง** (`agents/1-codex-1/`, …)
- **fleet registry** ที่ track agent ทีละชื่อ

→ เช่น ให้ `jack-oracle` เป็น lead ทีม expense-tracker และ `bob-oracle` เป็น lead ทีม morse พร้อมกันได้ — agent ของเรา, 2 โปรเจกต์

### B) สอง oracle session แบบเบา ๆ

ถ้าไม่ต้องการทีมเต็มต่อโปรเจกต์ แค่ปลุก oracle 2 ตัวเข้า 2 session โปรเจกต์ละตัว:

```bash
maw wake jack-oracle      # ทำ expense-tracker ตรงนี้
maw wake bob-oracle       # ทำ morse ตรงนี้
```

แต่ละตัวเป็น pane/session อิสระ — ดูทั้งคู่ด้วย `maw view <agent>` หรือ `maw panes`

---

## กันไม่ให้ 2 ตัวชนกัน (จุดเดียวที่ต้องตั้งใจ)

| เรื่องที่ต้องระวัง | ทำยังไง |
|---|---|
| **routing/ข้อความข้ามทีม** | ตั้งชื่อทีมให้ต่างกัน; ใช้ `maw scope` (named routing namespace) เพื่อไม่ให้ `maw hey` ของทีม A หลุดไปทีม B |
| **repo path เดียวกัน** | ห้ามชี้ 2 agent ไป working dir เดียวกัน — ให้แต่ละตัวมี **worktree** (`worktree: true` ใน charter) คนละโปรเจกต์อยู่คนละโฟลเดอร์อยู่แล้ว = ปลอดภัย |
| **ไฟล์ root ร่วม (เช่น lockfile)** | retro เตือนไว้: รัน `bun install` จาก repo root เท่านั้น ห้ามรันจาก 2 worktree พร้อมกัน — นี่คือจุดเดียวที่ agent ขนานกันชนกันจริง |
| **API quota** | agent ทุกตัวดึงจาก account/limit เดียวกัน — 2 ทีมเต็มเผา token เร็ว |

---

## สรุป

- **คนละโปรเจกต์ (เคสของเรา): ปลอดภัยและรองรับเต็มที่** → 2 charter แล้ว `maw team up` 2 ครั้ง, หรือแค่ `maw wake` 2 session
- เคสที่ต้องใช้ worktree คือ **โปรเจกต์เดียวกัน โฟลเดอร์เดียวกัน** เท่านั้น — ซึ่ง charter จัดการให้อยู่แล้ว

---

## ตารางสรุปรวม

| คำถาม | คำตอบสั้น |
|---|---|
| รัน 2 โปรเจกต์พร้อมกันได้ไหม | ได้ — ระบบ (tmux L0 + fleet identity) ออกแบบมาเพื่อสิ่งนี้ |
| ทำยังไง | (A) 2 charter ชื่อทีมต่างกัน → `maw team up` 2 ครั้ง หรือ (B) `maw wake` oracle 2 ตัว 2 session |
| แยกกันยังไง | tmux session คนละอัน + worktree คนละอัน + fleet registry track ทีละชื่อ |
| กันชนยังไง | ชื่อทีมต่าง + `maw scope` + worktree + กฎ install จาก root |
| จุดเดียวที่ชนจริง | ไฟล์ root ร่วม (lockfile) + API quota ที่ใช้ account เดียวกัน |

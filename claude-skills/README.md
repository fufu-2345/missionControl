# claude-skills — สำเนา versioned ของ Claude Code skills (ทำมือ)

โฟลเดอร์นี้คือ **ที่เก็บ/backup ของ custom skill** ที่เขียนเอง — ไม่ใช่ตัวที่ Claude รันโดยตรง

## ทำไมต้องมีโฟลเดอร์นี้

Claude Code โหลด skill จาก **`~/.claude/skills/<name>/SKILL.md`** ซึ่งอยู่ **นอก git repo ใดๆ** → ไม่ถูก version, ไม่มี backup, ลบแล้วหาย

→ เลย copy มาเก็บใน repo นี้ (`missionControl` / soulbrew) เป็น **source of truth** ที่ versioned + push ขึ้น GitHub ได้

## โครงสร้าง

```
claude-skills/
├── README.md          ← ไฟล์นี้
├── install.sh         ← ดึง skill ไปวางที่ ~/.claude/skills/ อัตโนมัติ
└── orches/
    └── SKILL.md       ← สำเนา /orches (maw-team orchestration แบบเห็น panes)
```

## วิธีใช้ตอน clone ไปเครื่องใหม่ (สำคัญ)

สำเนาในนี้ **ใช้ตรงๆ ไม่ได้** ต้อง "ดึง file ไปวาง" ที่ `~/.claude/skills/` ก่อน:

**วิธีเร็ว (อัตโนมัติ):**
```bash
bash claude-skills/install.sh
```

**วิธีมือ:**
```bash
mkdir -p ~/.claude/skills/orches
cp claude-skills/orches/SKILL.md ~/.claude/skills/orches/SKILL.md
```

จากนั้น **reload / restart Claude Code** → `/orches` จะขึ้นใน autocomplete

## ⚠️ เรื่อง sync (2 ฝั่ง อย่าให้ drift)

| ฝั่ง | path | บทบาท |
|------|------|--------|
| **live** (Claude โหลดอันนี้) | `~/.claude/skills/orches/SKILL.md` | ตัวที่ทำงานจริง |
| **repo** (versioned) | `claude-skills/orches/SKILL.md` | สำเนา backup ในนี้ |

- แก้ skill แล้ว → **copy live → repo** แล้ว commit (ไม่งั้น 2 ฝั่งไม่ตรงกัน)
  ```bash
  cp ~/.claude/skills/orches/SKILL.md claude-skills/orches/SKILL.md && git add claude-skills && git commit -m "chore(skills): sync orches"
  ```
- หรือแก้ใน repo → `bash claude-skills/install.sh` เพื่อ push กลับเข้า live

## skill ที่เก็บไว้

| skill | ใช้ทำอะไร |
|-------|-----------|
| `/orches` | BUILD orchestration ด้วย maw team แบบเห็น tmux panes — รับ requirement → แตก sprint → spawn worker เป็น claude สดใน worktree → verify/merge → capture เข้า Oracle · ไม่แก้ code maw |

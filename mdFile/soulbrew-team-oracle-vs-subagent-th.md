# soulbrew ใช้ "ทีม" (multi-agent) เมื่อไหร่ + ทำไมบางทีใช้ Oracle บางทีใช้ sub-agent (ฉบับภาษาไทย)

> สรุป ณ 2026-06-25 — ตอบ 2 คำถาม: (1) soulbrew ใช้ "team" แบบ multi-agent เมื่อไหร่
> (2) ทำไมบางงานใช้ **"Oracle agent"** แต่บางงานใช้ **"sub-agent"** แทน
> ground จากไฟล์จริง: `maw-js/docs/teams.md`, `maw-js/docs/codex-team-pattern.md`,
> `maw-js/docs/comparison/team-agents-vs-maw-team.md`, `~/.claude/skills/team-agents/SKILL.md`
> และโน้ตเดิม `soulbrew-online-systems-th.md`, `soulbrew-multi-agent-merge-th.md`

---

## หัวใจสำคัญ (อ่านบรรทัดเดียวจบ)

คำถามนี้ซ่อน agent อยู่ **3 ชนิด ไม่ใช่ 2** — และ soulbrew แยกมันด้วย **2 แกนตั้งฉากกัน**:
*งานอยู่ข้ามรอบ session ไหม?* กับ *งานข้ามเครื่องไหม?* (`teams.md:23-37`, `:41`)

ตัวชี้ขาดจริง ๆ คือ **"ความจำ + ตัวตน"** —
**Oracle** มี vault ความจำ (ψ→DB) และชื่อถาวร; **sub-agent** เป็นมือใช้แล้วทิ้งที่ลืมทุกอย่างเมื่อจบงาน

---

## agent มี 3 ชนิด (จุดที่มักสับสน)

|  | **Oracle agent** | **Team builder** (สมาชิกทีม) | **Sub-agent** |
|---|---|---|---|
| **คืออะไร** | AI peer ถาวรเต็มตัว | *"บทบาท"* ที่ทีมต้องเติม — เป็นได้ **ทั้ง 2 ฝั่ง** | worker ชั่วคราวจาก `Agent` tool |
| **ตัวตน** | `[host:handle]` ถาวร, มี repo ของตัวเอง, อยู่ใน `contacts.json` | สืบทอดจากตัวที่มาเติม | ไม่มีชื่อ ไม่มีที่อยู่ |
| **ความจำ** | ✅ มี vault ψ→DB (`oracle.db` FTS5 + `lancedb`) สะสมข้ามรอบ | — | ❌ ลืมหมดเมื่อจบ |
| **อายุ** | ถาวร; `maw team resume` ปลุกคืนชีพได้ (`teams.md:221`) | — | ตายเมื่อ task คืนค่า |
| **ที่อยู่** | อยู่คนละเครื่องได้ (federation port 3456) | — | in-process รอบนี้เท่านั้น |
| **เกิดด้วย** | `awaken`/`bud`, เข้าทีมด้วย `oracle-invite` | charter field `role:` | `Agent()` หรือ `/team-agents` Tier 3 |
| **คุยด้วย** | `maw hey` / `maw talk-to` | แล้วแต่ตัวที่มาเติม | มีแต่ lead ที่อ่าน report |

> ตัวอย่าง Oracle จริงในเครื่องนี้: `bob`, `jack`, `john`, `mike` (ใน `~/.oracle/contacts.json`)
> — แต่ละตัวเป็น peer อิสระ มี repo + vault ความจำของตัวเอง
> ส่วน sub-agent ไม่มีชื่อ ไม่มี repo ไม่มีความจำ — เกิดมาทำงานชิ้นเดียวแล้วหายไป

---

## คำถามที่ 1 — ใช้ "team" เมื่อไหร่

**team = รูปแบบ lead + builders** ใช้เมื่องาน 1 ก้อนแตกเป็นชิ้นย่อยที่ทำขนานกันได้
จาก charter จริง (`codex-team-pattern.md:24-74`):

- **lead 1 ตัว** (`worktree: false`) — *"dispatch issue, review PR, merge เมื่อเขียว, **ไม่เขียนโค้ดเอง**"* (`:30-35`)
- **builder N ตัว** (`worktree: true`) — แต่ละตัวได้ **worktree + branch + 1 issue ของตัวเอง**

ใช้ team เมื่อ:
- งาน **แตกเป็นคนละไฟล์/คนละ issue** ได้ และอยากให้ merge ไม่ชน
  (เขียนขนาน แต่ **merge เป็นเส้นเดียวผ่าน lead** — กลไกใน `soulbrew-multi-agent-merge-th.md`)
- ถ้างาน **ไม่แตก** → ไม่ต้องตั้งทีม ใช้ `maw bring`/`maw tile` (ผู้ช่วยตัวเดียว) หรือ `maw swarm` (A/B engine) แทน (`teams.md:48-56`)

แต่ "team" เองยังแยกเป็น **2 implementation** — และ **ตรงนี้แหละที่ตัดสินว่าใช้ Oracle หรือ sub-agent** (`comparison/team-agents-vs-maw-team.md`):

```
                  งานอยู่ข้ามรอบ session ไหม?
        ┌──────────── ไม่ ─────────────┬──────────── ใช่ ─────────────┐
        ▼                              ▼                              ▼
   /team-agents (skill)          maw team (local)          maw team + oracle-invite
   อยู่ใน Claude Code session     fleet, resume ได้           ข้ามเครื่อง
   สมาชิก = SUB-AGENT            สมาชิก = subagent           สมาชิกเป็น ORACLE ได้
   ข้าม session ไม่ได้           + reincarnation             peer ข้ามเครื่องเข้าร่วม
```

> **เส้นแบ่งตัวเป็น ๆ (killer differentiator — `comparison:32-33`):**
> `maw team oracle-invite` ดึง **federation Oracle** เข้าทีมได้
> ส่วน `/team-agents` **ทำไม่ได้** — มันสร้างได้แค่ sub-agent ภายใน session เดียว
> เส้นนี้ = *in-session vs cross-oracle* คือคำตอบทั้งหมดของคำถามที่ 2

---

## คำถามที่ 2 — ทำไมบางทีใช้ Oracle บางทีใช้ sub-agent "แทน"

มีคำตอบ **2 ชั้น** — ชั้นที่ 2 คือชั้นที่คนมักมองข้าม

### ชั้นที่ 1 — เลือกโดยตั้งใจ (architectural choice)

ไล่เงื่อนไข ถ้า **"ใช่" ข้อใดข้อหนึ่ง** → เอนไปทาง Oracle:

| งานต้อง... | ใช่ → | ไม่ → |
|---|---|---|
| อยู่ข้าม session / ทำต่อพรุ่งนี้ได้? | **Oracle** (`team resume`, reincarnation) | sub-agent |
| **จำ** / สะสมความรู้ข้ามรอบ? | **Oracle** (vault ψ→DB) | sub-agent (ความจำสั้น) |
| รันบนเครื่องอื่น / เป็น peer ที่ส่งข้อความหาได้? | **Oracle** (federation :3456) | sub-agent (in-process) |
| มีชื่อถาวรให้คนอื่น route หา? | **Oracle** (`contacts.json`) | sub-agent (ไม่มีชื่อ) |
| แค่ fan-out, อ่านเป็นหลัก, ทำครั้งเดียว, รายงานกลับ? | sub-agent (ถูก, เร็ว) | — |

นี่คือเหตุผลที่ charter จริง **ผสมทั้งคู่**: lead มักเป็น **Oracle จริง**
(ถาวร, ถือ context, มีความจำ, *"feed context ให้ agent ที่ context น้อย"* — `codex-team-pattern.md:34`)
ส่วน builder เป็น **engine spawn ชั่วคราว** ใน worktree ใช้แล้วทิ้งจน PR merge เสร็จ
→ **สมองถาวรสั่งงาน มือใช้แล้วทิ้ง**

และกฎ trigger ของ skill เองก็เขียนชัด (`SKILL.md:5`):
*"อย่า trigger สำหรับงาน subagent ธรรมดา (ใช้ Agent tool ตรง ๆ) หรือการคุยข้าม Oracle (ใช้ /talk-to)"*
→ มี 3 ประตู: `Agent()` ธรรมดา · `/team-agents` · `/talk-to` (Oracle)

### ชั้นที่ 2 — ชั้นที่มักลืม: tier อาจถูก "บังคับ" ลดระดับ

ต่อให้เลือก `/team-agents` แล้ว **การที่จะได้ teammate จริงหรือถูกลดเป็น sub-agent ธรรมดา
ตัดสินที่ environment preflight ไม่ใช่ที่ความยากของงาน** (`SKILL.md:93-137`):

```
Tier 1  tmux + framework      ← ดีสุด: split pane, mailbox, worktree
Tier 2  in-process framework  ← มี env+tools แต่ไม่มี tmux
Tier 3  sub-agent ธรรมดา       ← FALLBACK เมื่อ preflight ล้มเหลว
```

Tier 3 จะเกิดเฉพาะเมื่อ: ไม่ได้ตั้ง `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`,
tool `TeamCreate` โหลดไม่ขึ้น, หรือ CLI เก่ากว่า v2.1.32 — skill ย้ำหนัก (`:118`, `:130-137`):

> *"ห้ามเลือก Tier 3 เพราะงาน 'ดูง่าย' หรือ 'read-only' — นั่นเป็นสิทธิ์ผู้ใช้ตัดสิน*
> *Tier 3 คือ **fallback สำหรับ environment ที่พัง ไม่ใช่ optimization**"*

→ ดังนั้น "มันใช้ sub-agent แทน" บางทีหมายถึง *เลือกเอง* (ชั้น 1)
บางทีหมายถึง *environment บังคับลดระดับ* (ชั้น 2 — ไม่มี tmux/env-var/CLI ใหม่พอ)
สองอย่างนี้หน้าตาเหมือนกันจากภายนอก แต่สาเหตุคนละเรื่อง

### ตัวแปรที่ตัดสินอีกตัว — ความต้องการ "ประสานงาน"

- `Agent()` ธรรมดา: sub-agent **รายงานได้แค่ถึง lead** คุยกันเองไม่ได้ ไม่มี task graph (`SKILL.md:124-128`)
- ทันทีที่ worker ต้อง **คุยกันเอง** (task dependency, handoff) → ต้องใช้ framework (Tier 1/2) ไม่ใช่ sub-agent เปล่า
- ค่าใช้จ่าย ถูก→แพง: sub-agent เปล่า < framework `/team-agents` (~3–7× token, `:427`) < Oracle ถาวร (session เต็ม + vault)

---

## สรุปย่อหน้าเดียว

**team** = รูปแบบ lead + builders สำหรับงานที่แตกเป็นชิ้นได้
ส่วนสมาชิกจะเป็น **Oracle** หรือ **sub-agent** ตัดสินด้วยคำถาม *อยู่ข้าม session / ออกนอกเครื่องไหม*:
Oracle = peer ถาวร มีความจำ ข้ามเครื่องได้ (`maw team` + `oracle-invite`);
sub-agent = worker ใช้แล้วทิ้ง ความจำสั้น อยู่ใน session เดียว (`/team-agents` หรือ `Agent()` เปล่า)
และกับดักคือ — ต่อให้ขอ framework เต็ม ถ้าไม่มี env-var / tmux / CLI ใหม่พอ
มันจะถูก **บังคับลดเป็น sub-agent เงียบ ๆ** ซึ่งเป็นอีกเหตุผลที่บางทีเห็น sub-agent "แทน"

---

## ตารางสรุปรวม

| คำถาม | คำตอบสั้น |
|---|---|
| ใช้ "team" เมื่อไหร่ | งานแตกเป็นคนละ issue/ไฟล์ได้ → lead 1 + builder N (worktree) ; ไม่แตก → `tile`/`bring`/`swarm` |
| team มีกี่แบบ | `/team-agents` (in-session, sub-agent) · `maw team` (fleet, resume) · `maw team + oracle-invite` (ข้ามเครื่อง) |
| Oracle ต่างจาก sub-agent ตรงไหน | Oracle = ถาวร + มีความจำ (ψ→DB) + ชื่อถาวร + ข้ามเครื่อง ; sub-agent = ชั่วคราว + ลืมหมด + ไม่มีชื่อ + in-session |
| เลือกยังไง (ชั้น 1) | ต้องจำ/อยู่ข้าม session/ข้ามเครื่อง → Oracle ; fan-out ครั้งเดียวอ่านเป็นหลัก → sub-agent |
| ทำไมบางทีโดน sub-agent ทั้งที่ขอ team (ชั้น 2) | preflight ล้ม (ไม่มี `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` / ไม่มี tmux / CLI < 2.1.32) → บังคับ Tier 3 |
| เส้นแบ่งตัวเป็น ๆ | `oracle-invite` (cross-oracle) ทำได้แค่ `maw team` ; `/team-agents` ได้แค่ sub-agent ใน session เดียว |

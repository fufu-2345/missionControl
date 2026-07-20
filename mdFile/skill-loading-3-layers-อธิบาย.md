# Skill Loading — 3 ชั้น (progressive disclosure) + 2 กลไกที่เราใช้

อัปเดต 2026-07-20 · เอกสารนี้ไว้เปิดอ่านทวนเวลาลืมว่า "ระบบโหลด skill ของเราทำงานยังไง ทำไม skill เยอะแล้ว context ไม่บวม" — เขียนให้อ่านได้ทั้งคนและ AI (session หน้าเปิดอ่านได้)

---

## TL;DR
Skill ยิ่งเยอะ ยิ่งกิน context ของ **ทุก** session (eager). เราแก้ด้วยการโหลดแบบ "เปิดเมื่อใช้" (lazy) แบ่งเป็น **3 ชั้น** + ใช้ **2 กลไก**. หลักการต้นทางมาจาก Hermes.

---

## ปัญหา
Claude Code เอา `name` + `description` ของ **ทุก** skill ใน `~/.claude/skills/` ยัดเข้า system prompt ของ **ทุก session** เสมอ (นี่คือ "eager" — โตแบบ O(N) ตามจำนวน skill). มี skill 50 อัน = จ่าย context ของ 50 อันทุกครั้งที่เปิด session แม้จะใช้จริงแค่ 1-2 อัน.

---

## 3 ชั้น (progressive disclosure)
| ชั้น | คืออะไร | โหลดเมื่อไร | ตัวอย่าง |
|---|---|---|---|
| **L1 สารบัญ** | `name` + `description` ของแต่ละ skill | eager — ทุก session เสมอ | รายการ skill ที่ Claude เห็นตอนเริ่ม |
| **L2 เนื้อ** | `SKILL.md` body (ขั้นตอนเต็ม) | ตอน invoke skill นั้น | เนื้อ /orches-drive ตอนถูกเรียก |
| **L3 reference** | ไฟล์ย่อยที่ body ชี้ไป | on-demand ตอนเข้าเคสจริง (`cat` / `skill_view`) | `references/*.md`, `sprint-doc-template.md` |

หลักคิด: **ยิ่งดันของลงชั้นล่าง = ยิ่งโหลดช้าที่สุด = context พื้นหลังยิ่งเบา** — ของที่นานๆใช้ที ไม่ควรอยู่ชั้นบนที่แบกทุก session/ทุก turn

---

## 2 กลไกที่เราใช้ (คนละชั้นกัน — อย่าสับสน)

### กลไก 1 — skills-mcp : ย้าย "สกิลเย็นทั้งเล่ม" ออกจาก eager  (จัดที่ชั้น L1/L2)
- `~/.claude/skills-mcp/server.py` = MCP server (Python zero-dep) เสิร์ฟสารบัญสกิล "เย็น" แบบ on-demand: `skills_list` (ดูรายการ) → `skill_view` (โหลดเนื้อ)
- สกิล **เย็น** (ไม่เคยถูกเรียกจริง) ย้ายจาก `~/.claude/skills/` → `~/.claude/skills-lib/` → หลุดจาก eager index (L1) = ไม่กิน context ทุก session อีก
- สกิล **ร้อน** (ถูกเรียกจริง เช่น orches-drive, oracle G-SKLL) **คงไว้** `~/.claude/skills/` (eager) — ถ้าย้าย native `Skill()` call จะพัง
- `janitor.py` = กวาดสกิลเย็นอัตโนมัติ (เงื่อนไข: `installer: auto-skill` + 0 invocation ใน transcript + เก่ากว่า 7 วัน) → skills-lib · dry-run default, `--apply` ถึงจะย้ายจริง
- reversal: `~/.claude/skills-lib/.migrated-from-skills.txt` (mv กลับได้)
- สถานะ (2026-07-19): eager 43 / lazy 9
- source of truth: `oracle-autoskills/skills-mcp/` (runtime copy อยู่ `~/.claude/skills-mcp/`)

### กลไก 2 — cold-path extraction : ย้าย "ส่วนเย็นในเล่มเดียว" ลง L3  (จัดที่ชั้น L2/L3)
- สกิล **ร้อน** เล่มเดียว (เช่น orches-drive body ~40K tokens) มีบางส่วนที่ run ปกติ (happy path) ไม่แตะเลย — RESUME reconstruct, RESET, instance-window ฯลฯ — แต่แบกอยู่ใน context ทุก turn
- ยกส่วนพวกนั้นออกไป `references/` โหลดด้วย `cat` เฉพาะตอนเข้าเคสจริง
- 2026-07-20 ทำกับ **orches-drive**: ยก 6 บล็อกเย็น → SKILL.md 610→560 บรรทัด (-6.3%)
- **กติกาเหล็ก: trigger + safety gate ต้องคง inline เสมอ** ย้ายแค่ "ขั้นตอนละเอียด" เท่านั้น
  - เช่น RESUME driver-alive probe / 4.1r destructive-confirm / instance-window no-`--continue` = คง inline
  - VERIFY_CAPPED (เป็น `case` arm ที่ไม่มี `*)` default) **ห้ามย้าย** — ย้ายแล้ว land คืน VERIFY_CAPPED จะไม่มีใครรับ → merge เงียบทั้งที่เทส fail
- reversal: git history (+ backup `.bak-coldpath` ตอนทำ)

---

## เมื่อไรใช้อันไหน
- **สกิลทั้งเล่มไม่เคยถูกเรียก** → กลไก 1 (skills-mcp ย้ายไป skills-lib)
- **สกิลถูกเรียกจริง แต่ body มีส่วนที่นานๆใช้** → กลไก 2 (cold-path extraction ยก section ไป references/)

เปรียบเทียบ: กลไก 1 = จัดว่า "เล่มไหนขึ้นชั้นบน" · กลไก 2 = จัดว่า "หน้าไหนในเล่มที่ขึ้นชั้นบน"

---

## เรื่อง reload
- **ไม่ต้อง reload window** สำหรับ L2/L3 (body + reference อ่านสดตอน invoke/`cat` อยู่แล้ว) → cold-path extraction มีผลกับ run ถัดไปทันที
- **ต้อง reload window** เมื่อแก้ L1 index (ย้ายสกิลเข้า/ออก skills-lib, ปรับ name/description) เพราะ eager index อ่านตอนเริ่ม session

---

## caveat สำคัญ (กันคาดหวังผิด)
prompt cache ทำให้ eager body ที่นิ่ง cache-read เหลือ ~10% ของราคาเต็ม → การลด context แบบนี้ **ไม่แพงเป็นเงินเท่าตัวเลข** ที่เห็น ประโยชน์หลักจริงคือ **context-window โล่งขึ้น** (สำคัญกับ model [1m] ที่ compact ยาก) มากกว่าประหยัดเงิน token ตรงๆ

---

## ที่มา / อ้างอิง
- หลักการ 3 ชั้น + lazy `skills_list`/`skill_view` มาจาก **Hermes** (nousresearch/hermes-agent, ~/.hermes)
- เราพอร์ตมาเป็น **skills-mcp** (กลไก 1) + apply **cold-path extraction** กับสกิลตัวเอง (กลไก 2)
- doc เชิงเทคนิคของ skills-mcp: `oracle-autoskills/skills-mcp/README.md`
- design feature-4 (conditional visibility): `soulbrew/plan2.md`

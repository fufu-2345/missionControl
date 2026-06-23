# หลาย agent โค้ดพร้อมกันใน soulbrew แล้วทำไม merge ไม่ชน (ฉบับภาษาไทย)

> สรุป ณ 2026-06-19 — อธิบายว่า soulbrew (ผ่าน maw-js `team`/`swarm`) ทำยังไงเมื่อ agent เขียนโค้ดเสร็จ
> → review PR → merge แล้ว **ไม่เกิด conflict** ทั้งที่มี agent มากกว่า 1 ตัว
> และตอบคำถามว่า "แบบนี้มี queue ไหม"
> ground จากไฟล์จริง: `maw-js/docs/codex-team-pattern.md`, `maw-js/CONTRIBUTING.md`,
> `maw-js/src/core/message-queue.ts`, `maw-js/src/commands/shared/queue-store.ts`

---

## หัวใจสำคัญ (อ่านบรรทัดเดียวจบ)

**มันไม่ได้ "แก้" conflict เก่ง — มันออกแบบให้ conflict เกิดไม่ได้ตั้งแต่แรก**
ด้วยการ *แยกงานกายภาพ (worktree) → แบ่งงานเชิงตรรกะ (1 agent = 1 issue) → merge ทีละอันโดย lead คนเดียว*

งาน **ขนาน (parallel)** อยู่ที่ขั้น *เขียนโค้ด* — แต่ขั้น **merge ถูกบังคับให้เป็นเส้นเดียว (single-threaded)** เสมอ

---

## ภาพรวม flow

ทุกอย่างขับด้วย **charter** (ไฟล์ YAML ใน `docs/codex-team-pattern.md`) ที่นิยาม 1 ทีม:

- **lead 1 ตัว** (`role: lead`, `worktree: false`) — ตัวออร์เคสเตรชัน
- **builder N ตัว** (`role: builder`, `worktree: true`) — ตัวเขียนโค้ด

กฎสำคัญที่สุดอยู่ใน prompt ของ lead:

> "You dispatch issues, review PRs, merge when green.
> You **NEVER write code yourself** — only dispatch via `maw hey`."
> (ดิสแพตช์ issue, รีวิว PR, merge เมื่อเขียวเท่านั้น — **ไม่เขียนโค้ดเอง** สั่งงานผ่าน `maw hey` อย่างเดียว)

### ลำดับการทำงาน

1. **Dispatch (แจกงาน)** — `maw team up <sprint>` สร้าง builder แต่ละตัวใน **git worktree ของตัวเอง**
   (`agents/1-codex-1/`, `agents/1-codex-2/`, …) บน **branch ของตัวเอง**
   (`fix-2512-codemod`, `fix-2518-ui-state`, …) และผูกกับ **GitHub issue เดียว** ต่อ 1 ตัว

2. **Code (เขียน)** — builder ถูกสั่งว่า
   *"Rebase on alpha, find the failing test, fix it. PRs target alpha. Body must include `Closes #NNNN`."*
   (rebase บน alpha ก่อน → แก้ → เปิด PR เข้า alpha)

3. **Signal done (บอกว่าเสร็จ)** — builder ping หา lead:
   `maw hey mawjs-oracle "done #2512 PR #NNNN"`

4. **Review + merge** — lead รีวิว PR แล้ว
   *"merge only when tests and required checks are green"* — **ทีละอัน ตามลำดับ**

---

## ทำไมถึงไม่ชน — 5 ชั้นป้องกัน

การกัน conflict เป็นเชิง **โครงสร้าง** ไม่ใช่ไปนั่งแก้ทีหลัง:

| ชั้น | กลไก | กันอะไร |
|---|---|---|
| **กายภาพ (Physical)** | แต่ละ agent มี **git worktree** ของตัวเอง (`agents/<n>-<name>/`) — คนละโฟลเดอร์ คนละ `.git/index` คนละ branch pointer | ชนกันที่ working tree |
| **ตรรกะ (Logical)** | 1 issue → 1 agent เท่านั้น (`team reassign` จะ **ลบ worktree เก่า** แล้วสร้างใหม่ `fresh: true` เสมอ) | 2 agent แตะงานเดียวกัน |
| **Branch** | 1 agent = 1 branch ชื่อเฉพาะ | commit ชนกันบน branch ร่วม |
| **ปลายทาง (Target)** | **ทุก PR เข้า `alpha`** (ตาม `CONTRIBUTING.md`) แล้ว lead **merge ทีละอัน** | merge แข่งกันเข้า main พร้อมกัน |
| **ขอบเขต (Scope)** | issue แบ่งงานตาม feature/ไฟล์ — `#2512` แตะคนละไฟล์กับ `#2518` | conflict ระดับเนื้อหาไฟล์ |

**จุดที่เป็น "เวทมนตร์" จริง ๆ คือชั้น ตรรกะ + ขอบเขต + rebase-on-alpha:**
เพราะ builder แต่ละตัวแก้ *คนละ issue* ที่แตะ *คนละไฟล์* และ rebase บน `alpha` ก่อนเริ่ม —
พอ lead merge เรียง PR1 → PR2 → PR3 เข้า `alpha` มันจึงลงสะอาด เพราะไม่มีบรรทัดที่ทับกันให้ชน

---

## "แบบนี้มี queue ไหม" — คำตอบ

**ตรง ๆ: ไม่มี *merge queue* เฉพาะ** (ไม่เหมือน GitHub merge-queue ที่ auto จัดคิว merge PR ให้)
การที่ merge เป็นเส้นเดียวเกิดจาก **lead ตัวเดียว** ค่อย ๆ จัดการ ping `done #NNNN PR #NNNN`
ทีละอัน + มีด่าน "merge เมื่อเขียว" — เป็น **คิวเชิงตรรกะ (implicit queue)** ที่ lead ถือไว้ในหัว
ไม่ใช่ data structure ที่ auto-serialize การ merge git

**แต่** maw มี queue ของจริงอยู่ 2 ตัวที่ชั้น *สื่อสาร/อนุมัติ* (ไม่ใช่ชั้น git merge):

| queue จริง | ไฟล์ | ทำหน้าที่อะไร |
|---|---|---|
| **Message delivery queue** | `src/core/message-queue.ts` | คิวส่งข้อความ agent→agent (เบื้องหลัง `maw hey`) มี state `pending → delivering → delivered/failed`, retry ด้วย `attempts` |
| **Approval / inbox queue** | `src/commands/shared/queue-store.ts` + `maw inbox` | เมื่อ ACL ตอบ `"queue"` ข้อความถูกพักลงดิสก์ `<STATE_DIR>/pending/<ts>-<rand>.json` ให้ **คนกด approve/reject** ทีหลัง (1 ไฟล์ = 1 ข้อความ เพื่อไม่ให้เขียนชนกัน, TTL 30 วัน) |

### สรุปเรื่อง queue
- **คิว merge git** = ❌ ไม่มีตัวจริง → ได้ลำดับเส้นเดียวจาก **pattern "lead คนเดียว merge ทีละอัน"**
- **คิวสื่อสาร/อนุมัติ** = ✅ มีจริง → `message-queue.ts` (ส่งข้อความ) และ `maw inbox` (คิวอนุมัติให้คนรีวิว)

พูดอีกแบบ: **queue มีไว้ที่ชั้นประสานงาน ไม่ใช่ชั้น merge** — การจัดลำดับ merge เป็นคิวที่ lead ถือ ไม่ใช่ระบบ merge queue อัตโนมัติ

---

## ❓ แล้วถ้า agent แก้ "ไฟล์เดียวกัน" ล่ะ — worktree แก้ปัญหานี้จริงไหม?

**คำตอบตรง ๆ: git worktree ไม่ได้กัน conflict ของเนื้อหาไฟล์** — เป็นความเข้าใจผิดที่พบบ่อย
ต้องแยกให้ชัดว่า worktree ช่วยอะไร / ไม่ช่วยอะไร

### worktree ช่วยอะไร
- แต่ละ agent ได้ **working directory ของตัวเอง** (`agents/1-codex-1/`, `agents/1-codex-2/` …) บน branch ของตัวเอง
  (git ถึงขั้น **ห้าม** 2 worktree checkout branch เดียวกัน)
- ตอน *กำลังแก้ไฟล์* การเขียนไฟล์ลงคนละโฟลเดอร์ → **ไม่มี race "2 process เซฟไฟล์เดียวกันพร้อมกัน"**

### worktree ไม่ช่วยอะไร
- `.git` object store ใช้ร่วมกัน — branch เป็นแค่ ref ที่สุดท้ายต้อง merge เข้า `alpha`
  ถ้า 2 branch แก้บรรทัดเดียวกัน → **ก็ conflict ปกติของ git** ตอน merge/rebase
- **ไฟล์ส่วนกลางโดนทับ** — retro ของเขาบันทึกไว้ตรง ๆ (`docs/retrospectives/2026-04-19-shape-a-sprint.md:151`):
  > "multiple agents in parallel doing [`bun install`] produced **conflicting lockfile diffs mid-round**.
  > Rule: install only from the repo root, never from an agent worktree…"
  > (หลาย agent รัน `bun install` พร้อมกัน → lockfile (ไฟล์ root ร่วม) ชนกันกลางรอบ → ต้องตั้งกฎ
  > ห้ามรัน install จาก worktree)

  → เจอปัญหาที่ว่านี้จริง ๆ และ worktree **ไม่ได้ช่วย** — สิ่งที่ช่วยคือ "กฎการทำงาน" ต่างหาก

### แล้วเคสแก้ไฟล์เดียวกันจัดการยังไงจริง ๆ — 4 กลไก เรียงตามลำดับ

1. **เลี่ยง — แบ่งงานตาม issue (happy path)**
   แจก issue ที่แตะคนละไฟล์ — ได้ผลส่วนใหญ่ แต่ไม่เสมอไป

2. **เลื่อนไปแก้ตอน merge ด้วย rebase (กลไกจริง)**
   merge เป็น **เส้นเดียวเข้า `alpha`** + builder ทุกตัวถูกสั่ง *"Rebase on alpha"* (`codex-team-pattern.md:45`)
   ลำดับเมื่อ 2 agent แตะไฟล์เดียวกันจริง:
   - PR ของ agent A merge ก่อน → `alpha` มีของ A แล้ว
   - branch ของ agent B ตกขบวน → B รัน `git rebase alpha` **ใน worktree ตัวเอง**
   - git เล่น commit ของ B ทับบนของ A แล้ว **หยุดที่ hunk ที่ชน**
   - **agent (ซึ่งเป็น LLM) แก้ hunk เอง** — อ่านทั้ง 2 ฝั่ง รวมให้ → force-push → CI รันใหม่ → lead merge เมื่อเขียว

   นี่คือหัวใจ: **conflict ไม่ได้ถูกกัน แต่ถูกโยนให้ agent ที่ตกขบวน** ไปแก้ตอน rebase
   หน้าที่จริงของ worktree ตรงนี้คือ "ให้ที่สะอาด ๆ แยกตัว" ไว้นั่งแก้ conflict
   (เขายัง commit **ทีละไฟล์** ตาม `cross-team-queue-analysis.md:91` เพื่อให้ rebase/แยก PR ทำง่าย)

3. **กฎการทำงานสำหรับไฟล์ที่เลี่ยงไม่ได้**
   lockfile, ไฟล์ generated ฯลฯ ที่ *ทุก* agent ต้องแตะโดยธรรมชาติ — แบ่งไม่ได้ → ตั้งกฎชัด ๆ
   ("install จาก repo root เท่านั้น, worktree รับ `node_modules` ผ่าน bun hoisting")
   กฎพวกนี้ **เรียนรู้จากการเจ็บจริง** — ชนแล้ว retro แล้วเก็บเป็น memory

4. **lead + GitHub คือด่านกั้น**
   GitHub เองปฏิเสธการ merge PR ที่ยังมี conflict; lead *"merge เมื่อเขียวเท่านั้น"* —
   และ retro เตือนว่า *"agent บอก 'เขียวหมดแล้ว' กลายเป็นแค่สมมติฐาน 3 ครั้งในวันเดียว"*
   → lead จึง **verify ด้วย canonical test เอง** ไม่เชื่อคำพูด agent

### สรุปชั้นเดียว
worktree = **แยกตัวตอนเขียน + ที่นั่งแก้ conflict** ไม่ใช่ตัวกัน conflict
การจัดการจริง = *merge เส้นเดียวเข้า alpha + agent ที่ตกขบวน rebase แล้ว LLM แก้ hunk เอง
+ กฎสำหรับไฟล์ส่วนกลาง + lead ที่ไม่เชื่อคำว่า "เขียวแล้ว"*

---

## ข้อควรระวัง (พูดตามตรง)

"ไม่เคยชน" คือ **เป้าหมายการออกแบบที่ได้จากการแบ่งงาน** ไม่ใช่การันตีจาก 3-way merge อัจฉริยะ
ถ้าเผลอแจก 2 agent ให้แตะไฟล์ทับกัน → ก็ยัง conflict ตามปกติของ git
ระบบเลี่ยงด้วยการ:
- แบ่งงานระดับ **issue** (ไม่ใช่ระดับไฟล์ — จึงพึ่งว่า issue ไม่ overlap กันมาก)
- ให้ทุก agent **rebase บน `alpha` ก่อน** (เริ่มจาก state ล่าสุดที่ merge แล้ว)
- บีบทุกอย่างผ่าน **lead ตัวเดียว + branch ปลายทางเดียว (`alpha`) + ด่านเช็คเขียว** → merge ทีละอัน ไม่ขนาน

---

## ตารางสรุป

| ขั้นตอน | ใครทำ | กลไก |
|---|---|---|
| แจกงาน | lead | `maw team up` → worktree + branch + 1 issue ต่อ agent |
| เขียนโค้ด | builder (ขนานกัน) | rebase บน alpha → แก้ → เปิด PR เข้า alpha |
| บอกเสร็จ | builder | `maw hey lead "done #NNNN PR #NNNN"` (ผ่าน message-queue) |
| review + merge | lead (เส้นเดียว) | merge เมื่อ CI เขียว ทีละอัน เข้า alpha |
| คิว | — | merge = คิวเชิงตรรกะที่ lead ถือ; สื่อสาร/อนุมัติ = queue จริง (`message-queue.ts`, `maw inbox`) |

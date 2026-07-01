---
name: orches
description: BUILD orchestration ด้วย maw team แบบเห็น tmux panes + memory ข้าม run. DEFAULT = reincarnation (ใช้ crew oracle ถาวรที่ user เลือก → bring → assign → capture memory → shutdown --merge → รอบหน้าจำได้ เก่งขึ้นเรื่อยๆ). `--ephemeral` = flow เก่า (spawn claude สด → kill, ไม่มี memory). main Claude เป็น orchestrator อ่าน requirement (inline/file/URL) + flow.md → แตก sprint → assign role → verify → merge เข้า main → sprint ถัดไป. ไม่แก้ code maw (ใช้ maw team + tmux + git ล้วน). Use when user says "orches", "แตกงานด้วย maw team", "build แบบเห็น panes", "maw orchestrate", หรือส่ง requirement มาให้ build แบบเห็น agent ทำงานจริง. ต่างจาก /orchestrate (native subagent มองไม่เห็น/sync) — /orches = maw panes มองเห็น/poll-based.
argument-hint: "<requirement: ข้อความ inline / path ไฟล์ / URL> [flow-file] [--ephemeral] [--team <ชื่อ>]"
installer: create-shortcut
created_at: 2026-06-30T02:10:00+00:00
created_session: 7697f746-6261-44cf-9248-472a0aecae6f
---

# /orches

main Claude ทำตัวเป็น **orchestrator** ขับทีม maw team แบบ **เห็น tmux panes**: อ่าน requirement + flow.md → แตกเป็น sprint → มอบงานให้ worker → verify → merge เข้า main → วนจนจบ

**2 โหมด:**
- **DEFAULT = reincarnation** ♻️ — worker = **oracle ถาวรที่ user เลือก** (crew ที่ถูกสร้างไว้แล้ว เช่น `carbon`). ปลุกด้วย `maw team bring` → assign งาน → ปิดงานให้ capture memory เข้า ψ ของตัวเอง → `shutdown --merge`. รอบหน้าใช้ crew เดิม → agent **จำงานเดิม เก่งขึ้นเรื่อยๆ**
- **`--ephemeral`** 🔥 — flow เก่า: `maw team spawn` claude สดใหม่ต่อ role → ทำ → kill ทิ้ง. สะอาด/เร็ว แต่ **ไม่มี memory ข้าม run** (เหมาะ throwaway build)

> ⛔ **กฎข้อแรก — ถามก่อน อย่า assume:** ถ้า invoke มาโดย**ไม่มี requirement** → ถามผู้ใช้ **1 บรรทัดแล้วรอ** ("จะให้ build อะไร?") · **ห้ามสแกน/อ่านไฟล์ใน working dir เอง, ห้ามเดา, ห้ามเสนอ option จากไฟล์ที่เจอ (`req*.md` ฯลฯ), ห้ามเริ่ม Step ใดๆ** จนกว่าผู้ใช้จะตอบ · ทุกการตัดสินใจสำคัญ (ชื่อ/crew/แผน) ถามด้วย **กล่อง choice** แล้วรอ

> **ไม่แก้ code maw เลย** (runtime-verified 2026-06-30): ใช้ `maw team` + `tmux send-keys`/`capture-pane` + `git` ที่มีอยู่แล้ว · ดู [[orchestrate-skill-state]]
> **ต่างจาก /orchestrate:** /orchestrate = native `Agent` (มองไม่เห็น, sync). /orches = maw worker panes (เห็น agent ทำงาน, ต้อง poll)
> **reincarnation ของ maw = agent เกิดใหม่สดทุกครั้ง แต่ "จำ" ผ่าน ψ vault** (learnings/mailbox) — ไม่ใช่ resume session เดิม. crew ที่ bring กลับมาจะโหลด learnings เดิมเข้า context

---

## Step 0: เลือกโหมด + crew (reincarnation)

- อ่าน flag: มี `--ephemeral` → ไปโหมด ephemeral (ดู section ล่างสุด) · ไม่มี → **reincarnation (default)**
- **crew (reincarnation):** ต้องใช้ oracle-team ที่ **มีอยู่แล้ว** (user สร้างไว้) — /orches **ไม่สร้าง oracle เอง ไม่สั่ง `team up` เอง**
  - list ตัวเลือก: `ls ~/.maw/teams/*/oracle-members.json` แล้ว `maw team members <team>` ดูสมาชิก
  - **ถามผู้ใช้ด้วยกล่อง choice** ว่าจะใช้ team ไหน (หรือรับจาก `--team <ชื่อ>`) — เช่นเจอ `carbon`, `oracle-council`
  - ⛔ ถ้าไม่มี oracle-team เลย → บอกผู้ใช้ให้สร้างก่อน (`maw bud <ชื่อ>` แล้ว `maw team oracle-invite`) — **อย่าสร้างให้เอง** เว้นแต่ผู้ใช้สั่ง

## Step 1: รับ requirement (ยืดหยุ่น) + flow

- **requirement** = arg ตัวแรก รับได้ 3 แบบ:
  - **inline text** → ใช้ตรงๆ
  - **path ไฟล์** (เช่น `req2.md`) → `Read` มาก่อน
  - **URL** → `WebFetch` มาก่อน
  - **ไม่ส่ง arg → หยุดแล้วถามทันที** แค่บรรทัดเดียว: "จะให้ build อะไรครับ? (พิมพ์ / ชี้ไฟล์ / วาง URL)" แล้ว**รอ** · ⛔ ห้ามสแกน working dir, ห้ามอ่านไฟล์ใดๆ เอง, ห้ามเดา
- **flow** = arg ตัวสอง (ไม่บังคับ): path ไฟล์อธิบาย "วิธีแบ่งงาน/verify/merge" → `Read` มาแล้ว**ทำตามเป๊ะ** · ไม่ส่ง → ใช้ flow ดีฟอลต์ในไฟล์นี้
- **ถ้าข้อมูลไม่ครบ → ถามก่อน (กล่อง choice):**
  - **ชื่อโปรเจกต์ `<ชื่อ>`** → เสนอชื่อจาก requirement ให้ผู้ใช้ยืนยัน/แก้ (คุม folder `soulbrew/github.com/fufu-2345/projects/<ชื่อ>/`)
  - **crew** (จาก Step 0) ถ้ายังไม่ได้เลือก

## Step 2: ที่ตั้งโปรเจกต์ (no-code folder lock)

- โปรเจกต์ใหม่ใต้ **`soulbrew/github.com/fufu-2345/projects/<ชื่อ>/` เสมอ** (root `/github.com/` ถูก soulbrew git ignore อยู่แล้ว — ไม่ต้องมี .gitignore เพิ่มระดับ folder)
- `git init -b main` + `.gitignore` (`node_modules`, `*.sqlite`, `.env`, build, **`agents/`**, `.worktrees/`, **`.orches-notes.md`**) → scaffold + commit แรกบน main
  > `.orches-notes.md` = note ที่ worker เขียน insight ของตัวเอง (harvest โดย orchestrator) — gitignore ไว้เพื่อไม่ให้ merge ปนเข้าโปรเจกต์
  > ⚠️ `agents/` ต้องอยู่ใน .gitignore (worktree ของ worker งอกใต้ `<project>/agents/<role>`) ไม่งั้น `git add -A` บน main จะ stage worktree เป็น gitlink · เช็ค `git -C <project> check-ignore agents`
- **ห้าม set `charter.project`** → maw ใช้ git repo ของ cwd เป็น base → worktree ลงที่ `<project>/agents/<role>`

## Step 3: ปลุก crew ให้พร้อม (reincarnation — แทน preflight-spawn)

```bash
which claude                                  # engine ต้องมี
tmux has-session -t orches-<ชื่อ> 2>/dev/null || tmux new-session -d -s orches-<ชื่อ>   # 1 session/run
maw team members <team>                       # ยืนยันสมาชิก crew
git -C <project> status --porcelain           # ต้องสะอาดก่อนเริ่ม
```
- **ปลุก crew:** ถ้าสมาชิกยังไม่ live → `maw team bring <team>` (ปลุก oracle-members เข้า session) · ถ้า user ปลุกไว้แล้ว → ใช้เลย
- ยืนยันด้วย `tmux capture-pane` ว่าแต่ละ member เป็น claude สด (ไม่ใช่ bash)
- ⚠️ **ห้าม `maw team up`** (นั่นคือ spawn worker ephemeral จาก charter — คนละอย่างกับ oracle-member) · reincarnation ใช้ `bring` เท่านั้น

## Step 4: แตก requirement → sprint + role (ตาม flow)

- เรียงตาม dependency · **role = โซนไฟล์ที่ไม่ทับกัน** (backend/frontend/tests/ฯลฯ) — มี input/output/acceptance + **path worktree เป๊ะ**
- **assign role → member:** crew เป็น **generalist** → map แต่ละ role ให้ member หนึ่งตัว (ไม่ผูก member กับ tech ตายตัว) · **role มากกว่าจำนวน member → serialize** (member ตัวเดิมทำหลาย role ต่อกันใน sprint นั้น) — บันทึกใน plan

## Step 4.5: ยืนยันแผนก่อนเริ่ม — HARD GATE

โชว์ให้ผู้ใช้ยืนยัน **ก่อนแตะอะไรทั้งสิ้น** (กล่อง choice ถ้ามี option):
- ชื่อโปรเจกต์ + folder + **crew ที่เลือก** (team + สมาชิก)
- รายการ sprint + role + **role→member ที่ assign**
- flow ที่ใช้

→ **ห้ามเริ่มจนกว่าผู้ใช้ ok**

## Step 5: ลูปต่อ sprint (orchestrator ขับเอง)

ต่อ role ใน sprint:

**5.1 worktree (orchestrator คุมชื่อเอง):**
```bash
git -C <project> worktree add agents/<role> -b agents/<role>
```

**5.2 dispatch งานเข้า member ที่ตื่นอยู่ (ไม่ spawn ใหม่):**
```bash
# member = pane/window ของ oracle ที่ bring มา · ส่งงานสดด้วย send-keys (ห้าม `maw team send` = inbox ไม่ inject)
tmux send-keys -t <target-pane-ของ-member> "$(cat <<'P'
[งานใหม่จาก orchestrator] ทำใน worktree absolute path: <project>/agents/<role>  (อย่าเขียนนอก path นี้เด็ดขาด)
งาน: <task + acceptance criteria + โซนไฟล์>
อ้างอิง requirement: <สรุปส่วนที่เกี่ยวกับ role นี้>
เมื่อเสร็จ: (1) เขียน test (2) `git add -A && git commit -m "<role>: <sprint>"` (3) capture memory: เรียก `oracle_learn` + `oracle_trace` (สรุป key decisions + gotcha + project=<ชื่อ>) แล้ว `/rrr` — เพราะ code อยู่คนละ repo กับ ψ ของคุณ auto-hook จะไม่ยิงให้ ต้อง capture เอง (4) เขียน `.orches-notes.md` ที่ root worktree = สรุป 2-4 บรรทัด (5) เขียนไฟล์ `.orches-done` ที่ root worktree
P
)" Enter
```
> pin absolute path เสมอ · ทุก role ที่คนละ member ทำขนานได้

**5.3 poll จนเสร็จ (ไม่มี sync return):**
```bash
while [ ! -f <project>/agents/<role>/.orches-done ]; do sleep 15; tmux capture-pane -t <target-pane> -p | tail -3; done
git -C <project> rev-list --count main..agents/<role>    # > 0 = commit จริง
```
> member หยุดถาม (เห็นใน capture-pane) → `tmux send-keys` ตอบเข้า pane เดิม

**5.4 verify (review gate):** worktree commit จริง (`git -C <project>/agents/<role> status --porcelain` ว่าง) + รัน test/acceptance · ไม่ผ่าน = `send-keys` สั่งแก้เข้า **pane เดิม** ยังไม่ merge

**5.5 merge เข้า main:**
```bash
git -C <project> merge agents/<role> --no-edit
```

**5.6 harvest + ยืนยัน memory ของ member:**
```bash
cat <project>/agents/<role>/.orches-notes.md 2>/dev/null   # สะสมไว้ (orchestrator ใช้ตอนปิด)
```
> เช็ค capture-pane ว่า member เรียก `oracle_learn`/`oracle_trace`/`/rrr` แล้วจริง (ตาม 5.2 ข้อ 3) — ถ้ายัง `send-keys` เตือน

**5.7 ปิด sprint:** เขียน `<project>/docs/sprint-N.md` (สรุป+ผล verify **+ insight ที่ harvest**) → `git -C <project> add -A && commit` checkpoint → cleanup worktree:
```bash
git -C <project> worktree remove agents/<role> --force && git -C <project> branch -d agents/<role>
```
→ sprint ถัดไป (member ยังอยู่ ไม่ต้อง bring ซ้ำ)

## Step 6: ปิดงาน

- ครบทุก sprint → **integration test บน main** + รายงาน (sprint ที่ merge, ผล test, side-effect)
- **push ขึ้น GitHub (บังคับถาม user ก่อน):** หลัง test ผ่าน → ถามผู้ใช้ด้วย **กล่อง choice** (ไม่ใช่ text) ว่าจะ push ขึ้น GitHub เลยไหม
  - **ไม่ →** ข้าม (โปรเจกต์อยู่ local ต่อได้)
  - **เอา →** เช็ค `which gh` ก่อน แล้ว:
    - ยังไม่มี remote (`git -C <project> remote` ว่าง) → ถาม **private/public** (default private) → `gh repo create <ชื่อ> --private --source=<project> --remote=origin --push` (public = `--public`)
    - มี remote แล้ว → `git -C <project> push -u origin main`
  - `gh` ไม่มี / ยังไม่ login → บอกผู้ใช้ให้ `gh auth login` เองก่อนแล้วลองใหม่ (อย่าเดา token / สร้าง repo มั่ว)
- **memory close (reincarnation):** ให้แต่ละ member `/rrr` รอบสุดท้าย (สรุปทั้ง run เข้า ψ ของตัวเอง) → ยืนยันผ่าน capture-pane
- **teardown = `shutdown --merge` (ไม่ kill):**
  ```bash
  maw team shutdown <team> --merge --force    # เก็บ findings/inbox เข้า ψ, ปิด panes; รอบหน้า bring = จำได้
  tmux kill-session -t orches-<ชื่อ>           # ปิด session ของ run นี้
  git -C <project> worktree prune
  ```
  > ⛔ **อย่า kill member by PID** (นั่นคือของโหมด ephemeral) — reincarnation ต้อง `shutdown --merge` เพื่อรักษา memory
- capture เข้า Oracle (Step สุดท้าย)

## Step สุดท้าย (บังคับ): CAPTURE เข้า Oracle (orchestrator)

1. **`oracle_trace`** (เสมอ): `query`=สรุปงาน · `project`=`soulbrew/github.com/fufu-2345/projects/<ชื่อ>` · `scope`=project · `foundFiles`+`matchReason`+`confidence` · `agentCount`/`durationMs`
2. **`oracle_learn`**: บทเรียนเด่นระดับ run (`pattern` multi-line · `project` · `concepts`) — **fold insight ที่ harvest จาก worker (`.orches-notes.md` + commit msg) เข้าด้วย** · (per-member learnings อยู่ใน ψ ของแต่ละ oracle แล้วจาก Step 5.2/6)
> `oracle_learn` อาจขึ้น `embedding: failed` (Ollama ไม่มี bge-m3) — ไม่ร้ายแรง ไฟล์ถูกเขียน + FTS เจอ

---

## โหมด `--ephemeral` (flow เก่า — ไม่มี memory ข้าม run)

ใช้เมื่อสั่ง `/orches ... --ephemeral` — worker เป็น claude สดที่ spawn ใหม่แล้ว kill ทิ้ง (ไม่ใช่ oracle ถาวร) เหมาะ throwaway build. เปลี่ยนจาก default แค่ 4 จุด:

- **Step 0/3 (crew):** ไม่ต้องเลือก team/bring · preflight: `maw team create orches-<ชื่อ> --description "<req สั้นๆ>"` (หรือ reuse + `maw team prune`)
- **Step 5.2 (dispatch):** spawn สดต่อ role แทน send-keys เข้า member เดิม:
  ```bash
  maw team spawn orches-<ชื่อ> <role> --prompt "$(cat <<'P'
  ทำงานใน worktree absolute path: <project>/agents/<role> (อย่าเขียนนอก path นี้)
  งาน: <task + acceptance + โซนไฟล์> · อ้างอิง: <requirement ส่วน role นี้>
  เมื่อเสร็จ: (1) เขียน test (2) commit (3) เขียน `.orches-notes.md` (4) เขียน `.orches-done`
  P
  )" --cwd <project>/agents/<role>
  # จับ path system-prompt-file ที่ spawn พิมพ์ออกมา แล้ว launch เอง:
  tmux new-window -t orches-<ชื่อ> -n <role> -c <project>/agents/<role>
  tmux send-keys -t orches-<ชื่อ>:<role> "claude --dangerously-skip-permissions --model sonnet --system-prompt-file '<path>'" Enter
  sleep 8 && tmux send-keys -t orches-<ชื่อ>:<role> "เริ่มงานตามที่ระบุใน system prompt ได้เลย" Enter   # kickoff บังคับ
  ```
- **Step 5.6 (memory):** worker ไม่มี ψ → มีแค่ harvest `.orches-notes.md` (ไม่มี per-member learn)
- **Step 6 (teardown):** kill แทน shutdown:
  ```bash
  tmux kill-session -t orches-<ชื่อ>
  pgrep -af "teams/orches-<ชื่อ>" | awk '{print $1}' | xargs -r kill   # ⚠️ kill by PID (worker รอด kill-session; ห้าม pkill -f = match shell ตัวเอง)
  maw team delete orches-<ชื่อ>
  git -C <project> worktree prune
  ```
- Step สุดท้าย (Oracle capture โดย orchestrator) — เหมือนกัน (orchestrator เรียก trace/learn รวมของ worker ที่ harvest)

---

## Guardrails (จาก runtime findings — อย่าลืม)

- **reincarnation: crew มาจาก team ที่ user เลือก** (มี oracle-members) — /orches ไม่ bud/สร้างเอง ไม่ `team up`
- **ปลุก crew ด้วย `bring` ไม่ใช่ `up`** (`up` = spawn worker ephemeral จาก charter)
- **dispatch งานสดด้วย `tmux send-keys` เท่านั้น** — `maw team send` เป็น inbox (ไม่ inject เข้า pane)
- **memory ต้อง capture explicit** (reincarnation): member ทำงานใน project repo คนละ repo กับ ψ → auto-hook (post-commit/Stop) ไม่ยิง → สั่ง member เรียก `oracle_learn`/`oracle_trace`/`/rrr` เอง
- **teardown reincarnation = `shutdown --merge`** (รักษา memory) · ephemeral = kill by PID
- **worker prompt ต้อง pin absolute path** ของ worktree เสมอ
- **verify gate ทุก sprint** — ไม่ผ่านไม่ merge / ไม่ไป sprint ถัดไป
- **bge-m3 ยัง fail บน VM นี้** → learnings เก็บได้ + FTS หาเจอ แต่ semantic recall ยังไม่เต็มจนกว่าจะลง bge-m3
- ⚠️ **flow reincarnation ยังไม่ถูก runtime-verify end-to-end** — ครั้งแรกที่รันจริงถือเป็น live-test, ดู capture-pane ใกล้ชิด, ถ้าเจอ gap ที่ต้องแก้ code maw → หยุดแล้วบอก user (ห้ามแก้ code maw)

ARGUMENTS: <requirement: ข้อความ inline / path ไฟล์ / URL — บังคับ> [flow-file: path — ไม่บังคับ] [--ephemeral: ใช้ flow เก่า spawn+kill] [--team <ชื่อ>: ระบุ crew ตรงๆ]

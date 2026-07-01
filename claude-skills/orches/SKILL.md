---
name: orches
description: BUILD orchestration ด้วย maw team แบบเห็น tmux panes — main Claude เป็น orchestrator อ่าน requirement (inline/file/URL) + flow.md(ล็อกวิธี) แล้วแตกเป็น sprint → spawn worker เป็น claude สดใน worktree → kickoff/verify/merge เข้า main → sprint ถัดไป. ไม่แก้ code maw (ใช้ maw team spawn + tmux send-keys + git ล้วน). Use when user says "orches", "แตกงานด้วย maw team", "build แบบเห็น panes", "maw orchestrate", หรือส่ง requirement มาให้ build แบบเห็น agent ทำงานจริง. ต่างจาก /orchestrate (native subagent มองไม่เห็น/sync) — /orches = maw panes มองเห็น/poll-based.
argument-hint: "<requirement: ข้อความ inline / path ไฟล์ / URL> [flow-file]"
installer: create-shortcut
created_at: 2026-06-30T02:10:00+00:00
created_session: 7697f746-6261-44cf-9248-472a0aecae6f
---

# /orches

main Claude ทำตัวเป็น **orchestrator** ขับทีม maw team แบบ **เห็น tmux panes**: อ่าน requirement + flow.md → แตกเป็น sprint → `maw team spawn` worker เป็น claude สดในแต่ละ worktree → ส่งงาน/verify/merge เข้า main → วนจนจบ

> ⛔ **กฎข้อแรก — ถามก่อน อย่า assume:** ถ้า invoke มาโดย**ไม่มี requirement** → ถามผู้ใช้ **1 บรรทัดแล้วรอ** ("จะให้ build อะไร?") · **ห้ามสแกน/อ่านไฟล์ใน working dir เอง, ห้ามเดา, ห้ามเสนอ option จากไฟล์ที่เจอ (`req*.md` ฯลฯ), ห้ามเริ่ม Step ใดๆ** จนกว่าผู้ใช้จะตอบ · ทุกการตัดสินใจสำคัญ (ชื่อ/team/แผน) ต้องผ่านผู้ใช้ก่อน

> **ไม่แก้ code maw เลย** (runtime-verified 2026-06-30): ใช้ `maw team spawn` + `tmux send-keys`/`capture-pane` + `git` ที่มีอยู่แล้ว · ดู [[orchestrate-skill-state]]
> **ต่างจาก /orchestrate:** /orchestrate = native `Agent` (มองไม่เห็น, return sync, reliable). /orches = maw worker panes (เห็น agent ทำงาน, ต้อง poll). เป้าหมาย/โครง sprint เหมือนกัน
> **worker = claude ephemeral** (ใช้ engine `claude` ตัวเดียวกับ oracle แต่ **ไม่ใช่** oracle ถาวรใน fleet · ไม่มี ψ-memory · เกิด-ทำงาน-ตายต่อ sprint = สะอาดสำหรับ build จากศูนย์)

---

## Step 1: รับ requirement (ยืดหยุ่น) + flow

- **requirement** = arg ตัวแรก รับได้ 3 แบบ:
  - **inline text** → ใช้ตรงๆ
  - **path ไฟล์** (เช่น `req2.md`) → `Read` มาก่อน
  - **URL** → `WebFetch` มาก่อน
  - **ไม่ส่ง arg → หยุดแล้วถามทันที** แค่บรรทัดเดียว: "จะให้ build อะไรครับ? (พิมพ์ / ชี้ไฟล์ / วาง URL)" แล้ว**รอ** · ⛔ **ห้ามสแกน working dir, ห้ามอ่านไฟล์ใดๆ เอง (เช่น `req*.md`), ห้ามเดา, ห้ามเสนอ option จากไฟล์ที่เจอ** — ผู้ใช้ยังไม่บอก = ยังไม่ทำอะไรทั้งสิ้น
- **flow** = arg ตัวสอง (ไม่บังคับ): path ไฟล์อธิบาย "วิธีแบ่งงาน/ทำงาน/verify/merge" → `Read` มาแล้ว**ทำตามเป๊ะ** · ไม่ส่ง → ใช้ flow ดีฟอลต์ในไฟล์นี้ (Step 4-5)
- **ถ้าข้อมูลไม่ครบ → ถามก่อน อย่าเดาเอง:**
  - requirement คืออะไร (ถ้าไม่ส่ง arg)
  - **ชื่อโปรเจกต์ `<ชื่อ>`** → เสนอชื่อจาก requirement แล้วให้ผู้ใช้ยืนยัน/แก้ (ชื่อนี้คุม folder `soulbrew/github.com/fufu-2345/projects/<ชื่อ>/` + team `orches-<ชื่อ>`)
  - **team: ถามผู้ใช้** — รัน `maw team list` โชว์ team ที่มี แล้วให้เลือก 1 ใน 3:
    - **สร้างใหม่** (default, แนะนำ): `orches-<ชื่อ>` — สะอาด ไม่ปนงานเดิม
    - **ตั้งชื่อ team เอง** (พิมพ์ชื่อ)
    - **reuse team เดิม** (เลือกจาก list) → ก่อน spawn รัน `maw team prune <team>` เก็บ zombie member เก่าก่อน
    > worker ยัง ephemeral เสมอ (เกิด-ตายต่อ run) — team เป็นแค่ container/namespace ของ manifest+status ไม่ใช่ worker ถาวร

## Step 2: ที่ตั้งโปรเจกต์ (no-code folder lock)

- โปรเจกต์ใหม่ใต้ **`soulbrew/github.com/fufu-2345/projects/<ชื่อ>/` เสมอ** (root `/github.com/` ถูก soulbrew git ignore อยู่แล้ว — ไม่ต้องมี .gitignore เพิ่มระดับ folder)
- `git init -b main` + `.gitignore` (`node_modules`, `*.sqlite`, `.env`, build, **`agents/`**, `.worktrees/`, **`.orches-notes.md`**) → scaffold + commit แรกบน main
  > `.orches-notes.md` = note ที่ worker เขียน insight ของตัวเอง (harvest โดย orchestrator) — gitignore ไว้เพื่อไม่ให้ merge ปนเข้าโปรเจกต์
  > ⚠️ `agents/` ต้องอยู่ใน .gitignore (worktree ของ worker งอกใต้ `<project>/agents/<role>`) ไม่งั้น `git add -A` บน main จะ stage worktree เป็น gitlink · เช็ค `git -C <project> check-ignore agents`
- **ห้าม set `charter.project`** → maw จะใช้ git repo ของ cwd เป็น base → worktree ลงที่ `<project>/agents/<role>` (ไม่ผูก ghq) · spawn ด้วย `--cwd <project>/agents/<role>`

## Step 3: Preflight (บังคับ ก่อน spawn)

```bash
which claude                                  # engine ต้องมี
tmux has-session -t orches-<ชื่อ> 2>/dev/null || tmux new-session -d -s orches-<ชื่อ>   # 1 session/run
maw team create <team> --description "<req สั้นๆ>"   # ถ้าสร้างใหม่ · reuse → ข้าม create แล้ว `maw team prune <team>` แทน
git -C <project> status --porcelain           # ต้องสะอาดก่อนเริ่ม
```

## Step 4: แตก requirement → sprint + role (ตาม flow)

เรียงตาม dependency · **role = โซนไฟล์ที่ไม่ทับกัน** (เช่น backend/frontend/tests/ledger/matching) — หนึ่ง role = หนึ่ง worker, มี input/output/acceptance + **path worktree เป๊ะ**

## Step 4.5: ยืนยันแผนก่อน spawn — HARD GATE

โชว์ให้ผู้ใช้ยืนยัน **ก่อนสร้าง/spawn อะไรทั้งสิ้น**:
- ชื่อโปรเจกต์ + folder `soulbrew/github.com/fufu-2345/projects/<ชื่อ>/` + **team ที่เลือก** (ใหม่ `orches-<ชื่อ>` / ตั้งเอง / reuse เดิม)
- รายการ sprint + role (แต่ละ role ทำอะไร · โซนไฟล์ · acceptance)
- flow ที่ใช้ (ไฟล์ที่ส่งมา หรือ default)

→ **ห้าม spawn จนกว่าผู้ใช้ ok** · งง/อยากปรับ role → คุยให้จบก่อน (เปิด `/brainstorming` ถ้าต้องระดมจริง)

## Step 5: ลูปต่อ sprint (orchestrator ขับเอง)

ต่อ role ใน sprint:

**5.1 worktree (orchestrator คุมชื่อเอง — deterministic):**
```bash
git -C <project> worktree add agents/<role> -b agents/<role>
```

**5.2 spawn worker เป็น claude สดใน worktree (เห็น pane):**
```bash
# เขียน spawn-prompt + ได้คำสั่ง launch (spawn เองไม่ต้อง --exec เพื่อคุม window เอง)
maw team spawn orches-<ชื่อ> <role> \
  --prompt "$(cat <<'P'
ทำงานใน worktree ที่ absolute path: <project>/agents/<role>  (อย่าเขียนนอก path นี้เด็ดขาด)
งาน: <task ของ role นี้ + acceptance criteria + โซนไฟล์>
อ้างอิง requirement: <สรุปส่วนที่เกี่ยวกับ role นี้>
เมื่อเสร็จ: (1) เขียน test (2) `git add -A && git commit -m "<role>: <sprint>"` (3) เขียน `.orches-notes.md` ที่ root worktree = สรุป 2-4 บรรทัด: key decisions ที่เลือก + gotcha/ข้อควรระวังที่เจอ (4) เขียนไฟล์ `.orches-done` ที่ root ของ worktree
P
)" \
  --cwd <project>/agents/<role>
# ↑ พิมพ์ path ของ system-prompt-file + คำสั่ง `claude --system-prompt-file ...` ออกมา — จับ path/คำสั่งนั้น

tmux new-window -t orches-<ชื่อ> -n <role> -c <project>/agents/<role>
tmux send-keys -t orches-<ชื่อ>:<role> "claude --dangerously-skip-permissions --model sonnet --system-prompt-file '<path ที่ spawn พิมพ์ออกมา>'" Enter
```
> ทุก role spawn ขนานได้ (คนละ window/worktree) · workers วิ่งพร้อมกันจริง

**5.3 kickoff (บังคับ — system-prompt-file ไม่ auto-start):**
```bash
sleep 8   # รอ claude TUI boot
tmux capture-pane -t orches-<ชื่อ>:<role> -p | tail -5   # ยืนยันเป็น claude สด ไม่ใช่ bash
tmux send-keys -t orches-<ชื่อ>:<role> "เริ่มงานตามที่ระบุใน system prompt ได้เลย" Enter
```

**5.4 poll จนเสร็จ (ไม่มี sync return — ต้อง poll):**
```bash
# วนเช็ค .orches-done + commit ของ worker
while [ ! -f <project>/agents/<role>/.orches-done ]; do sleep 15; tmux capture-pane -t orches-<ชื่อ>:<role> -p | tail -3; done
git -C <project> rev-list --count main..agents/<role>    # > 0 = commit จริง
```
> ถ้า worker หยุดถามอะไร (เห็นใน capture-pane) → `tmux send-keys` ตอบ/สั่งต่อเข้า pane เดิม

**5.5 verify (review gate):** worktree commit จริง (`git -C <project>/agents/<role> status --porcelain` ว่าง) + รัน test/acceptance · ไม่ผ่าน = `send-keys` สั่งแก้เข้า **pane เดิม** (อย่า spawn ใหม่) ยังไม่ merge

**5.6 merge เข้า main:**
```bash
git -C <project> merge agents/<role> --no-edit    # role แยกโซนไฟล์ → conflict ต่ำ; ชนกัน orchestrator resolve เอง
```

**5.7 harvest insight จาก worker (ก่อนลบ worktree):**
```bash
# .orches-notes.md อยู่ใน worktree (gitignore) → ต้องอ่านก่อน worktree หาย
cat <project>/agents/<role>/.orches-notes.md 2>/dev/null   # ต่อ role — สะสมไว้ใช้ตอน Step สุดท้าย
git -C <project> log agents/<role> --oneline -5            # commit msg = insight เพิ่ม
```
→ เก็บ "key decisions + gotcha" ของแต่ละ worker รวมเป็น list (เอาไป fold เข้า `oracle_learn` ตอนปิดงาน)

**5.8 ปิด sprint:** เขียน `<project>/docs/sprint-N.md` (สรุป+ผล verify **+ insight ที่ harvest มา**) → `git -C <project> add -A && commit` checkpoint → cleanup worktree sprint นี้:
```bash
git -C <project> worktree remove agents/<role> --force && git -C <project> branch -d agents/<role>
```
→ sprint ถัดไป

## Step 6: ปิดงาน

- ครบทุก sprint → **integration test บน main** + รายงาน (sprint ที่ merge, ผล test, side-effect)
- **push ขึ้น GitHub (บังคับถาม user ก่อน):** หลัง test ผ่าน → ถามผู้ใช้ด้วย **กล่อง choice** (ไม่ใช่ text) ว่าจะ push ขึ้น GitHub เลยไหม
  - **ไม่ →** ข้าม (โปรเจกต์อยู่ local ต่อได้)
  - **เอา →** เช็ค `which gh` ก่อน แล้ว:
    - ยังไม่มี remote (`git -C <project> remote` ว่าง) → ถาม **private/public** (default private) → `gh repo create <ชื่อ> --private --source=<project> --remote=origin --push` (public = เปลี่ยน flag เป็น `--public`)
    - มี remote แล้ว → `git -C <project> push -u origin main`
  - `gh` ไม่มี / ยังไม่ login → บอกผู้ใช้ให้ `gh auth login` เองก่อนแล้วลองใหม่ (อย่าเดา token / สร้าง repo มั่ว)
- **teardown (ลำดับสำคัญ):**
  ```bash
  tmux kill-session -t orches-<ชื่อ>                    # ปิด panes
  pgrep -af "teams/orches-<ชื่อ>" | awk '{print $1}' | xargs -r kill   # ⚠️ worker claude รอดจาก kill-session — kill by PID (ห้าม pkill -f = match shell ตัวเอง)
  maw team delete orches-<ชื่อ>
  git -C <project> worktree prune
  ```
- capture เข้า Oracle (ดูข้างล่าง)

## Step สุดท้าย (บังคับ): CAPTURE เข้า Oracle

1. **`oracle_trace`** (เสมอ): `query`=สรุปงาน · `project`=`soulbrew/github.com/fufu-2345/projects/<ชื่อ>` · `scope`=project · `foundFiles`+`matchReason`+`confidence` · `agentCount`/`durationMs`
2. **`oracle_learn`**: บทเรียนเด่น (`pattern` multi-line · `project` · `concepts`) — **fold insight ที่ harvest จาก worker (`.orches-notes.md` + commit msg, จาก Step 5.7) เข้าด้วย** เพื่อให้ "เหตุผล/gotcha ของแต่ละ worker" ไม่หายไปกับ ephemeral worker (orchestrator เรียกครั้งเดียว รวมของตัวเอง + ของ worker)
> `oracle_learn` อาจขึ้น `embedding: failed` (Ollama ไม่มี bge-m3) — ไม่ร้ายแรง ไฟล์ถูกเขียน + FTS เจอ

---

## Guardrails (จาก runtime findings 2026-06-30 — อย่าลืม)

- **kickoff ทุกครั้งหลัง spawn** — `--system-prompt-file` ตั้ง system prompt แต่ worker นั่งรอที่ `❯` จนกว่าจะมี user-turn
- **ห้าม `maw team send <team> <agent>` ดิสแพตช์งานสด** — มันเป็น **inbox send** (รายงาน "✓ sent" แต่ไม่ inject เข้า pane) → ส่งงาน/สั่งแก้ ใช้ **`tmux send-keys`** เท่านั้น
- **worker prompt ต้อง pin absolute path** ของ worktree — ไม่งั้น worker คำนวณ path เองแล้วเขียนไฟล์หลุดออกนอก dir
- **`--exec` ต้องมี `$TMUX`** (รันจากใน tmux) — ถ้ารันจาก shell เปล่า ใช้ pattern spawn(เขียน prompt)→`tmux new-window`+`send-keys` launch (Step 5.2)
- **kill worker claude by PID** ตอน teardown — มันรอดจาก `tmux kill-session`
- **read-only ขนานได้ · งานแตะ state สายเดียวถือ** · worker แต่ละตัว worktree แยก เขียนขนานปลอดภัย (merge เก็บครบ)
- **verify gate ทุก sprint** — ไม่ผ่านไม่ merge / ไม่ไป sprint ถัดไป

ARGUMENTS: <requirement: ข้อความ inline / path ไฟล์ / URL — บังคับ> [flow-file: path อธิบายวิธีแบ่งงาน — ไม่บังคับ]

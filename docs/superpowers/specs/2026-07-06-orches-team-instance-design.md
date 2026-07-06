# /orches Team-Instance — 1 session = 1 ทีม (ของ run เดียว), ทีม = template, memory ไม่ชน

_2026-07-06 · design spec · scope: orches-skills (orches + orches-drive SKILL.md) + missionControl extension (บางส่วน BLOCKED) · ไม่แก้ code maw_

> เอกสารนี้เขียนให้ AI/คนอื่นทำต่อได้โดยไม่ต้องมี context เดิม — ข้อเท็จจริงทุกข้อ verify กับโค้ด/เครื่องจริงแล้ว (อ้าง file:line)

## โมเดล (คำ user โดยตรง)

- **1 session = 1 ทีม (ของ run เดียว)** — `/orches` เรียก orchestrator ก่อนเสมอ = **ผู้อยู่คนแรกของ session** · oracle ใดๆ ที่ถูกปลุกในบริบทของ run นี้ **ต้องถูกดึงเข้า session นี้ทั้งหมด**
- **ทีม = template** — หลาย project เรียกทีมเดียวกันซ้ำได้ (brew ทำ sci-calc, v4, missionControl) · แต่ละ run = **instance** ของ template แยกขาดจากกัน: ไม่ใช่ twin, ไม่โยงกับ project อื่น
- **ข้อบังคับเดียวที่ต้องรับประกัน: save memory ห้ามชนกันแล้วพัง** (user scope ไว้แค่นี้ — ไม่ต้อง isolate ψ เต็มรูป)

## ศัพท์

| คำ | ความหมาย |
|---|---|
| **template (ทีม)** | roster ใน `~/.maw/teams/<team>/oracle-members.json` — ใครบ้าง role อะไร |
| **instance (ทีมของ run)** | tmux session 1 อัน ที่ orchestrator + workers ของ run นั้นอาศัย · เกิด-ตายพร้อม run |
| **oracle ตัวจริง** | repo ของ oracle (`bob-oracle/` + ψ) — มีชุดเดียวในเครื่อง แชร์ระหว่างทุก instance |
| **instance window** | claude **บทสนทนาใหม่** (fresh) ของ oracle ที่กำลังถูก run อื่นใช้อยู่ — เปิดเป็น window ใน session ของเรา |

## ข้อเท็จจริงที่ verify แล้ว (ฐานของดีไซน์)

1. **reincarnation = โหลด ψ ไม่ใช่ resume บทสนทนา** — maw agent เกิด fresh เสมอแล้วอ่าน ψ (runtime-verified 2026-06-30) → บทสนทนาใหม่ไม่เสีย memory
2. **`maw wake <o> --session X`** = pin แข็ง: เข้า/สร้าง X ตามชื่อเป๊ะ, window ชื่อ `<o>`, bypass การเดา session (wake-cmd.ts:1262-1300) · **แต่** ถ้า cwd ของ oracle มีบทสนทนาเก่า มัน launch ด้วย `--continue` (wake-cmd.ts:1738-1741 `claudeCwdHasNoConversation`) → **ห้ามใช้กับ oracle ที่ live อยู่ใน run อื่น** (จะ resume/ชนบทสนทนาของ run นั้น)
3. **claude conversation ถูก key ด้วย cwd** — 2 claude fresh ใน cwd เดียว = 2 บทสนทนาแยกกัน ไม่ชน (ชนเฉพาะ `--continue` ที่ไป resume ตัวล่าสุด)
4. **memory store กลาง `~/.oracle/oracle.db` = sqlite WAL** (verified `pragma journal_mode`=wal) → concurrent insert จากหลาย process ปลอดภัย · lancedb เขียนผ่าน MCP server ต่อ process
5. **ψ ไฟล์ = timestamped path**: `ψ/memory/retrospectives/YYYY-MM/DD/HH.MM_<slug>.md` (ดูของจริงใน bob-oracle) → clobber ได้เฉพาะ "นาทีเดียวกัน + slug เดียวกัน"
6. tmux 3.4: `set-option -t "=name"` ใช้ `=` ไม่ได้ (ตี literal) — ใช้ `set -t "$SELF"` เปล่าๆ · `has-session`/`list-windows` ใช้ `=` ได้
7. maw มินต์ session `NN-<oracle>` เมื่อ bare wake (chooseWakeSessionName, wake-cmd.ts:981-994) — เลี่ยงด้วย `--session` เสมอ

## กติกา Memory กันชน (หัวใจ — 5 ข้อ)

ให้ orchestrator ใส่ลง dispatch prompt ของ worker ทุกตัว (และทำเองตอน capture ของตัวเอง):

1. **ทุก capture แท็ก provenance**: `oracle_learn`/`oracle_trace` ใส่ `project=<ชื่อ project>` + ขึ้นต้น summary ด้วย `[<session>]` (เช่น `[09-foreman-2]`) → แยก run ได้เสมอแม้ oracle เดียวกันรัน 2 instance
2. **slug/หัวเรื่องของ retro (`/rrr`) ต้องมีชื่อ project** (เช่น `sci-calc-backend-sprint1`) → ชื่อไฟล์ ψ ไม่มีทางชนข้าม project (ต่อให้เขียนนาทีเดียวกัน)
3. **ไฟล์ ψ ที่แชร์/mutable (`ψ/inbox/pending-rrr.md`, inbox ฯลฯ) = append เท่านั้น** — ห้ามเขียนทับทั้งไฟล์
4. **ห้ามแก้/ลบไฟล์ ψ เดิม** จาก instance — เขียนไฟล์ใหม่เท่านั้น (timestamped อยู่แล้ว)
5. **เขียน DB ผ่าน MCP (oracle_learn/trace) เท่านั้น** — ห้ามแตะ oracle.db ตรง (WAL จัดคิวให้เฉพาะการเขียนผ่าน sqlite ปกติ)

→ ด้วย 5 ข้อนี้ การรัน 2+ instance ของ template เดียวกันพร้อมกัน **ไม่มีทางทำ memory พัง**: DB append ผ่าน WAL, ไฟล์ใหม่เสมอ+ชื่อไม่ชน, ไฟล์แชร์ append-only, ทุกก้อนติดป้ายว่ามาจาก run ไหน

## Flow ใหม่

### A. `/orches` bootstrap (แชทรัน) — launch orchestrator เดี่ยว ไม่ bring ทั้งทีม

เดิม: `maw team bring <team>` → **ทั้งทีมกลายเป็น window ใน session ของแชท** (ผิดโมเดล: orchestrator ไม่ใช่ผู้อยู่คนแรก + ทีมไปกองใน session แชท) + ต้องทำ grouped-session hack เพื่อ attach

ใหม่:
1. เลือก team (template) + orchestrator (role:orchestrator) — เหมือนเดิม
2. **สร้าง session เฉพาะของ run + launch orchestrator fresh เป็นผู้อยู่คนแรก**:
   ```bash
   ORC=<orchestrator>; ORC_REPO=<path จาก oracles.json>
   SES="$(python3 -c "import json;print(json.load(open('$HOME/.config/maw/maw.config.50.json')).get('sessions',{}).get('$ORC',''))" 2>/dev/null)"
   [ -z "$SES" ] && SES="claude-$ORC"
   # instance ถัดไปถ้าชื่อถูกใช้อยู่ (run อื่น live): -2, -3, …
   BASE="$SES"; N=2; while tmux has-session -t "=$SES" 2>/dev/null; do SES="$BASE-$N"; N=$((N+1)); done
   tmux new-session -d -s "$SES" -n "$ORC-oracle" -c "$ORC_REPO"
   tmux send-keys -t "$SES" "claude --dangerously-skip-permissions '<kickoff: คุณคือ orchestrator ชื่อ $ORC ของทีม <team> …>'" Enter
   ```
   - **fresh เสมอ** (ห้าม `--continue`/`maw wake -p`) — reincarnation มาจาก ψ ไม่ใช่บทสนทนา
   - ชื่อ session ดิบ = unique id เท่านั้น (จอแสดงใช้ `@orches_label` = `<project> / <team>` อยู่แล้ว)
3. attach user เข้า session นั้นตรงๆ (`tmux attach -t "=$SES"`) — **ไม่ต้อง grouped-session อีกแล้ว** เพราะ orchestrator ไม่ได้อยู่ใน session ของแชท
4. แชทถอย — workers เป็นหน้าที่ orchestrator (Step 3.5 ของ orches-drive) **bootstrap ไม่ปลุก worker เลย**

กันชนเดิม ("worker live อยู่ → ให้เลือกทีมอื่น") **ตัดทิ้ง** — instance model จัดการเองใน orches-drive

### B. `/orches-drive` Step 3.5 — resolve worker (ladder ใหม่)

`SELF` = session ของ orchestrator (`tmux display-message -p -t "$TMUX_PANE" '#{session_name}'`)

| สภาพ worker | ทำอะไร |
|---|---|
| มี window ใน `$SELF` แล้ว | ใช้ pane เดิม (ห้าม wake ซ้ำ) |
| ไม่ live ที่ไหนเลย | `maw wake <w> --session "$SELF"` (reincarnate ψ, window ชื่อ `<w>`) |
| **live อยู่ใน session อื่น** (run อื่นใช้) | **ห้ามแตะ/ห้ามดึง pane ข้าม session · ห้าม `maw wake` ซ้ำ** (จะ `--continue` ชนบทสนทนา run นั้น) → **เปิด instance window ใน `$SELF`**: `tmux new-window -t "=$SELF" -n "<w>" -c "<repo ของ w>"` + `send-keys "claude" Enter` (fresh) → dispatch ปกติ · (ถ้ามี worker อื่นใน crew ที่ยังไม่ตื่น จะสลับ role ให้คนนั้นแทนก็ได้ — ถูกกว่า) |
| เปิดไม่ได้/ผิดปกติ | หยุด รายงาน user |

- role > จำนวน worker ใน run เดียวกัน = serialize ตามเดิม (คิวใน run ตัวเอง)
- teardown ตอนจบ run: ปิดเฉพาะ window ใน `$SELF` (`kill-window`) หลัง capture ครบ — ห้าม kill session อื่น/oracle ตัวจริงของ run อื่น

### C. Dispatch prompt (Step 4.2) — เพิ่มกติกา memory

เพิ่มในข้อ capture ของ prompt: `แท็กทุก capture ด้วย "[<session>]" + project=<ชื่อ> · slug ของ /rrr ต้องมีชื่อ project · ไฟล์ ψ ที่แชร์ append เท่านั้น ห้ามเขียนทับ/แก้ไฟล์เดิม` (= กติกา 5 ข้อฉบับย่อ)

### D. Extension (missionControl) — ⛔ BLOCKED: `startOrchestrator.ts` มี uncommitted project-star ของ user — **ห้ามแตะจน land**

พอปลดบล็อก ให้แก้ `launchOrchestrator`:
- **ตัด modal "งานนี้จะให้ทำที่ไหน" ทิ้ง** (ตัดแนวคิด twin/inject ออก) · พฤติกรรม deterministic:
  - **mode=resume(project)**: `meta.session` live → attach เข้า session นั้น (มี `attachToProject` อยู่แล้ว) · ไม่ live → สร้าง instance session ใหม่ + RESUME kickoff (fresh)
  - **mode=new**: สร้าง instance session ใหม่เสมอ (pin ว่าง → pin · ไม่ว่าง → `-2,-3,…` ตามสูตร bootstrap ข้อ A) — ไม่ถาม
- ตอน launch/attach: `tmux set -t "<SES>" @orches_label "<project> / <team>"` (ห้าม `=` prefix — tmux 3.4)
- `nextTwinSession`/`twinKickoffNote` → ใช้เป็นตัวตั้งชื่อ instance ได้ แต่ **เนื้อหา kickoff twin-note เดิม (แท็ก ψ) ยังถูกต้อง — เก็บสาระ เปลี่ยนคำจาก "twin" เป็น "instance"**

## สิ่งที่ทำแล้ว vs เหลือ (สถานะ ณ 2026-07-06)

- ✅ session-pin (`maw wake --session $SELF`) — orches-drive commit 5df3eda
- ✅ label `<project> / <team>` dashboard + tmux status bar (`@orches_label`) — missionControl 87ca172/4e2a132/5c26321, orches-drive d09cdd8 (RESUME Step 0)
- ✅ ตัด worker-twin เดิม — orches-drive 88d0182
- ✅/⏳ **spec นี้** + แก้ orches-drive Step 3.5 เป็น instance-ladder + memory-กติกา + แก้ orches bootstrap เป็น launch-เดี่ยว (ดู commit ล่าสุดของ orches-skills — ถ้ายังไม่มี = ทำตาม B, C, A ข้างบน)
- ✅ **extension (ข้อ D) — ทำแล้ว 2026-07-06 (แต่ยัง uncommitted โดยเจตนา)**: `launchOrchestrator` (startOrchestrator.ts) ตัด modal ทิ้ง · resume ที่ project live → `attachToProject()` return เลย · base session ไม่ว่าง → instance session `base-N` (ไม่ถาม) · `twinKickoffNote`/doc-comment เปลี่ยนคำ twin→instance + กติกา memory · **ไม่แตะ startOrchestrator.ts commit** เพราะไฟล์นี้มี project-star ของ user ค้าง → part D นั่งรวมใน working tree ให้ user commit พร้อม project-star ผ่านปุ่ม (หรือ surgical-split ถ้าต้องการ) · compile ผ่านทั้ง tree · **หมายเหตุ:** `inject` เหลือเป็น dead branch (always false) ไม่ error — ลบทีหลังได้ตอน project-star land · **skip @orches_label-at-launch** (launch เป็น async ใน terminal → set จะ race; skill Step 0 ของ orchestrator set ให้เชื่อถือได้ทุก path อยู่แล้ว)
- 🔭 ไม่บังคับ/ทีหลัง: ตั้งชื่อ session ดิบตาม project (`orches-<project>`) แทน `NN-<orch>-K` — ทำได้เพราะ `--session` สร้างชื่อ verbatim แต่ต้องเช็คทุกจุดที่ resolve session จาก pin ก่อน

## วิธี verify (สำหรับคนทำต่อ)

1. **instance window fresh จริง**: เปิด 2 run ที่ใช้ template เดียวกัน → session ที่สอง window `<w>` ต้องเป็นบทสนทนาใหม่ (ไม่มี history ของ run แรก) — ดู `claude` ใน pane ไม่ใช่ `claude --continue`
2. **memory ไม่ชน**: ให้ 2 instance ของ oracle เดียวกัน `oracle_learn` + `/rrr` ใกล้เวลากัน → ไฟล์ ψ ใหม่ 2 ไฟล์ (ชื่อไม่ชน) + rows ใน oracle.db ครบทั้งคู่ + summary มี `[<session>]` คนละอัน
3. **1 session = 1 team**: `tmux list-windows -t <SES>` เห็น orchestrator (window 0) + workers ของ run นั้นครบ ไม่มีของ run อื่น · ไม่มี session `NN-<worker>` งอกใหม่
4. **bootstrap**: รัน /orches ใหม่ → ได้ session ใหม่ที่ orchestrator เป็น window แรก, แชทไม่มี window ทีมงอก

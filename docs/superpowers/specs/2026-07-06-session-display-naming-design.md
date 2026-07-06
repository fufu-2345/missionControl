# Session Display Naming — label `project-team` ข้าม dashboard + tmux status bar

_2026-07-06 · design spec · scope: missionControl extension + orches-drive skill + ~/.tmux.conf_

## ปัญหา

ทุกที่ที่โชว์ชื่อ session ตอนนี้ = **ชื่อ tmux ดิบ** (`09-foreman`, `05-bob`, …) ซึ่งเป็นชื่อ oracle ตัวแรก/orchestrator ที่ maw ตั้งให้ (`NN-<oracle>`) → **มองไม่ออกว่า session นั้นกำลังทำ project ไหนอยู่**

ต้องการ: session ที่กำลังทำ project (ผ่าน /orches) ให้แสดงเป็น **`<project> / <team>`** (เช่น `scientific-calculator / brew`) ทั้งใน (1) missionControl dashboard และ (2) tmux status bar (มุมล่างซ้าย)

## โมเดล (ตกลงกับ user แล้ว)

- **team = แม่แบบ/preset** — spec ว่า spawn oracle ไหน role อะไรตอน `maw team` · roster ทับกัน/ซ้ำได้ (brew ≡ carbon) เป็นเรื่องปกติ (มีหลาย preset) · **ไม่ใช่ identity ของ session**
- **session ผูกกับ project** (สำหรับ /orches) ไม่ผูกกับ team
- **oracle = agent จริง** (มี 5 ตัว) · 1 ตัว = claude สด 1 · twin = บทสนทนาที่ 2 ของ oracle เดิม (ψ ก้อนเดียว)

## Goals

1. session ที่ทำ project → label **`<project> / <team>`** บน **(a)** dashboard Sessions panel **(b)** tmux status bar
2. session ปลุก oracle เดี่ยว → **`<oracle>`** (หรือ `<team> / <oracle>` ถ้า oracle นั้นสังกัดทีม)
3. session อื่นๆ → **ชื่อ tmux ดิบ** (ไม่เปลี่ยน)
4. **ไม่ rename tmux session จริง / ไม่แก้ code maw** — ชื่อจริงยังเป็น `09-foreman` (attach / maw fleet / session-pin `--session "$SELF"` ไม่พัง) · label เป็น **display-only overlay**

## Non-goals

- เคส "team run" (label = ชื่อทีมเฉยๆ) — user ตัดออก จัดการเอง
- rename session จริง หรือแก้ maw source
- เคลียร์ทีมซ้ำ (brew/carbon) — user เก็บไว้เป็น preset

## แหล่งความจริงเดียว: tmux user-option `@orches_label`

ตัวที่ "รู้" ว่า (session, project, team) คู่กันยังไง = ตัวที่ launch/ขับ run นั้น → ให้มันบันทึก label แบบ authoritative ลง tmux user-option ของ session ตัวเอง แล้ว **ทั้งสอง surface อ่านตัวเดียวกัน**

- **เขียน:** `tmux set -t "<session>" @orches_label "<project> / <team>"`
  - **extension** (`launchOrchestrator`) ตอน launch orchestrator ให้ project หนึ่ง (มี project + team อยู่แล้ว) — ครอบเคสปุ่ม/bootstrap
  - **/orches-drive** ตอนเริ่ม run (Step ~4.0 หลัง resolve `$PROJ` + team) — ครอบเคสเริ่มจาก terminal + refresh ให้ตรงถ้า project เปลี่ยน
- **อ่าน:**
  - tmux status bar: format string `#{?@orches_label,#{@orches_label},#S}` (มี label→โชว์ label, ไม่มี→ชื่อ session)
  - dashboard: `tmux list-sessions -F "...#{@orches_label}"` — ได้มาใน call เดียว ไม่ต้องอ่านไฟล์
- **persistence:** tmux option หายเมื่อ tmux server restart → dashboard มี fallback (ดู detection ล่าง) · `.orches-meta.json` (มี field team อยู่แล้ว) เป็น marker สำรองบนดิสก์ · (option: re-set `@orches_label` จาก meta ตอน reconnect — รายละเอียดใน plan)
- **clear:** ตอน teardown/จบ run (optional, priority ต่ำ — ถ้า session ถูก reuse label เก่าจะถูก orchestrator เขียนทับตอน run ใหม่อยู่แล้ว)

เหตุผลที่ใช้ tmux user-option: tmux อ่านเองได้ native ทั้ง status bar (format) และ dashboard (`list-sessions -F`) → ไม่ต้อง shell-out ต่อ refresh, ไม่ต้อง rename

## Label rules (priority) — dashboard

1. `@orches_label` ถูก set → ใช้เลย (authoritative)
2. else **cwd-scan:** มี pane ใน session ที่ cwd อยู่ใต้ `.../projects/<name>(/...)` → project=`<name>`; team จาก `<name>/.orches-meta.json`.team → `<project> / <team>` (ไม่มี meta = โชว์ `<project>` เฉยๆ) · [เชื่อถือได้เมื่อ worker อยู่ session เดียวกับ orchestrator = ผลของ session-pin fix 5df3eda]
3. else **lone-oracle:** session มี 1 window ที่ map เป็น oracle ที่รู้จัก (จาก `oracles.json` / ชื่อ `NN-<oracle>`) → `<oracle>` · หรือ `<team> / <oracle>` ถ้า oracle ∈ ทีม (เอาทีมแรกแบบ deterministic เรียงชื่อ)
4. else → **ชื่อ tmux ดิบ `s.name`**

tmux status bar ใช้แค่ rule 1 (option) ไม่งั้น `#S` — cwd-scan ทำใน format string ไม่ได้ แต่ orchestrator set option ให้ทุก project run อยู่แล้ว จึงครบ

## Format

- **`<project> / <team>`** separator = ` / ` (space-slash-space, user เลือก — อ่านง่ายกว่า hyphen เพราะชื่อ project มี hyphen อยู่แล้ว) เช่น `scientific-calculator / brew` · label เป็น display-only ไม่ได้ใช้เป็นชื่อ session จริง → มี ` / ` ปลอดภัย (attach ยิงด้วย `s.name` ดิบ)
- **dashboard:** label = ข้อความหลัก (`.sname`) · ชื่อ tmux ดิบ (`09-foreman`) ย้ายไป subtitle เล็กๆ ไว้อ้างอิง/attach · **attach/kill ยังยิงด้วย `s.name` จริง** (ไม่เปลี่ยน)
- **status bar:** โชว์ label · ชื่อจริงหาได้จาก `tmux display -p '#S'`

## จุดที่ต้องแก้ (3 surface, 1 source)

### 1. orches-skills — `skills/orches-drive/SKILL.md`
ตอนเริ่ม run (Step ~4.0 หลัง guard `$PROJ`): เพิ่ม ~2 บรรทัด
```bash
TEAM="$(python3 -c "import json;print(json.load(open('$PROJ/.orches-meta.json')).get('team',''))" 2>/dev/null)"
tmux set -t "=$SELF" @orches_label "$(basename "$PROJ")${TEAM:+ / $TEAM}"
```
(team จาก `.orches-meta.json` ที่มีอยู่ หรือจาก launch context)

### 2. missionControl extension
- **`commands/startOrchestrator.ts` `launchOrchestrator`:** หลังสร้าง/หา session → `tmux set -t "=<session>" @orches_label "<project> / <team>"` (มี project+team ในมืออยู่แล้ว)
- **`webview/sessions.ts`:** เพิ่ม pure `computeSessionLabel(session, ctx)` (ไม่ import vscode → unit-test `bun test` ตามแพทเทิร์นไฟล์นี้) · `ctx = { orchesLabel, panePaths, projectMetas, teamRosters, knownOracles }` · เพิ่ม field `orchesLabel?` + `label?` ใน interface `TmuxSession`
- **`webview/dashboard.ts`:**
  - `TMUX_FMT` เพิ่ม `\t#{@orches_label}` → parse เข้า `orchesLabel`
  - `pushSessions`: `tmux list-panes -a -F '#{session_name}\t#{pane_current_path}'` (1 call) group by session → panePaths · อ่าน project metas/team rosters/oracles (reuse `parseOrchesMeta`/`readMeta`/`parseTeamRoster`/`parseOraclePath`) · `computeSessionLabel` → set `s.label` → post
  - `renderSessions` (client): `.sname` = `s.label || s.name` · subtitle เพิ่มชื่อ tmux ดิบถ้า label ≠ name · `data-name` คง `s.name`

### 3. `~/.tmux.conf` (บรรทัด 19-20)
```
set -g status-left-length 60          # เดิม 40 — เผื่อชื่อยาว
set -g status-left "#[bg=colour110,fg=colour236,bold] #{?@orches_label,#{@orches_label},#S} #[bg=colour236,fg=colour110] "
```
non-project session ไม่มี `@orches_label` → fallback `#S` → ไม่เปลี่ยน (ปลอดภัย)

## Edge cases

- **@orches_label ค้างหลัง session ถูก reuse ทำ project อื่น** → orchestrator เขียนทับตอน run ใหม่ + cwd-scan แก้ให้ · ยอมรับได้
- **2 project ใน session เดียว (บั๊ก split ตอนนี้)** → หลัง session-pin fix แต่ละ run มี session ของตัวเอง → @orches_label ถูกต้องต่อ session
- **session ระบบ** (claude-soulbrew, grouped-view, shell) → ไม่มี option + ไม่มี project cwd + ไม่ใช่ single-oracle → ชื่อดิบ
- **oracle หลายทีม (lone)** → ทีมแรก deterministic
- **ชื่อยาวเกิน status-left-length** → bump เป็น 60 (ถ้ายังยาวไปจะถูก truncate — ยอมรับ)
- **09-foreman ปัจจุบัน (pane เดียว cwd=foreman-oracle, worker แยกไป -2)** → cwd-scan จับไม่ได้ · จะได้ label ถูกเมื่อ orchestrator set @orches_label (แก้ skill) หรือ worker กลับมา session เดียว (session-pin fix) — ระบุชัดว่า transitional

## Testing

- **unit** (`sessions.test.ts`, bun): `computeSessionLabel` คลุม 4 rules + edges — option set / cwd project (มี+ไม่มี meta) / lone oracle (ในทีม+ไม่มีทีม) / system session / stale option
- **manual:** `tmux set -t <test> @orches_label foo-bar` → เช็ค status bar + dashboard โชว์ `foo-bar` ทั้งคู่ · `tmux set -u -t <test> @orches_label` → fallback ชื่อ session ทั้งคู่

## Out of scope / follow-up

- team-run label
- rename session จริง
- เคลียร์ทีมซ้ำ (เก็บเป็น preset)
- extension มี uncommitted changes ค้างเก่า (twin/Accounts ฯลฯ) — งานนี้แตะเฉพาะไฟล์ที่ระบุ ไม่ยุ่งของเดิม

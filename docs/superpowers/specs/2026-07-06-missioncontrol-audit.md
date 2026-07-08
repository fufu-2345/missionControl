# Audit missionControl (2026-07-06) — สถานะ + บั๊กที่พบ + วิธีแก้

_audit โดย code-review 8 มุม (7 รันจบ, 1 ตายเพราะ usage limit) + ตรวจสถานะ repo · เขียนให้ AI/คนอื่นทำต่อได้ทันที_

## TL;DR

- **สุขภาพรวม: ดี** — `tsc` ผ่าน, bun test **88/88 ผ่าน** (รวม test ใหม่ของ project-star + teamsOps)
- **project-star: โค้ดครบ 3 tasks ตาม plan แล้ว** (helpers+tests / host wiring / star UI) — เหลือแค่ **user commit + reload + ลอง UI จริง**
- **เจอบั๊กจริงที่ควรแก้ก่อน land: 5 ตัว (สำคัญ 1-5 ด้านล่าง)** + cleanup อีกชุด
- ซากต้องเก็บกวาด: worktree เก่า 3 ตัว, `.orches-meta.json` ที่ root ไม่มีใน .gitignore

## สถานะ working tree (ตอน audit)

- 14 ไฟล์ modified (uncommitted): project-star + teams-management + gitOps/gitStatus + part D (launchOrchestrator no-modal จาก team-instance spec)
- 4 untracked: `teamsOps.test.ts` (ผ่าน 4/4), plan+design ของ project-star (docs), `.orches-meta.json` (root)
- worktrees ค้าง: `agents/1-bob`, `agents/1-jack`, `agents/1-john` — ทุกตัว **0 commit ล้ำหน้า main, ไม่มี .orches-done** = ซาก ลบได้ (`git worktree remove agents/1-<x> --force && git branch -d agents/1-<x>`)
- audit ที่ **ไม่ได้รัน**: มุม cross-file tracer (agent ชน weekly limit) — ควรรันซ้ำภายหลัง โดยเฉพาะเช็ค caller ของ `launchOrchestrator`/teamsOps ข้ามไฟล์

## 🐛 บั๊กที่ต้องแก้ (เรียงตามความรุนแรง)

### 1. ⛔ resume attach ผิด project ได้ — `startOrchestrator.ts:371` (part D ที่เพิ่งเพิ่ม) — CONFIRMED
`if (mode === "resume" && project && attachToProject(project)) return {}` — `attachToProject` เช็คแค่ "orchestrator ของทีมใน meta มี session live ไหม" **ไม่เช็คว่า session นั้นกำลังทำ project นี้จริง** และข้อมูลจริงยืนยันอันตราย: `.orches-meta.json` ของทั้ง scientific-calculator และ agentskill-marketplace-v4 ชี้ `session: "09-foreman"` เหมือนกัน (stale/แชร์)
**Failure จริง:** foreman กำลังทำ project Q ใน `claude-foreman` → user กด ⏮ ทำต่อ project P → attach เข้าบทสนทนาของ Q, **kickoff ของ P ไม่ถูกส่งเลย**, ไม่สร้าง instance session, meta ไม่ถูก stamp
**วิธีแก้:** gate ด้วย "project นี้ live จริง" ก่อน attach — ใช้ `isProjectLive(project.path, livePanePaths)` (มีอยู่แล้วใน orchestratorResume.ts — pane cwd อยู่ใต้ `<project>/agents/*`) หรือ field `doing` ที่ wizard ใช้ gate อยู่แล้ว:
```ts
if (mode === "resume" && project?.doing && attachToProject(project)) return {};
```
(ถ้า `ResumableProject` ที่ส่งเข้ามาไม่มี doing ให้คำนวณจาก listLiveAgentPanePaths + isProjectLive) · แล้วปล่อย fall-through ไปสร้าง instance session + ส่ง resume kickoff ตามปกติ · หมายเหตุ: เคส attach สำเร็จควร stamp `.orches-meta.json` (lastRun) ด้วย ไม่งั้น sortResumable จัดอันดับผิด (ตอนนี้ข้าม stamp เพราะ return ก่อน)

### 2. ⛔ deleteTeam ลบ memory ของทีมทิ้งทั้ง dir — `teamsOps.ts:299` — CONFIRMED
เปลี่ยนจากพฤติกรรมเดิม ("manifest ghost = surfaced, not force-rm'd") เป็น `rmSync(recursive, force)` ทั้ง `ψ/memory/mailbox/teams/<name>/` ซึ่ง**มีไฟล์ memory จริงอยู่** (เช่น calc-team มี `backend-core-spawn-prompt.md` 4.6K) — กด Delete ใน Teams panel = ลบ memory ถาวร ไม่มี confirm/undo
**วิธีแก้:** ลบเฉพาะ `manifest.json` แล้ว `fs.rmdirSync(dir)` เฉพาะเมื่อ dir ว่าง (rmdir จะ throw ถ้าไม่ว่าง = กันเอง):
```ts
fs.rmSync(path.join(vaultDir, "manifest.json"), { force: true });
try { fs.rmdirSync(vaultDir); } catch { /* ไม่ว่าง = มี memory → เก็บไว้ */ }
```

### 3. Save button ค้าง "Working…" ถาวร — `webview/teams.ts:115` — CONFIRMED
host `save_team` early-return เมื่อ `!isSafeTeamName(name)` โดย**ไม่ post `op_done`** — ปุ่มถูก busy() disable ไปแล้ว → ค้างตลอด (เจอได้จริง: ทีมชื่อไทย/มีช่องว่างที่สร้างนอก panel)
**วิธีแก้:** ครอบ handler ด้วย try/finally ที่ post `op_done` เสมอ (แก้ทั้ง save_team/create_team ทุก early-return + exception path เดียวจบ ไม่ต้องจำรายทาง)

### 4. create_team fail แล้วฟอร์มหาย — `webview/teams.ts:152` — CONFIRMED
เรียก `pushList(panel)` ก่อนเช็ค `r.ok` → กรณี fail รายการทีม re-render ทับฟอร์ม (ชื่อ/สมาชิกที่พิมพ์หาย) ขัดกับ comment "Stay on the form so the user can fix + retry"
**วิธีแก้:** ย้าย `pushList` เข้า branch `r.ok` เท่านั้น · fail → post `op_done` (+error) อยู่บนฟอร์มเดิม

### 5. auto-commit ยิงทันทีไม่มี grace — `webview/orchestrator.ts:598` — CONFIRMED
grace 3 วิ นับจาก**ตอนกด arm** (`armedAt`) ไม่ใช่ตอนผล `claude -p` มาถึง → ปกติ gen ใช้ >3 วิ ⇒ `wait = max(0, 3000-elapsed) = 0` → **commit(+push) ด้วย message ที่ user ยังไม่เคยเห็น ทันที ไม่มีช่อง cancel** (ขัด comment ของโค้ดเอง "ยิงเองหลัง grace 3 วิ")
**วิธีแก้:** นับ grace จากตอนผลมาถึง: ใน `handleAutoResult` ใช้ `setTimeout(execArmed, GRACE_MS)` ตรงๆ (ไม่หัก elapsed) · หรือเลิก arming ทั้งระบบ (ดู cleanup #C3 — ผู้ audit แนะนำทางนี้ด้วยซ้ำ: "✨ auto เติม textarea แล้วให้ user กด Commit เอง")

### 6. saveTeam ลบ config ของ member ทั้งที่ maw remove fail — `teamsOps.ts:261` — PLAUSIBLE
`writeToolConfig(remove: diff.removed)` รันเสมอแม้ `maw team oracle-remove` ล้มเหลว → member ยังอยู่ในทีมแต่ model/color หาย
**วิธีแก้:** กรอง `diff.removed` ให้เหลือเฉพาะตัวที่ remove สำเร็จก่อนส่งเข้า writeToolConfig

### 7. dashboard ไม่รู้จัก kind ใหม่ "pull"/"diverged" — `gitStatus.ts:62` — PLAUSIBLE
เพิ่ม kind ใหม่ใน `parseGitButtonState` (shared) แต่สอนเฉพาะ orchestrator webview — dashboard.ts (consumer ที่สอง, gitCellHtml ~1092) จะ render ปุ่ม unstyled ที่กดแล้วไม่ทำอะไร (ไม่มี `git_pull` case)
**วิธีแก้:** เพิ่ม case pull/diverged ใน dashboard (render+handler) หรือ map เป็น kind เดิมก่อนส่งเข้า dashboard

### 8. host ไม่ validate duplicate member — `teamsModel.ts:87` + `webview/teams.ts:353` — PLAUSIBLE
ตัว guard จริงเป็น copy มือใน webview script (`normOracle`/`duplicateNames` + comment "Mirror any change") ส่วน `findDuplicateOracleNames` (ตัวที่มี test) **ไม่ถูกเรียกใน production path เลย** → webview stale/drift = roster ซ้ำหลุดไปถึง maw
**วิธีแก้:** เรียก `findDuplicateOracleNames` ใน host handler (save_team/create_team) reject พร้อม error เดิม · (เสริม: inject ฟังก์ชันจริงเข้า template `${normalizeOracle.toString()}` แทน copy มือ)

## 🧹 Cleanup (ไม่บล็อก land แต่ควรทำ)

- **C1** `startOrchestrator.ts:383` — `inject` dead branch (always false) + return `{cancelled}` ที่ไม่มีวันเกิด แต่ caller 3 ที่ยังเช็ค (`startOrchestrator.ts:490`, `webview/orchestrator.ts:147`, `webview/dashboard.ts:545`) → ลบ inject/ternary/cancelled ทั้งเส้น
- **C2** `teamsOps.ts:42` — `SOULBREW_DIR` hardcode **copy ที่ 4** (terminal.ts:10, claude.ts:16, status.ts:12) → export ตัวเดียวใช้ร่วม (ย้ายไป path util) — เสี่ยงจริงเพราะมีแผน rename dir อยู่ในหัว user + `runMaw` cwd ENOENT ถ้า dir ย้าย
- **C3** `webview/orchestrator.ts:581` — arming state machine ~130 บรรทัด (8 fields/project + timers + gen counters + click-suppression hack) ใน template string ที่ test ไม่ได้ → ทางง่ายกว่า: "✨ auto เติม textarea, user กด Commit เอง" (ตัด scheduleExec/execArmed/disarmToBox/glow ทั้งชุด) — **ตัดสินใจ UX เป็นของ user**
- **C4** `teamsOps.ts:55` — `resolvePsi` walk-up ทุกครั้งที่เรียก ทั้งที่ผลคงที่ → memoize ครั้งเดียว + มัน mirror logic ภายในของ maw (ถ้า maw เปลี่ยน layout = ghost bug กลับมา) — พิจารณาแก้ที่ maw แทน (maw เป็น repo ของ user เอง)
- **C5** `webview/orchestrator.ts:217` — `toggle_star` re-run ทั้ง annotateLiveState+computeGitStates (~75 git spawns กับ 15 projects) เพื่อ reorder อย่างเดียว → cache states จากรอบก่อน หรือ reorder ฝั่ง client
- **C6** `webview/orchestrator.ts:285` — `git_commit_push` inline copy ของ git_commit+git_push bodies → แยก doCommit/doPush ใช้ร่วม 3 case + อย่า readGitStatus เต็ม (5 spawns) เพื่อเอา hasUpstream ตัวเดียว (`git rev-parse @{u}` พอ)
- **C7** `startOrchestrator.ts:389` — `nextTwinSession` วน has-session ทีละตัว (สูงสุด 9 sync spawns บน event loop) → `tmux list-sessions -F '#{session_name}'` ครั้งเดียวแล้วหาใน Set
- **C8** `webview/orchestrator.ts:230` — askMode มี 3 เจ้าของ (webview var / msg field / _st.askMode) เคยพังมาแล้ว 1 รอบ → เหลือเจ้าของเดียว (toggle message แบบ toggle_star)
- **C9** `webview/teams.ts:189` — `renderShell` ถูก export แต่ไม่มีใคร import → เอา export ออก
- **C10** `teamsOps.ts:92` — `{timeout, cwd, env}` ควรเป็น `{...MAW_OPTS, timeout: BUD_TIMEOUT}`
- **C11** root `.orches-meta.json` untracked → เพิ่ม `.orches-meta.json` ใน .gitignore (marker runtime ไม่ใช่ source)
- **C12** `extension.ts:68` — การลบ `pushDashboardEvent` ถูกต้อง (main ไม่ได้ export) แต่ agent-branch เก่า (1-bob/jack/john) มี version ที่พึ่งมัน — ไม่เป็นไรเพราะ worktree เหล่านั้นเป็นซากที่จะลบอยู่แล้ว (บันทึกกันงง)

## ลำดับ land ที่แนะนำ

1. แก้บั๊ก 1–5 (ตัวเล็ก, อยู่ในไฟล์ที่ modified อยู่แล้ว — แก้ใน working tree รวมกับงานเดิม)
2. user commit ทั้งชุด (ปุ่ม Commit / scoped add ตาม plan ของ project-star) + reload window
3. ทดสอบ UI: star toggle, teams save/create/delete (ดู #2 ก่อนกด Delete!), ⏮ ทำต่อ (เช็คว่า attach เฉพาะ project ที่ live จริง)
4. เก็บกวาด: worktree เก่า 3 ตัว + .gitignore + cleanup C1-C12 ตามสะดวก
5. รัน audit มุม cross-file (ที่ตายเพราะ usage) ซ้ำหลัง usage รีเซ็ต

## สถานะการแก้ (อัปเดต 2026-07-06 — แก้ใน working tree, ยังไม่ commit ให้ user commit เอง · tsc ✓ + 17 tests ✓)

- [x] **บั๊ก 1** attachToProject gate — `startOrchestrator.ts:371` ใส่ `annotateLiveState([project])` + `project.doing &&` ก่อน attach (attach เฉพาะ project ที่ live จริง ไม่ใช่ session ไหนก็ได้ของ orchestrator)
- [x] **บั๊ก 2** deleteTeam ไม่ลบ memory — `teamsOps.ts:299` registry dir ลบเต็ม, ψ-vault ลบเฉพาะ manifest.json + rmdir เมื่อว่าง (ENOTEMPTY=มี memory→เก็บ)
- [x] **บั๊ก 3** op_done ตอน save_team ชื่อ invalid — `teams.ts:115` post op_done + error ก่อน return (ปุ่มไม่ค้าง)
- [x] **บั๊ก 4** create_team fail ฟอร์มหาย — `teams.ts:152` ย้าย pushList เข้า branch r.ok
- [x] **บั๊ก 5** auto-commit grace — `orchestrator.ts:627` reset `armedAt=Date.now()` ตอนผลมาถึง (grace 3 วินับจากเห็น msg ไม่ใช่จาก click)
- [ ] **บั๊ก 6** saveTeam remove config เมื่อ maw remove fail — `teamsOps.ts:261` (ยังไม่แก้ — PLAUSIBLE, ต้องดู diff.removed vs ผล remove)
- [ ] **บั๊ก 7** dashboard ไม่รู้จัก pull/diverged — `gitStatus.ts:62` (ยังไม่แก้ — ต้องแตะ dashboard.ts)
- [ ] **บั๊ก 8** host ไม่ validate duplicate member — `teamsModel.ts:87` (ยังไม่แก้)
- [ ] cleanup C1–C12 + ซาก worktree 3 ตัว + .gitignore (.orches-meta.json)
- [ ] มุม cross-file audit (agent ตายเพราะ weekly usage limit) — รันซ้ำหลัง reset

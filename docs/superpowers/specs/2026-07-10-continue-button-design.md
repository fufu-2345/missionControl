# ปุ่ม `continue` (auto · background · 1 sprint) — MissionControl

> 2026-07-10 · DESIGN · สืบจาก `~/Desktop/todo/continue-button.md`

## เป้าหมาย
ปุ่ม `continue` inline ในการ์ด project (หน้า Orchestrator) — กดแล้ว **รันต่อ 1 sprint ทันทีแบบ auto**:
ยิง flow จริงของ `/orches` (`/orches-drive`) เหมือน `/orches` ทุกอย่างรวม **online PR merge** — ต่างแค่ **ไม่ถาม user เลย + รัน background + ทำแค่ 1 sprint**

## ⚠️ แก้ record
`continue-button.md` เขียน "✅ ทำแล้ว" แต่จริงๆ **ไม่เคย build** (เช็คทุก repo/worktree — ไม่มีปุ่ม/run-record/cancel เลย). ของที่มีคือ wizard "⏮ ทำต่อ" (คลิก→เลือกทีม→**attach**) = คนละอัน. อันนี้คือของจริง

## 6 จุดตัดสิน (ยืนยันแล้ว)
1. **1 sprint แล้วหยุด** → commit+push+PR+`gh pr merge` online เหมือน /orches
2. **ไม่ถาม user** → auto resolve ทีม (`metaTeam`→fallback `defaultTeamFor`) + orchestrator (1→auto, >1→`orchestrators[0]`) · ข้าม requirement · ปิด `--ask`
3. **Background แต่ attach ได้** → tmux session ปกติ, detached ตอนคลิก, คลิกการ์ด = attach เข้าดูได้ตลอด
4. **Cancel = safe local revert** → ทิ้งงานที่ยังไม่ merge + reset main local; **ไม่ force-push** ของที่ขึ้น GitHub แล้ว
5. **Marker file ไม่ใช่ SQLite** → `.orches-run.json`
6. **กันชน session/team** → reuse ของเดิม (attach-on-doing + twin session)

## แตะ 2 repo
- **extension** → ปุ่ม inline, spin-state, launch detached, poll, git fetch+refresh, cancel
- **orches-drive** → โหมด `--once` (sprint เดียว+เขียน marker) · gitignore `.orches-run.json` · `orches-integrate.sh abort` (safe revert)

## `.orches-run.json` (per-project, gitignored)
`{ status, sprint, session, baseMainSha, startedAt, errorMsg }`
- `running` (extension เขียนตอนคลิก) → `done`/`error` (orches-drive เขียนตอนจบ/ล้ม) → `cancelled` (extension เขียนตอน cancel)

## Spin-state = marker + tmux (2 สัญญาณ)
| status | tmux session | ปุ่ม |
|---|---|---|
| `running` | alive & created ≤ startedAt | 🌀 Spinning |
| `running` | dead / created > startedAt | ⚠️ stale (หยุด+เตือน) |
| `done` | — | หยุด (หายถ้าหมด sprint) |
| `error` | — | หยุด + toast เหตุผล |
| `cancelled`/ไม่มีไฟล์ | — | Idle |

เช็คตอน: เปิดหน้า/refresh (persist) + poll ~2-3วิ ระหว่างรัน

## Cancel (done ชนะ)
kill tmux → อ่าน marker ซ้ำ → ถ้า `done`/merged แล้ว = คง done ไม่ revert · ไม่งั้น `orches-integrate.sh abort` (ทิ้ง branch/worktree/PR ที่ยังไม่ merge + reset main ถ้ายังไม่ push) → `cancelled`
> คลิกการ์ด=attach · คลิกปุ่มที่หมุน=cancel (คนละ target)

## Bug กันแล้ว (6)
1. JSON ขาดครึ่ง → atomic write + tolerant read
2. zombie session → เทียบ `startedAt` vs `session_created`
3. cancel ชน done → done ชนะ (เช็ค ancestry ก่อน revert)
4. double-launch → guard running+alive ก่อนยิง
5. error เงียบ → แยกจาก done + toast
6. gitignore ไม่ครอบ → orches-drive เพิ่ม `.orches-run.json`

## Sprint (DoD ย่อ)
- **S1** ปุ่ม inline (เฉพาะ pending>0) + spin อ่านจาก marker+tmux → รอด refresh, crash→stale ไม่ค้าง
- **S2** คลิก→resolve+marker+`tmux -d`+`/orches-drive --once` → ไม่ถาม/ไม่ attach/attach ดูได้/กดซ้ำไม่ยิงซ้ำ
- **S3** done→git fetch+refresh git panel+หยุดหมุน · error→toast
- **S4** cancel→kill+safe revert (done ชนะ, ไม่ force-push) → Idle

## Out of scope
force-push revert ของที่ merge แล้ว · schedule/คิว · ปุ่มบน dashboard-embedded · หลาย sprint รวด

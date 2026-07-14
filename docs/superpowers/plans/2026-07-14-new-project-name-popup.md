# New-project Name Popup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** เพิ่ม popup ตั้งชื่อโปรเจคใหม่ (default ระบบคิดให้) + เช็คชื่อว่างสดทั้ง local และ GitHub org ก่อนเริ่ม build; ส่งชื่อที่เลือกให้ orchestrator ใช้แทนการตั้งชื่อเอง

**Architecture:** pure naming core (`projectName.ts`, DI, bun-tested) + extension glue (fs readdir local + `gh repo view` org + kickoff carries name) + webview modal (mirror `#delmodal`) + orches-skills prose (honor given name)

**Tech Stack:** TypeScript, VS Code webview, `bun:test`, `gh` CLI (child_process), bash SKILL prose

## Global Constraints

- เช็คชื่อ **2 แหล่ง**: local = โฟลเดอร์ใต้ projects root (`fs.readdirSync`), github = `gh repo view MyMissionControl/<name>`
- org const = `MyMissionControl` (ตรงกับ `ensure-remote` ใน orches-integrate.sh)
- name rule = `^[A-Za-z0-9._-]+$`
- gh ไม่พร้อม (ไม่มี/ไม่ login/ออฟไลน์) → เช็ค local อย่างเดียว + เตือน (ไม่บล็อก) · ensure-remote ยัง guard org ตอน push (safety net)
- เฉพาะ flow "เริ่มใหม่" — ไม่แตะ resume
- pure core ห้าม import vscode/fs/child_process (inject deps)

---

## File Structure

- **Create** `extension/src/commands/projectName.ts` — pure: sanitize/validate/bump/check/suggest
- **Create** `extension/src/commands/projectName.test.ts` — bun tests
- **Modify** `extension/src/commands/startOrchestrator.ts` — `launchOrchestrator` รับ `projectName?` → เติม kickoff
- **Modify** `extension/src/webview/orchestrator.ts` — `_st.newName`, `start_new` เปิด popup, `check_name`/`name_confirmed` handlers, gh probe + local scan wrappers, `#namemodal` HTML/CSS/JS, ส่ง projectName ตอน launch
- **Modify** (orches-skills) `skills/orches/SKILL.md` + `skills/orches-drive/SKILL.md` — honor ชื่อที่ kickoff ให้มา

---

## Task 1: pure `projectName.ts` (validate/bump/check/suggest)

**Files:**
- Create: `extension/src/commands/projectName.ts`
- Test: `extension/src/commands/projectName.test.ts`

**Interfaces:**
- Produces:
  - `ORG = "MyMissionControl"`, `isValidName(n): boolean`, `sanitizeName(raw): string`, `bumpBase(n): string`, `nextCandidate(base, n): string`
  - `interface NameCheck { valid; localTaken; githubChecked; githubTaken }`
  - `checkProjectName(name, localNames: string[], ghView: (n)=>boolean|null): NameCheck`
  - `isNameFree(c: NameCheck): boolean`
  - `suggestDefaultName(recentNames: string[], localNames: string[], ghView): string`

- [ ] **Step 1: เขียนเทสที่ยังไม่ผ่าน**

```typescript
// extension/src/commands/projectName.test.ts
import { expect, test } from "bun:test";
import {
  ORG, isValidName, sanitizeName, bumpBase, nextCandidate,
  checkProjectName, isNameFree, suggestDefaultName,
} from "./projectName";

test("ORG const", () => { expect(ORG).toBe("MyMissionControl"); });

test("isValidName", () => {
  expect(isValidName("agentskill-marketplace-v9")).toBe(true);
  expect(isValidName("a_b.c-1")).toBe(true);
  expect(isValidName("")).toBe(false);
  expect(isValidName("has space")).toBe(false);
  expect(isValidName("bad/slash")).toBe(false);
});

test("sanitizeName", () => {
  expect(sanitizeName("  My Project! ")).toBe("My-Project");
  expect(sanitizeName("a//b__c")).toBe("a-b__c");
});

test("bumpBase strips trailing -vN only", () => {
  expect(bumpBase("x-v8")).toBe("x");
  expect(bumpBase("x")).toBe("x");
  expect(bumpBase("a-v2-v3")).toBe("a-v2");
});

test("nextCandidate", () => {
  expect(nextCandidate("x", 1)).toBe("x");
  expect(nextCandidate("x", 2)).toBe("x-v2");
  expect(nextCandidate("x", 9)).toBe("x-v9");
});

test("checkProjectName: local taken", () => {
  const c = checkProjectName("rpn", ["rpn", "ttt"], () => false);
  expect(c).toEqual({ valid: true, localTaken: true, githubChecked: true, githubTaken: false });
});

test("checkProjectName: github taken", () => {
  const c = checkProjectName("foo", [], (n) => n === "foo");
  expect(c.githubTaken).toBe(true);
});

test("checkProjectName: gh unavailable → githubChecked=false", () => {
  const c = checkProjectName("foo", [], () => null);
  expect(c.githubChecked).toBe(false);
  expect(c.githubTaken).toBe(false);
});

test("checkProjectName: invalid name", () => {
  expect(checkProjectName("bad name", [], () => false).valid).toBe(false);
});

test("isNameFree", () => {
  expect(isNameFree({ valid: true, localTaken: false, githubChecked: true, githubTaken: false })).toBe(true);
  expect(isNameFree({ valid: true, localTaken: true, githubChecked: true, githubTaken: false })).toBe(false);
  expect(isNameFree({ valid: true, localTaken: false, githubChecked: true, githubTaken: true })).toBe(false);
  // gh not checked → local-only decides (free)
  expect(isNameFree({ valid: true, localTaken: false, githubChecked: false, githubTaken: false })).toBe(true);
  expect(isNameFree({ valid: false, localTaken: false, githubChecked: false, githubTaken: false })).toBe(false);
});

test("suggestDefaultName: bump past taken in both sources", () => {
  const local = ["agentskill-marketplace", "agentskill-marketplace-v2"];
  const ghTaken = new Set(["agentskill-marketplace-v3"]);
  const name = suggestDefaultName(
    ["agentskill-marketplace-v2"], local, (n) => ghTaken.has(n),
  );
  expect(name).toBe("agentskill-marketplace-v4"); // base,v2 local · v3 github → v4
});

test("suggestDefaultName: no projects → my-project", () => {
  expect(suggestDefaultName([], [], () => false)).toBe("my-project");
});
```

- [ ] **Step 2: รันเทสให้เห็นว่าล้ม**

Run: `cd extension && bun test src/commands/projectName.test.ts`
Expected: FAIL — `Cannot find module "./projectName"`

- [ ] **Step 3: เขียน implementation**

```typescript
// extension/src/commands/projectName.ts
// Pure naming helpers for the new-project popup. NO vscode/fs/gh import — the
// extension injects local folder names + a gh-view probe, so this unit-tests with
// `bun test`. Both-source collision check (local + GitHub org) lives here as pure
// logic; the impure fs.readdir + `gh repo view` wrappers live in orchestrator.ts.

export const ORG = "MyMissionControl";
const SAFE = /^[A-Za-z0-9._-]+$/;

export function isValidName(name: string): boolean {
  return typeof name === "string" && SAFE.test(name);
}

export function sanitizeName(raw: string): string {
  return (raw ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** strip a single trailing `-vN` → base ("x-v8"→"x", "x"→"x"). */
export function bumpBase(name: string): string {
  return name.replace(/-v\d+$/, "");
}

/** candidate #n: n≤1 → base, else `base-v{n}`. */
export function nextCandidate(base: string, n: number): string {
  return n <= 1 ? base : `${base}-v${n}`;
}

export interface NameCheck {
  valid: boolean;
  localTaken: boolean;
  githubChecked: boolean;
  githubTaken: boolean;
}

/** ghView(name): true = repo exists (taken), false = 404 (free), null = couldn't
 *  check (gh missing / not-authed / error) → treated as "not blocking". */
export function checkProjectName(
  name: string,
  localNames: string[],
  ghView: (n: string) => boolean | null,
): NameCheck {
  if (!isValidName(name))
    return { valid: false, localTaken: false, githubChecked: false, githubTaken: false };
  const gh = ghView(name);
  return {
    valid: true,
    localTaken: localNames.includes(name),
    githubChecked: gh !== null,
    githubTaken: gh === true,
  };
}

/** free = valid + not local + (github free OR gh not checked). */
export function isNameFree(c: NameCheck): boolean {
  return c.valid && !c.localTaken && !(c.githubChecked && c.githubTaken);
}

/** first free name: base of most-recent project (recentNames[0], strip -vN) or
 *  "my-project", bumped until free in BOTH local + github. capped at 40 rounds. */
export function suggestDefaultName(
  recentNames: string[],
  localNames: string[],
  ghView: (n: string) => boolean | null,
): string {
  const base = recentNames.length ? bumpBase(recentNames[0]) : "my-project";
  for (let n = 1; n <= 40; n++) {
    const cand = nextCandidate(base, n);
    if (isNameFree(checkProjectName(cand, localNames, ghView))) return cand;
  }
  return `${base}-new`;
}
```

- [ ] **Step 4: รันเทสให้ผ่าน**

Run: `cd extension && bun test src/commands/projectName.test.ts`
Expected: PASS (12 tests)

- [ ] **Step 5: commit**

```bash
cd /home/chillox-intern/Desktop/soulbrew/github.com/fufu-2345/missionControl
git add extension/src/commands/projectName.ts extension/src/commands/projectName.test.ts
git commit -m "feat: pure project-name helpers (validate/bump/both-source check/suggest)"
```

---

## Task 2: extension glue — kickoff carries name + gh/local wrappers + state

**Files:**
- Modify: `extension/src/commands/startOrchestrator.ts`
- Modify: `extension/src/webview/orchestrator.ts`

**Interfaces:**
- Consumes (Task 1): `checkProjectName`, `suggestDefaultName`, `isNameFree`, `sanitizeName`, `ORG`, `type NameCheck`
- Consumes (existing): `scanResumableProjects`, `sortResumable`, `launchOrchestrator`, `_st`
- Produces: `launchOrchestrator` opt `projectName?: string`; messages `open_namemodal{default}`, `name_result{...}`; handled `check_name`, `name_confirmed`

- [ ] **Step 1: `launchOrchestrator` รับ `projectName?` + เติม kickoff**

ใน `startOrchestrator.ts` แก้ opts type (บรรทัด ~600-606) เพิ่ม `projectName?: string;` และ destructure:

```typescript
export async function launchOrchestrator(opts: {
  orch: string;
  team: OracleTeam;
  mode: "new" | "resume";
  project?: ResumableProject;
  askMode?: boolean;
  projectName?: string;
}): Promise<{ error?: string; cancelled?: boolean }> {
  const { orch, team, mode, project, askMode = false, projectName } = opts;
```

หลังบรรทัดสร้าง `kickoff` (ปัจจุบันบรรทัด ~644-647) เพิ่ม:

```typescript
  if (mode === "new" && projectName && projectName.trim())
    kickoff += `\n\nโปรเจคชื่อ '${projectName.trim()}' — ใช้ชื่อนี้เป๊ะเป็นชื่อ project/repo (ผ่านการเช็คว่างแล้ว) · ⛔ ห้ามตั้งชื่อใหม่/ห้าม bump -vN เอง`;
```

- [ ] **Step 2: helper wrappers (real fs local + gh probe) + `_st.newName` — ใน orchestrator.ts**

เพิ่ม import (ใกล้ import อื่นจาก ../commands):

```typescript
import { ORG, checkProjectName, suggestDefaultName, sanitizeName, type NameCheck } from "../commands/projectName";
```

เพิ่ม field ใน state type ของ `_st` (หา `interface`/`type` ที่นิยาม `_st`; เพิ่ม): `newName?: string;`

เพิ่ม 2 helper (module-level, ใกล้ pushProjectsScreen):

```typescript
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// รายชื่อโฟลเดอร์ทั้งหมดใต้ projects root (local-taken check — ทุกโฟลเดอร์ ไม่ใช่แค่ resumable)
function localProjectNames(): string[] {
  const one = scanResumableProjects()[0]; // reuse: projects root = parent ของ project ใดๆ
  const root = one ? path.dirname(one.path) : null;
  if (!root) return scanResumableProjects().map((p) => p.name);
  try {
    return fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return scanResumableProjects().map((p) => p.name);
  }
}

// gh probe: true=exists, false=404(free), null=gh ไม่พร้อม/error
let _ghOk: boolean | undefined;
function ghAvailable(): boolean {
  if (_ghOk === undefined) {
    try { cp.execFileSync("gh", ["auth", "status"], { stdio: "ignore", timeout: 4000 }); _ghOk = true; }
    catch { _ghOk = false; }
  }
  return _ghOk;
}
function ghView(name: string): boolean | null {
  if (!ghAvailable()) return null;
  try { cp.execFileSync("gh", ["repo", "view", `${ORG}/${name}`, "--json", "name"], { stdio: "ignore", timeout: 6000 }); return true; }
  catch { return false; } // non-zero = 404 (free) — network error ยอมรับความเสี่ยง; ensure-remote guard ตอน push
}
```

> หมายเหตุ: ถ้า `scanResumableProjects` มี export ค่า projects-root const อยู่แล้ว ให้ import มาใช้แทนการเดา `dirname` (ตรวจตอน impl; เดา dirname เป็น fallback)

- [ ] **Step 3: `start_new` → เปิด name popup (แทนไป team picker ตรงๆ)**

แก้ `case "start_new"` (ปัจจุบัน set project/team undefined แล้ว pushTeamsScreen) เป็น:

```typescript
      case "start_new": {
        _st.project = undefined;
        _st.team = undefined;
        _st.newName = undefined;
        const def = suggestDefaultName(
          sortResumable(scanResumableProjects()).map((p) => p.name),
          localProjectNames(),
          ghView,
        );
        panel.webview.postMessage({ type: "open_namemodal", default: def });
        return;
      }
```

- [ ] **Step 4: `check_name` + `name_confirmed` handlers (วางใกล้ case อื่น)**

```typescript
      case "check_name": {
        const raw = typeof msg.name === "string" ? msg.name : "";
        const name = sanitizeName(raw);
        const c: NameCheck = checkProjectName(name, localProjectNames(), ghView);
        panel.webview.postMessage({ type: "name_result", name, sanitized: name, check: c });
        return;
      }
      case "name_confirmed": {
        const name = sanitizeName(typeof msg.name === "string" ? msg.name : "");
        if (!checkProjectName(name, localProjectNames(), ghView).valid) return;
        _st.newName = name;
        pushTeamsScreen(panel);
        return;
      }
```

- [ ] **Step 5: team-pick launch ส่ง projectName**

ที่ call `launchOrchestrator({...})` (ปัจจุบัน ~246) เพิ่ม `projectName: _st.newName`:

```typescript
  const r = await launchOrchestrator({
    orch,
    team: _st.team,
    mode: _st.project ? "resume" : "new",
    project: _st.project,
    askMode: askPick.ask,
    projectName: _st.newName,
  });
```

- [ ] **Step 6: typecheck + เทสเดิม**

Run: `cd extension && bun test && bun run compile`
Expected: PASS ทั้งหมด (รวม projectName.test.ts) + compile exit 0

- [ ] **Step 7: commit**

```bash
cd /home/chillox-intern/Desktop/soulbrew/github.com/fufu-2345/missionControl
git add extension/src/commands/startOrchestrator.ts extension/src/webview/orchestrator.ts
git commit -m "feat: name-popup extension glue (gh/local check, kickoff carries name)"
```

---

## Task 3: webview name popup UI (#namemodal) + F5 end-to-end

**Files:**
- Modify: `extension/src/webview/orchestrator.ts` (renderShell HTML/CSS + client `<script>`)

**Interfaces:**
- Consumes: messages `open_namemodal{default}`, `name_result{name,check}`; posts `start_new`, `check_name{name}`, `name_confirmed{name}`

- [ ] **Step 1: `#namemodal` HTML (วางถัดจาก `#delmodal`)**

```html
  <div id="namemodal" class="modal-backdrop" style="display:none">
    <div class="modal-card" role="dialog" aria-modal="true">
      <div class="mt">ตั้งชื่อโปรเจคใหม่</div>
      <div class="mh">พิมพ์ชื่อ (เช็คว่างทั้งในเครื่องและ GitHub org) — แก้ได้</div>
      <input id="nm-input" type="text" placeholder="ชื่อโปรเจค" />
      <div class="merr" id="nm-status"></div>
      <div class="mact">
        <button class="mbtn" id="nm-cancel">ยกเลิก</button>
        <button class="mbtn primary" id="nm-ok">ถัดไป</button>
      </div>
    </div>
  </div>
```

- [ ] **Step 2: CSS chip สถานะ (ใกล้ `.modal-card .merr`)**

```css
  #nm-status.ok { color:#3fb950; }
  #nm-status.bad { color:#f85149; }
  #nm-status.warn { color:#e3a13a; }
```

- [ ] **Step 3: client JS (วางถัดจากบล็อก delmodal)**

```javascript
  // ── ตั้งชื่อโปรเจคใหม่ modal — พิมพ์ + เช็คว่าง (local+github) debounce ──
  var _nmTimer=null, _nmLast='';
  function openNameModal(def){
    el('nm-input').value=def||''; el('nm-status').textContent=''; el('nm-status').className='merr';
    el('nm-ok').disabled=true;
    el('namemodal').style.display='flex'; el('nm-input').focus(); el('nm-input').select();
    nmSchedule();
  }
  function closeNameModal(){ el('namemodal').style.display='none'; }
  function nmSchedule(){
    el('nm-ok').disabled=true; el('nm-status').textContent='กำลังเช็ค…'; el('nm-status').className='merr';
    if(_nmTimer) clearTimeout(_nmTimer);
    _nmTimer=setTimeout(function(){ _nmLast=el('nm-input').value; post('check_name',{name:_nmLast}); }, 400);
  }
  function nmResult(m){
    if(m.name!==el('nm-input').value.trim() && m.sanitized!==el('nm-input').value) { /* stale */ }
    var c=m.check, s=el('nm-status');
    if(!c.valid){ s.textContent='ชื่อไม่ถูกต้อง (ใช้ A-Z a-z 0-9 . _ - เท่านั้น)'; s.className='merr bad'; el('nm-ok').disabled=true; return; }
    var free = !c.localTaken && !(c.githubChecked && c.githubTaken);
    if(c.localTaken){ s.textContent='ซ้ำ: มีในเครื่องแล้ว'; s.className='merr bad'; }
    else if(c.githubChecked && c.githubTaken){ s.textContent='ซ้ำ: มีบน GitHub org แล้ว'; s.className='merr bad'; }
    else if(!c.githubChecked){ s.textContent='ว่างในเครื่อง · (เช็ค GitHub ไม่ได้ — gh ไม่พร้อม)'; s.className='merr warn'; }
    else { s.textContent='ว่าง ใช้ได้'; s.className='merr ok'; }
    el('nm-ok').disabled = !free;
  }
  el('nm-cancel').addEventListener('click', closeNameModal);
  el('nm-ok').addEventListener('click', function(){ if(el('nm-ok').disabled) return; var n=el('nm-input').value; closeNameModal(); post('name_confirmed',{name:n}); });
  el('nm-input').addEventListener('input', nmSchedule);
  el('namemodal').addEventListener('click', function(e){ if(e.target===el('namemodal')) closeNameModal(); });
  el('nm-input').addEventListener('keydown', function(e){
    if(e.key==='Enter'){ e.preventDefault(); if(!el('nm-ok').disabled){ var n=el('nm-input').value; closeNameModal(); post('name_confirmed',{name:n}); } }
    else if(e.key==='Escape'){ e.preventDefault(); closeNameModal(); } });
```

- [ ] **Step 4: route ข้อความ host→client (ใน `window.addEventListener('message')` / ตัว dispatch เดิม)**

หา switch ที่รับ message จาก host (เช่นที่ route `screen_projects`→renderProjects) เพิ่ม 2 เคส:

```javascript
      case 'open_namemodal': openNameModal(m.default); break;
      case 'name_result': nmResult(m); break;
```

- [ ] **Step 5: typecheck + client script syntax**

Run:
```bash
cd extension && bun run compile
node --input-type=module -e 'import fs from "node:fs"; const s=fs.readFileSync("src/webview/orchestrator.ts","utf8").match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\$\{[^}]*\}/g,"0"); fs.writeFileSync("/tmp/nm.js",s);'
node --check /tmp/nm.js && echo CLIENT_OK
```
Expected: compile exit 0 + CLIENT_OK

- [ ] **Step 6: F5 verify end-to-end**

1. F5 → + เริ่มโปรเจคใหม่ → popup เด้ง + default pre-fill (เช่น `agentskill-marketplace-v9`), chip "ว่าง ใช้ได้"
2. พิมพ์ `rpn` → chip แดง "ซ้ำ: มีในเครื่องแล้ว", ปุ่มถัดไป disabled
3. พิมพ์ชื่อใหม่ที่ว่าง → chip เขียว → ถัดไปกดได้
4. ถัดไป → ไป team picker → เลือกทีม → launch → ดูใน pane orchestrator: ใช้ชื่อที่พิมพ์ (ไม่ bump)
5. (ถ้าทำได้) ปิดเน็ต/gh → chip เหลือง "เช็ค GitHub ไม่ได้" ยังไปต่อได้

- [ ] **Step 7: commit**

```bash
git add extension/src/webview/orchestrator.ts
git commit -m "feat: new-project name popup UI (live both-source availability check)"
```

---

## Task 4: orches-skills — orchestrator honor ชื่อที่ kickoff ให้มา

**Files:**
- Modify: `orches-skills/skills/orches/SKILL.md` (Step 3 เตรียม repo)
- Modify: `orches-skills/skills/orches-drive/SKILL.md` (Step 2 ย่อย + ตั้งชื่อ)

> ⚠️ orches-skills ตอนนี้มีงาน .sh ค้าง uncommitted อยู่ (prep + verbs) — Task นี้เพิ่ม prose เข้าไปในกองเดียวกัน · **ไม่ commit orches-skills** จนกว่า user จะ review batch นั้น (ตามที่ค้างไว้) — แค่แก้ไฟล์

- [ ] **Step 1: orches-drive Step 2 — honor given name**

เพิ่มบรรทัดใน Step 2 (ย่อย requirement → ตั้งชื่อ project):

```markdown
> 🏷️ **ถ้า kickoff/บทสนทนาระบุชื่อ project มาแล้ว (เช่น "โปรเจคชื่อ 'X' — ใช้ชื่อนี้เป๊ะ") → ใช้ชื่อนั้นตรงๆ เป็นชื่อโฟลเดอร์/repo · ⛔ ห้ามตั้งใหม่/ห้าม bump -vN เอง (ชื่อถูกเช็คว่าง local+GitHub org มาแล้วจาก MissionControl popup)** · ไม่มีชื่อมา = ตั้งเองตามเดิม
```

- [ ] **Step 2: orches bootstrap Step 3 — เช่นเดียวกัน**

เพิ่มใน Step 3 (เตรียม project repo):

```markdown
- **ถ้า kickoff ระบุชื่อ project มาแล้ว** → ใช้ชื่อนั้น (อย่าเดา/สุ่มใหม่) · ปกติ orchestrator เป็นคนสร้าง repo ที่ prep 2.1 อยู่แล้ว — แค่ล็อกชื่อตามที่ได้รับ
```

- [ ] **Step 3: verify (bash-level, ไม่มี test runner สำหรับ prose)**

```bash
grep -c "ใช้ชื่อนี้เป๊ะ\|honor\|kickoff ระบุชื่อ" \
  ~/.claude/skills/orches-drive/SKILL.md ~/.claude/skills/orches/SKILL.md
```
Expected: เจอบรรทัดที่เพิ่ม (≥1 ต่อไฟล์) · ยืนยันจริงตอน /orches รอบหน้า (integration)

- [ ] **Step 4: ไม่ commit** (orches-skills รอ review batch กับงาน .sh ที่ค้าง) — แจ้ง user ว่าแก้แล้ว รอ commit รวม

---

## Self-Review

**Spec coverage:** popup+default (T2/T3) · both-check local+github (T1 pure + T2 wrappers) · gh-unavailable fallback (T1 isNameFree + T3 chip warn) · pass name→orchestrator (T2 kickoff + T4 honor) · default logic (T1 suggestDefaultName) ✓

**Placeholder scan:** ไม่มี TBD/TODO; โค้ดจริงครบทุก step (T2 มี "ตรวจตอน impl" 1 จุด = projects-root const — มี fallback ชัด ไม่ใช่ placeholder) ✓

**Type consistency:** `checkProjectName`/`suggestDefaultName`/`NameCheck`/`isNameFree`/`sanitizeName`/`ORG` (T1) ใช้ตรงกับ import+เรียกใน T2 ✓ · `launchOrchestrator` opt `projectName` (T2S1) ตรงกับ call site (T2S5) ✓ · messages `open_namemodal`/`name_result`/`check_name`/`name_confirmed` ตรงกันระหว่าง handler (T2) กับ client (T3) ✓

# Delete-project Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** เพิ่มปุ่มลบโปรเจค (หลังกด Edit mode) ในหน้า orchestrator ของ MissionControl เพื่อลบโปรเจคที่ไม่ใช้ออกจากเครื่อง local อย่างปลอดภัย

**Architecture:** แยก 2 ชั้นตาม pattern เดิมของ repo — (1) โมดูลบริสุทธิ์ `commands/deleteProject.ts` (guard + fs.rm + name-match, ไม่ import vscode, เทสด้วย `bun test`) และ (2) กาว vscode ใน `webview/orchestrator.ts` (native confirm dialogs + running re-check + ปุ่ม UI). path ที่จะลบมาจาก `ResumableProject.path` ที่ scan มาแล้วเสมอ ไม่ใช่ string ที่ user พิมพ์

**Tech Stack:** TypeScript, VS Code extension API (`showWarningMessage`/`showInputBox`), `bun:test`, webview (HTML string + client `<script>` ผ่าน `acquireVsCodeApi`)

## Global Constraints

- ลบเฉพาะ **โฟลเดอร์ local** ด้วย `fs.rmSync(path,{recursive:true,force:true})` — ⛔ ห้ามรัน `gh` / ห้ามแตะ GitHub remote
- ปุ่มลบต้อง **disabled (กากบาทแดง)** เมื่อโปรเจคกำลัง run (`run.state === "spinning"`)
- ยืนยันด้วย **native VS Code dialog เท่านั้น** (`showWarningMessage` modal → `showInputBox` พิมพ์ชื่อ) — ไม่ใช้ webview modal
- path guard: ต้องเป็น **ลูกตรงใต้ dir ชื่อ `projects`** + resolve ผ่าน `fs.realpathSync` (กัน symlink escape) + เป็น directory จริง
- type-to-confirm: ต้องพิมพ์ `project.name` (basename) **ตรงเป๊ะ** (trim แล้วเทียบ ==)
- ห้ามแตะ logic เดิม: `continue_run` / `cancel_run` / `continue_multi` / git buttons / star

---

## File Structure

- **Create** `extension/src/commands/deleteProject.ts` — โมดูลบริสุทธิ์: `canDeleteProjectPath`, `confirmNameMatches`, `removeProjectDir`
- **Create** `extension/src/commands/deleteProject.test.ts` — bun tests ของทั้ง 3 ฟังก์ชัน
- **Modify** `extension/src/webview/orchestrator.ts` — import โมดูล + `isRunning()` helper + `deleteProjectFlow()` + `case "delete_project"` + Edit toggle + ปุ่ม `.del` + CSS

---

## Task 1: โมดูลบริสุทธิ์ `deleteProject.ts` (guard + rm + name-match)

**Files:**
- Create: `extension/src/commands/deleteProject.ts`
- Test: `extension/src/commands/deleteProject.test.ts`

**Interfaces:**
- Produces:
  - `canDeleteProjectPath(projectPath: string): { ok: boolean; reason?: string }`
  - `confirmNameMatches(typed: string, expected: string): boolean`
  - `removeProjectDir(projectPath: string): { deleted: boolean; reason?: string }`
- Consumes: `node:fs`, `node:path` เท่านั้น (ไม่ import vscode)

- [ ] **Step 1: เขียนเทสที่ยังไม่ผ่าน**

```typescript
// extension/src/commands/deleteProject.test.ts
import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { canDeleteProjectPath, confirmNameMatches, removeProjectDir } from "./deleteProject";

function tmpProjects(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mc-del-"));
  fs.mkdirSync(path.join(base, "projects"), { recursive: true });
  return base;
}

test("canDeleteProjectPath: ยอมรับลูกตรงใต้ projects/ ที่เป็น dir จริง", () => {
  const base = tmpProjects();
  const p = path.join(base, "projects", "foo");
  fs.mkdirSync(p);
  expect(canDeleteProjectPath(p).ok).toBe(true);
});

test("canDeleteProjectPath: ปฏิเสธ projects root เอง", () => {
  const base = tmpProjects();
  expect(canDeleteProjectPath(path.join(base, "projects")).ok).toBe(false);
});

test("canDeleteProjectPath: ปฏิเสธ path นอก projects/", () => {
  const base = tmpProjects();
  const p = path.join(base, "notprojects");
  fs.mkdirSync(p);
  expect(canDeleteProjectPath(p).ok).toBe(false);
});

test("canDeleteProjectPath: ปฏิเสธ path ที่ไม่มีจริง", () => {
  const base = tmpProjects();
  expect(canDeleteProjectPath(path.join(base, "projects", "ghost")).ok).toBe(false);
});

test("canDeleteProjectPath: ปฏิเสธไฟล์ (ไม่ใช่ dir)", () => {
  const base = tmpProjects();
  const f = path.join(base, "projects", "afile");
  fs.writeFileSync(f, "x");
  expect(canDeleteProjectPath(f).ok).toBe(false);
});

test("canDeleteProjectPath: ปฏิเสธ path ว่าง", () => {
  expect(canDeleteProjectPath("").ok).toBe(false);
});

test("confirmNameMatches: ตรง=true, ผิด/ว่าง=false, trim ก่อนเทียบ", () => {
  expect(confirmNameMatches("foo", "foo")).toBe(true);
  expect(confirmNameMatches("  foo  ", "foo")).toBe(true);
  expect(confirmNameMatches("foo", "bar")).toBe(false);
  expect(confirmNameMatches("", "foo")).toBe(false);
});

test("removeProjectDir: ลบ dir จริงหาย", () => {
  const base = tmpProjects();
  const p = path.join(base, "projects", "foo");
  fs.mkdirSync(path.join(p, "agents", "r"), { recursive: true });
  fs.writeFileSync(path.join(p, "file.txt"), "x");
  const r = removeProjectDir(p);
  expect(r.deleted).toBe(true);
  expect(fs.existsSync(p)).toBe(false);
});

test("removeProjectDir: ปฏิเสธ path นอก projects/ (ไม่ลบ)", () => {
  const base = tmpProjects();
  const p = path.join(base, "notprojects");
  fs.mkdirSync(p);
  const r = removeProjectDir(p);
  expect(r.deleted).toBe(false);
  expect(fs.existsSync(p)).toBe(true);
});
```

- [ ] **Step 2: รันเทสให้เห็นว่าล้ม**

Run: `cd extension && bun test src/commands/deleteProject.test.ts`
Expected: FAIL — `Cannot find module "./deleteProject"`

- [ ] **Step 3: เขียน implementation ให้ผ่าน**

```typescript
// extension/src/commands/deleteProject.ts
// Pure guard + fs removal for the delete-project button (orchestrator screen).
// NO vscode import — unit-tested standalone with `bun test`. The native confirm
// dialogs + tmux running-check live in webview/orchestrator.ts. The path always
// comes from a scanned ResumableProject.path, never user text; this guard is the
// last line against an rm -rf of the wrong directory.
import * as fs from "node:fs";
import * as path from "node:path";

/** Deletable only when: exists, resolves (symlinks followed) to a real
 *  directory, and is a DIRECT child of a dir named `projects` (i.e.
 *  `.../projects/<name>`), and is not the `projects` dir itself. */
export function canDeleteProjectPath(projectPath: string): { ok: boolean; reason?: string } {
  if (!projectPath || typeof projectPath !== "string") return { ok: false, reason: "path ว่าง" };
  let resolved: string;
  try {
    resolved = fs.realpathSync(projectPath); // follows symlinks + normalizes; throws if missing
  } catch {
    return { ok: false, reason: `ไม่พบโฟลเดอร์: ${projectPath}` };
  }
  let st: fs.Stats;
  try {
    st = fs.lstatSync(resolved);
  } catch {
    return { ok: false, reason: `stat ไม่ได้: ${resolved}` };
  }
  if (!st.isDirectory()) return { ok: false, reason: "ไม่ใช่โฟลเดอร์" };
  const parent = path.dirname(resolved);
  if (resolved === parent) return { ok: false, reason: "path ไม่ถูกต้อง (root)" };
  if (path.basename(parent) !== "projects")
    return { ok: false, reason: `ต้องเป็นลูกตรงใต้ projects/ (พบ: ${resolved})` };
  return { ok: true };
}

/** type-to-confirm: พิมพ์ (trim แล้ว) ต้องตรง basename เป๊ะ. */
export function confirmNameMatches(typed: string, expected: string): boolean {
  return typeof typed === "string" && typed.trim() === expected;
}

/** Guard แล้วลบโฟลเดอร์ (recursive). ไม่ผ่าน guard = ไม่ลบ + reason. */
export function removeProjectDir(projectPath: string): { deleted: boolean; reason?: string } {
  const g = canDeleteProjectPath(projectPath);
  if (!g.ok) return { deleted: false, reason: g.reason };
  fs.rmSync(fs.realpathSync(projectPath), { recursive: true, force: true });
  return { deleted: true };
}
```

- [ ] **Step 4: รันเทสให้ผ่าน**

Run: `cd extension && bun test src/commands/deleteProject.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: commit**

```bash
cd /home/chillox-intern/Desktop/soulbrew/github.com/fufu-2345/missionControl
git add extension/src/commands/deleteProject.ts extension/src/commands/deleteProject.test.ts
git commit -m "feat: pure delete-project guard + fs removal (tested)"
```

---

## Task 2: กาว vscode + UI — flow, handler, ปุ่ม Edit/ลบ (F5 end-to-end)

**Files:**
- Modify: `extension/src/webview/orchestrator.ts`

**Interfaces:**
- Consumes (จาก Task 1): `removeProjectDir`, `confirmNameMatches` จาก `../commands/deleteProject`
- Consumes (มีอยู่แล้วในไฟล์): `readRunMarker`, `resolveButtonState`, `pendingSprints` (จาก `../commands/continueRun`), `tmuxHasSession`, `sessionCreatedAt`, `scanResumableProjects`, `pushProjectsScreen`, `_st`, `type ResumableProject`
- Produces: message `delete_project{path}` (client→host); ไม่มี export ใหม่

- [ ] **Step 1: import โมดูล Task 1**

เพิ่มบรรทัด import ใกล้ import อื่นจาก `../commands/` (บนสุดของไฟล์):

```typescript
import { confirmNameMatches, removeProjectDir } from "../commands/deleteProject";
```

- [ ] **Step 2: เพิ่ม `isRunning()` + `deleteProjectFlow()` (เหนือ `panel.webview.onDidReceiveMessage`)**

reuse การ derive "spinning" เดิม (DRY — logic เดียวกับ pushProjectsScreen บรรทัด ~90-94):

```typescript
/** โปรเจคนี้กำลัง run จริงไหม (marker running + session live + ไม่ zombie) —
 *  reuse resolveButtonState ให้ตรงกับปุ่ม ▶ ทำต่อ ที่ user เห็น. */
function isRunning(p: ResumableProject): boolean {
  const marker = readRunMarker(p.path);
  const live = marker?.session
    ? { alive: tmuxHasSession(marker.session), createdAt: sessionCreatedAt(marker.session) }
    : { alive: false };
  return resolveButtonState(pendingSprints(p), marker, live).state === "spinning";
}

/** ลบโปรเจค: กัน running → confirm modal → พิมพ์ชื่อยืนยัน → ลบโฟลเดอร์ local.
 *  ⛔ ไม่แตะ GitHub. คืน {deleted:false} เงียบเมื่อ user ยกเลิก. */
async function deleteProjectFlow(p: ResumableProject): Promise<{ deleted: boolean; reason?: string }> {
  if (isRunning(p)) return { deleted: false, reason: `'${p.name}' กำลัง run อยู่ — กด stop ก่อนถึงจะลบได้` };
  const yes = await vscode.window.showWarningMessage(
    `ลบโปรเจค '${p.name}' ออกจากเครื่องถาวร?`,
    { modal: true, detail: `ลบโฟลเดอร์ ${p.path} (รวม git + worktrees ข้างใน) · ไม่แตะ GitHub` },
    "ลบถาวร",
  );
  if (yes !== "ลบถาวร") return { deleted: false };
  const typed = await vscode.window.showInputBox({
    title: `ยืนยันการลบ '${p.name}'`,
    prompt: `พิมพ์ชื่อโปรเจคให้ตรงเพื่อยืนยัน: ${p.name}`,
    ignoreFocusOut: true,
    validateInput: (v) => (confirmNameMatches(v, p.name) ? null : "ชื่อไม่ตรง"),
  });
  if (!confirmNameMatches(typed ?? "", p.name)) return { deleted: false };
  const r = removeProjectDir(p.path);
  if (r.deleted) vscode.window.showInformationMessage(`ลบ '${p.name}' แล้ว`);
  return r;
}
```

- [ ] **Step 3: เพิ่ม `case "delete_project"` ใน `onDidReceiveMessage` (วางถัดจาก `case "cancel_run"`)**

```typescript
      case "delete_project": {
        const p = _st.projects.find((x) => x.path === msg.path);
        if (!p) return;
        const r = await deleteProjectFlow(p);
        if (r.deleted) {
          _st.projects = scanResumableProjects(); // re-scan → การ์ดหลุดจาก list
          await pushProjectsScreen(panel);
        } else if (r.reason) {
          vscode.window.showWarningMessage(r.reason);
        }
        return;
      }
```

- [ ] **Step 4: CSS ปุ่มลบ + edit mode (ในบล็อก `<style>` ของ `renderShell`, ใกล้ `.card .cont`/`.star`)**

```css
  .del { display:none; background:none; border:none; cursor:pointer; font-size:14px;
         padding:2px 6px; border-radius:5px; color:#f85149; }
  #content.edit .del { display:inline-flex; align-items:center; }
  .del:hover { background:rgba(248,81,73,0.15); }
  .del.disabled { color:#6e7681; cursor:not-allowed; }
  .del.disabled:hover { background:none; }
  #editBtn.on { background:rgba(248,81,73,0.15); color:#f85149; border-color:#f85149; }
```

- [ ] **Step 5: ปุ่ม Edit — เพิ่ม param ใน `actionsHtml` + wire ใน `wireActions`**

แก้ signature `actionsHtml(canBack, showFetch, askable, showNew)` → เพิ่ม `showEdit` ท้ายสุด และต่อ HTML:

```javascript
  function actionsHtml(canBack, showFetch, askable, showNew, showEdit){
    return (canBack ? '<button id="backBtn">← กลับ</button>' : '')
      + (showNew ? '<button id="newProjBtn" style="background:#238636;color:#fff;border-color:#238636;font-weight:600;">+ เริ่มโปรเจคใหม่</button>' : '')
      + (askable ? '<button id="askBtn" title="เปิด = สัมภาษณ์ requirement ละเอียด (grilling) + รีวิวแผนก่อนลงมือ (scrutinize)" style="'+askBtnStyle()+'">'+askBtnLabel()+'</button>' : '')
      + (showFetch ? '<button id="reloadBtn">fetch</button>' : '')
      + (showEdit ? '<button id="editBtn" title="เปิดเพื่อลบโปรเจคที่ไม่ใช้">✏️ Edit</button>' : '');
  }
```

ใน `wireActions` เพิ่มการ wire ปุ่ม edit (toggle class `edit` บน `#content` + ไฮไลต์ปุ่ม):

```javascript
    var eb=el("editBtn"); if(eb) eb.addEventListener('click',function(){
      var c=el("content"); var on=c.classList.toggle('edit'); eb.classList.toggle('on', on); });
```

- [ ] **Step 6: เรียก `actionsHtml` ของหน้า Projects ให้เปิด Edit + render ปุ่ม `.del` ต่อการ์ด**

ใน `renderProjects` แก้บรรทัด actions ให้ส่ง `showEdit=true`:

```javascript
    el("actions").innerHTML = actionsHtml(false, true, false, true, true); wireActions(false);
```

ในการประกอบการ์ด (ก่อน `return '<div class="card'...`) เพิ่มตัวแปรปุ่มลบ — running (`run.state==='spinning'`) = กากบาทแดง disabled:

```javascript
      var delBtn = (run.state === 'spinning')
        ? '<button class="del disabled" title="กำลัง run — กด stop ก่อนถึงจะลบได้">✖</button>'
        : '<button class="del" title="ลบโปรเจคออกจากเครื่อง">🗑</button>';
```

แล้วต่อ `delBtn` เข้า HTML การ์ด ถัดจาก `contBtn+multiBtn`:

```javascript
      return '<div class="card'+(it.driven?' live':'')+'" data-path="'+esc(it.path)+'">'
        +'<span class="star'+(it.starred?' on':'')+'" role="button" title="ปักดาว / เอาดาวออก">'+(it.starred?'★':'☆')+'</span>'
        +'<div style="flex:1"><button class="pick"><span class="cname">'+esc(it.name)+chip+'</span>'
        +'<span class="csub">'+sub+'</span></button>'+gitEditor(it.git)+'</div>'
        +contBtn+multiBtn+delBtn
        +'<span class="git-cell">'+gitCell(it.git)+'</span></div>';
```

- [ ] **Step 7: เพิ่ม `.del` ใน row-click skip list + wire ปุ่มลบ**

ในตัว row-click guard เพิ่ม `.del`:

```javascript
        if (e.target.closest('.git-act') || e.target.closest('.git-editor') || e.target.closest('.star') || e.target.closest('.cont') || e.target.closest('.del')) return;
```

ในบล็อก `querySelectorAll('.card').forEach` (ถัดจาก wiring ของ `.cont`) เพิ่ม:

```javascript
      var delEl=card.querySelector('.del:not(.disabled)');
      if(delEl) delEl.addEventListener('click',function(e){ e.stopPropagation(); post('delete_project',{path:path}); });
```

- [ ] **Step 8: typecheck + เทสเดิมไม่พัง**

Run: `cd extension && bun test && bun run compile`
Expected: PASS ทั้งหมด (รวม `deleteProject.test.ts` จาก Task 1) + compile ผ่านไม่มี TS error

- [ ] **Step 9: verify F5 end-to-end (ตาม mc-orches-dev-verify)**

1. F5 reload extension → เปิดหน้า orchestrator (⏮ ทำต่อ)
2. กด **✏️ Edit** → การ์ดทุกใบโผล่ปุ่ม 🗑 (การ์ดที่ run อยู่ = ✖ สีเทา กดไม่ได้)
3. กด 🗑 บนโปรเจค done เก่า (เช่น `agentskill-marketplace-v5` ที่ว่าง) → modal "ลบ ... ถาวร?" → ลบถาวร → พิมพ์ชื่อผิด = ปุ่มไม่ให้ผ่าน / พิมพ์ถูก → ลบ
4. ยืนยัน: การ์ดหายจากหน้า + `ls projects/agentskill-marketplace-v5` = ไม่มีแล้ว + โปรเจคอื่นอยู่ครบ
5. ยืนยัน GitHub repo (ถ้ามี) ยังอยู่ (ไม่ถูกแตะ) — `gh repo list` หรือเปิดเว็บ
6. ลองกด ✖ บนการ์ดที่ run อยู่ → กดไม่ได้

- [ ] **Step 10: commit**

```bash
cd /home/chillox-intern/Desktop/soulbrew/github.com/fufu-2345/missionControl
git add extension/src/webview/orchestrator.ts
git commit -m "feat: delete-project button (Edit mode) on orchestrator screen"
```

---

## Self-Review

**Spec coverage:**
- UX (Edit toggle → ปุ่มลบ → running=red-X → modal → type-name → ลบ → การ์ดหาย) → Task 2 Steps 4-7, 9 ✓
- Scope local-only, ไม่แตะ GitHub → Task 1 `removeProjectDir` (fs.rm เท่านั้น) + Task 2 ไม่เรียก gh ✓
- path guard (child-of-projects, symlink, dir) → Task 1 `canDeleteProjectPath` + tests ✓
- running guard 2 ชั้น → webview `run.state==='spinning'` disabled (Task 2 Step 6) + extension `isRunning()` re-check (Step 2) ✓
- type-to-confirm → `confirmNameMatches` + tests + `showInputBox.validateInput` ✓
- native dialogs → `showWarningMessage`+`showInputBox` (Step 2) ✓

**Placeholder scan:** ไม่มี TBD/TODO; ทุก step มีโค้ดจริง ✓

**Type consistency:** `canDeleteProjectPath`/`confirmNameMatches`/`removeProjectDir` (Task 1) ใช้ชื่อ+ลายเซ็นตรงกับที่ import ใน Task 2 ✓ · `run.state==='spinning'` ตรงกับ payload `run:{state}` ที่ `pushProjectsScreen` ส่ง ✓ · message `delete_project{path}` ตรงกับ handler `case "delete_project"` อ่าน `msg.path` ✓

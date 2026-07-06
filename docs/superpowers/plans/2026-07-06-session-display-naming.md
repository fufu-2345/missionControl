# Session Display Naming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ให้ session ที่กำลังทำ project แสดงเป็น `<project> / <team>` (แทนชื่อ tmux ดิบ `09-foreman`) ทั้งใน missionControl dashboard และ tmux status bar

**Architecture:** display-only overlay — ชื่อ tmux จริงไม่เปลี่ยน (attach/maw/session-pin ไม่พัง) · แหล่งความจริงเดียว = tmux user-option `@orches_label` (orchestrator/extension เขียน) อ่านโดย 2 surface · dashboard มี fallback แบบ pure ที่ unit-test ได้ (cwd-scan → lone-oracle → ชื่อดิบ)

**Tech Stack:** TypeScript (VSCode extension), bun:test (unit), tmux CLI, bash (orches-drive skill)

## Global Constraints

- **Separator = ` / ` เป๊ะ** (space-slash-space) ทั้ง label project และ lone-oracle
- **Label เป็น display-only** — ห้ามใช้เป็นชื่อ session จริง; attach/kill ต้องยิงด้วย `s.name` ดิบเสมอ (data-name / data-kill ไม่เปลี่ยน)
- **ไม่แก้ maw source** และ **ไม่แตะไฟล์ extension อื่นที่มี uncommitted changes ค้างอยู่** — แตะเฉพาะไฟล์ที่ระบุในแต่ละ task
- `sessions.ts` ต้อง **ไม่ import vscode** (unit-test standalone ด้วย bun) — type จาก teams ใช้ `import type` เท่านั้น
- ฟิลด์ใหม่บน `TmuxSession` (`orchesLabel`, `label`) เป็น optional
- spec อ้างอิง: `docs/superpowers/specs/2026-07-06-session-display-naming-design.md`

---

### Task 1: Pure sessions layer — `@orches_label` field + label computation

ไฟล์ pure ที่ unit-test ได้ทั้งหมด — เป็น core ของ feature

**Files:**
- Modify: `extension/src/webview/sessions.ts`
- Test: `extension/src/webview/sessions.test.ts`

**Interfaces:**
- Consumes: `OracleTeam` (type-only) จาก `../commands/teams` — `{ name: string; members: {oracle:string; role:string}[]; orchestrators: string[] }`
- Produces (ใช้โดย Task 2):
  - `TmuxSession` เพิ่ม `orchesLabel?: string` และ `label?: string`
  - `projectFromPaths(paths: string[]): { name: string; path: string } | null`
  - `loneOracleName(session: TmuxSession, knownOracles: string[]): string | null`
  - `teamOfOracle(oracle: string, teams: OracleTeam[]): string | null`
  - `computeSessionLabel(args: { orchesLabel?: string; project?: { name: string; team?: string }; loneOracle?: { oracle: string; team?: string }; rawName: string }): string`
  - `parseOraclesJson(raw: string): string[]`

- [ ] **Step 1: อัปเดต test เดิมของ `parseTmuxSessions` ให้เป็น 6-field (จะ fail เพราะ format ยังเป็น 5-field)**

แก้ใน `extension/src/webview/sessions.test.ts` — test แรก (บรรทัด 5-11) เป็น:

```ts
test("parseTmuxSessions parses tab-separated session lines (with orches label col)", () => {
  const raw =
    "carbon\t2\t1\tclaude\t\t/home/u/bob\n" +
    "soulbrew\t1\t0\tbash\tsci-calc / brew\t/home/u/sb";
  expect(parseTmuxSessions(raw)).toEqual([
    { name: "carbon", windows: 2, attached: true, cmd: "claude", cwd: "/home/u/bob" },
    { name: "soulbrew", windows: 1, attached: false, cmd: "bash", orchesLabel: "sci-calc / brew", cwd: "/home/u/sb" },
  ]);
});
```

- [ ] **Step 2: รัน test ให้เห็นว่า fail**

Run: `cd extension && bun test src/webview/sessions.test.ts`
Expected: FAIL — carbon.cwd ได้ `""` (parse ยังตัด cwd ที่ index 4), soulbrew ไม่มี orchesLabel

- [ ] **Step 3: แก้ `TMUX_FMT` + `TmuxSession` + `parseTmuxSessions`**

ใน `extension/src/webview/sessions.ts` — เพิ่ม type-only import ที่ต้นไฟล์ (หลัง comment header):

```ts
import type { OracleTeam } from "../commands/teams";
```

แก้ interface `TmuxSession` (บรรทัด 4-10) เพิ่ม 2 ฟิลด์:

```ts
export interface TmuxSession {
  name: string;
  windows: number;
  attached: boolean;
  cmd: string; // active pane's current command (claude / maw / bash …)
  cwd: string; // active pane's current path
  orchesLabel?: string; // tmux user-option @orches_label (authoritative display label)
  label?: string; // computed display label (Task 2 fills this in the extension host)
}
```

แก้ `TMUX_FMT` (บรรทัด 14-15) — แทรก `@orches_label` เป็นคอลัมน์ก่อน `pane_current_path` (cwd ต้องอยู่ท้ายสุดเพราะ parse ใช้ `slice()` กัน tab ใน path):

```ts
export const TMUX_FMT =
  "#{session_name}\t#{session_windows}\t#{session_attached}\t#{pane_current_command}\t#{@orches_label}\t#{pane_current_path}";
```

แก้ `parseTmuxSessions` (บรรทัด 19-36) — orchesLabel=parts[4], cwd=slice(5):

```ts
export function parseTmuxSessions(raw: string): TmuxSession[] {
  const out: TmuxSession[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 5) continue;
    const name = parts[0];
    if (!name) continue;
    out.push({
      name,
      windows: Number.parseInt(parts[1], 10) || 0,
      attached: parts[2] === "1",
      cmd: parts[3] ?? "",
      orchesLabel: parts[4] || undefined,
      cwd: parts.slice(5).join("\t"),
    });
  }
  return out;
}
```

- [ ] **Step 4: รัน test ให้ parse ผ่าน**

Run: `cd extension && bun test src/webview/sessions.test.ts`
Expected: PASS (test parse ผ่าน; test อื่นที่มีอยู่ยังผ่าน)

- [ ] **Step 5: เขียน test ของ 4 pure helpers (จะ fail — ยังไม่มีฟังก์ชัน)**

เพิ่มท้าย `extension/src/webview/sessions.test.ts`:

```ts
import {
  projectFromPaths,
  loneOracleName,
  teamOfOracle,
  computeSessionLabel,
  parseOraclesJson,
} from "./sessions";

test("parseOraclesJson returns oracle names, tolerant of junk", () => {
  expect(parseOraclesJson('{"oracles":[{"name":"bob"},{"name":"foreman"},{"x":1}]}')).toEqual(["bob", "foreman"]);
  expect(parseOraclesJson("not json")).toEqual([]);
  expect(parseOraclesJson("{}")).toEqual([]);
});

test("projectFromPaths finds a projects/<name> dir from any pane cwd", () => {
  expect(projectFromPaths(["/x/foreman-oracle", "/x/projects/scientific-calculator/agents/frontend"]))
    .toEqual({ name: "scientific-calculator", path: "/x/projects/scientific-calculator" });
  expect(projectFromPaths(["/x/projects/rpn"])).toEqual({ name: "rpn", path: "/x/projects/rpn" });
  expect(projectFromPaths(["/home/u/foreman-oracle"])).toBeNull();
  expect(projectFromPaths([])).toBeNull();
});

test("loneOracleName: single window whose name resolves to a known oracle", () => {
  const oracles = ["bob", "foreman"];
  expect(loneOracleName({ name: "05-bob", windows: 1, attached: false, cmd: "claude", cwd: "" }, oracles)).toBe("bob");
  expect(loneOracleName({ name: "claude-bob", windows: 1, attached: false, cmd: "claude", cwd: "" }, oracles)).toBe("bob");
  // multi-window → not a lone oracle
  expect(loneOracleName({ name: "05-bob", windows: 3, attached: false, cmd: "claude", cwd: "" }, oracles)).toBeNull();
  // unknown stem → null
  expect(loneOracleName({ name: "claude-soulbrew", windows: 1, attached: false, cmd: "bash", cwd: "" }, oracles)).toBeNull();
});

test("teamOfOracle picks first team by name containing the oracle", () => {
  const teams = [
    { name: "carbon", members: [{ oracle: "bob", role: "member" }], orchestrators: [] },
    { name: "brew", members: [{ oracle: "bob", role: "member" }], orchestrators: [] },
    { name: "orch-dev", members: [{ oracle: "foreman", role: "orchestrator" }], orchestrators: ["foreman"] },
  ];
  expect(teamOfOracle("bob", teams)).toBe("brew"); // alphabetical: brew < carbon
  expect(teamOfOracle("mike", teams)).toBeNull();
});

test("computeSessionLabel priority: orchesLabel > project > loneOracle > rawName", () => {
  // rule 1
  expect(computeSessionLabel({ orchesLabel: "sci-calc / brew", rawName: "09-foreman" })).toBe("sci-calc / brew");
  expect(computeSessionLabel({ orchesLabel: "  ", project: { name: "p" }, rawName: "r" })).toBe("p"); // blank label ignored
  // rule 2
  expect(computeSessionLabel({ project: { name: "rpn", team: "brew" }, rawName: "09-foreman" })).toBe("rpn / brew");
  expect(computeSessionLabel({ project: { name: "rpn" }, rawName: "09-foreman" })).toBe("rpn"); // no team
  // rule 3
  expect(computeSessionLabel({ loneOracle: { oracle: "bob", team: "brew" }, rawName: "05-bob" })).toBe("brew / bob");
  expect(computeSessionLabel({ loneOracle: { oracle: "bob" }, rawName: "05-bob" })).toBe("bob"); // no team
  // rule 4
  expect(computeSessionLabel({ rawName: "claude-soulbrew" })).toBe("claude-soulbrew");
});
```

- [ ] **Step 6: รัน test ให้เห็นว่า fail**

Run: `cd extension && bun test src/webview/sessions.test.ts`
Expected: FAIL — helpers ยังไม่ export

- [ ] **Step 7: เขียน 4 helpers ใน `sessions.ts`**

เพิ่มท้าย `extension/src/webview/sessions.ts`:

```ts
/** First pane cwd sitting under a `.../projects/<name>` dir → that project's
 *  name + root path. Used to label a session by the project it is building. */
export function projectFromPaths(paths: string[]): { name: string; path: string } | null {
  for (const p of paths) {
    const m = p.match(/^(.*\/projects\/([^/]+))(?:\/|$)/);
    if (m) return { path: m[1], name: m[2] };
  }
  return null;
}

/** A session that is a single woken oracle → that oracle's name. Only when it
 *  has exactly one window and its name (`NN-<oracle>` / `claude-<oracle>` /
 *  bare) resolves to a known oracle. */
export function loneOracleName(session: TmuxSession, knownOracles: string[]): string | null {
  if (session.windows !== 1) return null;
  const stem = session.name.replace(/^\d+-/, "").replace(/^claude-/, "");
  return knownOracles.includes(stem) ? stem : null;
}

/** The team an oracle belongs to — first team by name (deterministic). null
 *  when the oracle is in no team. */
export function teamOfOracle(oracle: string, teams: OracleTeam[]): string | null {
  const hit = [...teams]
    .sort((a, b) => a.name.localeCompare(b.name))
    .find((t) => t.members.some((m) => m.oracle === oracle));
  return hit ? hit.name : null;
}

/** Priority-based display label: orches-label (authoritative) → project →
 *  lone-oracle → raw session name. Separator is " / ". */
export function computeSessionLabel(args: {
  orchesLabel?: string;
  project?: { name: string; team?: string };
  loneOracle?: { oracle: string; team?: string };
  rawName: string;
}): string {
  const lbl = args.orchesLabel?.trim();
  if (lbl) return lbl;
  if (args.project) {
    return args.project.team ? `${args.project.name} / ${args.project.team}` : args.project.name;
  }
  if (args.loneOracle) {
    return args.loneOracle.team ? `${args.loneOracle.team} / ${args.loneOracle.oracle}` : args.loneOracle.oracle;
  }
  return args.rawName;
}

/** Oracle names from ~/.maw/oracles.json content. Tolerant: junk → []. */
export function parseOraclesJson(raw: string): string[] {
  try {
    const d = JSON.parse(raw) as { oracles?: unknown };
    if (!Array.isArray(d?.oracles)) return [];
    return d.oracles
      .map((o) => (o as { name?: unknown })?.name)
      .filter((n): n is string => typeof n === "string");
  } catch {
    return [];
  }
}
```

- [ ] **Step 8: รัน test ให้ผ่านทั้งหมด**

Run: `cd extension && bun test src/webview/sessions.test.ts`
Expected: PASS ทุก test

- [ ] **Step 9: Commit**

```bash
cd /home/chillox-intern/Desktop/soulbrew/github.com/fufu-2345/missionControl
git add extension/src/webview/sessions.ts extension/src/webview/sessions.test.ts
git commit -m "feat(sessions): pure @orches_label parse + project/lone-oracle label helpers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Wire label into dashboard (host + webview render)

**Files:**
- Modify: `extension/src/webview/dashboard.ts` (`pushSessions` ~544-548, `renderSessions` client ~955-960, imports ~24-30)

**Interfaces:**
- Consumes: `projectFromPaths`, `loneOracleName`, `teamOfOracle`, `computeSessionLabel`, `parseOraclesJson`, `TMUX_FMT`, `parseTmuxSessions` (Task 1); `parseTeamRoster`, `type OracleTeam` จาก `../commands/teams`; `parseOrchesMeta` จาก `../commands/orchestratorResume`
- Produces: session rows แสดง `s.label`; ไม่มี type ใหม่ให้ task อื่นใช้

- [ ] **Step 1: เพิ่ม import + reader helpers (host side) ใน `dashboard.ts`**

ที่ต้นไฟล์ ตรวจว่ามี `import * as cp from "child_process"` (มีอยู่แล้ว — ใช้ `cp.execFile`). เพิ่ม (ถ้ายังไม่มี):

```ts
import * as fs from "fs";
import * as path from "path";
import { homedir } from "os";
```

ในบล็อก import จาก `./sessions` (บรรทัด ~24-30) เพิ่มชื่อ helper:

```ts
import {
  TMUX_FMT,
  type TmuxSession,
  isSafeSessionName,
  parseTmuxSessions,
  projectFromPaths,
  loneOracleName,
  teamOfOracle,
  computeSessionLabel,
  parseOraclesJson,
} from "./sessions";
```

เพิ่ม import จาก commands:

```ts
import { parseTeamRoster, type OracleTeam } from "../commands/teams";
import { parseOrchesMeta } from "../commands/orchestratorResume";
```

เพิ่ม 4 reader helper (host, best-effort — วางใกล้ `listTmuxSessions` ~535):

```ts
/** Group every pane's cwd by tmux session (one tmux call). */
function listPanePathsBySession(): Promise<Record<string, string[]>> {
  return new Promise((resolve) => {
    cp.execFile("tmux", ["list-panes", "-a", "-F", "#{session_name}\t#{pane_current_path}"], { timeout: 700 }, (err, stdout) => {
      const map: Record<string, string[]> = {};
      if (err) return resolve(map);
      for (const line of stdout.toString().split(/\r?\n/)) {
        const i = line.indexOf("\t");
        if (i < 0) continue;
        (map[line.slice(0, i)] ||= []).push(line.slice(i + 1));
      }
      resolve(map);
    });
  });
}

/** Oracle names from ~/.maw/oracles.json (best-effort → []). */
function readKnownOracles(): string[] {
  try {
    return parseOraclesJson(fs.readFileSync(path.join(homedir(), ".maw", "oracles.json"), "utf8"));
  } catch {
    return [];
  }
}

/** All team rosters from ~/.maw/teams/*/oracle-members.json (best-effort → []). */
function readTeamRosters(): OracleTeam[] {
  const dir = path.join(homedir(), ".maw", "teams");
  const out: OracleTeam[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    try {
      const raw = fs.readFileSync(path.join(dir, name, "oracle-members.json"), "utf8");
      const t = parseTeamRoster(name, raw);
      if (t) out.push(t);
    } catch {
      /* team has no oracle-members.json — skip */
    }
  }
  return out;
}

/** team จาก <project>/.orches-meta.json (best-effort → undefined). */
function readProjectTeam(projectPath: string): string | undefined {
  try {
    const raw = fs.readFileSync(path.join(projectPath, ".orches-meta.json"), "utf8");
    return parseOrchesMeta(raw)?.team || undefined;
  } catch {
    return undefined;
  }
}
```

> `parseOraclesJson` (pure, มี test แล้วใน Task 1) คืนรายชื่อ oracle ทั้งหมด — ต่างจาก `parseOraclePath` ที่หา path ของ oracle ทีละชื่อ

- [ ] **Step 2: แก้ `pushSessions` ให้คำนวณ label ต่อ session**

แทนที่ `pushSessions` (บรรทัด ~544-548) ด้วย:

```ts
async function pushSessions(panel: vscode.WebviewPanel): Promise<void> {
  const sessions = await listTmuxSessions();
  _lastSessionNames = new Set(sessions.map((s) => s.name));
  const panePaths = await listPanePathsBySession();
  const oracles = readKnownOracles();
  const teams = readTeamRosters();
  for (const s of sessions) {
    const paths = panePaths[s.name] || [s.cwd];
    const proj = projectFromPaths(paths);
    const lone = proj ? null : loneOracleName(s, oracles);
    s.label = computeSessionLabel({
      orchesLabel: s.orchesLabel,
      project: proj ? { name: proj.name, team: readProjectTeam(proj.path) } : undefined,
      loneOracle: lone ? { oracle: lone, team: teamOfOracle(lone, teams) ?? undefined } : undefined,
      rawName: s.name,
    });
  }
  panel.webview.postMessage({ type: "sessions", sessions });
}
```

- [ ] **Step 3: แก้ `renderSessions` (client) ให้โชว์ label + ชื่อดิบใน subtitle**

ใน `dashboard.ts` client script — แก้ `.sname` (บรรทัด ~959) และ `.ssub` (บรรทัด ~960):

```js
      + '<span class="sname">' + escapeHtml(s.label || s.name) + '</span>'
      + '<span class="ssub">' + escapeHtml((s.label && s.label !== s.name ? s.name + ' · ' : '') + s.windows + ' win · ' + s.cmd + '  ' + s.cwd) + '</span>'
```

> `data-name` (บรรทัด 956) และ `data-kill` (บรรทัด 962) **คงเป็น `s.name` ดิบ** — attach/kill ไม่เปลี่ยน

- [ ] **Step 4: compile ผ่าน**

Run: `cd extension && pnpm run compile`
Expected: `tsc -p ./` จบโดยไม่มี error

- [ ] **Step 5: verify ของจริง (manual, ต้องเห็นพฤติกรรม)**

```bash
# หา session ทดสอบ (หรือใช้ session ที่มีอยู่) แล้ว set label ปลอม
tmux set -t "=09-foreman" @orches_label "scientific-calculator / brew"
```
Reload extension (Developer: Reload Window / รันใหม่) → เปิด dashboard → row `09-foreman` ต้องโชว์หัวข้อ **`scientific-calculator / brew`** และ subtitle ขึ้นต้นด้วย `09-foreman ·` · คลิก row = attach เข้า `09-foreman` (ชื่อจริง) ได้ปกติ
```bash
tmux set -u -t "=09-foreman" @orches_label   # ลบ label
```
Reload → row กลับไปโชว์ `09-foreman` (fallback)

- [ ] **Step 6: Commit**

```bash
cd /home/chillox-intern/Desktop/soulbrew/github.com/fufu-2345/missionControl
git add extension/src/webview/dashboard.ts extension/src/webview/sessions.ts extension/src/webview/sessions.test.ts
git commit -m "feat(dashboard): show project / team label for sessions (reads @orches_label + cwd fallback)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: orches-drive skill sets `@orches_label` at run start

**Files:**
- Modify: `/home/chillox-intern/Desktop/soulbrew/github.com/fufu-2345/orches-skills/skills/orches-drive/SKILL.md` (Step 4.0 area)

**Interfaces:**
- Consumes: `$SELF` (session ของ orchestrator), `<project>` (absolute path), team จาก `<project>/.orches-meta.json`
- Produces: ไม่มี type — set tmux option `@orches_label` = `<project> / <team>` บน session ของ orchestrator

- [ ] **Step 1: เพิ่มบล็อก set-label ใน Step 4.0**

เปิด `skills/orches-drive/SKILL.md` หา Step 4.0 (`ensure project repo`). เพิ่มบล็อกนี้ต่อท้าย Step 4.0 (self-contained เพราะ shell state ไม่ persist ข้าม Bash call):

````markdown
**4.0a ตั้งชื่อ session ให้ dashboard/tmux โชว์ว่า "ทำ project อะไร" (display-only):**
```bash
SELF="$(tmux display-message -p -t "$TMUX_PANE" '#{session_name}' 2>/dev/null || tmux display-message -p '#{session_name}')"
PROJ="$(cd '<project>' && pwd)"
TEAM="$(python3 -c "import json;print(json.load(open('$PROJ/.orches-meta.json')).get('team',''))" 2>/dev/null)"
tmux set -t "=$SELF" @orches_label "$(basename "$PROJ")${TEAM:+ / $TEAM}"
```
> ตั้ง tmux user-option (ไม่ใช่ rename session — attach/maw ไม่พัง) · dashboard + tmux status bar อ่าน `@orches_label` ตัวนี้ → เห็นเป็น `<project> / <team>` · TEAM ว่าง = โชว์แค่ project
````

- [ ] **Step 2: verify snippet ทำงานจริง (dry-run บน scratch session)**

```bash
tmux new-session -d -s wtest -c /home/chillox-intern/Desktop/soulbrew/github.com/fufu-2345/projects/scientific-calculator
# จำลองบล็อก (แทน $TMUX_PANE ด้วย target ตรงๆ):
SELF=wtest
PROJ="$(cd /home/chillox-intern/Desktop/soulbrew/github.com/fufu-2345/projects/scientific-calculator && pwd)"
TEAM="$(python3 -c "import json;print(json.load(open('$PROJ/.orches-meta.json')).get('team',''))" 2>/dev/null)"
tmux set -t "=$SELF" @orches_label "$(basename "$PROJ")${TEAM:+ / $TEAM}"
tmux show -t "=$SELF" -v @orches_label   # ต้องได้: scientific-calculator / brew
tmux kill-session -t "=wtest"
```
Expected: พิมพ์ `scientific-calculator / brew`

- [ ] **Step 3: Commit (orches-skills repo)**

```bash
cd /home/chillox-intern/Desktop/soulbrew/github.com/fufu-2345/orches-skills
git add skills/orches-drive/SKILL.md
git commit -m "orches-drive: set @orches_label (<project> / <team>) so dashboard+tmux show the project

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: tmux status bar reads `@orches_label`

**Files:**
- Modify: `/home/chillox-intern/.tmux.conf` (บรรทัด 19-20)

**Interfaces:**
- Consumes: tmux user-option `@orches_label` (ตั้งโดย Task 3 / extension)
- Produces: status-left แสดง label ถ้ามี ไม่งั้น `#S`

- [ ] **Step 1: แก้ status-left + status-left-length**

แทนบรรทัด 19-20 ใน `/home/chillox-intern/.tmux.conf`:

```
set -g status-left-length 60
set -g status-left "#[bg=colour110,fg=colour236,bold] #{?@orches_label,#{@orches_label},#S} #[bg=colour236,fg=colour110] "
```

- [ ] **Step 2: reload + verify ทั้งสองทาง (มี label / ไม่มี label)**

```bash
tmux source-file ~/.tmux.conf
tmux new-session -d -s wtest2
tmux set -t "=wtest2" @orches_label "scientific-calculator / brew"
tmux display-message -p -t "=wtest2" '#{S:#{?@orches_label,#{@orches_label},#S}}' 2>/dev/null || \
  echo "check status bar of wtest2 shows: scientific-calculator / brew"
# ไม่มี label → fallback ชื่อ session:
tmux set -u -t "=wtest2" @orches_label
echo "check status bar of wtest2 now shows: wtest2"
tmux kill-session -t "=wtest2"
```
Expected: มี label → status bar โชว์ `scientific-calculator / brew`; ลบแล้ว → โชว์ `wtest2` · session อื่น (ไม่มี option) ไม่เปลี่ยน

> `~/.tmux.conf` ไม่ใช่ repo — ไม่ commit (มี backup: `cp ~/.tmux.conf ~/.tmux.conf.bak` ก่อนแก้ ถ้าอยากกันพลาด)

---

## Notes / transitional

- **`09-foreman` ที่รันอยู่ตอนนี้**: ยังไม่มี `@orches_label` (skill ยังไม่ re-run) และ cwd-scan จับไม่ได้ (pane เดียว cwd=foreman-oracle, worker แยกไป -2) → จะตกที่ lone-oracle → โชว์ `brew / foreman` (foreman เป็น orchestrator ของ brew — ไม่ผิด แค่ยังไม่ใช่ชื่อ project) · จะได้ `scientific-calculator / brew` เมื่อ (a) orchestrator รัน Step 4.0a รอบ drive ถัดไป หรือ (b) worker กลับมา session เดียว (ผล session-pin fix) — ตรงกับ caveat ใน spec
- extension มี uncommitted changes ค้างเก่า — ทุก commit ใน task add เฉพาะไฟล์ที่ระบุ
- **spec เสนอให้ `startOrchestrator.ts` `launchOrchestrator` ตั้ง `@orches_label` ตอน launch ด้วย — plan นี้ตัดออก** เพราะ (1) `startOrchestrator.ts` มี uncommitted changes ค้างอยู่ → `git add` ไฟล์นี้จะกวาด commit ของเก่าติดไป (ผิดกติกา ห้าม commit งานค้างของคนอื่น) · (2) Task 3 (skill Step 4.0a) ตั้ง label ให้ตั้งแต่ต้น drive อยู่แล้ว = single writer พอ · ถ้าอยากให้ label ขึ้นเร็วขึ้นตั้งแต่ launch (ก่อน discuss เสร็จ) ค่อยทำเป็น follow-up หลัง startOrchestrator.ts เคลียร์ของค้างแล้ว

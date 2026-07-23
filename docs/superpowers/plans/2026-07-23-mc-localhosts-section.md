# Localhosts Section Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Localhosts" section to the Mission Control sidebar that lists running dev servers grouped by project, opens each URL in a browser, and stops all of a project's servers with one button.

**Architecture:** Port-centric detection — parse `ss -ltnp`, resolve each listener's `/proc/<pid>/cwd`, and group by the project directory that contains it. Pure parsing/grouping/guardrail functions live in `localhostScan.ts` and `localhostKill.ts` and are unit-tested; thin impure wrappers run the actual `ss`/`ps` and kills. The sidebar webview (`sidebar.ts`) renders the groups and talks to the extension via `postMessage`.

**Tech Stack:** TypeScript, VS Code extension API, Node `child_process`/`fs`, `bun test`.

## Global Constraints

- Test runner: `bun test <file>` — tests use `import { expect, test } from "bun:test"`. Copy the existing style in `src/commands/*.test.ts`.
- Compile check: `cd extension && npm run compile` (`tsc -p ./`) must pass with no errors.
- No emoji anywhere in user-visible strings (the user's terminal cannot render them). Use plain words.
- Projects root MUST be derived via `resolveOwnerRoot()` from `./startOrchestrator` — never hardcode `~/Desktop/soulbrew/...`.
- Parse `ppid`/`pgid`/`comm` via `ps -o ...` output, never `awk` on `/proc/<pid>/stat` (the `comm` field contains parens/spaces and shifts columns).
- All shell exec calls use a timeout and swallow errors to a safe empty/false default — this feature must never break the rest of the sidebar.
- All new files under `extension/src/commands/`. Repo: `missionControl`. Do not push; local commits only.

---

### Task 1: Pure scan parsers and grouping

**Files:**
- Create: `extension/src/commands/localhostScan.ts`
- Test: `extension/src/commands/localhostScan.test.ts`

**Interfaces:**
- Produces (used by Task 2 and Task 5):
  - `type Listener = { port: number; pid: number; pgid: number; comm: string; role: string }`
  - `type ProjectGroup = { project: string; entries: Listener[] }`
  - `type RawListener = { port: number; pid: number; cwd: string | null; pgid: number; comm: string }`
  - `parseSsListeners(ssOutput: string): { port: number; pid: number }[]`
  - `parsePsOutput(out: string): Map<number, { pgid: number; comm: string }>`
  - `projectFromCwd(cwd: string | null, projectsRoot: string): string | null`
  - `guessRole(comm: string, port: number): string`
  - `groupListeners(raws: RawListener[], projectsRoot: string): ProjectGroup[]`

- [ ] **Step 1: Write the failing test**

Create `extension/src/commands/localhostScan.test.ts`:

```ts
import { expect, test } from "bun:test";

import {
  parseSsListeners,
  parsePsOutput,
  projectFromCwd,
  guessRole,
  groupListeners,
  type RawListener,
} from "./localhostScan";

const ROOT = "/home/u/github.com/owner/projects";

test("parseSsListeners: extracts port+pid for ipv4/ipv6, skips root-owned (no pid)", () => {
  const ss = [
    "LISTEN 0 2048  0.0.0.0:8000  0.0.0.0:*  users:((\"python3\",pid=15740,fd=3))",
    "LISTEN 0 511   127.0.0.1:3000 0.0.0.0:*  users:((\"next-server\",pid=15648,fd=21))",
    "LISTEN 0 4096  [::1]:6379    [::]:*",
    "LISTEN 0 128   [::]:3350     [::]:*      users:((\"xrdp\",pid=900,fd=11))",
  ].join("\n");
  expect(parseSsListeners(ss)).toEqual([
    { port: 8000, pid: 15740 },
    { port: 3000, pid: 15648 },
    { port: 3350, pid: 900 },
  ]);
});

test("parsePsOutput: parses pid/pgid/comm incl. a comm with a space", () => {
  const out = "15740 15371 python3\n15648 15371 next-server v1\n";
  const m = parsePsOutput(out);
  expect(m.get(15740)).toEqual({ pgid: 15371, comm: "python3" });
  expect(m.get(15648)).toEqual({ pgid: 15371, comm: "next-server v1" });
});

test("projectFromCwd: inside → name, outside/null → null", () => {
  expect(projectFromCwd(`${ROOT}/learningPlatform/apps/api`, ROOT)).toBe("learningPlatform");
  expect(projectFromCwd(`${ROOT}/shopApp`, ROOT)).toBe("shopApp");
  expect(projectFromCwd("/home/u", ROOT)).toBeNull();
  expect(projectFromCwd(null, ROOT)).toBeNull();
  expect(projectFromCwd(`${ROOT}`, ROOT)).toBeNull(); // root itself, no project segment
});

test("guessRole: api vs web fallback", () => {
  expect(guessRole("uvicorn", 8000)).toBe("api");
  expect(guessRole("next-server", 3000)).toBe("web");
  expect(guessRole("node", 5173)).toBe("web");
  expect(guessRole("something", 9999)).toBe("srv");
});

test("groupListeners: groups by project, sorts, drops unattributable", () => {
  const raws: RawListener[] = [
    { port: 8000, pid: 2, cwd: `${ROOT}/learningPlatform/apps/api`, pgid: 100, comm: "uvicorn" },
    { port: 3000, pid: 1, cwd: `${ROOT}/learningPlatform/apps/web`, pgid: 100, comm: "next-server" },
    { port: 5173, pid: 3, cwd: `${ROOT}/shopApp`, pgid: 200, comm: "node" },
    { port: 9, pid: 4, cwd: "/home/u", pgid: 300, comm: "code" }, // dropped
  ];
  const groups = groupListeners(raws, ROOT);
  expect(groups.map((g) => g.project)).toEqual(["learningPlatform", "shopApp"]);
  expect(groups[0].entries.map((e) => e.port)).toEqual([3000, 8000]); // sorted by port
  expect(groups[0].entries[0]).toEqual({ port: 3000, pid: 1, pgid: 100, comm: "next-server", role: "web" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && bun test src/commands/localhostScan.test.ts`
Expected: FAIL — cannot resolve `./localhostScan` (module does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `extension/src/commands/localhostScan.ts` (parsers + grouping only; live collectors come in Task 2):

```ts
export type Listener = {
  port: number;
  pid: number;
  pgid: number;
  comm: string;
  role: string;
};
export type ProjectGroup = { project: string; entries: Listener[] };
export type RawListener = {
  port: number;
  pid: number;
  cwd: string | null;
  pgid: number;
  comm: string;
};

/** Parse `ss -ltnpH` output → [{port, pid}]. The local address is the first
 *  token ending in `:<digits>` (the peer column ends in `:*`). Lines with no
 *  `pid=` (root-owned sockets we cannot inspect) are skipped. */
export function parseSsListeners(ssOutput: string): { port: number; pid: number }[] {
  const out: { port: number; pid: number }[] = [];
  const seen = new Set<string>();
  for (const raw of ssOutput.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const pidM = /pid=(\d+)/.exec(line);
    if (!pidM) continue;
    const local = line.split(/\s+/).find((t) => /:\d+$/.test(t));
    if (!local) continue;
    const portM = /:(\d+)$/.exec(local);
    if (!portM) continue;
    const port = Number(portM[1]);
    const pid = Number(pidM[1]);
    const key = `${port}/${pid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ port, pid });
  }
  return out;
}

/** Parse `ps -o pid=,pgid=,comm=` output → Map<pid, {pgid, comm}>.
 *  comm may contain spaces, so everything after the second number is the comm. */
export function parsePsOutput(out: string): Map<number, { pgid: number; comm: string }> {
  const m = new Map<number, { pgid: number; comm: string }>();
  for (const line of out.split("\n")) {
    const mm = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!mm) continue;
    m.set(Number(mm[1]), { pgid: Number(mm[2]), comm: mm[3].trim() });
  }
  return m;
}

/** Project name if `cwd` is strictly inside `<projectsRoot>/<name>/...`, else null. */
export function projectFromCwd(cwd: string | null, projectsRoot: string): string | null {
  if (!cwd) return null;
  const prefix = projectsRoot.replace(/\/+$/, "") + "/";
  if (!cwd.startsWith(prefix)) return null;
  const name = cwd.slice(prefix.length).split("/")[0];
  return name || null;
}

/** Light label from comm/port. Best-effort only. */
export function guessRole(comm: string, port: number): string {
  const c = comm.toLowerCase();
  if (/uvicorn|gunicorn|python|flask|django/.test(c) || port === 8000) return "api";
  if (/next|vite|node|astro|webpack|remix/.test(c)) return "web";
  return "srv";
}

/** Group raw listeners by the project their cwd lives in. Drops listeners not
 *  under any project. Groups sorted by name, entries sorted by port. */
export function groupListeners(raws: RawListener[], projectsRoot: string): ProjectGroup[] {
  const byProject = new Map<string, Listener[]>();
  for (const r of raws) {
    const project = projectFromCwd(r.cwd, projectsRoot);
    if (!project) continue;
    const list = byProject.get(project) ?? [];
    list.push({ port: r.port, pid: r.pid, pgid: r.pgid, comm: r.comm, role: guessRole(r.comm, r.port) });
    byProject.set(project, list);
  }
  const groups: ProjectGroup[] = [];
  for (const [project, entries] of byProject) {
    entries.sort((a, b) => a.port - b.port);
    groups.push({ project, entries });
  }
  groups.sort((a, b) => a.project.localeCompare(b.project));
  return groups;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && bun test src/commands/localhostScan.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
cd extension && git add src/commands/localhostScan.ts src/commands/localhostScan.test.ts
git commit -m "feat: localhost scan parsers + project grouping"
```

---

### Task 2: Live scan collectors

**Files:**
- Modify: `extension/src/commands/localhostScan.ts` (append collectors)
- Test: `extension/src/commands/localhostScan.test.ts` (append a smoke test)

**Interfaces:**
- Consumes: `parseSsListeners`, `parsePsOutput`, `groupListeners` (Task 1); `resolveOwnerRoot` from `./startOrchestrator`.
- Produces (used by Task 4 and Task 5):
  - `getProjectsRoot(): string | null`
  - `collectRaw(): RawListener[]`
  - `scanLocalhosts(): ProjectGroup[]`

- [ ] **Step 1: Write the failing test**

Append to `extension/src/commands/localhostScan.test.ts`:

```ts
import { scanLocalhosts, getProjectsRoot } from "./localhostScan";

test("scanLocalhosts: returns an array and never throws", () => {
  const groups = scanLocalhosts();
  expect(Array.isArray(groups)).toBe(true);
  // getProjectsRoot is null OR an absolute path ending in /projects
  const root = getProjectsRoot();
  expect(root === null || root.endsWith("/projects")).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && bun test src/commands/localhostScan.test.ts`
Expected: FAIL — `scanLocalhosts`/`getProjectsRoot` are not exported yet.

- [ ] **Step 3: Write minimal implementation**

Append to `extension/src/commands/localhostScan.ts`:

```ts
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { resolveOwnerRoot } from "./startOrchestrator";

/** `<owner>/projects` derived portably from oracles.json, or null. */
export function getProjectsRoot(): string | null {
  const owner = resolveOwnerRoot();
  return owner ? path.join(owner, "projects") : null;
}

function ssRaw(): string {
  try {
    return cp.execSync("ss -ltnpH", { encoding: "utf8", timeout: 4000 });
  } catch {
    try {
      return cp.execSync("ss -ltnp", { encoding: "utf8", timeout: 4000 });
    } catch {
      return "";
    }
  }
}

function psRaw(pids: number[]): string {
  if (!pids.length) return "";
  try {
    return cp.execSync(`ps -o pid=,pgid=,comm= -p ${pids.join(",")}`, {
      encoding: "utf8",
      timeout: 4000,
    });
  } catch {
    return "";
  }
}

/** Enumerate listeners and enrich each with cwd/pgid/comm. Two subprocesses
 *  total (one ss, one ps). Unreadable pids (root-owned) get cwd=null and are
 *  dropped by groupListeners. */
export function collectRaw(): RawListener[] {
  const listeners = parseSsListeners(ssRaw());
  const info = parsePsOutput(psRaw(listeners.map((l) => l.pid)));
  const raws: RawListener[] = [];
  for (const { port, pid } of listeners) {
    let cwd: string | null = null;
    try {
      cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      cwd = null;
    }
    const ps = info.get(pid);
    raws.push({ port, pid, cwd, pgid: ps?.pgid ?? 0, comm: ps?.comm ?? "" });
  }
  return raws;
}

/** Full scan: listeners grouped by project. Empty array if projects root or ss
 *  is unavailable — callers render "unavailable" and move on. */
export function scanLocalhosts(): ProjectGroup[] {
  const projectsRoot = getProjectsRoot();
  if (!projectsRoot) return [];
  return groupListeners(collectRaw(), projectsRoot);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && bun test src/commands/localhostScan.test.ts`
Expected: PASS (6 tests). Also run `cd extension && npm run compile` → no errors.

- [ ] **Step 5: Commit**

```bash
cd extension && git add src/commands/localhostScan.ts src/commands/localhostScan.test.ts
git commit -m "feat: live localhost scan (ss + /proc/cwd + ps)"
```

---

### Task 3: Kill guardrails and command builder

**Files:**
- Create: `extension/src/commands/localhostKill.ts`
- Test: `extension/src/commands/localhostKill.test.ts`

**Interfaces:**
- Produces (used by Task 4):
  - `isProtectedComm(comm: string): boolean`
  - `canKillGroup(pgid: number, leaderCwd: string | null, leaderComm: string, projectsRoot: string): boolean`
  - `buildKillCmd(pgid: number, force: boolean): string`

- [ ] **Step 1: Write the failing test**

Create `extension/src/commands/localhostKill.test.ts`:

```ts
import { expect, test } from "bun:test";

import { isProtectedComm, canKillGroup, buildKillCmd } from "./localhostKill";

const ROOT = "/home/u/github.com/owner/projects";

test("isProtectedComm: shells / editor / tmux / init are protected", () => {
  ["code", "tmux", "bash", "-bash", "zsh", "sh", "systemd", "init"].forEach((c) =>
    expect(isProtectedComm(c)).toBe(true),
  );
  ["node", "next-server", "uvicorn", "python3"].forEach((c) =>
    expect(isProtectedComm(c)).toBe(false),
  );
});

test("canKillGroup: only pgid>1, non-protected leader, leader cwd under project", () => {
  expect(canKillGroup(15371, `${ROOT}/learningPlatform`, "node", ROOT)).toBe(true);
  expect(canKillGroup(15371, null, "node", ROOT)).toBe(true); // leader gone → allow (pgid>1)
  expect(canKillGroup(1, `${ROOT}/x`, "node", ROOT)).toBe(false); // pgid<=1
  expect(canKillGroup(0, `${ROOT}/x`, "node", ROOT)).toBe(false);
  expect(canKillGroup(15371, "/home/u", "node", ROOT)).toBe(false); // cwd outside project
  expect(canKillGroup(15371, `${ROOT}/x`, "code", ROOT)).toBe(false); // protected comm
});

test("buildKillCmd: TERM / KILL to the negative pgid (whole group)", () => {
  expect(buildKillCmd(15371, false)).toBe("kill -TERM -15371");
  expect(buildKillCmd(15371, true)).toBe("kill -KILL -15371");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && bun test src/commands/localhostKill.test.ts`
Expected: FAIL — cannot resolve `./localhostKill`.

- [ ] **Step 3: Write minimal implementation**

Create `extension/src/commands/localhostKill.ts` (pure guardrails first; orchestration in Task 4):

```ts
const PROTECTED_COMM = new Set([
  "code",
  "tmux",
  "tmux: server",
  "bash",
  "-bash",
  "zsh",
  "-zsh",
  "sh",
  "-sh",
  "login",
  "systemd",
  "init",
]);

/** Never signal a shell, the editor, tmux, or init. */
export function isProtectedComm(comm: string): boolean {
  return PROTECTED_COMM.has(comm.trim());
}

/** A process group is safe to kill only if it is a real group (pgid>1), its
 *  leader is not a protected process, and — when the leader is still readable —
 *  its cwd is under the projects root. A missing leader (reparented/exited) is
 *  allowed because the group was discovered via a listener whose cwd was already
 *  confirmed inside the project. */
export function canKillGroup(
  pgid: number,
  leaderCwd: string | null,
  leaderComm: string,
  projectsRoot: string,
): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  if (leaderComm && isProtectedComm(leaderComm)) return false;
  if (leaderCwd) {
    const prefix = projectsRoot.replace(/\/+$/, "") + "/";
    if (!leaderCwd.startsWith(prefix)) return false;
  }
  return true;
}

/** Signal the whole process group: `kill -SIG -<pgid>`. */
export function buildKillCmd(pgid: number, force: boolean): string {
  return `kill -${force ? "KILL" : "TERM"} -${pgid}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && bun test src/commands/localhostKill.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd extension && git add src/commands/localhostKill.ts src/commands/localhostKill.test.ts
git commit -m "feat: localhost kill guardrails + command builder"
```

---

### Task 4: Stop-all orchestration

**Files:**
- Modify: `extension/src/commands/localhostKill.ts` (append orchestration)

**Interfaces:**
- Consumes: `scanLocalhosts`, `getProjectsRoot` (Task 2); `canKillGroup`, `buildKillCmd` (Task 3).
- Produces (used by Task 5): `stopProjectLocalhosts(project: string): Promise<void>`

- [ ] **Step 1: Write the implementation**

Append to `extension/src/commands/localhostKill.ts`:

```ts
import * as cp from "node:child_process";
import * as fs from "node:fs";

import * as vscode from "vscode";

import { scanLocalhosts, getProjectsRoot } from "./localhostScan";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Read the group leader's cwd + comm (pid == pgid). Both may be missing. */
function leaderInfo(pgid: number): { cwd: string | null; comm: string } {
  let cwd: string | null = null;
  try {
    cwd = fs.readlinkSync(`/proc/${pgid}/cwd`);
  } catch {
    cwd = null;
  }
  let comm = "";
  try {
    comm = cp.execSync(`ps -o comm= -p ${pgid}`, { encoding: "utf8", timeout: 3000 }).trim();
  } catch {
    comm = "";
  }
  return { cwd, comm };
}

/** Distinct, guardrail-approved pgids for a project's current listeners. */
function killablePgids(project: string, projectsRoot: string): number[] {
  const g = scanLocalhosts().find((x) => x.project === project);
  if (!g) return [];
  const pgids = [...new Set(g.entries.map((e) => e.pgid))];
  return pgids.filter((pgid) => {
    const { cwd, comm } = leaderInfo(pgid);
    return canKillGroup(pgid, cwd, comm, projectsRoot);
  });
}

/** Confirm, then TERM every process group of the project's servers; force-KILL
 *  survivors after a grace period. Bounded to the project by process group +
 *  cwd/comm guardrails — cannot reach VS Code / tmux / the shell. */
export async function stopProjectLocalhosts(project: string): Promise<void> {
  const projectsRoot = getProjectsRoot();
  if (!projectsRoot) return;

  const group = scanLocalhosts().find((x) => x.project === project);
  if (!group || group.entries.length === 0) {
    void vscode.window.showInformationMessage(
      `Mission Control: nothing running for ${project}.`,
    );
    return;
  }

  const portList = group.entries.map((e) => `:${e.port}`).join(" ");
  const choice = await vscode.window.showWarningMessage(
    `Stop ${group.entries.length} server(s) in ${project}?  (${portList})`,
    { modal: true },
    "Stop all",
  );
  if (choice !== "Stop all") return;

  for (const pgid of killablePgids(project, projectsRoot)) {
    try {
      cp.execSync(buildKillCmd(pgid, false), { timeout: 3000 });
    } catch {
      /* group may already be gone */
    }
  }

  await sleep(2000);

  const survivors = killablePgids(project, projectsRoot);
  for (const pgid of survivors) {
    try {
      cp.execSync(buildKillCmd(pgid, true), { timeout: 3000 });
    } catch {
      /* best effort */
    }
  }

  void vscode.window.showInformationMessage(`Mission Control: stopped ${project}.`);
}
```

- [ ] **Step 2: Verify compile**

Run: `cd extension && npm run compile`
Expected: no TypeScript errors.

- [ ] **Step 3: Re-run kill tests (still green)**

Run: `cd extension && bun test src/commands/localhostKill.test.ts`
Expected: PASS (3 tests) — orchestration added no test regressions.

- [ ] **Step 4: Commit**

```bash
cd extension && git add src/commands/localhostKill.ts
git commit -m "feat: stop-all orchestration (TERM then KILL by process group)"
```

---

### Task 5: Sidebar integration

**Files:**
- Modify: `extension/src/webview/sidebar.ts`

**Interfaces:**
- Consumes: `scanLocalhosts`, `type ProjectGroup` (Task 2); `stopProjectLocalhosts` (Task 4).

- [ ] **Step 1: Add imports**

At the top of `extension/src/webview/sidebar.ts`, after the existing `import { isMawUp } from "../commands/mawServe";` line, add:

```ts
import { scanLocalhosts, type ProjectGroup } from "../commands/localhostScan";
import { stopProjectLocalhosts } from "../commands/localhostKill";
```

- [ ] **Step 2: Add a localhost poll field**

In the `SidebarProvider` class, add a timer field next to `private mawTimer?: NodeJS.Timeout;`:

```ts
  private lhTimer?: NodeJS.Timeout; // polls localhost servers for the Localhosts section
```

- [ ] **Step 3: Handle new webview messages**

In `resolveWebviewView`, inside the `onDidReceiveMessage` handler, add these branches (place them alongside the existing `open_dashboard` / `refreshProjects` branches):

```ts
      } else if (msg?.type === "ready") {
        await this.tick();
        await this.pushProjectList();
        await this.pushMaw();
        await this.pushLocalhosts();
      } else if (msg?.type === "refreshLocalhosts") {
        await this.pushLocalhosts();
      } else if (msg?.type === "openLocalhost" && typeof msg.port === "number") {
        void vscode.env.openExternal(
          vscode.Uri.parse(`http://localhost:${msg.port}`),
        );
      } else if (msg?.type === "stopProject" && typeof msg.project === "string") {
        await stopProjectLocalhosts(msg.project);
        await this.pushLocalhosts();
```

NOTE: the existing handler already has a `ready` branch — replace that existing `ready` branch with the version above (which adds the `pushLocalhosts()` call). Do not create a second `ready` branch.

- [ ] **Step 4: Start/stop the poll timer**

In `resolveWebviewView`, right after `this.mawTimer = setInterval(() => void this.pushMaw(), 5000);`, add:

```ts
    this.lhTimer = setInterval(() => void this.pushLocalhosts(), POLL_MS);
```

In the `view.onDidDispose(() => { ... })` callback, add cleanup alongside the `mawTimer` cleanup:

```ts
      if (this.lhTimer) clearInterval(this.lhTimer);
      this.lhTimer = undefined;
```

- [ ] **Step 5: Add the `pushLocalhosts` method**

Add this method to `SidebarProvider` (e.g. right after `pushMaw`):

```ts
  /** Scan localhost servers grouped by project and push them to the webview.
   *  Ready (panel) state only. Never throws — an empty list renders "none". */
  private async pushLocalhosts(): Promise<void> {
    if (!this.view || this.renderedSetup !== false) return;
    let groups: ProjectGroup[] = [];
    try {
      groups = scanLocalhosts();
    } catch {
      groups = [];
    }
    this.view.webview.postMessage({ type: "localhosts", groups });
  }
```

- [ ] **Step 6: Add the section markup to `panelHtml`**

In `panelHtml()`, add the Localhosts section right after the `Settings` button
(`<button class="btn" data-cmd="missioncontrol.settings">Settings</button>`) and
before the `<script>` tag:

```html
  <div class="nav-label lh-head">
    <span>Localhosts</span>
    <span id="lhRefresh" class="lh-refresh">refresh</span>
  </div>
  <div id="localhosts"><div class="lh-empty">scanning…</div></div>
```

- [ ] **Step 7: Add section styles to `head()`**

In `head()`, add these rules inside the `<style>` block (before `</style>`):

```css
  .lh-head { display: flex; justify-content: space-between; align-items: center; }
  .lh-refresh { cursor: pointer; opacity: 0.6; text-transform: none; letter-spacing: 0; }
  .lh-refresh:hover { opacity: 1; }
  .lh-empty { font-size: 12px; opacity: 0.55; padding: 4px 2px; }
  .lh-group { margin-bottom: 8px; }
  .lh-group-head { display: flex; justify-content: space-between; align-items: center; font-size: 12px; font-weight: 600; padding: 2px; }
  .lh-stop { cursor: pointer; color: #f85149; font-size: 11px; opacity: 0.85; }
  .lh-stop:hover { opacity: 1; }
  .lh-row { display: flex; justify-content: space-between; align-items: center; font-size: 12px; padding: 2px 2px 2px 8px; opacity: 0.9; }
  .lh-open { cursor: pointer; color: var(--vscode-textLink-foreground); }
  .lh-open:hover { text-decoration: underline; }
```

- [ ] **Step 8: Add the render script**

In `panelHtml()`, inside the existing `<script>` block, add the following just
before the final `vscode.postMessage({ type: 'ready' });` line. It renders the
groups and wires clicks via event delegation (CSP allows inline scripts here):

```javascript
  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function renderLocalhosts(groups) {
    const box = document.getElementById('localhosts');
    if (!box) return;
    if (!groups || !groups.length) {
      box.innerHTML = '<div class="lh-empty">no servers running</div>';
      return;
    }
    box.innerHTML = groups.map((g) => {
      const rows = g.entries.map((e) =>
        '<div class="lh-row"><span class="lh-open" data-port="' + e.port + '">:' +
        e.port + '  ' + esc(e.role) + '</span></div>').join('');
      return '<div class="lh-group"><div class="lh-group-head"><span>' +
        esc(g.project) + '</span><span class="lh-stop" data-project="' +
        esc(g.project) + '">Stop all</span></div>' + rows + '</div>';
    }).join('');
  }
  document.getElementById('localhosts').addEventListener('click', (ev) => {
    const open = ev.target.closest('.lh-open');
    if (open) {
      vscode.postMessage({ type: 'openLocalhost', port: Number(open.dataset.port) });
      return;
    }
    const stop = ev.target.closest('.lh-stop');
    if (stop) {
      vscode.postMessage({ type: 'stopProject', project: stop.dataset.project });
    }
  });
  document.getElementById('lhRefresh').addEventListener('click', () => {
    vscode.postMessage({ type: 'refreshLocalhosts' });
  });
```

Also extend the existing `window.addEventListener('message', ...)` handler so it
also handles the `localhosts` message. The existing handler returns early unless
`m.type === 'maw'`; change it to handle both:

```javascript
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m) return;
    if (m.type === 'maw') {
      const b = document.getElementById('mawToggle');
      if (!b) return;
      b.textContent = m.up ? 'Stop maw ui' : 'Start maw ui';
      b.classList.toggle('on', !!m.up);
    } else if (m.type === 'localhosts') {
      renderLocalhosts(m.groups);
    }
  });
```

- [ ] **Step 9: Verify compile**

Run: `cd extension && npm run compile`
Expected: no TypeScript errors.

- [ ] **Step 10: Manual verification (live)**

1. Reload the VS Code window (Developer: Reload Window) so the extension host
   picks up the rebuilt `out/`.
2. Ensure at least one project dev server is running (e.g. a project with a live
   `:3000`/`:8000`).
3. Open the Mission Control sidebar → the Localhosts section lists the project
   with its ports.
4. Click a port → it opens `http://localhost:<port>` in the browser.
5. Click "Stop all" → confirm the modal → the servers stop and the section
   refreshes to remove them (verify with `ss -ltnp` that the ports are gone and
   that VS Code / tmux are unaffected).

- [ ] **Step 11: Commit**

```bash
cd extension && git add src/webview/sidebar.ts
git commit -m "feat: Localhosts section in the MC sidebar"
```

---

## Self-Review Notes

- **Spec coverage:** detection (Tasks 1-2), grouping-by-project (Task 1 `groupListeners`), open-in-browser (Task 5 `openLocalhost`), Stop-all kills whole group with confirm + guardrails (Tasks 3-4), placement in the `missioncontrol.panel` sidebar (Task 5), refresh via poll + button (Task 5), error handling / graceful empty (Tasks 2 & 5), tests (Tasks 1-3). All covered.
- **Defaults from the design** are implemented: external browser; only projects with a live listener shown (groupListeners drops the rest); no "Other" group.
- **Types** are consistent across tasks: `ProjectGroup`/`Listener`/`RawListener` defined in Task 1 and reused; `scanLocalhosts`/`getProjectsRoot` from Task 2; `canKillGroup`/`buildKillCmd` from Task 3; `stopProjectLocalhosts` from Task 4 consumed in Task 5.

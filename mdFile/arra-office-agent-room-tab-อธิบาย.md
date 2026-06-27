# ARRA Office — agent / room / tab ต่างกันยังไง

> สรุปจากการอ่านโค้ดจริงของ `maw-ui` (frontend) และ `maw-js` (backend)
> แถบบนสุดของหน้า Office โชว์ `N agents · M rooms · K tabs` — เอกสารนี้อธิบายว่าแต่ละเลขมาจากไหน

---

## TL;DR

| เลข | คือ | นับจาก | โค้ด |
|---|---|---|---|
| **room** | tmux **session** | `sessions.length` | [App.tsx:464](../github.com/Soul-Brews-Studio/maw-ui/src/App.tsx#L464) |
| **tab** | tmux **window** (รวมทุก session) | `Σ windows.length` | [App.tsx:465](../github.com/Soul-Brews-Studio/maw-ui/src/App.tsx#L465) |
| **agent** | window ตัวเดิม แต่มองในมุม "ช่อง AI ที่มี status" | `agents.length` (= 1 ต่อ window) | [App.tsx:463](../github.com/Soul-Brews-Studio/maw-ui/src/App.tsx#L463) |

**จุดสำคัญ: 1 window = 1 agent เป๊ะ ๆ** ไม่ได้แตกตาม pane

---

## agent กับ tab คือของชุดเดียวกัน

ใน UI นี้ agent ถูกสร้างจาก window ตรง ๆ — [useSessions.ts:252-275](../github.com/Soul-Brews-Studio/maw-ui/src/hooks/useSessions.ts#L252-L275):

```js
const agents = sessions.flatMap((s) =>
  s.windows.map((w) => ({
    target: `${s.name}:${w.index}`,   // key = session:windowIndex
    name: w.name,
    session: s.name,
    windowIndex: w.index,
    status: statuses[key] || "idle",  // มาจาก feed แบบ realtime
    ...
  }))
);
```

`flatMap → windows.map` แปลว่า **หนึ่ง window สร้าง agent หนึ่งตัวพอดี** ดังนั้น:

> **agent count == tab count เสมอ** ในมุมมองปกติ
> เพราะเลขสองตัวลากมาจากชุด window เดียวกัน

มองง่าย ๆ: window เดียวกัน
- มองเป็น "หน้าต่าง terminal" → เรียก **tab**
- มองเป็น "AI ที่มีสถานะ (idle/busy/...)" → เรียก **agent**

### ต่างกันได้กรณีเดียว: filter local / remote

`agentCount` เคารพ filter (local / remote / all) แต่ `tabCount` นับทุก window เสมอ — [App.tsx:373-376](../github.com/Soul-Brews-Studio/maw-ui/src/App.tsx#L373-L376):

```js
if (sourceFilter === "local")  return agents.filter(a => !a.source);
if (sourceFilter === "remote") return agents.filter(a => !!a.source);
```

ตอนกด filter → agentCount ลดลง แต่ tabCount เท่าเดิม → สองเลขจะต่างกัน

---

## ความเข้าใจผิดที่เจอบ่อย

| เดาว่า... | จริง ๆ คือ |
|---|---|
| tab = pane | ❌ tab = **window** — pane (จากการ `maw tile` แตกจอ) UI นี้ **ไม่นับแยก** เพราะ fleet model เก็บข้อมูลแค่ระดับ window |
| agent = oracle ที่โดน wake | ❌ agent = **ทุก window** ไม่ว่าตื่นหรือหลับ — การ wake แค่เปลี่ยน `status` เป็น `busy`/`active` ไม่ได้ทำให้เลขเพิ่ม |
| ทั้งสามเป็นอัตราส่วน 1:1:1 | ❌ room ห่อหลาย window ได้ → **room (1) ⊃ tab/agent (หลาย)** |

> ทำไม fleet model ถึงเป็น window-level ไม่ใช่ pane-level?
> ดู [snapshot.ts:47-55](../github.com/Soul-Brews-Studio/maw-js/src/core/fleet/snapshot.ts#L47-L55) — `SnapshotWindow` เก็บแค่ `name` + `paneCmd` (คำสั่งของ pane ที่ active) หนึ่ง entry ต่อหนึ่ง window

---

## ลำดับชั้น (mental model)

```
Room  = tmux session       ← กล่องห่อ, มีสี + ชื่อ (Pulse, Neo, Hermes, ...)
 └─ Tab / Agent = tmux window   ← 1 window = 1 tab = 1 agent
```

เทียบออฟฟิศจริง: **Room = ห้อง, window = โต๊ะทำงาน 1 ตัว = พนักงาน 1 คน (agent)** ที่นั่งโต๊ะนั้น

---

## รายละเอียดเสริม (ของดีที่เจอระหว่างทาง)

### 1. สถานะ agent มี 4 แบบ
`PaneStatus = "ready" | "busy" | "idle" | "crashed"` — [types.ts:14](../github.com/Soul-Brews-Studio/maw-ui/src/lib/types.ts#L14)
มาจาก feed แบบ realtime ไม่ใช่ scan ครั้งเดียว

### 2. Power Level bar (แถบบนหัว RoomGrid)
นับสัดส่วน agent ที่ `busy` เทียบกับทั้งหมด — [RoomGrid.tsx:23,34-36](../github.com/Soul-Brews-Studio/maw-ui/src/components/RoomGrid.tsx#L23):
- 🟢 เขียว: busy ≤ 2
- 🟠 ส้ม: busy 3-5
- 🔴 แดง: busy > 5

### 3. แต่ละห้องมีสี + ชื่อประจำตัว
`roomStyle(sessionName)` map ชื่อ session → สี + label — [constants.ts:5-23](../github.com/Soul-Brews-Studio/maw-ui/src/lib/constants.ts#L5):
`01-pulse → Pulse (แดง)`, `03-neo → Neo (ฟ้า)`, `12-odin → Odin (ม่วง)` ฯลฯ
ถ้าเป็น session ที่ไม่รู้จัก → hash ชื่อเป็นสี fallback อัตโนมัติ

### 4. Badge บอกที่มาของห้อง
- 🟢 `local` = อยู่เครื่องนี้
- 🟣 `<hostname>` = peer ที่ federate มาจากเครื่องอื่น
ดู [RoomGrid.tsx:73-85](../github.com/Soul-Brews-Studio/maw-ui/src/components/RoomGrid.tsx#L73)

### 5. คลิก agent card → เปิด TerminalModal
`onSelectAgent` เปิดหน้าจอ terminal ของ pane นั้นให้คุมได้ทันที — [App.tsx:471](../github.com/Soul-Brews-Studio/maw-ui/src/App.tsx#L471)

### 6. ห้องว่าง
ห้องที่ไม่มี agent จะโชว์ "Empty room" — [RoomGrid.tsx:108-112](../github.com/Soul-Brews-Studio/maw-ui/src/components/RoomGrid.tsx#L108)

---

## ที่มาของข้อมูล (data flow)

```
tmux (list-windows -a)
   │
   ▼
maw-js  →  snapshot / SSE  (ระดับ window)
   │
   ▼
maw-ui  useSessions()  →  sessions[] + agents[] (1 agent / window)
   │
   ▼
RoomGrid  →  การ์ดห้อง (session) + AgentCard (window)
StatusBar →  N agents · M rooms · K tabs
```

ไฟล์หลัก:
- frontend: `maw-ui/src/hooks/useSessions.ts`, `components/RoomGrid.tsx`, `components/StatusBar.tsx`, `App.tsx`
- backend: `maw-js/src/core/fleet/snapshot.ts`, `core/transport/tmux-class.ts`, `api/sessions.ts`

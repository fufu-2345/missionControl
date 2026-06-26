# `maw serve` ทำงานยังไง + แต่ละหน้าคืออะไร

## `maw serve` คืออะไร

`maw serve [port]` คือการบูต **maw-js backend** — เซิร์ฟเวอร์ Bun ตัวเดียวที่รับทั้ง HTTP + WebSocket (พอร์ตเริ่มต้น **3456**) เป็น "สมอง" ของ oracle mesh ทั้งหมด ไม่ใช่แค่เสิร์ฟไฟล์ static เฉย ๆ — หน้าเว็บเป็นแค่หนึ่งในหลายอย่างที่มัน mount ขึ้นมา

> ซอร์ส: `maw-js/src/core/server.ts` → `startBunGatewayServer()`

### ลำดับการบูต (server.ts)

1. **เลือก gateway** — `bun` (ค่าเริ่มต้น) หรือ `rust` ผ่าน `--gateway` / `MAW_GATEWAY` / config ถ้าเป็น rust จะ delegate ออกไป ไม่งั้นเดินสาย bun
2. **บูต `MawEngine`** + transport router (เชื่อมต่อ peer/agent แบบ non-blocking — เซิร์ฟเวอร์สตาร์ทได้แม้ transport ล้มเหลว)
3. **สตาร์ท dispatch engine** — ส่งข้อความที่ค้างคิวให้อัตโนมัติเมื่อ agent ว่าง (idle)
4. **โหลด plugin** เป็นชั้น ๆ: builtin → user (`~/.local/share/maw/plugins`) → project-local (`.maw/plugins`) พร้อม hot-reload คอยจับการเปลี่ยนแปลงในโฟลเดอร์ user/project
5. **bind socket** — heuristic ความปลอดภัยใน `bind-host.ts`: bind แค่ `localhost` **ยกเว้น** มี federation peer ตั้งไว้ (จะเปิดกว้างขึ้น) `config.bind` override ได้ และมี HTTPS server ตัวที่สองบนพอร์ต `port+1` ถ้าตั้ง TLS cert/key
6. log ว่า `maw <version> serve → http://localhost:3456 (ws://…/ws)`

### request ถูก route ยังไง (`fetchHandler` เรียงตามลำดับความสำคัญ)

1. CORS preflight
2. **WebSocket upgrade** (`/ws`) — feed แบบ real-time ที่ UI ใช้ชีวิตอยู่บนนั้น (ไม่มี polling)
3. `/api/*` → engine-plugin proxy → legacy Elysia auth → serve route registry → Elysia API
4. **ที่เหลือทั้งหมด → fallback** = plugin **`serve-views`** ตัวนี้แหละที่เสิร์ฟหน้าเว็บ

---

## หน้าเว็บถูกเสิร์ฟยังไง

หน้าเว็บอยู่ **คนละ repo** (`Soul-Brews-Studio/maw-ui`) build ด้วย Vite แบบ **multi-page** — แต่ละไฟล์ `.html` เป็น entry point ของตัวเอง โดยมี `src/apps/*.tsx` หนุนหลัง หลังรัน `maw ui --install` ไฟล์ที่ build แล้วใน `dist/` จะไปอยู่ที่ `~/.maw/ui/dist/`

plugin `serve-views` (`serve-views/index.ts`) ทำงานแบบนี้:

- ถ้ามี `~/.maw/ui/dist` → `serveStatic({ root: mawUiDir })` เสิร์ฟ HTML/JS/assets ทั้งหมด **บนพอร์ต 3456 เดียวกัน** (เรียกว่า "Shape A — พอร์ตเดียว โปรเซสเดียว")
- ถ้า **ยังไม่ติดตั้ง** → เสิร์ฟ **"The Door"** หน้า landing เล็ก ๆ ให้วางที่อยู่ federation
- เพิ่ม route `/topology` (อ่าน `ψ/outbox/fleet-topology.html`)

ทริกสำคัญ: ทุกหน้ารับ `?host=<peer>` เพื่อชี้ไปยัง maw-js node *อื่น* ได้ — UI build เดียวเลยส่องได้ทุก node ในฝูง (drizzle.studio pattern) state เก็บใน Zustand store ที่ป้อนข้อมูลจาก WebSocket `/ws`

---

## แต่ละหน้า

| หน้า | ไฟล์ที่หนุน | คืออะไร |
|------|-----------|---------|
| `index.html` | `main.tsx` | **ARRA Office** — หน้าแรกเริ่มต้น; grid ของ agent แสดงสถานะ + PTY terminal สด |
| `office.html` | `office.tsx` | หน้า Office (แนวคิด agent-grid เดียวกัน แต่เป็น entry แยก) |
| `overview.html` | `overview.tsx` | ภาพรวม office ระดับสูง |
| `dashboard.html` | `dashboard.tsx` | dashboard metric + สถานะ agent |
| `fleet.html` | `fleet.tsx` | มุมมองทั้งฝูง — ทุก session ข้ามทุก node |
| `federation_2d.html` | `federation_2d.tsx` | กราฟ force แบบ 2D บน canvas ของ node + agent, เส้นข้อความวิ่งสด ๆ (เป็นค่าเริ่มต้นของ host `god.buildwithoracle.com`) |
| `federation.html` | `federation.tsx` | มุมมอง federation **3D** ด้วย Three.js, bloom + particle ⚠️ (VM นี้ไม่มี GPU — หน้า 3D จะ crash) |
| `terminal.html` | `terminal.tsx` | terminal xterm.js เต็มรูปแบบต่อ agent |
| `mission.html` | `mission.tsx` | mission control — task ที่กำลังทำ + ความคืบหน้า |
| `chat.html` | `chat.tsx` | ส่งข้อความข้าม agent |
| `inbox.html` | `inbox.tsx` | inbox ของ oracle — ข้อความ + handoff |
| `config.html` | `config.tsx` | ดูคอนฟิกของฝูง |
| `workspace.html` | `workspace.tsx` | workspace หลาย agent พร้อมปุ่ม send/action |
| `arena.html` | — | **3D Arena** ⚠️ (หนัก GPU เช่นกัน) |
| `shrine.html` | — | เทวะสถานลานเบียร์ — "Oracle Shrine" หน้าธีมพิธีกรรม |
| `talk.html` | — | หน้า Talk ไว้คุยกับ oracle |
| `timemachine.html` | — | Fleet Time Machine — เล่นย้อน/ดูประวัติสถานะของฝูง |

---

## คำสั่งจัดการเซิร์ฟเวอร์

```bash
maw serve                      # สตาร์ทบนพอร์ต 3456 (bun gateway)
maw serve 3457 --gateway rust  # เปลี่ยนพอร์ต / ใช้ rust gateway
maw serve status               # เช็คว่ารันอยู่ไหม
maw serve stop                 # หยุด
maw serve --force-takeover     # ฆ่า PID ของ maw ที่ยึดพอร์ตอยู่
maw serve -vvv                 # verbosity: 0 เงียบ → 3 HTTP access → 4 WS frames
```

> ⚠️ หน้า 3D หนัก ๆ (`federation.html`, `arena.html`) จะ render ไม่ได้บน VM นี้เพราะไม่มี GPU — ใช้ `federation_2d.html`, `fleet.html`, `dashboard.html` แทน

# แก้ปัญหา `localhost:3456` แครช → ตั้ง Dashboard เป็นหน้า default

> วันที่ 2026-06-22 · repo: `Soul-Brews-Studio/maw-ui` (อยู่ใน `soulbrew/github.com/Soul-Brews-Studio/maw-ui`)

## TL;DR
เปิด `http://localhost:3456` แล้วเด้งเข้า **Dashboard 2D** ทันที ไม่แครชอีกต่อไป
มุมมอง 3D ยังเข้าได้ผ่าน `#office` / `#federation` (แค่ไม่โหลดอัตโนมัติ)

---

## ปัญหาเดิม (ทำไมมันแครช / เปิด dashboard ไม่ได้)

1. **แครช:** เปิด `localhost:3456` เปล่า ๆ มันไป restore ค่า `lastView` ที่จำไว้ใน localStorage
   ซึ่งถ้าเคยกดแท็บ **Office / Fed (3D)** ค่ามันจะเป็น `office` → พอโหลดหน้า three.js/WebGL
   จะเริ่มทำงาน → **เครื่อง VM (Azure) ไม่มี GPU จริง เลยทำให้แท็บเบราว์เซอร์แครช**
   (หน้า Dashboard ไม่ใช้ WebGL เลยไม่แครช)

2. **เปิด dashboard ไม่ได้:** พิมพ์ `localhost:3456/dashboard` (path เปล่า) → **404**
   ตัวที่ใช้ได้จริงคือ `localhost:3456/#dashboard` (hash) หรือ `localhost:3456/dashboard.html`

---

## สิ่งที่แก้ (ในโค้ด maw-ui)

ไฟล์ที่แก้ — commit อยู่บน branch `fix/default-view-dashboard`:

- **`src/App.tsx`** — ฟังก์ชัน `useHashRoute()`
  - ถ้าไม่มี hash ใน URL → default เป็น `dashboard` (เดิมเป็น `mission`)
  - ถ้า `lastView` ที่จำไว้เป็นมุมมอง 3D (`office` / `federation`) → **ไม่ restore อัตโนมัติ** ให้ตกไปที่ dashboard แทน
  - มุมมอง 3D ยังเข้าได้ปกติถ้าใส่ hash เอง เช่น `#office`, `#federation`
- **`src/components/PinLock.tsx`** — ปลดล็อก PIN เสร็จ ไปหน้า `dashboard` (เดิม `mission`)

```js
// src/App.tsx
const DEFAULT_VIEW = "dashboard";
const WEBGL_VIEWS = new Set(["office", "federation"]);
// ...ถ้า lastView เป็น WEBGL_VIEWS → ข้าม ไม่ auto-load, ใช้ dashboard
```

---

## วิธี build + deploy UI (สำคัญ — จำไว้)

UI อยู่คนละ repo (`maw-ui`) ส่วน `maw-js` แค่เสิร์ฟไฟล์ที่ build แล้ว

```bash
cd soulbrew/github.com/Soul-Brews-Studio/maw-ui
bun install
bun run build                       # vite build → ออกที่ dist/
rsync -a --delete dist/ ~/.maw/ui/dist/   # เอาไป deploy ที่ maw อ่าน
pkill -f "maw serve"; maw serve     # restart
```

⚠️ **ระวัง:** คำสั่ง `maw ui install` จะ **ดาวน์โหลด UI สำเร็จรูปจาก GitHub มาทับ** `~/.maw/ui/dist`
→ ถ้ายังไม่ push/merge โค้ดขึ้น maw-ui การแก้ในเครื่องจะ **หายทันที** ที่รัน `maw ui install` ใหม่

---

## เรื่อง Port (3456 vs 5173)

| Port | คืออะไร | หน้าที่ |
|------|---------|---------|
| **3456** | maw backend (`maw serve`) | API + WebSocket + เสิร์ฟ UI ที่ build แล้ว — ใช้งานจริงพอร์ตเดียว |
| **5173** | vite dev server (`maw ui --dev`) | เฉพาะตอนแก้โค้ด UI (hot reload), proxy `/api` กลับไป 3456 |

- 2D กับ 3D **ใช้พอร์ตเดียวกัน** ต่างกันแค่ไฟล์/route ไม่ใช่พอร์ต
- ใช้งานปกติสนใจแค่ **3456** พอ

---

## Git

- `origin` = `https://github.com/Soul-Brews-Studio/maw-ui.git` (repo ขององค์กร ไม่ใช่ fork)
- commit อยู่บน branch `fix/default-view-dashboard` — **ยังไม่ push**
- ถ้าจะ push: `git push -u origin fix/default-view-dashboard` แล้วเปิด PR (ไม่แตะ `main` ตรง ๆ)

---

## วิธีเช็กว่าใช้งานได้

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3456/   # ต้องได้ 200
```
แล้วเปิด `http://localhost:3456` ในเบราว์เซอร์ + **กด Ctrl+Shift+R** (hard refresh) หนึ่งครั้ง
เพื่อล้าง bundle เก่าที่ cache ไว้ → จะเข้าหน้า Dashboard 2D เลย

✅ ทดสอบแล้ว (headless chromium): เปิด `/` เปล่า → ขึ้น "Dashboard Pro", WebGL 0 ครั้ง, ไม่แครช
แม้จะ seed `lastView:"office"` ไว้ ก็ยังเด้งไป `#dashboard`

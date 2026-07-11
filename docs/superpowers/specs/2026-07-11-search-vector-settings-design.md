# Search & Vector settings — Mission Control extension

Date: 2026-07-11
Status: design (approved-pending) · brainstorming output, ก่อนเข้า writing-plans
Repos touched: **`missionControl/extension` เท่านั้น** (ไม่แตะ `arra-oracle-v3`)

---

## 1. Goal

เพิ่ม section "Search / Oracle" ในหน้า Settings ของ extension ให้ผู้ใช้:
- เปิด/ปิด hybrid search ได้ (ปิด = FTS5 only แบบเดิม)
- ถ้าเปิด เลือก sub-mode ได้ 2 แบบ: **Vector** (= oracle mode `hybrid` เดิม: FTS5 + vector similarity ใน **LanceDB**; cosine/ANN เป็นของ LanceDB อยู่แล้ว เราแค่เปิดใช้ ไม่ได้ implement เอง) หรือ **Graph** (graphify — ยังไม่ทำ, เลือกได้แต่ผลลัพธ์ = FTS5)
- เลือก embedding model (BGE-M3 default / nomic), สั่ง install model, ชี้ path model file, สั่ง index, ดูสถานะความพร้อม

toggle นี้ต้อง **มีผลจริง** กับ search ของ oracle (ยิง HTTP ไปเปลี่ยน config ของ oracle) ไม่ใช่แค่จำค่าไว้เฉยๆ

---

## 2. Scope

**In scope**
- UI section custom-rendered ในหน้า Settings เดิม (ไม่ใช่ panel แยก)
- HTTP client ใหม่ใน extension ยิงไป oracle `:47778`
- persist ค่าที่ผู้ใช้เลือก + reconcile กับสถานะจริงของ oracle
- ปุ่ม Install (`ollama pull`) + Choose file (เลือก path model) + Index now/Stop + progress

**Out of scope**
- ทำ graphify / graph search จริง (โหมด Graph เป็น placeholder → FTS5)
- expose oracle mode `vector` (semantic-only) — "Vector" ใน UI = backend mode `hybrid` (FTS5 + LanceDB vector). **ไม่ implement cosine/ANN เอง** — LanceDB adapter ของ oracle ทำอยู่แล้ว เราแค่เปิด `enabled` ให้ path เดิมทำงาน
- แก้โค้ด oracle repo

**ต้อง verify ตอน implement (ไม่ใช่ blocker)**
- `/api/vector/config` ต้องมี auth token ไหม (เจอ `auth-settings.test.ts` ใน oracle; loopback น่าจะเปิด แต่ต้องเช็ค)
- field ไหนใน oracle config ที่รับ "model path" จากปุ่ม Choose file (ปัจจุบัน config มี `dataPath` = ที่เก็บ vector DB, `embeddingEndpoint` = URL ollama; ยังไม่มี field path ของตัว model file ชัดๆ → ถ้าไม่มี ให้เก็บ path ฝั่ง extension ไว้ก่อนแล้ว flag ว่ารอ field รองรับ)

---

## 3. State model & backend mapping

### 3.1 UI intent (เก็บใน `~/.mission-control/config.json`)
- `search.hybrid_enabled: boolean`
- `search.mode: "vector" | "graph"`
- `search.model_path: string` (จากปุ่ม Choose file; ว่าง = ใช้ default ของ ollama)

เหตุผลที่ต้องเก็บ intent เอง: "Hybrid OFF" กับ "Hybrid ON + Graph" ให้ผล backend เหมือนกัน (`enabled=false`) — ถ้าไม่จำ intel ไว้ เปิดหน้ามาใหม่จะแยกไม่ออกว่าผู้ใช้เลือกอะไร

### 3.2 Backend lever (คันโยกเดียว ที่ oracle)
สูตร: `enabled = hybrid_enabled && (mode === "vector")`
ยิงผ่าน `PATCH /api/vector/config { enabled }`. flag นี้ search.ts อ่านอยู่แล้ว (`isVectorSectionEnabled`) → ถ้า false ทุก query ที่ขอ hybrid/vector จะ downgrade เป็น fts เงียบๆ

### 3.3 Truth table

| UI | `oracle.enabled` | ผล search จริง |
|---|---|---|
| Hybrid OFF | false | FTS5 only |
| Hybrid ON + Vector | true | hybrid = FTS5 + LanceDB vector (path เดิมของ oracle) |
| Hybrid ON + Graph | false | FTS5 only (graph ยังไม่ทำ) |

เลือกโมเดล = `PATCH /api/vector/config { collections: { <key>: { primary: true } } }`

### 3.4 Reconcile ตอนเปิดหน้า Settings
1. ยิง `GET /api/vector/config` (authoritative: enabled, engine, state.ready/reason/recommendedAction, collections, options) + `GET /api/health` (vectorMode: embedded|proxied|disabled)
2. อ่าน intent จาก config.json
3. ตัดสิน UI:
   - `enabled === true` → แสดง Hybrid ON + Vector
   - `enabled === false` → ใช้ intent มาแยก: (`hybrid_enabled && mode==="graph"`) → ON + Graph; ไม่งั้น → OFF
4. ถ้ามี env `ORACLE_VECTOR_ENABLED=1` (UI แก้ไม่ได้) และไม่ตรงกับ toggle → แสดง note เล็กๆ ว่า runtime ต่างจากที่เห็น (อ้างอิง `vectorMode` จาก /api/health)
5. oracle offline (connection refused) → แสดง banner offline + ปิดคอนโทรลทั้งหมด (ไม่ยิง PATCH)

---

## 4. UI layout & interaction

```
▾ Search / Oracle                          Oracle: ● online :47778

   Hybrid search        [ ●———  OFF ]           <- slide toggle (ON/OFF)

     Mode            [ Vector | ● | Graph ]      <- segmented slide (2 ช่อง)
                       Vector: FTS5 + cosine/ANN
                       Graph:  graphify · coming soon

     Embedding model  [ BGE-M3 ▾ ]  default · nomic
        BGE-M3  — not installed   [Install] [Choose file…]
        nomic   — ready

     Status: ✓ vector ready · 482 docs indexed
             [ Index now ]   [ Stop ]

   (เมื่อ Hybrid OFF → Mode / model / index เทา + กดไม่ได้; search = FTS5)
```

### Controls
- **Hybrid search**: slide toggle 2 สถานะ (ON/OFF) แบบเลื่อน knob
- **Mode**: segmented control 2 ช่อง (Vector | Graph) เลื่อน highlight; ทั้งบล็อกเทา/disabled เมื่อ Hybrid OFF; เลือก Graph ได้จริง มีป้าย "coming soon"
- **Embedding model**: picker 2 ตัว — BGE-M3 (default) + nomic. ต่อโมเดลแสดงสถานะ (ready / not installed / not indexed) + ปุ่ม:
  - **Install**: spawn `ollama pull <model>` (local shell) + progress; confirm ก่อนเริ่ม (ดาวน์โหลดหนัก)
  - **Choose file…**: `vscode.window.showOpenDialog` เลือกไฟล์ model → เก็บ path ลง `search.model_path` (เผื่อโหลด model ไว้แล้วแต่ระบบไม่รู้ที่อยู่)
- **Status / readiness**: จาก `state` ของ GET config (ready, reason, recommendedAction) + จำนวน docs จาก `/api/vector/stats`
- **Index now / Stop**: `POST /api/vector/index/start` / `POST /api/vector/index/stop`; poll `GET /api/vector/index/status` ระหว่างทำ

### Interaction rules
- เปลี่ยนค่าใดๆ → host ยิง PATCH → re-fetch → push state กลับ (client อยู่ dumb ตามแพทเทิร์นเดิมของ settings)
- ไม่ auto-index / ไม่ auto-pull ตอนกดเปิด toggle — ทำต่อเมื่อผู้ใช้กดปุ่มเองเท่านั้น (กัน CPU storm)

---

## 5. Message protocol (host ↔ webview)

ต่อยอดจาก settings.ts เดิม (push ทั้งก้อน หลัง mutation ทุกครั้ง)

**Host → webview**
- `{ type: "searchState", state: SearchViewModel }` — view-model พร้อม render (hybridEnabled, mode, models[{key,label,status,reason}], selectedModel, readiness{ready,reason,action}, docs, index{status,current,total,eta}, oracleOnline, envOverrideNote)

**Webview → host**
- `{ type: "searchSet", field: "hybrid"|"mode"|"model", value }`
- `{ type: "indexStart" }` / `{ type: "indexStop" }`
- `{ type: "installModel", model }`
- `{ type: "chooseModelFile", model }`
- `{ type: "reloadSearch" }`

**Foot-gun**: บล็อก HTML/JS custom นี้อยู่ใน template-literal ของ renderShell — ห้ามมี backtick / backslash ใน inline script (client regex ห้ามใช้ `\`). ค่า label/help ที่มาจาก postMessage (JSON) ปลอดภัย เพราะ escape ฝั่ง client

---

## 6. Oracle API surface (มีอยู่แล้ว — แค่เรียกใช้)

- `GET  /api/vector/config` → `{ source, enabled, engine, state{ready,reason,recommendedAction,collections}, options{localEngines,embeddingProviders}, config{...collections} }`
- `PATCH /api/vector/config` body(optional) `{ enabled?, engine?, collections?: { <key>: { primary?, model?, ... } } }` → เขียน `~/.oracle/vector-server.json`, คืน payload + `{ path }`; 400 ถ้า validate ไม่ผ่าน
- `GET  /api/health` → `{ ..., vectorMode: "embedded"|"proxied"|"disabled", vectorDisabledReason? }`
- `GET  /api/vector/stats` → per-model collection counts (503 ถ้า proxy ล่ม)
- `POST /api/vector/index/start` body `{ model?, batchSize?, source?, repoRoot? }` → `{ jobId, status:"started", ... }`; 409 ถ้ากำลัง index อยู่
- `GET  /api/vector/index/status` → `{ status:"idle|indexing|completed|error|stopped", current, total, docsPerSec, eta, ... }`
- `POST /api/vector/index/stop` → `{ status, stopped, job }`

base URL: `http://127.0.0.1:47778` (จาก `isPortUp(47778)` ที่มีอยู่). ยิงด้วย global `fetch` (แพทเทิร์นเดียวกับ teamsOps.ts:388, usage.ts:71)

---

## 7. Modules (ไฟล์ที่เพิ่ม/แก้)

**NEW `src/commands/oracleVectorClient.ts`**
- node-only, ใช้ global fetch, base `http://127.0.0.1:47778`
- `getConfig()`, `patchConfig(update)`, `getHealth()`, `getStats()`, `startIndex(opts)`, `indexStatus()`, `stopIndex()`
- จับ ECONNREFUSED/timeout → คืน `{ online:false }` แทน throw (ให้ UI แสดง offline)

**NEW `src/commands/searchOps.ts`**
- logic ล้วน (ไม่ import vscode) → unit-test ได้ผ่าน `MC_CONFIG_PATH`
- อ่าน/เขียน intent ใน config.json
- `deriveEnabled(intent): boolean` (สูตรข้อ 3.2)
- `reconcile(oracleGet, oracleHealth, intent): SearchViewModel` (ตรรกะข้อ 3.4)
- spawn `ollama pull <model>` + parse progress (หรือแยกเป็น helper เล็ก)

**CHANGE `src/webview/settings.ts`**
- special-case group "Search / Oracle" ใน render() → เรียก renderer custom (ไม่ผ่าน generic fieldControl)
- เพิ่ม message ตามข้อ 5 ใน onDidReceiveMessage switch
- poll `indexStatus()` / progress ของ pull ระหว่างทำงาน แล้ว push `searchState`
- เพิ่มชื่อ group ใน `GROUP_ORDER` (byte-match เป๊ะ รวมช่องว่างรอบ `/`)

**CHANGE `src/commands/settingsOps.ts`** (ถ้าจำเป็น)
- ประกาศ 3 คีย์ intent ให้ read/write coerce ถูก (หรือจัดการใน searchOps เอง โดยไม่ผ่าน SETTINGS_SCHEMA generic เพราะ group นี้ custom)

**ไม่ต้อง**: เพิ่ม command ใน package.json (ใช้ `missioncontrol.settings` เดิม), แก้ oracle repo

---

## 8. Safety

- **CPU storm guard**: Index / Install เป็น manual + confirm modal เตือน (CPU / ขนาดดาวน์โหลด) + ปุ่ม Stop; ไม่แตะ ψ-watcher หรือ ollama CPUQuota เดิม
- **Oracle offline**: banner + ปิดคอนโทรล, ไม่ยิง PATCH ให้ error
- **Env override**: ถ้า `ORACLE_VECTOR_ENABLED=1` ทำให้ runtime ต่างจาก toggle → note เตือน (อ่าน `vectorMode` จาก /api/health)
- **BGE-M3 default แต่ยังไม่ได้ลงบน VM นี้**: readiness banner จะขึ้น "not installed" จนกว่าจะกด Install หรือเลือก nomic — เป็นพฤติกรรมที่คาดไว้ ไม่ใช่ bug

---

## 9. Testing

**Unit (bun)**
- `searchOps`: truth table `deriveEnabled` (3 เคส), `reconcile` (enabled true/false × intent vector/graph/off, offline, env override), persist intent ผ่าน `MC_CONFIG_PATH`
- `oracleVectorClient`: mock fetch → PATCH body ถูกต้อง, map response, ECONNREFUSED → offline

**Manual / verify (skill: verify)**
- ต่อ oracle จริง: toggle ON+Vector → เช็ค `~/.oracle/vector-server.json` `enabled=true`; toggle OFF → `false`; ยิง `GET /api/search?mode=hybrid` แล้วดู `metadata.vectorAvailable` / effective mode เปลี่ยนตาม
- grey-out ทำงานเมื่อ OFF; Graph → search downgrade เป็น FTS5
- Install / Index / Stop เดินและหยุดได้จริง; oracle offline → UI ไม่พัง

---

## 10. Open items (decide ตอน impl)

1. auth ของ `/api/vector/config` (verify; ถ้าต้องมี token หา source ของ token ใน oracle)
2. field รองรับ "model path" ของ Choose file (ถ้า oracle ยังไม่มี → เก็บฝั่ง extension + flag ไว้)
3. ความถี่ poll ระหว่าง index/pull (เริ่มที่ ~1.5s, ปรับได้)
4. รูปแบบ progress ของ `ollama pull` (parse stdout เป็น %) — ถ้า parse ยาก ใช้ spinner + สถานะ done/fail แทน

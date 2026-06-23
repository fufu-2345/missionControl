# MISSION: "miniredis" — In-Memory Data Server (RESP protocol)

> Brief สำหรับทีม 3 agent (bob / jack / john). เป้าหมาย: เขียน in-memory data store
> ที่พูด RESP protocol ให้ `redis-cli` ต่อใช้งานได้จริง — เขียนเองทั้งหมด ห้ามใช้ redis library.

## Core
- TCP server รับหลาย connection พร้อมกัน
- พูด **RESP** (REdis Serialization Protocol) — `redis-cli -p <port>` ต่อแล้วใช้งานได้จริง

## Commands (acceptance criteria)
1. **String**: `SET k v`, `GET k`, `DEL k`, `EXISTS k`, `INCR k` (atomic, error ถ้าไม่ใช่ตัวเลข)
2. **Expiry**: `SET k v EX <sec>`, `TTL k`, `EXPIRE k <sec>` — หมดอายุแล้ว `GET` คืน nil (lazy + active expiry)
3. **List**: `LPUSH` / `RPUSH`, `LRANGE k start stop`, `LLEN`
4. **Hash**: `HSET k f v`, `HGET k f`, `HGETALL k`
5. **Generic**: `KEYS <pattern>` (glob `*` / `?`), `TYPE k`, `FLUSHALL`
6. **Errors**: command/arg ผิด → RESP error `-ERR ...` (ห้าม crash); ใช้ command ผิด type → `-WRONGTYPE`

## Non-functional
- GET / SET / INCR เป็น O(1)
- รองรับ **concurrent clients** ปลอดภัย (ไม่ race) — มีเทสยิงพร้อมกันพิสูจน์
- expiry ไม่ memory leak (มี active sweeper เก็บ key หมดอายุ)

## Deliverables
- server รันได้ + demo (`redis-cli` หรือ raw-socket script ยิงคำสั่งครบ)
- **test suite**: ทุก command, expiry boundary, WRONGTYPE, concurrent SET/INCR, KEYS pattern, RESP encode/decode round-trip
- README (วิธี start + command ที่รองรับ)
- **commit เป็น step ๆ** (ไม่ใช่ก้อนเดียว) — เห็น progress ชัด และให้ auto-memory hook จับได้

## แตกงาน — 3 agent
| agent | งาน | contract ที่ต้อง agree |
|-------|-----|------------------------|
| **bob** | RESP codec + TCP server: parse request frame → serialize reply, จัดการ connection/concurrency | รูปแบบ parsed command = `string[]` + reply types (simple / bulk / array / error / integer) |
| **jack** | Command engine + data types (string / list / hash) + expiry logic | รับ `string[]` จาก bob, อ่าน/เขียนผ่าน Store interface ของ john, คืน reply type |
| **john** | Store: thread-safe map + TTL + active sweeper + test suite ทั้งระบบ | Store API (`get / set / del / expire / type / keys`) ที่ jack เรียก |

## สัญญากลาง (ล็อกก่อนแตกงาน — ไม่งั้น integrate พัง)
1. **RESP reply types** (bob ↔ jack)
2. **Store interface** (jack ↔ john)
3. **parsed command = `string[]`** (bob → jack)

## เกณฑ์วัด (สำหรับเทส mission control)
- กำหนด 3 สัญญากลางก่อนแตกงานไหม
- แต่ละ agent ส่งงานแล้ว integrate ติดเลยไหม (interface ตรงกัน)
- RESP เข้ากับ `redis-cli` จริงไหม
- concurrent test ผ่านไหม (ไม่ race)
- commit เป็น step → auto-memory จับครบไหม

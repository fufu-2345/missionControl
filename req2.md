# Lumen Exchange — Requirement Specification (req2.md)

> **โปรเจค:** Lumen Exchange — Backend ระดับ exchange สำหรับเทรด spot หลายคู่เหรียญ + wallet
> **สถาปัตยกรรม:** Event Sourcing + CQRS + Saga (deterministic, replayable, exactly-once)
> **Tech stack:** TypeScript บน Bun/Node · PostgreSQL · Redis · WebSocket (`ws`) · Zod · Vitest
> **เวอร์ชันเอกสาร:** v1.0 — 2026-06-29
> **สถานะ:** Draft for build (ออกแบบมาเพื่อแตกงานให้ทีม multi-agent วิ่งขนาน + adversarial verify)

---

## สารบัญ

1. [ภาพรวมและเป้าหมาย (Vision & Goals)](#1-ภาพรวมและเป้าหมาย)
2. [ขอบเขต (Scope: In / Out)](#2-ขอบเขต)
3. [คำศัพท์ (Glossary)](#3-คำศัพท์)
4. [ภาพรวมสถาปัตยกรรม (Architecture Overview)](#4-ภาพรวมสถาปัตยกรรม)
5. [หลักการข้ามระบบ (Cross-cutting Principles)](#5-หลักการข้ามระบบ)
6. [Hard Invariants — กฎความถูกต้องระดับระบบ](#6-hard-invariants)
7. [Service Specifications (รายละเอียดราย service)](#7-service-specifications)
   - 7.1 API Gateway / BFF
   - 7.2 Account & Identity
   - 7.3 Wallet / Funding
   - 7.4 Ledger
   - 7.5 Order Gateway
   - 7.6 Matching Engine
   - 7.7 Risk / Limit Engine
   - 7.8 Settlement Saga
   - 7.9 Market Data
   - 7.10 Event Store + Bus
   - 7.11 Read Models (CQRS)
   - 7.12 Admin / Ops
   - 7.13 Reconciliation & Observability
8. [Non-Functional Requirements (NFR)](#8-non-functional-requirements)
9. [กลยุทธ์การทดสอบ (Testing Strategy)](#9-กลยุทธ์การทดสอบ)
10. [Milestones & Phasing](#10-milestones--phasing)
11. [แผนแตกงานให้ Agent (Decomposition Guide)](#11-แผนแตกงานให้-agent)
12. [Definition of Done](#12-definition-of-done)
13. [ภาคผนวก: Contract & Schema เริ่มต้น](#13-ภาคผนวก)

---

## 1. ภาพรวมและเป้าหมาย

Lumen Exchange คือ backend ของ centralized spot exchange ที่ผู้ใช้สามารถฝากสินทรัพย์ (เช่น `BTC`, `ETH`, `USDT`), ตั้งคำสั่งซื้อขาย, จับคู่คำสั่งแบบ real-time, และถอนสินทรัพย์ออกได้ ระบบทั้งหมดยึดหลัก **ความถูกต้องของเงินเป็นอันดับหนึ่ง** เหนือ throughput และ feature

### 1.1 เป้าหมายหลัก (Primary Goals)

- **G1 — เงินต้องถูกเป๊ะทุกขณะ:** ทุก state ของระบบต้องสอดคล้องกับ double-entry ledger; ผลรวมสินทรัพย์ในระบบต้องเท่ากับ (ฝากรวม − ถอนรวม) ตลอดเวลา ไม่มีเงินงอกหรือหาย
- **G2 — Matching ต้อง deterministic และ fair:** ลำดับ event ชุดเดียวกัน ต้องให้ผลการจับคู่เหมือนเดิมทุกครั้ง (bit-for-bit) และยึด price-time priority อย่างเคร่งครัด
- **G3 — รอด crash และ replay ได้:** หยุด process ตัวใดก็ได้กลางคัน ระบบต้อง rebuild state จาก event log กลับมาที่จุดเดิมโดย invariant ไม่พัง
- **G4 — Exactly-once settlement:** ทุก trade ต้องถูก settle ลง ledger เพียงครั้งเดียว แม้มี retry / replay / duplicate
- **G5 — Real-time market data ที่ recover ได้:** client รับ orderbook/trade feed ต่อเนื่อง, ตรวจ gap ได้ผ่าน sequence number, และ resync ได้เมื่อหลุด

### 1.2 เป้าหมายรอง (Secondary Goals)

- รองรับหลาย market (trading pair) พร้อมกัน, แต่ละ market แยก orderbook อิสระ
- รองรับ order หลายชนิด: `LIMIT`, `MARKET`, `IOC`, `FOK`, `POST_ONLY`
- มี API สำหรับ programmatic trading (REST + WebSocket) พร้อม HMAC request signing
- สังเกตการณ์ได้ (observability): metrics, structured logs, distributed traces
- ทดสอบได้ลึก: golden tests, property-based tests, chaos tests

### 1.3 Non-Goals (สิ่งที่จงใจไม่ทำในเวอร์ชันนี้)

- ไม่ทำ on-chain integration จริง — deposit/withdrawal ใช้ **mock chain adapter**
- ไม่ทำ margin / futures / leverage — spot เท่านั้น (เผื่อ extension ในอนาคต)
- ไม่ทำ fiat on/off-ramp และ payment gateway จริง
- ไม่ทำ frontend UI (เฉพาะ API + WebSocket); จะมีแค่ minimal CLI client สำหรับทดสอบ
- ไม่ทำ multi-region active-active replication (single-region, แต่ออกแบบให้ scale แนวนอนได้ภายหลัง)

---

## 2. ขอบเขต

### 2.1 In Scope

| หมวด | รายการ |
|------|--------|
| User flow | สมัคร/ยืนยันตัวตน (KYC tier), จัดการ API key, ฝาก, ถอน, ตั้ง/ยกเลิก order, ดูประวัติ |
| Trading | spot matching หลาย market, order type 5 ชนิด, fee maker/taker, self-trade prevention |
| Money | double-entry ledger, holds/reservations, settlement saga, withdrawal approval |
| Real-time | WebSocket: orderbook L2, trades, ticker, ข้อมูล private (order updates, balance) |
| Ops | halt/resume market, fee config, manual ledger adjustment (audited), reconciliation |
| Quality | event sourcing + replay, golden/property/chaos tests, observability |

### 2.2 Out of Scope

ดู [Non-Goals](#13-non-goals-สิ่งที่จงใจไม่ทำในเวอร์ชันนี้) ในข้อ 1.3 — สรุป: ไม่มี on-chain จริง, ไม่มี margin/futures, ไม่มี fiat, ไม่มี UI, single-region

---

## 3. คำศัพท์

| คำ | ความหมาย |
|----|----------|
| **Asset** | สินทรัพย์หนึ่งชนิด เช่น `BTC`, `USDT` (มี `scale` = จำนวนทศนิยมที่อนุญาต) |
| **Market** | คู่เทรด เช่น `BTC-USDT` ประกอบด้วย `base` (BTC) และ `quote` (USDT) |
| **Order** | คำสั่งซื้อ/ขายของผู้ใช้ |
| **Fill / Trade** | การจับคู่สำเร็จระหว่าง order สองฝั่ง ทำให้เกิดการแลกเปลี่ยน |
| **Maker / Taker** | maker = order ที่อยู่ใน book ก่อน, taker = order ที่เข้ามาชน |
| **Hold / Reservation** | ยอดที่ถูก "กัน" ไว้ตอนตั้ง order ยังไม่ใช่การโอน |
| **Ledger account** | บัญชีย่อยใน double-entry เช่น `user:{id}:available:{asset}`, `user:{id}:hold:{asset}` |
| **Event** | ข้อเท็จจริงที่เกิดขึ้นแล้วและเปลี่ยนแปลงไม่ได้ (immutable, past tense) เช่น `OrderPlaced` |
| **Command** | เจตนาที่ขอให้เกิด action เช่น `PlaceOrder` (อาจถูกปฏิเสธ) |
| **Projection / Read model** | view ที่ build จาก event stream เพื่ออ่านเร็ว |
| **Saga** | กระบวนการระยะยาวที่ประสานหลาย step พร้อม compensation เมื่อ fail |
| **Sequence number (seq)** | เลขลำดับโตทางเดียวต่อ stream เพื่อ ordering + gap detection |
| **Idempotency key** | คีย์ที่ client ส่งมาเพื่อให้ retry ไม่เกิดผลซ้ำ |

---

## 4. ภาพรวมสถาปัตยกรรม

```
                          ┌──────────────────────────────────────┐
   REST / WS clients ───▶ │   (1) API Gateway / BFF               │
   (signed requests)      │   auth · rate limit · idempotency     │
                          └───────┬───────────────────┬───────────┘
                                  │ commands          │ subscribe
                    ┌─────────────▼──────┐     ┌───────▼────────────┐
                    │ (2) Account/Identity│    │ (9) Market Data    │◀── orderbook/trade events
                    │ (3) Wallet/Funding  │    │     WS fanout       │
                    └─────────┬──────────┘     └────────────────────┘
                              │
                    ┌─────────▼──────────┐     ┌────────────────────┐
                    │ (5) Order Gateway  │────▶│ (7) Risk/Limit      │
                    │  validate · idemp. │◀────│     pre-trade check │
                    └─────────┬──────────┘     └────────────────────┘
                              │ validated command
                    ┌─────────▼──────────┐
                    │ (6) Matching Engine│  deterministic, per-market
                    │   orderbook + seq  │
                    └─────────┬──────────┘
                              │ TradeExecuted / OrderAccepted ... (events, ordered)
              ┌───────────────▼───────────────────────────────────────┐
              │ (10) Event Store + Bus  (append-only, ordered, replay) │
              └───┬───────────────┬───────────────┬───────────────┬────┘
                  │               │               │               │
        ┌─────────▼───┐  ┌────────▼──────┐ ┌──────▼───────┐ ┌─────▼────────┐
        │ (8) Settle  │  │ (4) Ledger    │ │ (11) Read     │ │ (13) Recon.  │
        │     Saga    │─▶│ double-entry  │ │     Models    │ │  + Observ.   │
        └─────────────┘  └───────────────┘ └───────────────┘ └──────────────┘

        (12) Admin/Ops ── commands (halt market, fee config, adjustments) ──▶ ทุก service
```

### 4.1 หลักการไหลของข้อมูล (Data Flow)

1. Client ส่ง **command** (เช่น `PlaceOrder`) ผ่าน API Gateway → ตรวจ auth, rate limit, idempotency
2. Order Gateway validate + เรียก Risk Engine กัน hold ใน ledger ก่อน
3. Command ที่ผ่านแล้วเข้า Matching Engine → จับคู่ → ปล่อย **event** ที่มี seq ต่อ market
4. Event เข้า Event Store (source of truth) แล้วกระจายผ่าน Bus
5. Settlement Saga consume `TradeExecuted` → สั่ง ledger ย้ายเงินแบบ exactly-once
6. Read Models + Market Data + Reconciliation consume event เพื่อ build view/feed/ตรวจสอบ

### 4.2 โครงสร้าง Repository (monorepo)

```
lumen-exchange/
├── packages/
│   ├── contracts/        # Zod schemas: commands, events, API DTOs, error codes (shared)
│   ├── event-store/      # (10) append-only log + bus
│   ├── ledger/           # (4)
│   ├── matching/         # (6) pure deterministic engine (no I/O)
│   ├── risk/             # (7)
│   ├── settlement/       # (8) saga
│   ├── market-data/      # (9)
│   ├── read-models/      # (11)
│   ├── account/          # (2)
│   ├── wallet/           # (3)
│   ├── order-gateway/    # (5)
│   ├── admin/            # (12)
│   └── observability/    # (13) metrics/logs/traces + reconciliation job
├── apps/
│   ├── gateway/          # (1) HTTP + WS server (ประกอบทุก service)
│   └── cli-client/       # minimal client สำหรับ test
├── test/
│   ├── golden/           # deterministic replay fixtures
│   ├── property/         # invariant property tests
│   └── chaos/            # crash/partition scenarios
└── req2.md
```

---

## 5. หลักการข้ามระบบ

### 5.1 Event Sourcing (`GEN-ES`)

- **GEN-ES-01** — Event Store เป็น **single source of truth** ทุก state อื่น (balance, orderbook, read model) ต้อง derive ได้จาก event stream
- **GEN-ES-02** — Event เป็น immutable, append-only, มี past-tense name (`OrderPlaced`, `TradeExecuted`, `FundsSettled`)
- **GEN-ES-03** — ทุก event มี envelope มาตรฐาน: `{ eventId (uuid), streamId, seq, type, version, occurredAt, causationId, correlationId, payload }`
- **GEN-ES-04** — ระบบต้อง replay event stream ตั้งแต่ต้นแล้วได้ state เดียวกันเป๊ะ (deterministic projection)
- **GEN-ES-05** — รองรับ **snapshot** เพื่อย่นเวลา replay; snapshot ต้องเป็น optimization เท่านั้น — ลบ snapshot ทั้งหมดแล้ว replay จาก event ล้วนต้องได้ผลเท่ากัน

### 5.2 CQRS (`GEN-CQRS`)

- **GEN-CQRS-01** — แยก write path (commands → events) ออกจาก read path (projections) อย่างชัดเจน
- **GEN-CQRS-02** — Read model อาจ eventually consistent ได้ แต่ต้องเปิดเผย `asOfSeq` ให้ client รู้ว่าข้อมูลทันถึง event ไหน
- **GEN-CQRS-03** — Read model ต้อง rebuild ได้จาก event stream เสมอ (drop table แล้ว replay ใหม่ได้)

### 5.3 Commands & Idempotency (`GEN-CMD`)

- **GEN-CMD-01** — ทุก command ที่มีผลเปลี่ยน state ต้องรองรับ `idempotencyKey` (client-provided)
- **GEN-CMD-02** — command เดิม (idempotencyKey เดียวกัน) ที่ส่งซ้ำ ต้องคืนผลลัพธ์เดิม **โดยไม่เกิด side effect ซ้ำ**
- **GEN-CMD-03** — การ validate command ต้องเป็น deterministic และไม่พึ่งเวลา wall-clock โดยตรง (เวลาให้ inject ผ่าน event ที่มี `occurredAt`)

### 5.4 Money & Precision (`GEN-MONEY`)

- **GEN-MONEY-01** — **ห้ามใช้ floating point กับเงินเด็ดขาด** ทุกจำนวนเงินเป็น integer หน่วยย่อยที่สุด (เช่น satoshi) เก็บเป็น `bigint`/string
- **GEN-MONEY-02** — ทุก asset มี `scale` (จำนวนทศนิยม); การแปลงเข้า/ออกต้องผ่าน util กลางใน `contracts` เท่านั้น
- **GEN-MONEY-03** — การคิดเงิน (price × qty, fee) ต้องมี rounding rule ที่กำหนดชัดและทดสอบได้ (default: round half-up; เศษ fee ปัดเข้า exchange fee account ไม่ทำให้ conservation พัง)

### 5.5 Error Model (`GEN-ERR`)

- **GEN-ERR-01** — error ทุกตัวมี machine-readable `code` (เช่น `INSUFFICIENT_BALANCE`, `MARKET_HALTED`, `RATE_LIMITED`) + human message
- **GEN-ERR-02** — แยก error 4 ชั้น: validation (400), auth (401/403), business rule (409/422), system (500)
- **GEN-ERR-03** — business-rule rejection ต้องเป็น event ที่ audit ได้ด้วย (`OrderRejected` ลง stream) ไม่ใช่แค่ HTTP error ที่หายไป

---

## 6. Hard Invariants

> นี่คือ "ฟัน" ของสเปค — ทุกข้อต้องมี automated test ที่ตรวจได้ และเป็นเป้าหลักของ adversarial verification

| ID | Invariant | วิธีตรวจ |
|----|-----------|----------|
| **INV-01** | **Conservation of value:** สำหรับทุก asset, ผลรวมทุก ledger account = (ฝากรวม − ถอนรวม) ตลอดเวลา | reconciliation job รัน query หลังทุก batch event; property test |
| **INV-02** | **No negative available balance:** ไม่มีบัญชี `available` ติดลบ ณ จุดใดเลย | invariant check ใน ledger ทุก transaction; property test |
| **INV-03** | **Hold consistency:** `available + hold` = total ของ user ต่อ asset; hold ทุกก้อนผูกกับ order/withdrawal ที่ active เท่านั้น | reconciliation; เมื่อ order ปิด hold ต้องถูกปล่อยครบ |
| **INV-04** | **Exactly-once settlement:** trade หนึ่งครั้ง settle เข้า ledger ครั้งเดียว แม้ replay/retry | settlement saga ใช้ dedup key = `tradeId`; replay test |
| **INV-05** | **Matching determinism:** event input ชุดเดียวกัน → fills + orderbook state เดียวกัน bit-for-bit | golden test: record→replay→diff |
| **INV-06** | **Price-time priority:** ใน price level เดียวกัน order ที่มาก่อน (seq น้อยกว่า) ได้จับคู่ก่อนเสมอ | property test สุ่ม order แล้วตรวจลำดับ fill |
| **INV-07** | **No self-trade:** order สองฝั่งของ user เดียวกันต้องไม่จับคู่กัน (ตาม STP policy ที่ตั้งไว้) | unit + property test |
| **INV-08** | **Sequence monotonicity:** seq ต่อ stream/market โตทางเดียว ไม่ซ้ำ ไม่ข้าม (ภายใน stream) | event store constraint + test |
| **INV-09** | **Crash safety:** kill process ที่จุดใดก็ได้ → restart → state + invariant ทั้งหมดยังถูก | chaos test |
| **INV-10** | **Withdrawal safety:** ถอนไม่เกิน available; withdrawal ที่ pending กัน hold ไว้; reject/cancel ปล่อย hold คืนครบ | property test concurrent withdrawal vs order |
| **INV-11** | **Idempotent commands:** ส่ง command idempotencyKey เดิมซ้ำ → ไม่มี state เปลี่ยนเพิ่ม | test ยิงซ้ำ N ครั้ง |
| **INV-12** | **Replay equivalence:** drop ทุก projection/snapshot แล้ว replay จาก event ล้วน → ได้ read model + balance เท่าเดิม | full replay test |

---

## 7. Service Specifications

> รูปแบบแต่ละ service: **บทบาท · Commands (in) · Events (out) · Interface/API · Data model · Requirements · Acceptance criteria · Edge cases & test scenarios**

---

### 7.1 API Gateway / BFF

**บทบาท:** ประตูเดียวสู่ระบบ — รับ REST + WebSocket, ทำ authentication, rate limiting, idempotency, request validation, backpressure แล้ว route ไป service ภายใน

**Commands (in):** ทุก command จาก client (proxy ต่อ)
**Events (out):** `RequestRateLimited`, `AuthFailed` (เพื่อ audit/observability)

**Interface/API:**
- REST: `POST /v1/orders`, `DELETE /v1/orders/:id`, `GET /v1/orders`, `POST /v1/withdrawals`, `GET /v1/balances`, `GET /v1/markets`, ฯลฯ
- WebSocket: `wss://.../v1/stream` — รับ subscribe message สำหรับ public (orderbook/trades/ticker) และ private (orders/balances) channel
- Auth: JWT (session) สำหรับ user; API key + **HMAC-SHA256 request signing** สำหรับ programmatic (`timestamp + method + path + body` → signature; ป้องกัน replay ด้วย timestamp window)

**Data model:** stateless (เก็บ rate-limit counter + idempotency cache ใน Redis)

**Requirements:**
- **GW-01** — ตรวจ HMAC signature: reject ถ้า signature ผิด, timestamp นอก window (±5s), หรือ nonce ซ้ำ
- **GW-02** — Rate limit ต่อ API key แบบ token bucket (config ได้ต่อ tier เช่น 10 req/s burst 50); เกินคืน `429` + `Retry-After`
- **GW-03** — Idempotency: header `Idempotency-Key` → cache response 24 ชม.; ส่งซ้ำคืน response เดิม + header `Idempotent-Replayed: true`
- **GW-04** — Validate request body ด้วย Zod schema จาก `contracts`; reject ด้วย error code ที่ชัด
- **GW-05** — Backpressure บน WebSocket: ถ้า client consume ไม่ทัน (buffer เกิน threshold) → ส่ง `slow_consumer` warning แล้ว disconnect ถ้าเกินต่อ
- **GW-06** — ไม่มี business logic ใน gateway (เป็น orchestration/edge เท่านั้น)

**Acceptance criteria:**
- ✅ ยิง request ที่ signature ผิด → `401 INVALID_SIGNATURE` เสมอ
- ✅ ยิงเกิน rate limit → `429` และไม่ทะลุไปถึง service ภายใน
- ✅ ส่ง order ด้วย idempotency key เดิม 100 ครั้งพร้อมกัน → order ถูกสร้างครั้งเดียว

**Edge cases & test scenarios:**
- timestamp ชนขอบ window พอดี · clock skew · idempotency cache miss ระหว่าง 2 instance (ต้องใช้ Redis ร่วม) · WebSocket reconnect storm · payload ใหญ่เกิน limit

---

### 7.2 Account & Identity

**บทบาท:** จัดการ user, KYC tier, API key, 2FA

**Commands (in):** `RegisterUser`, `VerifyKyc`, `CreateApiKey`, `RevokeApiKey`, `EnableTwoFactor`
**Events (out):** `UserRegistered`, `KycTierChanged`, `ApiKeyCreated`, `ApiKeyRevoked`, `TwoFactorEnabled`

**Data model:**
- `users(id, email, status, kycTier, createdAt)`
- `api_keys(id, userId, publicKey, secretHash, scopes, createdAt, revokedAt)`
- KYC tier: `TIER_0` (ฝากได้แต่ถอนไม่ได้), `TIER_1` (ถอนได้ limit ต่ำ), `TIER_2` (ถอนได้ limit สูง)

**Requirements:**
- **ACC-01** — เก็บ API secret เป็น hash เท่านั้น (เห็น plaintext ครั้งเดียวตอนสร้าง)
- **ACC-02** — KYC tier กำหนด withdrawal limit (เชื่อมกับ Wallet/Risk)
- **ACC-03** — API key มี scope (`read`, `trade`, `withdraw`); withdraw ต้อง scope + 2FA
- **ACC-04** — revoke API key มีผลทันที (Gateway ต้องไม่ accept key ที่ revoke แล้ว)

**Acceptance criteria:**
- ✅ user `TIER_0` ขอถอน → reject `KYC_TIER_INSUFFICIENT`
- ✅ revoke key แล้วใช้ key เดิม → `401`
- ✅ API key ที่ scope=`read` ส่ง order → `403 INSUFFICIENT_SCOPE`

**Edge cases:** สมัครซ้ำ email เดิม · race ระหว่าง revoke กับ request กำลังบิน · 2FA replay

---

### 7.3 Wallet / Funding

**บทบาท:** จัดการฝาก/ถอนผ่าน **mock chain adapter**, address management, withdrawal approval flow

**Commands (in):** `RequestDepositAddress`, `RequestWithdrawal`, `ApproveWithdrawal`, `RejectWithdrawal`
**Events (out):** `DepositAddressAssigned`, `DepositDetected`, `DepositCredited`, `WithdrawalRequested`, `WithdrawalApproved`, `WithdrawalBroadcast`, `WithdrawalRejected`, `WithdrawalCompleted`

**Data model:**
- `deposit_addresses(address, userId, asset)`
- `withdrawals(id, userId, asset, amount, status, holdId, txRef)` — status: `requested → approved → broadcast → completed | rejected`
- mock chain adapter: simulate confirmation ด้วย event ที่มี `confirmations` count

**Requirements:**
- **WAL-01** — Deposit flow: `DepositDetected` (mock) → รอ N confirmations → `DepositCredited` → สั่ง ledger เครดิต `available`
- **WAL-02** — Deposit ต้อง idempotent ต่อ `txRef` (chain reorg/duplicate ต้องไม่เครดิตซ้ำ) — INV-04 style
- **WAL-03** — Withdrawal flow: `RequestWithdrawal` → ตรวจ available + KYC limit → กัน hold ใน ledger → `requested`; ต้อง approve (manual/auto-rule) → broadcast (mock) → `completed` (debit hold จริง)
- **WAL-04** — reject/cancel withdrawal → ปล่อย hold คืน available ครบ (INV-10)
- **WAL-05** — withdrawal ต้องผ่าน 2FA + scope `withdraw`

**Acceptance criteria:**
- ✅ ส่ง `DepositDetected` ด้วย txRef เดิม 2 ครั้ง → เครดิตครั้งเดียว
- ✅ ขอถอนเกิน available → reject, hold ไม่ถูกสร้าง
- ✅ reject withdrawal ที่ pending → available กลับมาเท่าเดิมเป๊ะ
- ✅ ถอนพร้อมกันหลายรายการรวมเกิน available → อย่างน้อยหนึ่งรายการถูก reject, conservation ไม่พัง

**Edge cases:** chain reorg · partial confirmation แล้วหาย · approve ซ้ำ · concurrent withdraw + place order แย่ง balance เดียวกัน

---

### 7.4 Ledger

**บทบาท:** หัวใจการเงิน — double-entry, append-only journal, balance projection, holds/reservations

**Commands (in):** `PostJournalEntry`, `PlaceHold`, `ReleaseHold`, `SettleTrade` (จาก saga)
**Events (out):** `JournalEntryPosted`, `HoldPlaced`, `HoldReleased`, `BalanceChanged`

**Data model:**
- `journal_entries(id, ts, correlationId)` — แต่ละ entry มีหลาย `lines`
- `journal_lines(entryId, account, asset, debit, credit)` — **ผลรวม debit = ผลรวม credit ต่อ entry เสมอ**
- account naming: `user:{id}:available:{asset}`, `user:{id}:hold:{asset}`, `exchange:fee:{asset}`, `external:deposit:{asset}`, `external:withdrawal:{asset}`
- balance projection: `balances(account, asset, amount)` — derive จาก journal

**Requirements:**
- **LDG-01** — ทุก journal entry ต้อง **balanced** (Σdebit = Σcredit ต่อ asset) มิฉะนั้น reject
- **LDG-02** — Hold = ย้ายจาก `available` → `hold` (ภายใน user เดียวกัน) แบบ atomic; release = ย้ายกลับ
- **LDG-03** — ห้าม `available` ติดลบ (INV-02): hold/debit ที่จะทำให้ติดลบต้อง reject
- **LDG-04** — balance projection ต้องตรงกับผลรวม journal เสมอ (rebuild ได้ — INV-12)
- **LDG-05** — เปิด API query: balance ต่อ user/asset, journal history, ผลรวมระบบต่อ asset (สำหรับ reconciliation)
- **LDG-06** — ทุก write เป็น atomic transaction; ใช้ optimistic concurrency หรือ serialize ต่อ account เพื่อกัน race (INV-02 ภายใต้ concurrency)

**Acceptance criteria:**
- ✅ post entry ที่ debit ≠ credit → reject `UNBALANCED_ENTRY`
- ✅ hold เกิน available → reject `INSUFFICIENT_BALANCE`, balance ไม่เปลี่ยน
- ✅ rebuild balances จาก journal ล้วน → ตรงกับ projection เดิมทุกบัญชี
- ✅ concurrent hold 1000 ครั้งบน balance ที่พอแค่ครึ่ง → สำเร็จไม่เกินที่ balance รับได้, ไม่มีติดลบ

**Edge cases:** rounding เศษ fee · hold แล้ว order ถูก partial fill (hold ลดบางส่วน) · release hold ของ order ที่ปิดไปแล้ว (idempotent) · settlement กับ hold ของ market order (กันด้วย worst-case price)

---

### 7.5 Order Gateway

**บทบาท:** ด่านก่อนเข้า matching — validate order, เรียก risk pre-check, กัน hold, จัดการ idempotency, route

**Commands (in):** `PlaceOrder`, `CancelOrder`, `CancelAllOrders`
**Events (out):** `OrderAccepted`, `OrderRejected`, `OrderCancelRequested`

**Requirements:**
- **ORD-01** — validate: market มีอยู่+ไม่ halt, qty/price อยู่ในกรอบ (`minQty`, `tickSize`, `lotSize`), order type valid
- **ORD-02** — เรียก Risk Engine กัน hold ตาม side: ฝั่ง buy กัน `quote` (price×qty + fee buffer), ฝั่ง sell กัน `base` (qty)
- **ORD-03** — MARKET order: กัน hold ด้วย worst-case (เช่น เปอร์เซ็นต์ slippage cap หรือ balance ทั้งก้อน) แล้วคืนส่วนเกินหลัง fill
- **ORD-04** — ถ้ากัน hold ไม่ได้ → `OrderRejected(INSUFFICIENT_BALANCE)` ไม่ส่งเข้า matching
- **ORD-05** — assign `clientOrderId` (idempotent ต่อ user) + `orderId` ภายใน; ส่งซ้ำ clientOrderId เดิม → คืน order เดิม (INV-11)
- **ORD-06** — POST_ONLY ที่จะ match ทันที → reject (`WOULD_TAKE`); FOK ที่ fill ไม่ครบ → reject ทั้งก้อน; IOC → fill ได้เท่าไหร่แล้วยกเลิกส่วนที่เหลือ

**Acceptance criteria:**
- ✅ order บน market ที่ halt → `MARKET_HALTED`
- ✅ buy order ที่ quote ไม่พอ → reject ก่อนถึง matching, ไม่มี hold ค้าง
- ✅ clientOrderId ซ้ำ → คืน order เดิม ไม่สร้างใหม่
- ✅ POST_ONLY ที่ราคาจะชน book → reject

**Edge cases:** price=0/ติดลบ · qty ต่ำกว่า minQty · tickSize ไม่ลงตัว · cancel order ที่ fill ไปแล้วบางส่วน · cancel order ที่ไม่มี/ปิดแล้ว

---

### 7.6 Matching Engine ⭐

**บทบาท:** หัวใจการเทรด — orderbook ต่อ market, จับคู่ deterministic, price-time priority, ปล่อย event ที่มี seq

> **ข้อกำหนดสำคัญ:** Matching Engine ต้องเป็น **pure function ของ (state, command) → (newState, events)** ไม่มี I/O, ไม่อ่านเวลา wall-clock, ไม่สุ่ม — เพื่อ determinism (INV-05) และ replay

**Commands (in):** `OrderAccepted` (จาก Order Gateway), `CancelOrderRequested`, `HaltMarket`, `ResumeMarket`
**Events (out):** `OrderOpened`, `OrderPartiallyFilled`, `OrderFilled`, `OrderCanceled`, `TradeExecuted`, `BookUpdated`

**Data model (in-memory, rebuildable):**
- ต่อ market: bid side + ask side เป็น price level (sorted), แต่ละ level เป็น FIFO queue ของ order (price-time)
- `seq` counter ต่อ market (monotonic — INV-08)

**Requirements:**
- **MAT-01** — รองรับ order type: `LIMIT`, `MARKET`, `IOC`, `FOK`, `POST_ONLY` ตามนิยามใน ORD-06
- **MAT-02** — Price-time priority (INV-06): best price ก่อน, ใน price เดียว FIFO ตาม seq ที่เข้า
- **MAT-03** — Self-trade prevention (INV-07): ตาม policy `CANCEL_TAKER` / `CANCEL_MAKER` / `CANCEL_BOTH` (config ต่อ market)
- **MAT-04** — ปล่อย `TradeExecuted{ tradeId, market, makerOrderId, takerOrderId, price, qty, makerSide, seq }` ทุกการจับคู่ + อัปเดต order state
- **MAT-05** — เมื่อ market halt: ปฏิเสธ order ใหม่, ยัง process cancel ได้ (config), book คงอยู่
- **MAT-06** — **Determinism (INV-05):** ต้องไม่มี source of non-determinism (เวลา/สุ่ม/iteration order ของ map ที่ไม่กำหนด); ทุกการตัดสินใจอิง field ใน event
- **MAT-07** — rebuild orderbook จาก event stream ได้ (replay) — INV-12
- **MAT-08** — fee: คิด maker/taker fee rate (config ต่อ market/tier) แล้วใส่ใน TradeExecuted เพื่อให้ saga settle

**Acceptance criteria:**
- ✅ **Golden test:** record event sequence → replay → orderbook + fills เหมือนเดิม bit-for-bit
- ✅ buy LIMIT @100 ชน sell หลายไม้ที่ 98/99/100 → fill ราคาดีก่อน (98→99→100), เหลือเข้า book
- ✅ FOK ที่ liquidity ไม่พอ → ไม่มี fill เลย, order reject
- ✅ self order สองฝั่ง → ไม่จับคู่ตาม STP policy
- ✅ order ราคาเดียวกัน เข้าก่อนได้ก่อน (FIFO) เสมอ

**Edge cases:** crossed book ตอน startup · price level ที่ qty รวม=0 · partial fill ข้ามหลาย level · MARKET order ที่ book ว่าง (reject/partial) · cancel order ที่กำลังถูก match ใน batch เดียวกัน · overflow ของ qty รวม

**Performance:** ดู NFR — target ≥ 50,000 orders/sec/market บน single core (in-memory), p99 match latency < 1ms (ไม่รวม I/O)

---

### 7.7 Risk / Limit Engine

**บทบาท:** pre-trade checks, กำหนด hold, position/notional limits, circuit breaker

**Commands (in):** `CheckOrderRisk` (sync จาก Order Gateway), `ConfigureLimits`, `TripCircuitBreaker`
**Events (out):** `RiskCheckPassed`, `RiskCheckRejected`, `CircuitBreakerTripped`, `CircuitBreakerReset`

**Requirements:**
- **RSK-01** — คำนวณ hold ที่ต้องกันต่อ order (ตาม side/type — ORD-02/03) แล้วสั่ง ledger `PlaceHold`
- **RSK-02** — Per-user limits: max open orders, max notional ต่อ market, KYC-tier-based
- **RSK-03** — Circuit breaker ต่อ market: ถ้าราคาขยับเกิน X% ใน window Y → halt market อัตโนมัติ (ป้องกัน flash crash)
- **RSK-04** — fat-finger check: reject order ที่ราคาห่าง mid-price เกิน threshold (config)
- **RSK-05** — ทุก decision ต้อง log เป็น event เพื่อ audit

**Acceptance criteria:**
- ✅ order ที่ราคาเพี้ยน 10x mid → reject `PRICE_BAND_EXCEEDED`
- ✅ trade ที่ขยับราคาเกิน breaker threshold → market halt อัตโนมัติ + event
- ✅ user เกิน max open orders → reject `TOO_MANY_OPEN_ORDERS`

**Edge cases:** mid-price ยังไม่มี (book ว่าง) · breaker trip ระหว่างมี order กำลังบิน · config เปลี่ยนกลางทาง

---

### 7.8 Settlement Saga ⭐

**บทบาท:** ประสานการ settle เงินลง ledger ต่อ trade แบบ **exactly-once** พร้อม compensation

**Commands (in):** consume `TradeExecuted`
**Events (out):** `SettlementStarted`, `FundsSettled`, `SettlementFailed`, `SettlementCompensated`

**Saga steps ต่อ `TradeExecuted`:**
1. dedup ด้วย `tradeId` (INV-04) — ถ้า settle แล้วข้าม
2. คำนวณการย้ายเงิน double-entry:
   - buyer: `hold:quote` → debit (price×qty + takerFee), `available:base` → credit qty
   - seller: `hold:base` → debit qty, `available:quote` → credit (price×qty − fee)
   - `exchange:fee:*` → credit fee
3. post journal entry (atomic, balanced — LDG-01)
4. ปล่อย/ปรับ hold ส่วนเกิน (กรณี MARKET order หรือ partial)
5. emit `FundsSettled`

**Requirements:**
- **SET-01** — Exactly-once (INV-04): ใช้ `tradeId` เป็น dedup key persistent; replay TradeExecuted เดิมต้องไม่ settle ซ้ำ
- **SET-02** — Atomicity: การย้ายเงินทุกฝั่งของ trade ต้องอยู่ใน journal entry เดียว (all-or-nothing)
- **SET-03** — ถ้า settle fail (เช่น invariant violation ที่ไม่ควรเกิด) → `SettlementFailed` + halt market ที่เกี่ยวข้อง + alert (fail-safe, ไม่ปล่อยเงินผิด)
- **SET-04** — Compensation: ถ้า partial settle เกิดได้ (ไม่ควร แต่ต้องกัน) ต้องมี compensating entry ที่ทำให้ conservation กลับมาถูก
- **SET-05** — saga state ต้อง durable + resumable หลัง crash (INV-09)

**Acceptance criteria:**
- ✅ replay `TradeExecuted` เดิม 100 ครั้ง → ledger เปลี่ยนครั้งเดียว
- ✅ หลัง settle ทุก trade, conservation ต่อ asset ยังถูก (INV-01)
- ✅ kill saga ระหว่าง settle → restart → settle เสร็จพอดี ไม่ซ้ำ ไม่ขาด
- ✅ fee ถูกเก็บเข้า `exchange:fee` ครบ, ไม่มีเศษหาย

**Edge cases:** crash หลัง post journal ก่อน emit FundsSettled · TradeExecuted มาก่อน OrderAccepted (out-of-order delivery) · hold ไม่พอ (ไม่ควรเกิดถ้า risk ถูก — แต่ต้องตรวจ)

---

### 7.9 Market Data

**บทบาท:** กระจาย real-time feed — orderbook L2, trades, ticker, candles — ผ่าน WebSocket fanout พร้อม snapshot + incremental + recovery

**Commands (in):** consume `BookUpdated`, `TradeExecuted`; subscribe requests จาก gateway
**Events (out):** ไม่ปล่อย domain event (เป็น read-side); ส่ง WS message

**Channels:**
- `book.{market}` — L2 snapshot + incremental update (มี `seq`)
- `trades.{market}` — trade stream
- `ticker.{market}` — 24h stats (last, high, low, volume, change)
- `candles.{market}.{interval}` — OHLCV

**Requirements:**
- **MKT-01** — ทุก incremental message มี `seq` ต่อ market; client ตรวจ gap ได้ (INV-08)
- **MKT-02** — เมื่อ client subscribe: ส่ง snapshot + `seq` ปัจจุบัน แล้วตามด้วย incremental จาก seq นั้น (ไม่ขาด ไม่ซ้ำ)
- **MKT-03** — ถ้า client ตรวจพบ gap → ขอ snapshot ใหม่ได้ (resync)
- **MKT-04** — fanout ต้องไม่บล็อก matching (async, มี buffer + drop policy สำหรับ slow consumer)
- **MKT-05** — candle aggregation ต้อง deterministic (อิง trade event + time bucket ที่กำหนด)

**Acceptance criteria:**
- ✅ subscribe ระหว่างมี trade วิ่ง → snapshot + incremental ต่อเนื่องไม่มี gap
- ✅ orderbook ที่ client build จาก feed = orderbook จริงใน matching engine
- ✅ slow consumer ไม่ทำให้ client อื่นช้า

**Edge cases:** subscribe ตอน book ว่าง · seq wrap · reconnect แล้ว resync · ticker ตอนยังไม่มี trade

---

### 7.10 Event Store + Bus

**บทบาท:** source of truth — append-only log ที่ ordered, durable, replayable + กระจาย event ให้ subscriber

**Requirements:**
- **ES-01** — append เป็น atomic, assign `seq` ต่อ stream (monotonic, gapless ภายใน stream — INV-08)
- **ES-02** — รองรับ **optimistic concurrency**: append ด้วย `expectedSeq`; ถ้าไม่ตรง → conflict (กัน lost update)
- **ES-03** — อ่าน event ตั้งแต่ seq ใดก็ได้ (สำหรับ replay/projection rebuild)
- **ES-04** — Bus กระจาย event ตามลำดับต่อ stream; at-least-once delivery (subscriber ต้อง idempotent)
- **ES-05** — subscriber เก็บ checkpoint (last processed seq) เพื่อ resume หลัง crash
- **ES-06** — รองรับ snapshot store แยก (optimization — GEN-ES-05)
- **ES-07** — schema versioning + upcasting: event เวอร์ชันเก่าต้อง deserialize ได้หลัง schema เปลี่ยน

**Acceptance criteria:**
- ✅ concurrent append ด้วย expectedSeq เดียวกัน 2 ตัว → สำเร็จ 1, อีกตัว conflict
- ✅ subscriber crash แล้ว resume → ไม่พลาด event, process ซ้ำได้แบบ idempotent
- ✅ replay จาก seq 0 → ลำดับ event เป๊ะ

**Edge cases:** append แล้ว crash ก่อน ack · bus กระจายซ้ำ · ordering ข้าม stream (ไม่รับประกัน global order — เฉพาะ per-stream)

---

### 7.11 Read Models (CQRS)

**บทบาท:** สร้าง view สำหรับอ่านเร็วจาก event stream — ทุก view rebuildable (INV-12)

**Read models:**
- `open_orders(userId, market, ...)` — order ที่ยัง active
- `order_history(userId, ...)`
- `trade_history(userId, market, ...)`
- `balances_view(userId, asset, available, hold)` — projection จาก ledger event
- `ohlcv(market, interval, ...)`
- `pnl(userId, ...)` — กำไร/ขาดทุน (อิง cost basis)

**Requirements:**
- **RM-01** — แต่ละ projection consume event + เก็บ checkpoint (asOfSeq)
- **RM-02** — เปิด `asOfSeq` ใน API response (GEN-CQRS-02)
- **RM-03** — rebuild ได้: drop table → replay → ได้ค่าเท่าเดิม (INV-12)
- **RM-04** — projection ต้อง idempotent ต่อ event ซ้ำ (at-least-once จาก bus)
- **RM-05** — P&L cost basis ใช้วิธีที่กำหนดชัด (เช่น weighted average) และทดสอบได้

**Acceptance criteria:**
- ✅ rebuild balances_view = ledger projection เป๊ะ
- ✅ ส่ง event ซ้ำ → read model ไม่เพี้ยน
- ✅ open_orders ตรงกับ matching engine state

**Edge cases:** event มาไม่เรียง · projection lag · partial fill อัปเดต open_orders

---

### 7.12 Admin / Ops

**บทบาท:** ควบคุมระบบ — halt/resume market, fee config, listing asset/market, manual adjustment (audited)

**Commands (in):** `HaltMarket`, `ResumeMarket`, `ListAsset`, `ListMarket`, `SetFeeSchedule`, `ManualLedgerAdjustment`
**Events (out):** `MarketHalted`, `MarketResumed`, `AssetListed`, `MarketListed`, `FeeScheduleChanged`, `ManualAdjustmentPosted`

**Requirements:**
- **ADM-01** — ทุก admin action ต้อง authenticated (admin role) + audit log (ใครทำ, เมื่อไหร่, อะไร, เหตุผล)
- **ADM-02** — `ManualLedgerAdjustment` ต้องเป็น balanced entry และระบุเหตุผล; ปรากฏใน reconciliation
- **ADM-03** — halt market มีผลทันทีกับ matching + order gateway
- **ADM-04** — fee schedule เปลี่ยนได้ runtime; มีผลกับ trade ใหม่เท่านั้น (ไม่ย้อนหลัง)

**Acceptance criteria:**
- ✅ halt market → order ใหม่ถูก reject, book คงอยู่, cancel ยังทำได้
- ✅ manual adjustment ที่ unbalanced → reject
- ✅ ทุก admin action ตรวจสอบย้อนหลังได้จาก audit log

**Edge cases:** halt ระหว่างมี order กำลังบิน · adjustment ทำให้ available ติดลบ (ต้อง reject) · concurrent admin actions

---

### 7.13 Reconciliation & Observability

**บทบาท:** ตรวจ invariant อัตโนมัติ + เปิดเผย health ของระบบ

**Requirements:**
- **REC-01** — Reconciliation job รันเป็นระยะ (และ on-demand): ตรวจ INV-01 (conservation), INV-03 (hold consistency), balances_view = ledger; alert ถ้าพบ drift
- **REC-02** — Metrics: order rate, match latency (p50/p99), trade volume, settlement lag, event store seq lag, WS connection count, reject rate ต่อ code
- **REC-03** — Structured logs (JSON) ทุก service พร้อม `correlationId`/`causationId` ตามรอย flow ได้
- **REC-04** — Distributed tracing: trace ตั้งแต่ HTTP request → command → events → settlement
- **REC-05** — `/health` + `/ready` endpoint ต่อ service; reconciliation status เปิดเผยได้

**Acceptance criteria:**
- ✅ จงใจ inject เงินผิด (ผ่าน test hook) → reconciliation ตรวจเจอ + alert
- ✅ trace request เดียวตามรอยข้าม service ได้ครบ
- ✅ metrics สะท้อนภาระจริงตอน load test

---

## 8. Non-Functional Requirements

| ID | หมวด | ข้อกำหนด |
|----|------|----------|
| **NFR-01** | Throughput | Matching engine ≥ 50,000 orders/sec/market (in-memory, single core); ระบบ end-to-end (รวม persist) ≥ 5,000 orders/sec |
| **NFR-02** | Latency | p99 match latency < 1ms (ใน engine); p99 end-to-end order ack < 50ms |
| **NFR-03** | Recovery | restart + replay กลับสู่ steady state < 60s สำหรับ event log 1M events (ด้วย snapshot) |
| **NFR-04** | Durability | ไม่สูญ committed event แม้ crash (fsync/WAL); RPO = 0 สำหรับ event store |
| **NFR-05** | Consistency | write path strongly consistent; read path eventually consistent + expose `asOfSeq` |
| **NFR-06** | Security | HMAC signing, secret hashing, no secret in logs, rate limiting, input validation ทุก boundary |
| **NFR-07** | Scalability | matching แยกต่อ market (shard ได้); stateless services scale แนวนอน; read models replica ได้ |
| **NFR-08** | Observability | metrics + structured logs + traces ครบทุก service (REC-02..04) |
| **NFR-09** | Testability | ทุก invariant มี automated test; matching engine เป็น pure (testable แยก); chaos test ได้ |
| **NFR-10** | Maintainability | service หลัง typed contract; เปลี่ยน internal ของ service โดยไม่กระทบ consumer ได้ |

---

## 9. กลยุทธ์การทดสอบ

### 9.1 Golden Tests (determinism — INV-05, INV-12)
- บันทึก event sequence จริงเป็น fixture → replay → diff orderbook/ledger/read-model กับ snapshot ที่บันทึกไว้
- เก็บ golden fixtures หลายสถานการณ์ (heavy matching, partial fills, cancels, halts)

### 9.2 Property-Based Tests (invariants)
- สุ่ม sequence ของ command (deposit/order/cancel/withdraw) จำนวนมาก → หลังทุก step ตรวจ INV-01..03, INV-06, INV-10
- ใช้ shrinking หา minimal failing case

### 9.3 Chaos Tests (crash safety — INV-09)
- kill process ที่จุดต่างๆ (ก่อน/หลัง append event, กลาง saga, กลาง projection) → restart → ตรวจ invariant + ไม่มี double effect
- จำลอง bus duplicate delivery, out-of-order, slow consumer

### 9.4 Load / Performance Tests (NFR-01/02)
- ยิง order ปริมาณสูงต่อ market → วัด throughput + latency; ตรวจ backpressure

### 9.5 Contract Tests
- ทุก service publish/consume event ตาม Zod schema ใน `contracts`; contract test กัน breaking change

### 9.6 Integration / E2E
- flow ครบ: register → deposit → place order → match → settle → withdraw; ตรวจ conservation ปลายทาง

---

## 10. Milestones & Phasing

| Milestone | ขอบเขต | Exit criteria |
|-----------|--------|---------------|
| **M0 — Foundation** | `contracts` package (events/commands/DTO/error), Event Store + Bus (10), observability skeleton | append/replay ได้, contract test ผ่าน, INV-08 ผ่าน |
| **M1 — Money** | Ledger (4), Wallet/Funding (3), Account (2) | deposit/withdraw flow + INV-01/02/03/10 ผ่าน, reconciliation เบื้องต้น |
| **M2 — Trading core** | Order Gateway (5), Matching Engine (6), Risk (7) | order lifecycle + INV-05/06/07/11 ผ่าน, golden tests ชุดแรก |
| **M3 — Settlement** | Settlement Saga (8) | INV-04 ผ่าน, conservation หลัง trade (INV-01), crash-safe (INV-09) |
| **M4 — Real-time & read** | Market Data (9), Read Models (11) | feed ต่อเนื่อง+resync, read model rebuild (INV-12) |
| **M5 — Ops & hardening** | Admin (12), Reconciliation full (13), chaos + load tests | NFR-01..04 ผ่าน, chaos suite เขียว, DoD ครบ |

ลำดับ M0→M5 มี dependency ชัด; ภายใน milestone หลาย service ทำขนานได้ (ดูข้อ 11)

---

## 11. แผนแตกงานให้ Agent

> ออกแบบมาเพื่อ multi-agent fan-out + adversarial verify (ตาม workflow playbook)

### 11.1 หลักการแตกงาน
- **Contract-first:** M0 สร้าง `contracts` (event/command/DTO schema) ให้เสร็จก่อน เป็นสัญญากลาง → service ทุกตัว implement หลัง contract นี้ → ทำขนานได้โดยไม่ชนกัน
- **หนึ่ง service = หนึ่ง agent task** ที่มี input ชัด (contract ที่ consume) + output ชัด (event ที่ publish) + acceptance criteria + test ของตัวเอง
- **Isolation:** ใช้ git worktree ต่อ agent เมื่อแก้ไฟล์ขนานในแพ็กเกจเดียวกัน เพื่อกัน conflict
- **Adversarial verify:** หลัง agent ส่งงาน → spawn verifier agent ที่พยายาม "หักล้าง" ว่า invariant ที่เกี่ยวข้องยังถูก (ยิง property/chaos test เฉพาะจุด)

### 11.2 Fan-out map (ภายในแต่ละ milestone)
- **M0:** contracts (ทำก่อน, blocking) → จากนั้น event-store + observability skeleton ขนานกัน
- **M1:** ledger ‖ wallet ‖ account (3 agent ขนาน, integrate ผ่าน event)
- **M2:** matching-engine ‖ order-gateway ‖ risk (3 agent; matching เป็น pure → test แยกง่ายสุด)
- **M3:** settlement-saga (1-2 agent; verify หนักที่ INV-04 + INV-01)
- **M4:** market-data ‖ read-models (2 agent ขนาน)
- **M5:** admin ‖ reconciliation ‖ chaos/load harness (3 agent ขนาน)

### 11.3 รูปแบบ verify ที่แนะนำต่อ service
| Service | Invariant เป้าหมายของ verifier |
|---------|-------------------------------|
| Ledger | INV-01, INV-02, INV-03, INV-12 |
| Matching | INV-05, INV-06, INV-07, INV-08 |
| Settlement | INV-04, INV-01, INV-09 |
| Wallet | INV-10, INV-04 |
| Read models | INV-12 |
| ทั้งระบบ (E2E) | INV-01 หลัง E2E flow + chaos |

### 11.4 Integration gate
- ก่อน merge service ใดเข้า main: contract test + service test + invariant test ที่เกี่ยวข้องต้องเขียว
- หลังครบ milestone: รัน E2E + reconciliation + chaos suite เป็น integration gate

---

## 12. Definition of Done

โปรเจคถือว่า "เสร็จ" เมื่อ:

- [ ] ทุก service (1–13) implement ครบตาม requirement ID และผ่าน acceptance criteria ของตัวเอง
- [ ] **Hard Invariants INV-01..INV-12 ทุกข้อมี automated test และเขียวทั้งหมด**
- [ ] Golden test suite (determinism + replay) เขียว
- [ ] Property-based test suite (invariants) เขียว
- [ ] Chaos test suite (crash safety) เขียว
- [ ] Load test ผ่าน target NFR-01/02
- [ ] Reconciliation job รันแล้วไม่พบ drift บน scenario E2E
- [ ] E2E flow (register→deposit→trade→settle→withdraw) ผ่าน + conservation ถูกปลายทาง
- [ ] Observability ครบ (metrics/logs/traces) + health endpoints
- [ ] Contract tests กัน breaking change เขียว
- [ ] เอกสาร: README ต่อ package + API reference + runbook (halt/recover)

---

## 13. ภาคผนวก

### 13.1 ตัวอย่าง Event Envelope (contracts)

```ts
// packages/contracts/src/envelope.ts
import { z } from "zod";

export const EventEnvelope = z.object({
  eventId: z.string().uuid(),
  streamId: z.string(),          // เช่น "market:BTC-USDT" | "user:42"
  seq: z.bigint(),               // monotonic ต่อ stream (INV-08)
  type: z.string(),              // เช่น "TradeExecuted"
  version: z.number().int(),     // schema version (ES-07)
  occurredAt: z.string(),        // ISO8601 (มาจากภายในระบบ ไม่ใช่ wall-clock ใน pure logic)
  causationId: z.string().uuid().nullable(),   // event/command ที่ทำให้เกิด
  correlationId: z.string().uuid(),            // ตามรอย flow เดียวกัน
  payload: z.unknown(),
});
```

### 13.2 ตัวอย่าง Money type

```ts
// packages/contracts/src/money.ts
// เก็บเป็นจำนวนเต็มหน่วยย่อยที่สุด ห้าม float (GEN-MONEY-01)
export type Amount = bigint;          // เช่น satoshi
export interface Asset { symbol: string; scale: number; } // scale = ทศนิยม

export function toAmount(human: string, asset: Asset): Amount { /* parse → bigint */ }
export function toHuman(a: Amount, asset: Asset): string { /* format */ }
```

### 13.3 ตัวอย่าง TradeExecuted payload

```ts
export const TradeExecuted = z.object({
  tradeId: z.string().uuid(),        // dedup key สำหรับ settlement (INV-04)
  market: z.string(),
  price: z.bigint(),
  qty: z.bigint(),
  makerOrderId: z.string(),
  takerOrderId: z.string(),
  makerUserId: z.string(),
  takerUserId: z.string(),
  makerSide: z.enum(["BUY", "SELL"]),
  makerFee: z.bigint(),
  takerFee: z.bigint(),
  seq: z.bigint(),
});
```

### 13.4 ตัวอย่าง Order Lifecycle (state machine)

```
PLACED ──validate/risk──▶ ACCEPTED ──match──▶ PARTIALLY_FILLED ──▶ FILLED
   │                          │                      │
   └──reject──▶ REJECTED      └──cancel──▶ CANCELED ◀─┘ (ส่วนที่เหลือ)
```

### 13.5 Ledger entry ตัวอย่าง (1 trade)

```
TradeExecuted: buyer=U1 seller=U2, 0.1 BTC @ 60,000 USDT, takerFee=6 USDT (buyer taker)
Journal entry (balanced ต่อ asset):
  USDT: debit  U1:hold:USDT   6006     credit U2:available:USDT 6000
                                       credit exchange:fee:USDT    6
  BTC : debit  U2:hold:BTC    0.1 BTC  credit U1:available:BTC   0.1 BTC
→ Σdebit = Σcredit ต่อ asset (LDG-01) ✓ ; conservation รักษา (INV-01) ✓
```

---

*จบเอกสาร — req2.md v1.0*

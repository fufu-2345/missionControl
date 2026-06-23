# Agent Memory → รวมไว้ Repo เดียว (โดยไม่เปลี่ยนโครงสร้าง)

> เขียนเมื่อ 2026-06-22 — ตอบคำถาม: "ตอนนี้ agent memory มี `.git` แยกกันต่อ agent
> ถ้าอยาก push memory ไปไว้ repo เดียว ทำได้ไหมโดยไม่เปลี่ยนโครงสร้างปัจจุบัน?"

---

## สรุปสั้น (TL;DR)

- **ได้** — รวม memory ของทุก agent ไว้ repo เดียวได้ โดยไม่ต้องย้าย `ψ/` และไม่ต้องแก้ oracle repo เลย
- **แต่มีข้อจำกัด 1 อย่าง**: จะทำเป็น git ก้อนเดียวที่ track `ψ/` ทั้ง 4 อัน "สด ๆ ในที่เดิม" **ไม่ได้** เพราะแต่ละ `ψ/` อยู่ข้างใน oracle repo (มี `.git` ของตัวเอง) — git จะไม่ข้ามขอบเขต repo ซ้อน repo (ทดสอบยืนยันแล้ว)
- **เรื่องสำคัญที่เจอตอนเช็ก**: ตอนนี้ `ψ/` ของทุก agent **ยังไม่ถูก track เลย** (`git status` ขึ้น `?? ψ/`) → แปลว่า **memory ยังไม่ได้ push ขึ้นที่ไหนเลย อยู่แค่ในเครื่องนี้** การรวม repo ครั้งนี้ = backup ครั้งแรกไปในตัว
- **วิธีที่แนะนำ (แผน A)**: สร้าง repo กลาง `oracle-memory` 1 อัน → มี script เล็ก ๆ `rsync` `ψ/` ของแต่ละ agent เข้าไปเป็นโฟลเดอร์ย่อย แล้ว commit + push → ผูกกับ hook ให้อัตโนมัติ (แบบเดียวกับ auto-index hook ที่ใช้อยู่)

---

## 1. ตอนนี้เป็นยังไง (สภาพปัจจุบัน)

`~/Desktop/soulbrew/` เป็น workspace repo (remote = `fufu-2345/missionControl`)
และมัน `.gitignore` ตัว `/github.com/` ทิ้งโดยตั้งใจ — เพราะข้างใน `github.com/` แต่ละโฟลเดอร์
**เป็น git repo อิสระของตัวเอง** มี `.git` + remote บน GitHub แยกกันคนละอัน:

```
soulbrew/                         ← repo: fufu-2345/missionControl
└── github.com/                   ← ถูก .gitignore (ไม่ track ใน soulbrew)
    └── fufu-2345/
        ├── bob-oracle/   .git → github.com/fufu-2345/bob-oracle   + ψ/  ← memory
        ├── jack-oracle/  .git → github.com/fufu-2345/jack-oracle  + ψ/  ← memory
        ├── john-oracle/  .git → github.com/fufu-2345/john-oracle  + ψ/  ← memory
        └── mike-oracle/  .git → github.com/fufu-2345/mike-oracle  + ψ/  ← memory
```

### "memory" คือโฟลเดอร์ `ψ/` ในแต่ละ oracle

โครงสร้างข้างใน `ψ/` (ตัวอย่างจาก `bob-oracle`):

```
ψ/
├── memory/
│   ├── learnings/        ← บทเรียนจากแต่ละ session
│   ├── retrospectives/   ← retro
│   ├── collaborations/   ← งานร่วมกับ agent อื่น
│   ├── traces/           ← ร่องรอยงาน
│   ├── resonance/        ← จังหวะที่ "คลิก"
│   └── mailbox/          ← กล่องข้อความถาวร
├── inbox/   outbox/   plans/   teams/
```

### ⚠️ จุดสำคัญ: ตอนนี้ `ψ/` ยังไม่ถูก track

เช็กทุก oracle repo แล้วได้:

| agent | สถานะ `ψ/` ใน git | push ขึ้น remote แล้วยัง |
|---|---|---|
| bob-oracle | `?? ψ/` (untracked, ไม่ได้ ignore) | **ยัง** |
| jack-oracle | `?? ψ/` | **ยัง** |
| john-oracle | `?? ψ/` | **ยัง** |
| mike-oracle | `?? ψ/` | **ยัง** |

→ แปลว่า **ความจำของ agent ทุกตัวอยู่แค่ในเครื่องนี้เครื่องเดียว** ถ้าเครื่องหาย / เผลอ `git clean` = หายหมด
การรวมเข้า repo เดียวจึงเป็น backup ครั้งแรกไปในตัวด้วย

---

## 2. โจทย์

> อยากให้ memory ของทุก agent **push ขึ้น repo เดียว** โดย **ไม่เปลี่ยนโครงสร้างปัจจุบัน**
> (ไม่ย้าย `ψ/`, ไม่แก้ทรงของ oracle repo)

---

## 3. ข้อจำกัดที่เจอ (ทำไมวิธี "สวยที่สุด" ใช้ไม่ได้)

วิธีที่ดูสวยที่สุดคือ: สร้าง git ก้อนเดียวที่ตั้ง work-tree ไว้ที่ `fufu-2345/`
แล้วสั่ง track `ψ/` ทั้ง 4 อันในที่เดิมเลย (เทคนิคแบบ "bare repo dotfiles")

**ทดสอบแล้ว → ใช้ไม่ได้** ❌

```
$ git --git-dir=mem.git --work-tree=fufu-2345 add bob-oracle/ψ
# ผล: ไม่มีอะไรถูก add เลย
```

**เพราะ**: `bob-oracle/` มี `.git` ของตัวเอง → git ตัวนอกมองว่ามันเป็น "repo ซ้อน repo" (embedded repository)
แล้ว **ไม่ยอมเดินเข้าไป add ไฟล์ข้างใน** repo ลูก

→ สรุป: **git ก้อนเดียวที่ track `ψ/` ทั้ง 4 แบบสด ๆ ในที่เดิม เป็นไปไม่ได้** ตราบใดที่ `ψ/` ยังอยู่ใน oracle repo
จึงเหลือ 2 ทางที่ทำได้จริง (ด้านล่าง)

---

## 4. ทางเลือกที่ทำได้จริง

| | **แผน A — repo กลาง + sync** ✅ แนะนำ | **แผน B — repo เดียว แยก branch ต่อ agent** |
|---|---|---|
| รูปแบบ | repo ใหม่ `oracle-memory` มีโฟลเดอร์ย่อย `bob/ jack/ john/ mike/` → script `rsync` `ψ/` เข้าไป แล้ว commit+push | แต่ละ oracle มี git-dir ตัวที่ 2 (work-tree = โฟลเดอร์ oracle, track แค่ `ψ/`) → push ขึ้น repo เดียวกันคนละ branch (`bob`,`jack`,…) |
| `ψ/` | อยู่ที่เดิม ไม่แตะ | อยู่ที่เดิม ไม่แตะ |
| แก้ oracle repo | ไม่แตะเลย | เพิ่ม `ψ/` ใน `.gitignore` แต่ละอัน (1 บรรทัด ไม่ใช่เปลี่ยนทรง) |
| สด vs สำเนา | เป็นสำเนา (มี step sync) | สด commit ในที่เดิม ไม่มีสำเนา |
| ดู memory รวม | repo เดียว เห็นทุก agent เรียงกัน ✅ | ต้องสลับ branch ดู, มี 4 git-dir ต้องดูแล |
| เข้ากับนิสัยเดิม | ตรงกับ pattern auto-index hook ที่ใช้อยู่ | ชิ้นส่วนเยอะกว่า |

### ทางที่ "ตัดทิ้ง" — submodule / symlink
- **submodule**: ทำให้ `ψ/` กลายเป็น submodule + เพิ่ม `.gitmodules` → **เปลี่ยนโครงสร้าง** + tool ของ maw/oracle ที่คาดว่า `ψ/` เป็นโฟลเดอร์จริงอาจพัง
- **symlink**: `ψ/` กลายเป็น symlink → **เปลี่ยนโครงสร้าง** + เสี่ยง tool ตามไม่เจอ

→ ทั้งคู่ผิดเงื่อนไข "ไม่เปลี่ยนโครงสร้าง" จึงไม่เอา

---

## 5. แผน A (แนะนำ) — ทำงานยังไง

### 5.1 ภาพรวม

```
bob-oracle/ψ/  ─┐
jack-oracle/ψ/ ─┤   rsync (สำเนา)         ~/.oracle-memory/
john-oracle/ψ/ ─┼──────────────────────▶   ├── bob/ψ/
mike-oracle/ψ/ ─┘                           ├── jack/ψ/    ──git push──▶  github.com/
   (อยู่ที่เดิม ไม่แตะ)                       ├── john/ψ/                    fufu-2345/oracle-memory
                                            └── mike/ψ/
```

- agent ยังเขียน memory ลง `ψ/` ของตัวเองเหมือนเดิมทุกอย่าง — **วิธีรันไม่เปลี่ยน**
- พอรัน script → memory ทั้ง 4 ไปรวมที่ repo เดียว เป็น commit เดียว push ขึ้น GitHub
- บน GitHub เห็น **repo เดียวที่มี memory ทุก agent เรียงข้างกัน** + history ว่าความจำแต่ละตัวโตยังไง

### 5.2 Setup ครั้งเดียว (~2 นาที)

1. สร้าง GitHub repo ว่าง ๆ เช่น `fufu-2345/oracle-memory`
2. clone มาไว้ที่เดิม ๆ เช่น `~/.oracle-memory/`
3. วาง sync script ไว้ — จบ; **oracle repo และ `ψ/` ไม่ถูกแตะเลย**

### 5.3 Sync script (หัวใจของแผน)

```bash
#!/usr/bin/env bash
set -euo pipefail
SRC=~/Desktop/soulbrew/github.com/fufu-2345
DST=~/.oracle-memory

for o in bob jack john mike; do
  mkdir -p "$DST/$o"
  rsync -a --delete "$SRC/$o-oracle/ψ/" "$DST/$o/ψ/"
done

cd "$DST"
git add -A
git commit -m "memory sync $(date +%F_%H%M)" || echo "ไม่มีอะไรเปลี่ยน"
git push
```

> `--delete` = ให้ฝั่ง repo กลางตรงกับ `ψ/` เป๊ะ (ลบไฟล์ที่ถูกลบต้นทางด้วย)
> ถ้าอยากเก็บสะสมไม่ลบอะไรเลย ให้เอา `--delete` ออก

### 5.4 ทำให้อัตโนมัติ (ผูก hook)

แทนที่จะรันมือ → ชี้ hook มาเรียก script นี้ (pattern เดียวกับ auto-index hook ที่มีอยู่แล้ว):
- รันตอนจบ session (`Stop` hook) หรือ
- รันพ่วงไปกับขั้นตอน index `ψ`→DB ที่ทำอยู่

แล้วก็ "set and forget"

### 5.5 กู้คืนเครื่องใหม่

```bash
git clone https://github.com/fufu-2345/oracle-memory ~/.oracle-memory
# แล้ว rsync ย้อนกลับเข้า ψ/ ของแต่ละ oracle
for o in bob jack john mike; do
  rsync -a ~/.oracle-memory/$o/ψ/ ~/Desktop/soulbrew/github.com/fufu-2345/$o-oracle/ψ/
done
```

### 5.6 ข้อแลกเปลี่ยน

เป็น **สำเนา** → GitHub สะท้อน memory "ณ ตอน sync ล่าสุด" ไม่ใช่สด ๆ ทุกวินาที
สำหรับงาน backup / แชร์ — เพียงพอสบาย ๆ

---

## 6. แผน B (ทางเลือก) — repo เดียว แยก branch

ไม่มีสำเนา: แต่ละ oracle มี git-dir ตัวที่ 2 อยู่นอก `.git` เดิม track แค่ `ψ/`
ทุกตัว push ขึ้น `oracle-memory` repo เดียวกันแต่คนละ branch:

```bash
# ต่อ oracle, ครั้งเดียว:
git --git-dir=~/.mem/bob.git \
    --work-tree=~/Desktop/soulbrew/github.com/fufu-2345/bob-oracle \
    add ψ
# ... commit ...
git --git-dir=~/.mem/bob.git push origin HEAD:bob   # ขึ้น branch ชื่อ bob
```

- memory ถูก commit **ในที่เดิม** (ไม่ rsync)
- ของ bob = branch `bob`, ของ jack = branch `jack`, …
- ต้องเพิ่ม `ψ/` ใน `.gitignore` ของแต่ละ oracle เพื่อให้ repo ตัวเองเลิกขึ้น `?? ψ/`
- **ข้อเสีย**: มี 4 git-dir ต้องดูแล + ดู "memory รวม" ต้องสลับ branch + tool ของ maw/oracle ส่วนใหญ่คาดว่ามี work-tree เดียว

---

## 7. สรุปให้เลือก

| อยากได้ | เลือก |
|---|---|
| repo เดียว เรียบ ๆ ดูง่าย, agent ไม่ถูกแตะ, ยอมมี step sync (ผูก hook ได้) | **แผน A** ✅ |
| commit สดในที่เดิมไม่อยากมีสำเนา ยอมจัดการ git-dir/branch หลายอัน | แผน B |

**ขั้นต่อไป**: ถ้าโอเคแผน A → คุณสร้าง GitHub repo ว่าง `oracle-memory` มา
ที่เหลือ (clone + วาง script + ลองรันรอบแรก + ผูก hook) เดี๋ยวจัดให้

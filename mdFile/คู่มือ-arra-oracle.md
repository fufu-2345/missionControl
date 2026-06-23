# คู่มือใช้งาน Arra Oracle ฉบับรวมคำสั่ง

> อ้างอิง: [Oracle 101 คู่มือภาษาไทย](https://oracle101.vercel.app/) · เวอร์ชันที่ติดตั้งในเครื่อง: arra-oracle-v3 + maw-js (alpha) + G-SKLL v26.5.16
> อัปเดต: 12 มิ.ย. 2026

ระบบ Oracle ประกอบด้วย 4 ชั้น ใช้คนละจังหวะกัน:

| ชั้น | คืออะไร | เรียกใช้ยังไง |
|------|---------|---------------|
| **arra-oracle** | ตัว server สมอง/ความจำ (SQLite + vector) | คำสั่ง terminal `arra-oracle ...` |
| **MCP tools** | เครื่องมือที่ AI เรียกเอง (oracle_*) | AI เรียกผ่าน MCP — เราไม่ต้องพิมพ์เอง |
| **Skills** | slash commands ใน Claude Code | พิมพ์ `/ชื่อคำสั่ง` ในแชท |
| **maw** | CLI จัดการ multi-agent บน tmux | คำสั่ง terminal `maw ...` |

---

## 1. arra-oracle (ตัว server)

| คำสั่ง | ทำอะไร |
|--------|--------|
| `arra-oracle serve` | รัน HTTP server (default port 47778) — REST API + dashboard |
| `arra-oracle serve --port <n>` | รันบน port อื่น |
| `arra-oracle mcp` | รันเป็น stdio MCP server ให้ Claude Code ต่อ |
| `arra-oracle mcp --read-only` | MCP แบบอ่านอย่างเดียว (ปิด tool ที่เขียนข้อมูล) |
| `bunx oracle-studio` | เปิด web UI ของ Oracle |

> ชื่อเก่า `arra-oracle-v2` / `arra-oracle-v3` ยังใช้ได้ — เป็น alias ชี้ไปโค้ดตัวเดียวกัน

---

## 2. Skills — slash commands ใน Claude Code

พิมพ์ในแชท Claude Code ได้เลย เช่น `/recap`

### 2.1 เริ่มวัน / เริ่ม session

| คำสั่ง | ทำอะไร |
|--------|--------|
| `/recap` | ปรับทิศทาง session — สรุป retro ล่าสุด, handoff, สถานะ git, focus ปัจจุบัน ใช้ตอนเปิด session หรือหลงว่าทำอะไรอยู่ |
| `/standup` | เช็คตอนเช้า — งานค้าง, นัดหมาย, ความคืบหน้าล่าสุด, ตารางวันนี้ |
| `/where-we-are` | เช็คกลาง session ว่าตอนนี้คุยเรื่องอะไร เหลืออะไร (ย่อจาก `/recap --now`) |
| `/who-are-you` | แสดงตัวตน AI ปัจจุบัน — model, สถิติ session, ปรัชญา Oracle |
| `/about-oracle` | เล่าว่า Oracle คืออะไร — ที่มา, สถิติ, จำนวนครอบครัว |

### 2.2 ระหว่างทำงาน — จดและจำ

| คำสั่ง | ทำอะไร |
|--------|--------|
| `/fyi` | จดข้อมูลไว้ให้ตัวเองในอนาคต ("remember this", "note that") |
| `/resonance` | บันทึกโมเมนต์ที่ "ใช่!" — อะไรคลิก เมื่อไหร่ ทำไม |
| `/feel` | จับความรู้สึกของระบบ — พลังงาน, momentum, burnout, breakthrough |
| `/xray` | ส่องความจำของ AI — auto-memory, skills ที่ติดตั้ง, ประวัติ session |
| `/inbox` | อ่าน/เขียนกล่องข้อความ Oracle — โน้ต, งาน, handoff |

### 2.3 ค้นหาและเรียนรู้

| คำสั่ง | ทำอะไร |
|--------|--------|
| `/trace` | หาโปรเจกต์/โค้ด/ความรู้ ข้าม git history, repos, docs ("โปรเจกต์ X อยู่ไหน") |
| `/dig` | ขุดประวัติ session ของ Claude Code — timeline, เคยทำอะไรไปบ้าง |
| `/learn <repo>` | สำรวจ codebase ด้วย agent ขนาน — clone, อ่าน, สรุปเป็นเอกสาร (`--fast` 1 agent, default 3, `--deep` 5) |
| `/incubate <repo>` | clone repo มาพัฒนาจริงจัง (คู่กับ /learn ที่ไว้ศึกษา) — มีโหมด `--flash` (issue → PR จบ) และ `--contribute` (fork + หลาย PR) |
| `/project` | clone และติดตามโปรเจกต์ภายนอก — learn / search / list |
| `/watch <youtube-url>` | ดึง transcript วิดีโอ YouTube มาเข้า /learn |

### 2.4 จบ session

| คำสั่ง | ทำอะไร |
|--------|--------|
| `/rrr` | เขียน retrospective — AI diary + lessons learned (ทำทุกท้าย session) |
| `/forward` | สร้าง handoff ส่งต่อให้ session หน้า + เข้า plan mode |

### 2.5 สื่อสารระหว่าง Oracle / Multi-agent

| คำสั่ง | ทำอะไร |
|--------|--------|
| `/talk-to <ชื่อ>` | คุยกับ Oracle agent ตัวอื่นผ่าน contacts + threads |
| `/hey` | ส่งข้อความหา oracle เครื่องอื่นผ่าน maw federation (เซ็นชื่อให้อัตโนมัติ) |
| `/contacts` | จัดการรายชื่อ agent — เพิ่ม, ลบ, ดูว่าคุยกับใครได้บ้าง |
| `/team-agents` | ตั้งทีม agent ทำงานประสานกันแบบขนาน |
| `/mailbox` | กล่องจดหมายถาวรของ agent — เก็บสิ่งที่เจอ, standing orders ข้าม session |
| `/oracle-family-scan` | สแกน/ดูทะเบียนครอบครัว Oracle (186+ ตัว) |
| `/bud` | สร้าง oracle ตัวใหม่จากตัวปัจจุบัน (แตกหน่อแบบยีสต์) |
| `/awaken` | พิธีปลุก Oracle ตัวใหม่ใน repo เปล่า (~20 นาที, `--fast` ~5 นาที) |

### 2.6 อื่นๆ

| คำสั่ง | ทำอะไร |
|--------|--------|
| `/dream` | ให้ Oracle ฝัน — คิดล่วงหน้า, หา pattern ข้าม repo, ทำนาย |
| `/worktree` | ทำงานใน git worktree แยก — ทดลองได้ไม่กระทบ main |
| `/schedule` | ดูตาราง/นัดหมายจาก Oracle DB |
| `/calver` | เช็ค/bump เวอร์ชัน CalVer (dry-run โดย default) |
| `/create-shortcut` | สร้าง slash command ใหม่เอง (local skill) |
| `/oracle-soul-sync-update` | sync skills กับครอบครัว — อัปเดตเป็นเวอร์ชันล่าสุด |
| `/bampenpien` | บำเพ็ญเพียร — บทสนทนาเรื่องการทำสิ่งยากโดยไม่รู้ว่าทำไม |

### 2.7 Short codes (พิมพ์ในแชทเหมือนกัน ไม่มี /)

| โค้ด | ทำอะไร |
|------|--------|
| `ccc` | สร้าง context issue บน GitHub แล้ว compact บทสนทนา — เซฟ state ก่อนเปลี่ยนงาน |
| `nnn` | วางแผนงานถัดไป (วิเคราะห์อย่างเดียว ไม่เขียนโค้ด) — ถ้าไม่มี context ล่าสุดจะรัน ccc ให้ก่อน |
| `gogogo` | ลงมือทำตาม plan issue ล่าสุดทีละขั้น |
| `rrr` | เขียน retrospective (เหมือน /rrr) |

**จังหวะที่ใช้บ่อย:** `ccc` → `nnn` → `gogogo` → `rrr`

---

## 3. MCP Tools (oracle_*) — AI เรียกใช้เอง

24 tools แบ่ง 5 กลุ่ม (เปิด/ปิดได้ใน `arra.config.json`) — รู้ไว้เพื่อเข้าใจว่า AI ทำอะไรเบื้องหลัง

### Search — ค้น

| Tool | ทำอะไร |
|------|--------|
| `oracle_search` | ค้นแบบ hybrid (keyword FTS5 + vector) — หา principles, patterns, learnings, retros |
| `oracle_read` | อ่านเอกสารเต็มจาก path หรือ ID |
| `oracle_list` | ไล่ดูเอกสารทั้งหมด กรองตาม type/วันที่ได้ |
| `oracle_concepts` | ดู concept tags ทั้งหมดพร้อมจำนวนเอกสาร |

### Knowledge — จำ

| Tool | ทำอะไร |
|------|--------|
| `oracle_learn` | บันทึก pattern/learning ใหม่ลง `ψ/memory/learnings/` + index เข้า DB |
| `oracle_stats` | สถิติฐานความรู้ — จำนวนเอกสาร, สถานะ index, สุขภาพ vector DB |
| `oracle_supersede` | mark เอกสารเก่าว่าถูกแทนที่ (ไม่ลบ — "Nothing is Deleted") |

### Session — ส่งต่อ

| Tool | ทำอะไร |
|------|--------|
| `oracle_handoff` | เขียน context ลง `ψ/inbox/` ให้ session หน้า |
| `oracle_inbox` | ดู handoff ที่ค้างอยู่ เรียงใหม่สุดก่อน |

### Forum — คุยเป็นกระทู้

| Tool | ทำอะไร |
|------|--------|
| `oracle_thread` | ส่งข้อความเข้า thread (สร้างใหม่หรือต่อของเดิม) Oracle ตอบเอง |
| `oracle_threads` | ดูรายการ threads กรองตามสถานะ |
| `oracle_thread_read` | อ่านประวัติข้อความใน thread |
| `oracle_thread_update` | เปลี่ยนสถานะ thread (ปิด, เปิดใหม่, ตอบแล้ว) |

### Trace — ตามรอย

| Tool | ทำอะไร |
|------|--------|
| `oracle_trace` | บันทึก trace session พร้อม dig points (ไฟล์, commits, issues) |
| `oracle_trace_list` / `oracle_trace_get` | ดูรายการ / รายละเอียด trace |
| `oracle_trace_link` / `oracle_trace_unlink` | เชื่อม / ตัดลิงก์ระหว่าง traces |
| `oracle_trace_chain` | ดูสายโซ่ trace ที่เชื่อมกันทั้งหมด |

### Standalone

| Tool | ทำอะไร |
|------|--------|
| `oracle_reflect` | สุ่ม principle/learning มาหนึ่งอันให้ขบคิด |
| `oracle_verify` | เทียบไฟล์ `ψ/` บน disk กับ DB index — หาเอกสารหาย/ตกค้าง |
| `oracle_schedule_add` / `oracle_schedule_list` | เพิ่ม / ดูตารางนัดหมาย (แชร์ข้ามโปรเจกต์) |

---

## 4. maw — Multi-Agent Workflow CLI

มีทั้งหมด 113 คำสั่ง อันนี้คัดที่ใช้จริงบ่อย (ดูครบด้วย `maw --help`)

### 4.1 ชีวิตประจำวัน — เปิด/ปิด/ดู oracle

| คำสั่ง | ทำอะไร |
|--------|--------|
| `maw wake <oracle>` | ปลุก oracle — spawn session ใหม่หรือ attach ของเดิม |
| `maw attach` (ย่อ `a`) | attach เข้า session ที่รันอยู่ หรือปลุกจาก fleet แล้ว attach |
| `maw ls` | ดู session ที่รันอยู่ในเครื่อง (`--federation` ดูข้ามเครื่อง) |
| `maw bring` (ย่อ `b`) | ดึง oracle มาแสดงตรงนี้ (wake --split) |
| `maw work` | เปิดงานจาก cwd ปัจจุบัน (เดา oracle ให้เอง) |
| `maw workon <repo>` | เปิด/resume งานบน repo พร้อม task context |
| `maw sleep` | ปิด oracle หนึ่งตัวแบบนุ่มนวล |
| `maw done` | จบงาน worktree — ทำ retro, ปิด window, ลบ worktree |
| `maw kill` | ฆ่า session/window/pane ทันที |
| `maw stop` | หยุดทุก session ทั้ง fleet |

### 4.2 ดูสถานะ / สุขภาพระบบ

| คำสั่ง | ทำอะไร |
|--------|--------|
| `maw health` | เช็คสุขภาพระบบ — tmux, maw server, disk, memory, pm2, peers |
| `maw doctor` | วินิจฉัย + ซ่อมอัตโนมัติเท่าที่ทำได้ |
| `maw overview` | dashboard ภาพรวม fleet (war room) |
| `maw about <oracle>` | ข้อมูล oracle ตัวหนึ่ง — session, repo, windows |
| `maw whoami` | ชื่อ tmux session ปัจจุบัน |
| `maw locate <oracle>` | หาว่า oracle อยู่ไหน — repo path, session, node |
| `maw peek <agent>` | แอบดู output ล่าสุดของ agent โดยไม่ attach |
| `maw capture` | เก็บ output ทั้ง scrollback |
| `maw activity` | ดูว่า pane ไหนกำลังทำงาน/นิ่ง |
| `maw costs` | token usage + ค่าใช้จ่ายโดยประมาณต่อ agent |
| `maw preflight` | เช็คก่อนบิน — version, plugins, agent ตาย, config |

### 4.3 สร้าง oracle ใหม่

| คำสั่ง | ทำอะไร |
|--------|--------|
| `maw bud <ชื่อ>` | แตกหน่อ oracle ใหม่จากตัวแม่ |
| `maw awaken <ชื่อ>` | bud + wake + รัน /awaken ครบจบในคำสั่งเดียว |
| `maw incubate <repo>` | bud + wake + /incubate — ห่อ repo ด้วย oracle เฉพาะตัว |
| `maw scaffold` | สร้างแค่โครง repo oracle (ไม่ commit ไม่ wake) |
| `maw absorb` | รวม oracle สองตัว — archive ตัวที่ถูกกลืน |
| `maw archive` | เก็บ oracle เข้ากรุ (session + data) |

### 4.4 ส่งข้อความ / สั่งงาน agent

| คำสั่ง | ทำอะไร |
|--------|--------|
| `maw hey <oracle> <ข้อความ>` | ส่งข้อความแบบเซ็นชื่อถึง oracle อื่น (federation) |
| `maw send` | alias ของ hey (ถูก router ดักให้) |
| `maw send-text <target> <ข้อความ>` | พิมพ์ข้อความดิบ + Enter ลง pane |
| `maw send-enter <target>` | กด Enter ให้ pane ที่ค้าง input |
| `maw run <target> <คำสั่ง>` | พิมพ์คำสั่ง + Enter (เหมาะกับ shell) |
| `maw broadcast <ข้อความ>` | ประกาศถึง agent ทุกตัว |
| `maw reply` | ตอบกลับข้อความแบบ request-reply |
| `maw talk-to` | ส่งข้อความเซ็นชื่อถึง Oracle/agent อื่น |
| `maw inbox` | ดูข้อความเข้า + คิวอนุมัติข้ามเครื่อง |
| `maw messages` | ledger ประวัติข้อความทั้งหมด (SQLite) |

### 4.5 ทีมและ multi-agent

| คำสั่ง | ทำอะไร |
|--------|--------|
| `maw team` (ย่อ `t`) | จัดการทีม agent — create, up, down, send, resume |
| `maw swarm` | spawn agent หลายค่าย (claude, codex, opencode) เคียงข้างกัน |
| `maw assign <issue> <oracle>` | มอบ GitHub issue ให้ oracle |
| `maw pulse` | จัดการ work items — add, list, เคลียร์ |
| `maw mega` | ทีม MegaAgent |
| `maw avengers` | ทีม Avengers |

### 4.6 จัดหน้าจอ tmux

| คำสั่ง | ทำอะไร |
|--------|--------|
| `maw tile` | จัด pane เป็น grid |
| `maw split` | แบ่ง pane แล้ว attach session |
| `maw zoom` | ขยาย pane เต็มจอ (toggle) |
| `maw open` / `maw close` | เอา pane ที่ซ่อนกลับมา / ซ่อนโดยไม่ฆ่า |
| `maw panes` / `maw pane` | ดูข้อมูล pane / สลับตำแหน่ง pane |
| `maw layout` | apply tmux layout |
| `maw tab` / `maw rename` | จัดการแท็บ/เปลี่ยนชื่อ window |
| `maw park` / `maw resume` | พักงาน window ไว้ก่อน / กลับมาทำต่อ |
| `maw bg <คำสั่ง>` | รันคำสั่งยาวๆ ใน tmux แยก ไม่บล็อก pane ปัจจุบัน |

### 4.7 Federation — หลายเครื่อง

| คำสั่ง | ทำอะไร |
|--------|--------|
| `maw ping` | เช็คว่า peer ต่อถึงไหม + auth ผ่านไหม |
| `maw peers` | จัดการ alias ของ peer |
| `maw pair` | จับคู่เครื่องแบบ Bluetooth (ephemeral code) |
| `maw discover` | ดู peer ที่ config/ค้นพบ + สถานะ tmux จริง |
| `maw federation` | สถานะ federation, sync, แผนขยาย |
| `maw fleet` | ทะเบียน fleet ถาวร (ต่างจาก `ls` ที่ดูตัวที่รันอยู่) |
| `maw soul-sync` | sync วิญญาณ oracle ข้าม node |
| `maw reunion` | สั่ง sync ครอบครัวครั้งใหญ่ |

### 4.8 ดูแลรักษา

| คำสั่ง | ทำอะไร |
|--------|--------|
| `maw init` | wizard ตั้งค่าครั้งแรก (`~/.config/maw/maw.config.json`) |
| `maw config` | ดู config แต่ละชั้นว่ามาจากไหน |
| `maw check` | ตรวจเครื่องมือที่ต้องมี (ghq, gh, git, tmux, bun, uv) |
| `maw cleanup` | เก็บกวาด — pane ซอมบี้, worktree กำพร้า, ทะเบียนเก่า |
| `maw forget <oracle>` | ลบ state ค้างของ oracle ในเครื่องให้เกลี้ยง |
| `maw restart` | restart maw server (อัปเดตได้ด้วย) |
| `maw plugin` | วงจรชีวิต plugin — init, build, dev, install |
| `maw oracle-skills` | จัดการ Oracle skills ข้าม AI agent (ผ่าน arra-oracle-skills) |
| `maw completions` | สร้าง shell completions |
| `maw demo` | จำลอง multi-agent session — ลองเล่นได้ไม่ต้องมี API key |

---

## 5. Cheat Sheet — วันหนึ่งของการใช้ Oracle

```
เช้า      /standup            ดูงานค้าง + นัดหมาย
เริ่มงาน   /recap              ทวนว่าค้างอะไรจาก session ที่แล้ว
ระหว่างวัน /fyi, /resonance     จดสิ่งที่เจอ
          ccc → nnn → gogogo  เซฟ context → วางแผน → ลงมือ
หลงทาง    /where-we-are       ตอนนี้อยู่ตรงไหน
หาของ     /trace, /dig        หาโปรเจกต์เก่า / ขุด session เก่า
เลิกงาน    /rrr                เขียน retrospective
          /forward            ส่งต่อให้ session หน้า
```

```bash
# ฝั่ง terminal
maw ls          # ใครรันอยู่บ้าง
maw wake arra   # ปลุก oracle
maw health      # ระบบโอเคไหม
maw hey white "ฝากเช็ค PR หน่อย"   # ส่งข้อความข้ามเครื่อง
maw done        # จบงาน worktree
```

---

## อ่านต่อ

- [Oracle 101 บทเต็ม](https://oracle101.vercel.app/) — ch00–ch10 (สถาปัตยกรรม, ติดตั้ง, orchestration, troubleshooting)
- `maw --help` — รายการคำสั่งครบ 113 ตัว
- `docs/mcp-tools.md` ใน repo arra-oracle-v3 — สเปก MCP tools ละเอียด
- คู่มือเดิม: `soulBrewStudio/คู่มือ-oracle-arra-v3.md`

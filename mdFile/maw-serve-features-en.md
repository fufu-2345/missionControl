# Every feature of `maw serve` (English)

> Summary as of 2026-06-25 — a complete catalog of every feature `maw serve` brings up.
> (Companion to `maw-serve-อธิบาย.md`, which covers the *boot sequence + web pages*; this file covers *all features/APIs*.)
> Grounded in source: `src/core/server.ts`, `src/core/serve-route-registry.ts`,
> `src/core/serve-ws-registry.ts`, `src/vendor/mpr-plugins/serve-*/`, `src/vendor-plugins/serve-*/`
> (every endpoint pulled from the actually-registered routes via grep).

---

## TL;DR (one line)

`maw serve` is not "a web server" — it's a **single gateway** (Bun, port **3456**) that fuses HTTP + WebSocket,
and **each feature is a separate plugin**. Two groups:

- **Route-registering plugins** (`mpr-plugins/serve-*`) → expose APIs / web pages
- **Background plugins** (`vendor-plugins/serve-*`) → daemons/timers that self-start at boot

→ "the features of maw serve" = the sum of these plugins, not one monolithic blob.

---

## Feature map (one picture)

```
maw serve (Bun gateway :3456)
│
├── serve UI .............. serve-views     → all .html pages + /topology
├── real-time ............. serve-ws        → /ws · /ws/pty · /ws/tmux
├── agent: list/wake/sleep  serve-agents    → /api/agents · /api/agent · /api/wake · /api/sleep · /api/probe
├── messaging ............. (engine)        → /api/send · /api/messages
├── federation/peers ...... serve-federation→ /api/federation/status · /api/peers/discovered · /discoveries
├── remote pane control ... serve-control   → /api/control/:target/{send,key,kill,resize} · /api/pane-keys  🔒
├── triggers (read) ....... serve-triggers  → /api/triggers
├── triggers (fire) ....... serve-triggers-mutate → /api/triggers/fire  🔒
├── worktrees ............. serve-worktrees → /api/worktrees · /api/worktrees/cleanup
├── config + health ....... serve-config-health → /api/config · /api/config/reload · /api/health · /api/status[/:oracle]
├── identity (public) ..... serve-identity  → /api/identity
└── debug / plugin system . serve-debug     → /api/plugins · /api/plugins/reload · HTML status page

background daemons (self-start at boot, no direct endpoint):
   serve-engine-health-polling · serve-maintenance · serve-session-reaper · serve-peer-startup-warnings
```

🔒 = requires a write-token / is opt-in (see Security section)

---

## Features by category

### 1. Serve web pages — `serve-views`
> *"Register maw serve static and bundled view routes."*

- If `~/.maw/ui/dist` exists → serves the whole UI (built from the `maw-ui` repo) **on the same port 3456**
- If not installed yet → serves **"The Door"**, a small landing page to drop in a federation address
- Adds route `/topology` (reads `ψ/outbox/fleet-topology.html`)
- Every page accepts `?host=<peer>` → one UI build can inspect any node in the fleet

> 📄 The full breakdown of all 17 pages (office, fleet, federation_2d/3d, terminal, mission, chat, inbox, …)
> lives in **`maw-serve-อธิบาย.md`** under the "แต่ละหน้า" (each page) table — not duplicated here.

### 2. Real-time — `serve-ws`
> *"Registers maw serve WebSocket upgrade routes and handlers."*

| endpoint | what it does |
|---|---|
| `/ws` | the live feed the UI lives on — agent status/messages are pushed (no polling) |
| `/ws/pty` | streams a PTY (an agent's live terminal), bidirectional |
| `/ws/tmux` | stream/control a tmux pane over WebSocket |

WS registry: `src/core/serve-ws-registry.ts`

### 3. Agent — list / wake / sleep — `serve-agents`
> *"Registers the maw serve agent listing API routes."*

| endpoint | what it does |
|---|---|
| `GET /api/agents` | list every agent in the fleet + status |
| `GET /api/agent` | info for a single agent |
| `POST /api/wake` | wake/create an oracle's session |
| `POST /api/sleep` | gracefully stop an agent |
| `GET /api/probe` | liveness/status check |

### 4. Messaging — `/api/send`, `/api/messages`
Via the engine (the backend behind `maw hey`/`maw talk-to`)

| endpoint | what it does |
|---|---|
| `POST /api/send` | send a message to an agent/peer (enqueued in the message-queue) |
| `GET /api/messages` | read the message-history ledger |

### 5. Federation / peers — `serve-federation`
> *"Registers maw serve federation and discovered-peer API routes."*

| endpoint | what it does |
|---|---|
| `GET /api/federation/status` | cross-machine node connection status |
| `GET /api/peers/discovered` | peers already discovered (config) |
| `GET /api/peers/discoveries` | peers just found by scanning (scout) |

### 6. Remote pane control (for `maw share`) — `serve-control` 🔒
> *"Opt-in, write-token-gated pane control routes for maw share."*

| endpoint | what it does |
|---|---|
| `POST /api/control/:target/send` | type text into a pane |
| `POST /api/control/:target/key` | send a keypress (e.g. Enter, Ctrl-C) |
| `POST /api/control/:target/resize` | resize the pane |
| `POST /api/control/:target/kill` | kill the pane |
| `GET  /api/pane-keys` | which keys are allowed to be sent |

⚠️ **Off by default.** Must be enabled + requires a write-token — because it can write to / drive a real terminal (the most dangerous surface in this set).

### 7. Triggers (automation) — `serve-triggers` + `serve-triggers-mutate`
> read: *"read-only triggers API route"* / write: *"trigger mutation API routes"*

| endpoint | what it does | plugin |
|---|---|---|
| `GET  /api/triggers` | view configured triggers (read-only) | serve-triggers |
| `POST /api/triggers/fire` | fire a trigger | serve-triggers-mutate 🔒 |

Split into two plugins on purpose: reading is safe to expose; "fire" is gated.

### 8. Worktrees — `serve-worktrees`
> *"Registers the maw serve worktrees API routes."*

| endpoint | what it does |
|---|---|
| `GET  /api/worktrees` | list agents' git worktrees (`agents/<n>-<name>/`) |
| `POST /api/worktrees/cleanup` | sweep stale/dead worktrees |

(Ties into the team/builder pattern where each builder sits in its own worktree.)

### 9. Config + Health — `serve-config-health`
> *"Registers maw serve config, health, and agent status API routes."*

| endpoint | what it does |
|---|---|
| `GET  /api/config` | read current fleet config |
| `POST /api/config/reload` | reload config without restarting |
| `GET  /api/health` | health check (for load-balancers / monitors) |
| `GET  /api/status` · `/api/status/:oracle` | aggregate status / a single oracle's |

### 10. Identity — `serve-identity`
> *"Registers the public /api/identity route."*

| endpoint | what it does |
|---|---|
| `GET /api/identity` | declares who this node is `[host:handle]` — **public**, no auth (lets other peers discover it) |

### 11. Debug / plugin system — `serve-debug`
> *"maw serve plugin-system debug API and HTML status page."*

| endpoint | what it does |
|---|---|
| `GET  /api/plugins` | list loaded plugins + status |
| `POST /api/plugins/reload` | hot-reload plugins |
| (HTML page) | human-readable plugin-system status page |

---

## Background daemons (vendor-plugins — self-start at boot, no endpoint)

These are the "housekeeping" features `maw serve` runs automatically:

| plugin | what it does |
|---|---|
| `serve-engine-health-polling` | polls engine-plugin health periodically across the lifecycle |
| `serve-maintenance` | sets timers to **sweep PTYs** + **prune memory** on a cadence (prevents leaks/cruft) |
| `serve-session-reaper` | at boot, **reaps stale tmux sessions** for PTY/view (zombies) |
| `serve-peer-startup-warnings` | warns at boot if **peer auth is exposed** or there's a **duplicate identity** |
| `serve-config-health` | (also a route — see #9 — plus health behavior) |

---

## Security (a theme hidden across many features)

| mechanism | where |
|---|---|
| **bind to localhost only** by default (widens only when a federation peer is set) | `bind-host.ts` heuristic |
| **write-token gating** for routes that can write/drive things | `serve-control`, `serve-triggers-mutate` |
| **warn on exposed auth / duplicate identity** | `serve-peer-startup-warnings` |
| **second HTTPS server** on port `port+1` | when TLS cert/key set in config |
| `/api/identity` is intentionally public | `serve-identity` (must be discoverable) |

> Principle: **read** routes can be exposed; **write/pane-control** routes are token-gated + opt-in.

---

## Management commands (brief — full detail in `maw-serve-อธิบาย.md`)

```bash
maw serve                      # start on port 3456 (bun gateway)
maw serve 3457 --gateway rust  # change port / use the rust gateway
maw serve status               # check whether it's running
maw serve stop                 # stop it
maw serve --force-takeover     # kill the old PID holding the port
maw serve -vvv                 # verbosity 0→4 (quiet → HTTP access → WS frames)
```

---

## Master table (feature → plugin → endpoint)

| feature | plugin | main endpoints | token-gated? |
|---|---|---|---|
| serve UI | serve-views | all `.html`, `/topology` | — |
| real-time | serve-ws | `/ws`, `/ws/pty`, `/ws/tmux` | — |
| list/wake/sleep agent | serve-agents | `/api/agents`,`/api/wake`,`/api/sleep`,`/api/probe` | — |
| messaging | engine | `/api/send`, `/api/messages` | — |
| federation/peers | serve-federation | `/api/federation/status`, `/api/peers/*` | — |
| remote pane control | serve-control | `/api/control/:target/*`, `/api/pane-keys` | ✅ |
| triggers read | serve-triggers | `/api/triggers` | — |
| triggers fire | serve-triggers-mutate | `/api/triggers/fire` | ✅ |
| worktrees | serve-worktrees | `/api/worktrees`, `/cleanup` | — |
| config/health | serve-config-health | `/api/config`,`/reload`,`/health`,`/status` | — |
| identity | serve-identity | `/api/identity` (public) | — |
| debug/plugins | serve-debug | `/api/plugins`, `/reload` | — |
| health polling | serve-engine-health-polling | (daemon) | — |
| maintenance timer | serve-maintenance | (daemon) | — |
| reap zombie sessions | serve-session-reaper | (daemon) | — |
| startup warnings | serve-peer-startup-warnings | (daemon) | — |

# Turma 2.0 Proof of Concept

Validates that dsh can operate in multi-host, single-UI mode.

## What This Proves

1. Multiple dsh instances can register with a central hub
2. A single UI can view sessions across all hosts
3. Commands can be routed to the correct host
4. Session events can be streamed to the hub

## Components

```
┌─────────────────────────────────────┐
│           Fleet Hub                 │
│  - Agent registry                   │
│  - Unified dashboard                │
│  - Command routing                  │
│  - Event aggregation                │
│         :3000                       │
└─────────────────────────────────────┘
        ▲              ▲
        │ WebSocket    │ WebSocket
        │              │
   ┌────┴────┐    ┌────┴────┐
   │  dsh    │    │  dsh    │
   │ host-1  │    │ host-2  │
   │  :3080  │    │  :3081  │
   └─────────┘    └─────────┘
```

## Quick Start

### Option A: Standalone Test (No dsh required)

This simulates two agents to prove the hub/protocol works:

```bash
# Terminal 1: Start the Fleet Hub
cd fleet-hub
npm install
npm run dev

# Terminal 2: Run the standalone test
cd ..
npx tsx test-standalone.ts
```

Open http://localhost:3000 — you should see both simulated hosts.
Click "Spawn Session" to test command routing.

### Option B: Full Test with real dsh

One command — no global dsh install needed, `dsh` comes in as a dependency:

```bash
./test-real-dsh.sh
```

It builds the plugin, installs it into a **throwaway** dsh profile, starts the
Fleet Hub, boots a real dsh instance, and asserts the device registers. On
success it prints `=== PASS ===` and stays up so you can browse:

- Fleet dashboard — http://localhost:3000
- dsh web UI — http://localhost:3080

To add a second host to the same fleet, in another terminal:

```bash
FLEET_DEVICE=dsh-worker-2 DSH_PORT=3081 ./test-real-dsh.sh
```

It reuses the running hub, and both hosts then appear in `/api/agents`.

Knobs: `FLEET_DEVICE`, `DSH_PORT`, `HUB_PORT`, `DSH_HOME`.

Notes:
- The **first** run installs ~460 packages and can take 10+ minutes.
- It installs under `.dsh-test-home/<device>/`, never your real `~/.dsh`.
  Delete that directory to reset. Overriding `DSH_HOME` at a real profile is
  refused unless you also set `DSH_HOME_ALLOW_CLOBBER=1`, because the script
  rewrites the profile's `package.json` and `cordis.patch.yml`.
- On success the script **blocks** (Ctrl+C to stop). If you script around it,
  bound it with `timeout` and match on `=== PASS ===` rather than the exit
  code.

#### Why the plugin installs as a profile bundle

dsh resolves plugins through a **profile bundle**, not through `--patch`.
`dsh web` rejects `--patch` outright, and the correct `dsh --profile web
--patch` form can only *override* an entry some bundle already declared —
aimed at a plugin dsh has never heard of it logs `patch: entry "..." not
found` and boots without it. So the plugin is packed, installed into the
profile, and registered in `dsh.profile.bundles`; the profile's own
`cordis.patch.yml` then overrides that entry's config to set the run's device
and hub URL.

**Plugin integration verified (2026-08-24):**
```
$ curl http://localhost:3000/api/agents
[{"device":"dsh-test-host","sessions":[],"online":true}]
```

## Test Scenarios

### Scenario 1: Agent Registration
- Start hub
- Start two dsh instances
- Verify both appear in dashboard

### Scenario 2: Session Visibility
- Create a session on host-1 via dsh UI
- Verify it appears in fleet dashboard
- Create a session on host-2
- Verify both sessions visible from single UI

### Scenario 3: Command Routing
- From fleet dashboard, spawn a session on host-1
- Verify it starts on the correct host
- Send input to that session
- Verify response

### Scenario 4: Live Events
- Start a session
- Watch events stream to hub in real-time
- Verify tool calls, responses visible

## Files

```
test-real-dsh.sh    # end-to-end test against a real dsh instance
test-multi-host.ts  # multi-host federation test (mock workers)
test-standalone.ts  # hub/protocol test (mock workers)

fleet-hub/
  package.json
  src/
    index.ts        # Express server + WebSocket + dashboard HTML

fleet-agent-plugin/
  package.json      # dsh.bundle points at cordis.yml
  cordis.yml        # bundle patch that inserts the plugin entry
  src/
    index.ts        # dsh plugin entry
```

## Success Criteria

Split by what actually proves each one — the two are not equivalent evidence,
and conflating them was overclaiming.

**Proven against real dsh** (`test-real-dsh.sh`):

- [x] A real dsh instance loads the plugin and registers with the hub
- [x] Multiple real dsh instances register with one hub
- [x] The dashboard lists every registered host

**Proven only against MOCK workers** (`test-multi-host.ts`, `test-standalone.ts`)
— these exercise the hub and the wire protocol, not the plugin's dsh-side code:

- [x] Can spawn a session on a specific host from the dashboard
- [x] Can send input to any session from the dashboard
- [x] Session events stream to the dashboard in real time

**Not yet proven anywhere:**

- [ ] `spawn` / `input` / `kill` driven end to end against a real dsh — the
      plugin's `handleSpawn` / `handleInput` / `handleKill` have never executed
      against a live `ctx.agents`. This is the biggest remaining gap in the
      PoC's evidence.

## Known limitations

- **The hub identifies an agent by DEVICE NAME, and holds one record per
  name.** Two processes claiming one name share that record; the hub treats
  whichever socket registered last as the agent and ignores the other. That is
  why the harness asserts on a per-run `instanceId` rather than the name — a
  name cannot say *which process* is connected.
  - Consequence not yet fixed: when the holding socket closes, the record is
    dropped even if another live socket for that name is still connected, and
    that socket can never re-register without reconnecting first. Fixing it
    means tracking a set of sockets per device and promoting one on close —
    a registry design change, so it is deliberately not folded into the
    harness work. Tracked as XERK-456.
- **The hub is unauthenticated** and binds all interfaces. It is a prototype;
  do not expose it.

## Validation Results (2026-08-24)

All tests pass:

```
============================================================
Turma 2.0 Multi-Host Federation Test
============================================================

Test 1: Connect multiple workers to hub
✓ 3 agents connected (truenas-1, truenas-2, k8x)

Test 2: Spawn sessions on different workers
✓ 3 sessions created across 3 workers

Test 3: Verify event streaming to dashboard
✓ 54 events received from all workers
  Event types: session/created, user/message, assistant/chunk,
               turn/start, request/header, assistant/message, turn/end

Test 4: Route input to specific worker
✓ Input routed to k8x, received 16 new events
  ✓ User message event received
  ✓ Assistant message event received

============================================================
VALIDATION COMPLETE
============================================================

Proven capabilities:
  ✓ Multiple workers can connect to single hub
  ✓ Sessions from all workers visible in one dashboard
  ✓ Session events stream from workers to dashboard
  ✓ Commands can be routed to specific workers
```

This validates the Coordinator Pattern for multi-host dsh federation.

## Real dsh Plugin Integration (2026-08-24)

The `@turma/dsh-fleet-agent` plugin runs inside real dsh instances:

```
dsh web: http://127.0.0.1:3080
$ curl http://localhost:3000/api/agents
[{"device":"dsh-test-host","sessions":[],"online":true}]
```

The plugin:
- Connects to Fleet Hub via WebSocket on startup
- Sends heartbeats with session list every 15s
- Streams session events to the hub in real-time
- Handles spawn/input/kill commands from the hub

This proves the full architecture: **dsh as the agent runtime with 100% plugin architecture**.

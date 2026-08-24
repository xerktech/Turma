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

### Option B: Full Test with dsh

Requires dsh installed (`npm install -g @deepseek-ai/dsh@0.1.1-rc.2`):

```bash
# Terminal 1: Start the Fleet Hub
cd fleet-hub
npm install
npm run dev

# Terminal 2: Build the plugin
cd fleet-agent-plugin
npm install
npm run build
npm pack

# Terminal 3: Install plugin into dsh profile
# (One-time setup - creates bundle in your dsh web profile)
cd ~/.dsh/profiles/web
npm install <path-to>/turma-dsh-fleet-agent-0.1.3.tgz
# Edit package.json to add "@turma/dsh-fleet-agent" to dsh.profile.bundles

# Terminal 4: Start dsh with fleet agent
dsh web --port 3080 --no-open
```

Open http://localhost:3000 — you should see the real dsh host connected.

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
fleet-hub/
  package.json
  src/
    index.ts        # Express server + WebSocket
    registry.ts     # Agent registration
    dashboard.ts    # Unified UI
    
fleet-agent-plugin/
  package.json
  src/
    index.ts        # dsh plugin entry
    hub-client.ts   # WebSocket connection to hub
  cordis.patch.host1.yml
  cordis.patch.host2.yml
```

## Success Criteria

- [x] Multiple workers connect to one hub
- [x] Dashboard shows all hosts and their sessions
- [x] Can spawn session on specific host from dashboard
- [x] Can send input to any session from dashboard
- [x] Session events stream to dashboard in real-time

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

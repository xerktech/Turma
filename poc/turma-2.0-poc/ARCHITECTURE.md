# Multi-Host Single UI Architecture Options

The challenge: dsh's UI reads from local `ctx.sessions`. To show sessions from multiple hosts in ONE UI, we need to federate.

## Option 1: Coordinator Pattern (Recommended)

One dsh instance acts as the "coordinator" that proxies remote sessions into its local context.

```
┌─────────────────────────────────────────────────────────────────┐
│                    Coordinator dsh (UI host)                    │
│                                                                 │
│  ┌─────────────┐  ┌─────────────────────────────────────────┐  │
│  │ ctx.sessions │◄─┤ Remote Session Provider Plugin         │  │
│  │ (federated) │  │  - Syncs sessions from worker hosts    │  │
│  └─────────────┘  │  - Proxies commands to workers         │  │
│                   │  - Streams events from workers         │  │
│  ┌─────────────┐  └─────────────────────────────────────────┘  │
│  │   dsh UI    │                                               │
│  │ (unmodified)│  Shows all sessions - local AND remote        │
│  └─────────────┘                                               │
└─────────────────────────────────────────────────────────────────┘
         │ WebSocket                    │ WebSocket
         ▼                              ▼
    ┌─────────┐                    ┌─────────┐
    │  dsh    │                    │  dsh    │
    │ worker1 │                    │ worker2 │
    │ (no UI) │                    │ (no UI) │
    └─────────┘                    └─────────┘
```

### How It Works

1. **Coordinator dsh** runs the web UI (port 3080)
2. **Worker dsh instances** run headless (no web UI)
3. **Remote Session Provider plugin** on coordinator:
   - Connects to all workers via WebSocket
   - Registers remote sessions into `ctx.sessions` with metadata marking them as remote
   - Proxies `ctx.agents.create()` to the appropriate worker
   - Streams session events from workers and injects them locally
4. **dsh UI sees all sessions** — doesn't know some are remote

### Plugin Implementation

```typescript
// @turma/dsh-remote-sessions
export function apply(ctx: Context, config: Config) {
  const workers = new Map<string, WorkerConnection>()
  
  // Connect to workers
  for (const worker of config.workers) {
    const conn = new WorkerConnection(worker)
    workers.set(worker.id, conn)
    
    // Sync sessions from worker
    conn.on('sessions', (sessions) => {
      for (const session of sessions) {
        // Register remote session in local context
        ctx.sessions.registerRemote({
          ...session,
          remoteHost: worker.id,
        })
      }
    })
    
    // Forward events
    conn.on('session-event', (sessionId, event) => {
      const session = ctx.sessions.get(sessionId)
      session?.injectEvent(event)
    })
  }
  
  // Intercept session creation
  ctx.on('session/pre-create', (opts, next) => {
    if (opts.targetHost) {
      // Route to worker
      const worker = workers.get(opts.targetHost)
      return worker.createSession(opts)
    }
    return next()  // Local session
  })
}
```

### Challenges

1. **Session state sync** — Need to keep remote sessions in sync
2. **Event ordering** — Events from remote must be ordered correctly
3. **Input proxying** — User input must route to correct worker
4. **Persistence** — Where does session data live? Worker has canonical copy.

### Benefits

- **Unmodified dsh UI** — Works with stock dsh
- **Clean separation** — Workers just run sessions, coordinator manages fleet
- **Scalable** — Add workers without changing coordinator


## Option 2: UI Extension Pattern

Keep sessions truly local to each host, add a "Fleet" panel to the UI.

```
┌─────────────────────────────────────────────────────────────────┐
│                         dsh UI                                  │
│  ┌──────────────────┐  ┌──────────────────────────────────────┐│
│  │ Sidebar          │  │ Main Content                         ││
│  │ ┌──────────────┐ │  │                                      ││
│  │ │ Local        │ │  │  Conversation view                   ││
│  │ │ Sessions     │ │  │  (local OR iframe to remote)         ││
│  │ └──────────────┘ │  │                                      ││
│  │ ┌──────────────┐ │  │                                      ││
│  │ │ Fleet        │ │  │                                      ││
│  │ │ ├─ host-1    │ │  │                                      ││
│  │ │ │  └─ sess-a │ │  │                                      ││
│  │ │ └─ host-2    │ │  │                                      ││
│  │ │    └─ sess-b │ │  │                                      ││
│  │ └──────────────┘ │  │                                      ││
│  └──────────────────┘  └──────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

### How It Works

1. **Fleet sidebar plugin** shows all hosts and their sessions
2. **Clicking a local session** works normally
3. **Clicking a remote session** either:
   - Opens that host's dsh UI in an iframe
   - Opens in a new tab
   - Proxies the view through the coordinator

### Challenges

- UI feels fragmented (iframe/tab switching)
- Not truly "single UI" — more like "linked UIs"


## Option 3: Shared Backend Store

All dsh instances share a central session store.

```
┌─────────┐    ┌─────────┐    ┌─────────┐
│  dsh 1  │    │  dsh 2  │    │  dsh 3  │
└────┬────┘    └────┬────┘    └────┬────┘
     │              │              │
     └──────────────┼──────────────┘
                    ▼
           ┌───────────────┐
           │ Central Store │
           │  (Postgres/   │
           │   SQLite)     │
           └───────────────┘
```

### How It Works

1. Replace `ctx.sessions` provider with one backed by central DB
2. All dsh instances see all sessions
3. Session execution is distributed, storage is centralized

### Challenges

- Significant dsh changes (new session provider)
- Latency for session operations
- Single point of failure


## Recommendation: Option 1 (Coordinator Pattern)

**Why:**
1. Works with stock dsh UI
2. Clear separation of concerns
3. Plugin-only implementation
4. Workers can be headless (saves resources)

**Implementation steps:**
1. Build `@turma/dsh-remote-sessions` plugin
2. Define worker-to-coordinator protocol
3. Handle session lifecycle proxying
4. Test with 2 workers + 1 coordinator

**Key question to validate:**
- Can we register "remote" sessions into `ctx.sessions` that the UI will render?
- Can we intercept `ctx.agents` operations to route to workers?

This needs deeper investigation into dsh's session store internals.


## Key Finding: Client-Host Architecture

From dsh's `client-runtime` docs:

> **Client sessions are always Host-born** (Session+Agent+cwd in one `session.create`);
> the client holds no pre-entity session state

The UI is a **mirror** of what the Host serves. It receives:
- `host/session-added` frames when sessions are created
- `session/*` frames for updates
- `session/queue`, `session/event` for live state

**This means: to show multi-host sessions in one UI, we need the HOST to aggregate them.**

The coordinator pattern becomes:

```
┌─────────────────────────────────────────────────────────────────┐
│              Coordinator dsh (runs the UI)                      │
│                                                                 │
│  Host Backend:                                                  │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  ctx.sessions (federated)                                │   │
│  │  - Local sessions (created here)                         │   │
│  │  - Remote sessions (synced from workers)                 │   │
│  │                                                          │   │
│  │  Remote Session Provider Plugin:                         │   │
│  │  - Connects to worker hosts                              │   │
│  │  - Receives session/event streams                        │   │
│  │  - Injects into local SessionStore                       │   │
│  │  - Proxies agent commands to workers                     │   │
│  └─────────────────────────────────────────────────────────┘   │
│                         │                                       │
│                         ▼                                       │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  dsh UI (unmodified)                                     │   │
│  │  - Receives host/session-added for ALL sessions         │   │
│  │  - Receives session/* frames for ALL sessions           │   │
│  │  - Doesn't know which are remote                         │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
         │                              │
         ▼                              ▼
    Worker dsh 1                   Worker dsh 2
    (headless)                     (headless)
```

### Implementation Path

1. **Worker dsh instances** run headless (no web UI)
   - Execute sessions locally
   - Stream events to coordinator
   - Accept commands from coordinator

2. **Coordinator dsh** runs the web UI
   - Has a "Remote Session Provider" plugin
   - Plugin connects to all workers
   - Plugin injects remote sessions into `ctx.sessions`
   - Plugin proxies `agent.*` commands to workers
   - UI sees all sessions as if local

3. **The key question**: Can we inject sessions into `ctx.sessions` from external sources?
   - `ctx.sessions.create()` requires seed events
   - We could create "proxy sessions" that mirror remote state
   - Events from remote would be injected as they arrive

### Alternative: Custom Session Store Provider

If injecting into `ctx.sessions` is too invasive, we could:

1. Implement a custom `SessionStore` that federates
2. Replace the default `ctx.sessions` with our federated version
3. This is more work but cleaner separation

### What We Need to Validate

1. Can we call `ctx.sessions.create()` with remote session data?
2. Can we inject events into a session we didn't create locally?
3. How does the UI handle sessions that don't have local agents?
4. Can we intercept `session.create` RPC to route to workers?


## Validation Results

### 1. Can we call `ctx.sessions.create()` with remote session data?

**YES** — `ctx.sessions.create(id, { seed, meta })` accepts:
- `id`: Optional session ID (can be pre-allocated, e.g., from remote)
- `seed`: Array of `SessionEvent[]` to replay/fork
- `meta`: `SessionHeader` fields including `cwd`, `createdAt`, `parentSession`

```typescript
// Example: Create a session from remote data
const remoteSession = ctx.sessions.create(remoteId, {
  seed: remoteEvents,  // Events from worker
  meta: {
    cwd: remoteCwd,
    createdAt: remoteCreatedAt,
    // Custom field to mark as remote
  }
})
```

**Caveat**: The seed events are **validated and frozen** at creation. They must:
- Have contiguous `seq` values starting from 0
- Be JSON-serializable
- Pass surface validation (message shape, source, etc.)

### 2. Can we inject events into a session after creation?

**YES** — `session.append(type, data, opts?)` is a public method:
- Validates and freezes the event
- Assigns `seq` and `time`
- Emits to `session/event` listeners
- UI receives via the `mux()` stream

```typescript
// Example: Inject remote event
const session = ctx.sessions.get(sessionId)
session.append('user/message', {
  message: { id: msgId, role: 'user', source: {...}, content: [...] }
})
```

**Caveat**: Events must pass the same validation as local events. The coordinator
plugin would need to translate remote events to match expected shapes.

### 3. How does the UI handle sessions without local agents?

**The UI doesn't care about agents** — it renders from:
- `host/session-added` frames (from `session/created` events)
- `session/event` frames (from `session.append()` calls)
- `host/session-status` frames (from `agent/status` events)

A session without a local agent simply shows no `running` status. The UI handles
this as "idle" — which is exactly right for a remote session whose agent runs
elsewhere.

For input routing, the client calls `prompt()` RPC which goes to `ctx.agents`.
A remote session would need to intercept this — see #4.

### 4. Can we intercept operations to route to workers?

**YES** — Cordis events can be intercepted with `ctx.on()` and `ctx.before()`:

```typescript
// Intercept prompt to route to worker
ctx.before('agent/prompt', async (agent, payload) => {
  const session = agent.session
  if (isRemoteSession(session)) {
    await routeToWorker(session.id, payload)
    return false  // Prevent local handling
  }
})
```

For session creation, we can intercept the RPC:
```typescript
ctx.before('api/session.create', async (request) => {
  if (request.targetHost) {
    const result = await worker.createSession(request)
    // Create local proxy session from result
    return { handled: true, result }
  }
})
```

### 5. Additional Finding: Session Metadata

Sessions support custom header fields that survive serialization:
- `parentSession`: Links to fork source
- `delegationDepth`: For subagent chains
- `agentPreset`: For preset-based sessions
- `origin`: For tracking session source

We can use these to mark remote sessions:
```typescript
meta: {
  cwd: remoteCwd,
  origin: { type: 'remote', host: 'worker-1' }
}
```

## Implementation Path (Validated)

1. **Create `@turma/dsh-remote-sessions` plugin**:
   - Connects to worker hosts via WebSocket
   - On worker `session/created`: call `ctx.sessions.create()` with remote data
   - On worker `session/event`: call `session.append()` to inject events
   - Mark remote sessions with `origin: { type: 'remote', host }` in header

2. **Intercept user operations**:
   - `ctx.before('agent/prompt')` → route to worker for remote sessions
   - `ctx.before('agent/interrupt')` → route to worker
   - `ctx.before('session.delete')` → route to worker

3. **Worker plugin**:
   - Streams `session/event` to coordinator
   - Accepts commands via RPC
   - Local agents execute normally

4. **No dsh fork required** — 100% plugin architecture confirmed.

## Remaining Questions

1. **Event ordering**: If events arrive out of order from worker, does `append()`
   reject them? Answer: Yes — `seq` must equal `log.length`. Solution: buffer
   and order on coordinator before appending.

2. **Persistence**: Remote sessions are proxied, not persisted locally. The
   worker holds canonical state. Coordinator stores only what it needs for UI.

3. **Reconnect**: On coordinator restart, remote sessions must be re-synced from
   workers. Workers should send full session list on connect.

## Conclusion

**The Coordinator Pattern is fully viable with 100% plugin architecture.**

The key insight: dsh's session system is designed for event-sourcing. The
`seed` parameter on `create()` and the public `append()` method are exactly
what we need to mirror remote sessions. The UI is session-centric, not
agent-centric — it renders from events, not from agent state.

Next step: Build a minimal working prototype with one coordinator + one worker.

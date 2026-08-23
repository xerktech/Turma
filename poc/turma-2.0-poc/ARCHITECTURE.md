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

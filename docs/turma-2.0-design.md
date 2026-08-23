# Turma 2.0: dsh-Based Fleet Architecture

A redesign of Turma built entirely on DeepSeek Harness (dsh) as the agent runtime, with full
session visibility, local-model-first design, and 100% plugin architecture.

## Goals

1. **Local models primary** — designed for local models with API fallback
2. **Full session visibility** — every event, every tool call, every token
3. **Model-agnostic** — same session capture for any model
4. **No fork required** — build entirely as dsh plugins
5. **Keep essential features** — multi-device, multi-org, ticket tracking, mobile apps

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Turma 2.0 Fleet Hub                               │
│                                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │
│  │  Org Manager │  │ Ticket Queue │  │   Archive    │  │    Usage     │    │
│  │  (isolation) │  │  (routing)   │  │ (aggregator) │  │  (billing)   │    │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘    │
│                                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │
│  │Agent Registry│  │ Peer Roster  │  │  Migration   │  │  API Gateway │    │
│  │  (per-org)   │  │  (per-org)   │  │  Coordinator │  │ (mobile/web) │    │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
         │                    │                    │                    │
         ▼                    ▼                    ▼                    ▼
    ┌─────────┐          ┌─────────┐          ┌─────────┐          ┌─────────┐
    │  dsh    │          │  dsh    │          │  dsh    │          │  dsh    │
    │  +plugins         │  +plugins         │  +plugins         │  +plugins
    └─────────┘          └─────────┘          └─────────┘          └─────────┘
         │                    │                    │                    │
         ▼                    ▼                    ▼                    ▼
    ┌─────────┐          ┌─────────┐          ┌─────────┐          ┌─────────┐
    │ LiteLLM │          │ Ollama  │          │ vLLM    │          │DeepSeek │
    │ (proxy) │          │ (local) │          │ (GPU)   │          │  API    │
    └─────────┘          └─────────┘          └─────────┘          └─────────┘
```

## Why dsh

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (~188k stars) is a plugin-based
agent runtime where everything is a plugin — session management, persistence, telemetry, tools, and
the agent loop itself.

### Key Features We Inherit

1. **Event-sourced sessions** — append-only log of typed events, not transcript parsing
2. **Structured telemetry** — OTEL export with per-event granularity
3. **SQLite persistence** — schema-versioned, compressed, durable
4. **Model-agnostic LLM seam** — `llm-pi-ai` adapter supports any OpenAI-compatible endpoint
5. **Plugin architecture** — extend without forking

### Model Support

dsh's `llm-pi-ai` adapter already supports:
- DeepSeek API (native)
- OpenAI, Anthropic, etc. (via pi-ai catalog)
- **Any OpenAI-compatible endpoint** — LiteLLM, Ollama, vLLM, llama.cpp, etc.

Configuration is YAML, not code:

```yaml
- id: llm
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      local:
        displayName: Local Model
        api: openai-completions
        baseURL: http://localhost:11434/v1  # Ollama
        models:
          - id: qwen2.5-coder:32b
            contextWindow: 131072
          - id: deepseek-r1:70b
            contextWindow: 65536
            reasoningEfforts:
              high: high
```

## 100% Plugin Architecture

### Component Ownership

| Component | Type | Owner |
|-----------|------|-------|
| Fleet Hub | Separate service | Turma |
| Fleet Agent | dsh plugin | `@turma/dsh-fleet-agent` |
| Worktree Manager | dsh plugin | `@turma/dsh-worktree` |
| Jira Integration | dsh plugin | `@turma/dsh-jira` |
| ADO Integration | dsh plugin | `@turma/dsh-ado` |
| Safety Guard | dsh plugin | `@turma/dsh-safety-guard` |
| PR Tracker | dsh plugin | `@turma/dsh-pr-tracker` |
| Peer Roster | dsh plugin | `@turma/dsh-peers` |

**Zero dsh core changes required.**

### dsh Plugin APIs Used

All documented, stable dsh APIs:

```typescript
// Session management
ctx.agents.create(opts)      // Spawn session
ctx.agents.resume(opts)      // Resume session
ctx.sessions.list()          // List all sessions

// Lifecycle events
ctx.on('agent/created', ...)
ctx.on('agent/disposed', ...)
ctx.on('session/event', ...)

// Tool interception (safety guard)
ctx.on('tools/pre-execute', (agent, call, next) => ...)

// Input injection
agent.followup(message)      // Queue user input
agent.steer(message)         // Inject context
agent.cancel()               // Stop session

// Telemetry
ctx.sessionTelemetry         // Usage stats

// HTTP endpoints
ctx.webServer.register(...)  // Add routes for hub communication
```

## Plugin Specifications

### `@turma/dsh-fleet-agent`

Connects dsh instance to Fleet Hub, handles commands, streams events.

```typescript
export const name = 'turma-fleet-agent'
export const inject = ['agents', 'sessions', 'webServer', 'sessionTelemetry']

export interface Config {
  hubUrl: string
  device: string
  token: string
  reposRoot: string
}

export function apply(ctx: Context, config: Config) {
  const hub = new HubClient(config.hubUrl, config.token)
  
  // Register on startup
  ctx.effect(() => {
    hub.connect(config.device)
    return () => hub.disconnect()
  })
  
  // Heartbeat every 15s
  const interval = setInterval(() => {
    hub.heartbeat({
      device: config.device,
      sessions: ctx.sessions.list().map(summarize),
      usage: ctx.sessionTelemetry?.stats(),
    })
  }, 15000)
  ctx.effect(() => () => clearInterval(interval))
  
  // Handle hub commands
  hub.on('spawn', async (opts) => {
    const handle = await ctx.agents.create(opts)
    hub.ack('spawn', { sessionId: handle.agent.id })
  })
  
  hub.on('input', async ({ sessionId, message }) => {
    ctx.agents.get(sessionId)?.followup(message)
  })
  
  hub.on('kill', async ({ sessionId }) => {
    ctx.agents.get(sessionId)?.cancel()
  })
  
  hub.on('peers', (roster) => {
    ctx.emit('turma/peers-updated', roster)
  })
  
  // SSE endpoint for live session events
  ctx.webServer.register({
    path: '/turma/events',
    method: 'GET',
    handler: (req, res) => {
      res.setHeader('Content-Type', 'text/event-stream')
      ctx.on('session/event', (session, event) => {
        res.write(`data: ${JSON.stringify({ session: session.id, event })}\n\n`)
      })
    }
  })
}
```

### `@turma/dsh-worktree`

Creates/cleans worktrees per session (same isolation as current Turma).

```typescript
export const name = 'turma-worktree'
export const inject = ['agents']

export interface Config {
  reposRoot: string
  worktreesDir: string  // .turma/worktrees
}

export function apply(ctx: Context, config: Config) {
  // Pre-spawn hook creates worktree
  ctx.on('turma/pre-spawn', async (opts) => {
    const sessionId = opts.sessionId || crypto.randomUUID()
    const worktreePath = path.join(
      config.reposRoot, config.worktreesDir, opts.repo, sessionId
    )
    
    await exec(`git worktree add --detach ${worktreePath}`, {
      cwd: path.join(config.reposRoot, opts.repo)
    })
    
    return { ...opts, cwd: worktreePath, sessionId }
  })
  
  // Cleanup on dispose
  ctx.on('agent/disposed', async (agent) => {
    const cwd = agent.session.header.cwd
    if (cwd?.includes(config.worktreesDir)) {
      await exec(`git worktree remove ${cwd}`)
    }
  })
}
```

### `@turma/dsh-jira`

Jira integration — same logic as current `hub-agent.py`, plugin form.

```typescript
export const name = 'turma-jira'
export const inject = ['agents']

export interface Config {
  siteUrl: string
  email: string
  apiToken: string
  project: string
}

export function apply(ctx: Context, config: Config) {
  const jira = new JiraClient(config)
  
  // Poll for tickets
  const interval = setInterval(async () => {
    const tickets = await jira.getTickets(config.project)
    ctx.emit('turma/tickets-updated', tickets)
  }, 60000)
  ctx.effect(() => () => clearInterval(interval))
  
  // Update status on lifecycle
  ctx.on('agent/created', async (agent) => {
    const ticket = agent.options.metadata?.ticket
    if (ticket) await jira.transition(ticket, 'In Progress')
  })
  
  ctx.on('agent/disposed', async (agent) => {
    const ticket = agent.options.metadata?.ticket
    if (ticket) {
      const status = agent.session.meta?.prs?.length ? 'In Review' : 'Done'
      await jira.transition(ticket, status)
    }
  })
}
```

### `@turma/dsh-safety-guard`

Permission enforcement via tool interception.

```typescript
export const name = 'turma-safety-guard'
export const inject = ['tools']

export interface Config {
  policy: SafetyPolicy
}

export function apply(ctx: Context, config: Config) {
  ctx.on('tools/pre-execute', (agent, call, next) => {
    const denial = checkPolicy(call, config.policy)
    if (denial) {
      throw new ToolError('DENIED', denial.message)
    }
    return next()
  })
  
  ctx.on('fs/pre-write', (agent, path, next) => {
    if (isProtectedPath(path, config.policy)) {
      throw new FsError('DENIED', `Cannot write to ${path}`)
    }
    return next()
  })
}
```

### `@turma/dsh-pr-tracker`

Detects PR creation from session events.

```typescript
export const name = 'turma-pr-tracker'
export const inject = ['sessions']

export function apply(ctx: Context) {
  ctx.on('session/event', (session, event) => {
    if (event.type === 'tool/result') {
      const pr = extractPrUrl(event.data.message.content)
      if (pr) {
        session.meta.prs = session.meta.prs || []
        session.meta.prs.push(pr)
        ctx.emit('turma/pr-created', { session: session.id, pr })
      }
    }
  })
}
```

### `@turma/dsh-peers`

Writes peer roster file for cross-session messaging.

```typescript
export const name = 'turma-peers'

export interface Config {
  peersFile: string  // ~/.turma/peers.tsv
}

export function apply(ctx: Context, config: Config) {
  ctx.on('turma/peers-updated', async (roster) => {
    const tsv = roster.map(p => 
      `${p.id}\t${p.name}\t${p.host}\t${p.repo}\t${p.branch}\t${p.task}`
    ).join('\n')
    await fs.writeFile(config.peersFile, tsv)
  })
}
```

## Fleet Hub

The Fleet Hub is a **separate service** (not a dsh plugin) that coordinates dsh instances. It's
much simpler than current Turma because dsh handles all session complexity.

### Responsibilities

| Function | Description |
|----------|-------------|
| Agent Registry | Track online dsh instances per org |
| Org Isolation | Trust-on-first-use binding, cross-org prevention |
| Ticket Queue | Route tickets to available agents |
| Peer Roster | Generate per-org roster, push to agents |
| Archive Aggregator | Pull session data from dsh SQLite stores |
| Usage Aggregator | Collect telemetry, enforce limits |
| API Gateway | Serve mobile apps and web dashboard |

### Simplified Design

```typescript
class FleetHub {
  private agents = new Map<string, AgentConnection>()
  private orgs = new Map<string, Set<string>>()
  private ticketQueue = new TicketQueue()
  
  handleRegister(agentId: string, info: AgentInfo) {
    this.agents.set(agentId, new AgentConnection(info))
    this.bindOrg(agentId, info.org)
  }
  
  handleHeartbeat(agentId: string, payload: HeartbeatPayload) {
    this.agents.get(agentId)?.updateState(payload)
    this.aggregateUsage(agentId, payload.usage)
  }
  
  async spawnSession(org: string, opts: SpawnOpts) {
    const agent = this.selectAgent(org, opts.repo)
    return agent.sendCommand('spawn', opts)
  }
  
  getPeersForOrg(org: string): PeerEntry[] {
    return [...(this.orgs.get(org) || [])].flatMap(id => {
      const agent = this.agents.get(id)
      return agent.sessions.map(s => ({
        id: s.id, name: s.rcName, host: agent.device,
        repo: s.repo, branch: s.branch, task: s.task,
      }))
    })
  }
}
```

## Feature Mapping

### Essential Features Preserved

| Feature | Current Turma | Turma 2.0 |
|---------|---------------|-----------|
| Multi-device fleet | Hub + Agent | Fleet Hub + dsh plugins |
| Multi-org isolation | `orgBound` | Fleet Hub org manager |
| Ticket queue | Hub | Fleet Hub |
| Jira/ADO integration | Agent | `@turma/dsh-jira`, `@turma/dsh-ado` |
| PR tracking | Agent | `@turma/dsh-pr-tracker` |
| Session migration | Hub + Agent | Fleet Hub + dsh persistence |
| Mobile apps | Android/Glasses | Updated API endpoints |
| Archive | Hub | Fleet Hub (aggregates dsh SQLite) |
| Safety guards | Agent hooks | `@turma/dsh-safety-guard` |
| Peer roster | Hub + Agent | Fleet Hub + `@turma/dsh-peers` |
| Usage tracking | Hub + Agent | Fleet Hub (aggregates dsh telemetry) |

### New Capabilities

| Feature | Description |
|---------|-------------|
| Full event log | Every session event captured, not just transcript |
| Structured telemetry | Per-turn token usage, timing, error rates |
| Session replay | Event-sourced replay, not transcript parsing |
| Model-agnostic | Same capture for any model |
| Local-first | Designed for local models |
| Rich analytics | Token spend by model, tool success rates, etc. |

## Deployment

### Per-Host dsh Configuration

```yaml
# cordis.yml
- id: turma-fleet
  name: '@turma/dsh-fleet-agent'
  config:
    hubUrl: https://turma-hub.example.com
    device: nas1
    token: ${TURMA_TOKEN}
    reposRoot: /repos

- id: turma-worktree
  name: '@turma/dsh-worktree'
  config:
    reposRoot: /repos
    worktreesDir: .turma/worktrees

- id: turma-jira
  name: '@turma/dsh-jira'
  config:
    siteUrl: https://xerktech.atlassian.net
    email: ${JIRA_EMAIL}
    apiToken: ${JIRA_API_TOKEN}
    project: XERK

- id: turma-guard
  name: '@turma/dsh-safety-guard'
  config:
    policy:
      deniedCommands: [...]
      protectedPaths: [...]

- id: turma-pr
  name: '@turma/dsh-pr-tracker'

- id: turma-peers
  name: '@turma/dsh-peers'
  config:
    peersFile: ~/.turma/peers.tsv

- id: llm
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      local:
        api: openai-completions
        baseURL: http://localhost:11434/v1
        models:
          - id: qwen2.5-coder:32b
            contextWindow: 131072
```

### Container Image

```dockerfile
FROM node:22-alpine
RUN npm install -g @deepseek-ai/dsh
RUN npm install -g @turma/dsh-fleet-agent @turma/dsh-worktree \
    @turma/dsh-jira @turma/dsh-safety-guard @turma/dsh-pr-tracker \
    @turma/dsh-peers
COPY cordis.yml /app/
WORKDIR /app
CMD ["dsh", "web", "--host", "0.0.0.0"]
```

## Code Size Comparison

| Component | Current Turma | Turma 2.0 |
|-----------|---------------|-----------|
| Agent runtime | ~8000 LOC | 0 (dsh) |
| Session management | ~3000 LOC | 0 (dsh) |
| Persistence | ~2000 LOC | 0 (dsh) |
| Fleet plugins | 0 | ~1500 LOC |
| Fleet Hub | ~5000 LOC | ~1500 LOC |
| **Total custom** | **~15000+ LOC** | **~3000 LOC** |

## Migration Path

### Phase 1: Build Plugins (3-4 weeks)

- Fleet Hub with org manager, ticket queue, peer roster
- `@turma/dsh-fleet-agent`
- `@turma/dsh-worktree`
- `@turma/dsh-jira` (port existing logic)
- `@turma/dsh-safety-guard`

### Phase 2: Parallel Deploy (2 weeks)

- Deploy dsh agents alongside Claude Code agents
- Both report to same Fleet Hub
- Hub routes by agent type

### Phase 3: Mobile + Archive (2-3 weeks)

- Update mobile apps for new API
- Build archive aggregator
- Usage tracking integration

### Phase 4: Cutover (1-2 weeks)

- Migrate active sessions
- Retire Claude Code agents
- Archive old transcripts

## Benefits Summary

1. **No fork to maintain** — we're plugin authors, not runtime maintainers
2. **Automatic upgrades** — `pnpm update @deepseek-ai/dsh-*` brings improvements
3. **80% less code** — dsh handles session, persistence, telemetry, tools
4. **Full visibility** — event-sourced sessions capture everything
5. **Model freedom** — local models, any API, same infrastructure
6. **Plugin ecosystem** — our plugins could benefit others

## Open Questions

1. **Session migration format** — Can we export/import dsh sessions for cross-host migration?
2. **Archive search** — Best approach for cross-agent session search?
3. **Mobile parity** — What API changes needed for Android/glasses?
4. **Gradual rollout** — Can dsh and Claude Code agents coexist during transition?

## References

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- [dsh Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/architecture.md)
- [Session Subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/subsystems/session.md)
- [Telemetry Subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/subsystems/session-telemetry.md)
- [LLM Adapter Cookbook](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/cookbook/adding-an-llm-adapter.md)

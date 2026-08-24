# DeepSeek Harness Integration

Research and integration plan for adding DeepSeek Harness (`dsh`) as a selectable agent type in Turma.

## What DeepSeek Harness Is

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) is an open-source,
plugin-based agent runtime built on the Cordis framework (~188k stars). Its tagline "Everything is a
Plugin" describes a highly modular architecture where session management, persistence, telemetry,
tools, and the agent loop itself are all pluggable.

Key value proposition for Turma: **full session data capture** with event-sourced sessions,
structured telemetry export, and rich session analytics.

## Architecture Highlights

### Event-Sourced Session Model

Sessions are **append-only logs** of typed `SessionEvent`s. LLM message history is *derived* from
the log, never stored separately. Every event has:

| Field | Description |
|-------|-------------|
| `type` | Event type (e.g. `turn/start`, `assistant/message`, `tool/call`) |
| `seq` | Monotonic sequence number within session |
| `time` | Unix epoch milliseconds |
| `data` | Type-specific payload |

Core event types:
- `turn/start`, `turn/end` — Turn boundaries with end reasons
- `step/start`, `step/end` — Model call + tool execution boundaries
- `user/message` — User input (direct, injected context, steering)
- `assistant/chunk` — Raw stream chunks (token-level replay fidelity)
- `assistant/message` — Assembled assistant response with token usage
- `tool/call`, `tool/result` — Tool invocation and outcome
- `request/header` — Full request envelope (config, system prompt, tools)

### Session Persistence

Two backends available:

1. **JSONL backend** — Simple file-based persistence (like Claude Code's transcripts)
2. **SQLite backend** — Schema-versioned, packed compressed event rows, WAL mode, full durability

The persistence layer is decoupled from the session store via a capability seam, with semantic
checkpoint policies (not every event triggers a write).

### Session Telemetry

This is the standout feature we want:

- **Live capture**: Subscribes to session firehose + `agent/error` relay
- **On-demand capture**: Replays canonical log when requested
- **Redaction waterfall**: `session-telemetry/record` waterfall allows deployment rules to
  transform/redact before export
- **OpenTelemetry export**: Ships to any OTEL-compatible backend
- **Three modes**: `FULL`, `FEEDBACK_ONLY`, `DISABLED`

Records captured:
- Every session event (with first-chunk-only projection for streaming to reduce noise)
- Operational records: `agent-error`, `shutdown`
- Severity auto-mapped from `isError` flags on tool results and `turn/end` reasons

The handoff cursor (per-session WeakMap) tracks what's been delivered, enabling crash recovery
without duplicate delivery.

### Session Stats & Projections

- `session-stats`: Whole-log conversation counts and wall times
- `session-title`: LLM-generated session titles from first/all prompts
- `session-projection-cache`: Persists and restores projection checkpoints

### Agent Registry

- `ctx.agents.create()` / `ctx.agents.resume()` for session lifecycle
- `AgentHandle = { agent, dispose() }` pattern for consumer ownership
- Rich event vocabulary: `agent/created`, `agent/disposed`, `agent/pre-step`, `agent/request-error`

## Integration Options

### Option A: Native dsh Process (Recommended)

Run `dsh` as the agent process instead of `claude --remote-control`, capturing its native session
data.

**Pros:**
- Full event-sourced session model
- Native telemetry export
- Rich session replay
- Structured analytics

**Cons:**
- Different tool set than Claude Code
- Requires DeepSeek API key (or adapter work for other providers)
- Two agent runtimes to maintain

### Option B: Telemetry Sidecar

Keep Claude Code as the agent, add dsh-style session capture alongside by parsing transcripts into
the dsh event model.

**Pros:**
- Keep existing Claude Code capabilities
- Incremental adoption

**Cons:**
- Lossy conversion from transcript to events
- Maintains two representations
- Less accurate than native capture

## Detailed Plan (Option A)

### Phase 1: Basic dsh Agent Type

#### 1.1 Add `agentType` to Session Spawn

Extend spawn options in `hub-agent.py`:

```python
AGENT_TYPES = {'claude', 'deepseek'}  # Allowlist validated agent-side

# In spawn handler:
agent_type = opts.get('agentType', 'claude')
if agent_type not in AGENT_TYPES:
    raise ValueError(f'invalid agentType: {agent_type}')
```

Hub passes `agentType` through to the agent; the agent dispatches to the appropriate launcher.

#### 1.2 Create DeepSeek Agent Launcher

New launcher function in `hub-agent.py`:

```python
def _launch_dsh_session(session_id: str, cwd: str, opts: dict) -> dict:
    """Launch dsh in headless mode with telemetry enabled."""
    # 1. Create cordis.yml config for this session
    # 2. Start dsh with --profile headless
    # 3. Configure OTEL export to local file
    # 4. Configure SQLite persistence under worktree
    # 5. Return session metadata (ttyd URL, etc.)
```

dsh CLI invocation:
```bash
dsh --profile headless \
    --config session.persistence.path=.dsh/session.sqlite \
    --config telemetry.mode=full \
    --config telemetry.export.path=.dsh/telemetry.jsonl \
    "initial prompt or task"
```

#### 1.3 Session State Reading

Read session state from dsh SQLite:

```python
def _read_dsh_session_state(session_dir: str) -> dict:
    db_path = os.path.join(session_dir, '.dsh', 'session.sqlite')
    # Query sessions and events tables
    # Return normalized state for heartbeat
```

#### 1.4 Hub Changes

In `turma/server.js`:

- Add `agentType` to session records (default `'claude'`)
- Differentiate transcript reading by agent type
- Normalize dsh events to Turma's display format

### Phase 2: Full Session Data

#### 2.1 Telemetry Export

Configure dsh to export OTEL logs to a JSONL file:

```yaml
# cordis.yml overlay
plugins:
  - package: '@deepseek-ai/dsh-session-telemetry-otel'
    config:
      mode: full
      exporter:
        type: file
        path: ${SESSION_DIR}/.dsh/telemetry.jsonl
```

#### 2.2 Event-to-Display Mapper

Map dsh `SessionEvent` types to Turma's rendering in `tunnel-agent.js`:

```javascript
function mapDshEventToBlock(event) {
  switch (event.type) {
    case 'user/message':
      return { type: 'user', content: event.data.content };
    case 'assistant/message':
      return { type: 'assistant', content: event.data.message.content };
    case 'tool/call':
      return { type: 'tool_use', name: event.data.name, input: event.data.arguments };
    case 'tool/result':
      return { type: 'tool_result', content: event.data.message.content };
    // ...
  }
}
```

#### 2.3 Live Tail

Tail the telemetry JSONL for live updates, or poll the SQLite events table.

### Phase 3: Analytics

#### 3.1 Session Stats Aggregation

Leverage dsh's event model for rich analytics:

```javascript
function computeSessionStats(events) {
  return {
    turns: countTurns(events),
    steps: countSteps(events),
    tokens: sumTokenUsage(events),
    wallTime: computeWallTime(events),
    toolCalls: countToolCalls(events),
    errorRate: computeErrorRate(events),
  };
}
```

#### 3.2 Token Usage Dashboard

New view showing:
- Token spend over time (input/output by model)
- Tool call patterns (frequency, success rate)
- Error rates by type
- Average turn duration

## Configuration

New env vars on agent container:

```bash
# DeepSeek API (required for dsh agent type)
DEEPSEEK_API_KEY=...
DEEPSEEK_BASE_URL=...  # Optional, defaults to api.deepseek.com

# dsh telemetry settings
DSH_TELEMETRY_MODE=full        # full | feedback-only | disabled
DSH_PERSISTENCE=sqlite         # sqlite | jsonl
```

## Considerations

### DeepSeek API vs Local Models

dsh is built for DeepSeek's API, but the LLM adapter is pluggable. Could wire it to:
- Local models via LiteLLM (similar to our existing local-model failover)
- Other providers via their adapter packages

### Claude Code Feature Parity

dsh has its own tool set (fs, shell, subprocess capabilities). The feature set won't match Claude
Code exactly:
- Different permission model (`dsh-interaction` vs safety guard)
- Different tool implementations
- Different system prompt assembly

### Web UI Options

dsh has its own web UI (`dsh web`) at port 3080. Options:
1. **Headless only**: Run dsh headless, build Turma's views over the session data
2. **Expose native UI**: Run dsh web alongside ttyd, link from Sessions page
3. **Hybrid**: Headless for automation, native UI available for debugging

Recommendation: Start with headless (option 1) for consistency with Claude Code sessions.

## Open Questions

1. **Agent type selection**: User choice per session, or org-level default?
2. **Migration path**: Can we import existing Claude Code transcripts into dsh format for analytics?
3. **Cost comparison**: Token usage comparison between Claude and DeepSeek for similar tasks?
4. **Tool compatibility**: Which Claude Code tools have dsh equivalents? Gap analysis needed.

## References

- [DeepSeek Harness repo](https://github.com/deepseek-ai/deepseek-harness)
- [Session subsystem docs](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/subsystems/session.md)
- [Telemetry subsystem docs](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/subsystems/session-telemetry.md)
- [Persistence docs](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/subsystems/persistence.md)

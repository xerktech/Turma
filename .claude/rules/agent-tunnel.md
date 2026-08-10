---
paths:
  - "agent/tunnel-agent.js"
  - "agent/tests/tunnel-agent.test.js"
---

# `agent/tunnel-agent.js` — reverse tunnel, live tail and pane footer

It is a JS re-implementation of `hub-agent.py`'s transcript and pane parsers — the parity contract
is in `CLAUDE.md`, and `.claude/rules/agent.md` carries the Python side.

- The reverse tunnel; the hub's `{open,port}` selects which per-session ttyd to bridge over one
  per-host control channel, which also carries the **live transcript tail** (`{watch}`/`{unwatch}`,
  ~1s, `{tail,entries}` deltas). Tailing runs only while a client watches. It is a JS
  re-implementation of `hub-agent.py`'s parsers — see `CLAUDE.md`'s parity contract.

### Control-channel liveness

- **Both ends prove the channel rather than assume it**: the heartbeat is a fresh HTTP POST while
  the tunnel is one long-lived socket, so they die independently — a wedged tunnel reads as a
  healthy host (`online` with `terminalOnline:false`).
- Hub beats every `CONTROL_PING_EVERY_MS` (30s) and drops a channel silent for
  `CONTROL_DEAD_AFTER_MS` (90s); the agent reconnects after `TURMA_CONTROL_IDLE_TIMEOUT_MS` (90s).
- It sends **two pings and needs both**: the **protocol ping** (`0x9`), auto-ponged by every agent,
  is liveness the hub gets from OLD agents for free (how it reaps a half-open channel to a host that
  died without a FIN); the **app-level `{ping}`** text frame is the only liveness a browser-style
  WebSocket's `onmessage` can observe. Older agents ignore the unknown key.
- **A dead hub does not necessarily close the socket** — through Cloudflare the edge holds the
  agent's end open after the origin dies, so **silence, not a close event, is what the agent acts
  on**.
- The agent's watchdog arms **only once the hub has proven it app-pings**, so a new agent against an
  older hub keeps the old behaviour instead of reconnect-looping.
- `retire()` is idempotent per-socket and **never waits on `ws.close()`**: it schedules the
  reconnect itself. **Supervision cannot cover any of this** — the native supervisor only respawns
  on process *exit*, and a wedged socket never exits.
- Tests: `tunnel-agent.test.js`, `server.test.js`.

### Live working footer and agent list

- `parsePaneLiveTurn` → `{generating,text,status,agents}`: the in-progress assistant text plus
  `status = {verb, token counters, elapsed, hint}` and the live agent rows (`parseAgentList`).
- **`agents` is parsed before the busy check and rides the FRAME, not `status`** (XERK-245): the two
  stop being true at different moments. `status` is "a turn is running" — it drives the chat's Stop
  button, so it must clear the instant the turn ends — while a background agent keeps going past
  that, which is exactly when the operator can no longer tell the session from an idle one. It stays
  on `status` as well while generating, for an older hub that forwards only `status`.
- **`turn` text only ever moves forward** (`resolveLiveText`): activity summaries strip off the
  REFLOWED tail (`stripActivityTail`); already-committed text is suppressed (`committedDupe`,
  skeleton compare — the pane renders markdown away); and UNCOMMITTED prose HOLDS through
  empty/tool-bullet frames until the tail owns it (at a block boundary the tool bullet paints before
  the entry lands — clearing into that gap blinks).
- A single-frame **busy→idle blip is held one poll** before the bar clears (`liveTurnDecision`,
  XERK-42); busy is never held.
- **Clicking a subagent row opens that background agent's own transcript**: `subagentHistory` →
  `_resolve_subagent`/`_stage_subagent_history` maps the row to `subagents/agent-<id>.jsonl` via the
  main transcript's Task `tool_use` + its result text (`agentId: <id>`), matching type + description
  (exact else prefix; **trailing pane-ellipsis stripped**, XERK-130). Results ride the next beat as
  `subagentHistoryResults`.
- Tests: `TestResolveSubagent`, `TestStageSubagentHistory`; `parseAgentList`, `liveTurnDecision`,
  `stripActivityTail` in `tunnel-agent.test.js`.


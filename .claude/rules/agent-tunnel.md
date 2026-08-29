---
paths:
  - "agent/tunnel-agent.js"
  - "agent/tests/tunnel-agent.test.js"
---

# `agent/tunnel-agent.js` — reverse tunnel, live tail and pane footer

JS re-implementation of `hub-agent.py`'s transcript/pane parsers — parity contract in `CLAUDE.md`,
Python side in `.claude/rules/agent.md`.

- The reverse tunnel; the hub's `{open,port}` selects which per-session ttyd to bridge over one
  per-host control channel, which also carries the **live transcript tail** (`{watch}`/`{unwatch}`,
  ~1s, `{tail,entries}` deltas). Tailing runs only while a client watches.

### Control-channel liveness

- **Both ends prove the channel rather than assume it** — heartbeat is a fresh HTTP POST, the tunnel
  is one long-lived socket; they die independently, so a wedged tunnel reads as `online` with
  `terminalOnline:false`.
- Hub beats every `CONTROL_PING_EVERY_MS` (30s), drops a channel silent for `CONTROL_DEAD_AFTER_MS`
  (90s); agent reconnects after `TURMA_CONTROL_IDLE_TIMEOUT_MS` (90s).
- **Sends TWO pings, needs both**: the protocol ping (`0x9`, auto-ponged by every agent — how the hub
  reaps a channel to a host that died without a FIN) and the app-level `{ping}` text frame (the only
  liveness a browser WebSocket's `onmessage` can observe). Older agents ignore the unknown key.
- **A dead hub does not necessarily close the socket** — Cloudflare's edge holds the agent's end
  open after the origin dies, so **silence, not a close event, is what the agent acts on**.
- Agent's watchdog arms **only once the hub has proven it app-pings** — a new agent against an older
  hub keeps old behaviour instead of reconnect-looping.
- `retire()` is idempotent per-socket, **never waits on `ws.close()`** (schedules its own reconnect).
  **Supervision can't cover this** — the native supervisor respawns only on process exit, and a
  wedged socket never exits.
- Tests: `tunnel-agent.test.js`, `server.test.js`.

### Live working footer and agent list

- `parsePaneLiveTurn` → `{generating,text,status,agents}`: in-progress assistant text plus
  `status = {verb, token counters, elapsed, hint}` and live agent rows (`parseAgentList`).
- **`agents` rides the FRAME, not `status`** (XERK-245) — they clear at different moments: `status`
  is "a turn is running" (drives the Stop button, must clear the instant a turn ends), while a
  background agent keeps going past that.
- **The frame's `agents` come from the TRANSCRIPT** (`scanAgentEntry`, folded into per-watcher
  `agentState` persisting across polls), **never the pane** — forged rows + the ~24s linger ruled
  the pane out (`agent.md`). A tail window is a pure suffix, so re-folding is safe; a stop already
  seen beats a later-read launch (a queued notification can sit at an earlier offset than its
  launch).
- `__setControlSink` lets a test drive `startWatch` → `transcriptTail` → `pollWatcher` and assert the
  emitted frame carries `agents`.
- The pane's footer rows still ride `status.agents` while a turn runs, for live elapsed/token
  counters the transcript can't know. **Display only — never liveness.**
- **`turn` text only ever moves forward** (`resolveLiveText`): activity summaries strip the REFLOWED
  tail (`stripActivityTail`); already-committed text is suppressed (`committedDupe`); UNCOMMITTED
  prose HOLDS through empty/tool-bullet frames until the tail owns it (else clearing into the gap
  before a block lands blinks).
- A single-frame busy→idle blip is held one poll before the bar clears (`liveTurnDecision`, XERK-42);
  busy is never held.
- **Clicking a subagent row opens that background agent's own transcript**: `subagentHistory` →
  `_resolve_subagent`/`_stage_subagent_history` maps the row to `subagents/agent-<id>.jsonl` via the
  main transcript's Task `tool_use` + result text (`agentId: <id>`), matching type + description
  (exact else prefix; trailing pane-ellipsis stripped, XERK-130). Results ride the next beat as
  `subagentHistoryResults`.
- Tests: `TestResolveSubagent`, `TestStageSubagentHistory`; `parseAgentList`, `liveTurnDecision`,
  `stripActivityTail` in `tunnel-agent.test.js`.

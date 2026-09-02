---
paths:
  - "agent/dsh_session.py"
  - "agent/dsh-session-driver/**"
  - "agent/hub-agent.py"
  - "agent/tests/test_dsh_session.py"
---

# Driving a dsh session: input, interaction, projection (XERK-467 [C])

A dsh session is headless: no Claude TUI pane. Input, answers and liveness ride a per-session UNIX
control socket; its transcript is a projection of dsh's own event log. Runtime-selection is [A]
(`dsh.md`); the projector is [S1] (`dsh_transcript.py`).

## The three pieces

- **`agent/dsh-session-driver/`** — cordis plugin loaded by the dsh process. Creates ONE agent on the
  pinned session id, binds `~/.turma/dsh/<id>.sock`, writes each raw `session/event` as one JSONL line
  to the native log, speaks the control protocol. **Identity comes from process ENV
  (`TURMA_DSH_*`), never plugin config** — dsh hot-reloads config and every dsh sharing a `DSH_HOME`
  reads the same file, so config-borne identity lets an abandoned instance adopt another's id (the
  `TURMA_FLEET_INSTANCE_ID` discipline).
- **`agent/dsh_session.py`** — `DshControl` (control-socket client) + `DshProjectionTail` (tails the
  native log via `DshProjector`, appends to the pinned `<claudeSessionId>.jsonl`). stdlib-only, off
  the beat.
- **`hub-agent.py`** — `_launch_dsh`, the dsh arms of `send_input`/`notify_session`/`answer_question`,
  interaction callbacks.

## Control-socket contract (LDJSON, plugin BINDS / hub-agent CONNECTS)

hub→plugin (acked `{ok,error?}`): `input{source:{kind:user|peer|machine},text}`,
`answer{requestId,optionIndex?|optionIndices?|text?}`, `state{}`, `kill{}`.
plugin→hub: `state{status,eventCount}`, `interaction{requestId,kind,prompt,options,detail?}`,
`interaction_end{requestId}`, `peer_send{name,text}` (XERK-476), `peer_inbound{from,text}` (XERK-476).
**Answer indices are 0-based into the emitted `options[]`** (same as `answer_question`); the plugin
maps to dsh's native answer (option label or approval outcome).

## Cross-session peer messaging (XERK-476)

Roster mechanics (runtime-independent, already worked, incl. `DSH_PEERS_ADDENDUM` since dsh's send
tool is `send_message` and has no `ListAgents`) are in `dsh.md` [L]. This adds MESSAGING, hub-routed
both ways.

- **SEND (dsh → peer).** Driver registers a `send_message` tool → emits `peer_send`.
  `_on_dsh_peer_send` STAGES it; `_drain_dsh_peer_traffic` (on the beat, NEVER the reader thread — a
  callback may not socket-write to another session) resolves the name against this host's running
  sessions and delivers peer-framed: Claude target via `_post_to_inbox` (dsh session's `rcName` as
  `from`, no `INBOX_PREFIX` — indistinguishable from a native SendMessage); dsh target via
  `ctl.input(kind="peer")`. Same-host only (same-org by construction, matches Claude's
  `isolatePeerMachines`); unknown/ambiguous/cross-host name drops best-effort.
- **RECEIVE (native Claude peer → dsh).** Claude's SendMessage only delivers to a socket its own
  registry lists (`~/.claude/sessions/<pid>.json` → `messagingSocketPath`). The DRIVER forges that
  record under its OWN live pid, binds `cc-socks/<pid>.sock` (pid must be live — registry
  liveness/peercred checks require it). Inbound verified against wire `session_id`, forwarded as
  `peer_inbound`, `_deliver_dsh_peer_inbound` applies `crossSessionInbound` opt-out before
  `ctl.input(kind="peer")`.
- **RECEIVE depends on Claude Code's PRIVATE, versioned peer-record format** — host-verified only, no
  CI, may drift across Claude releases. SEND has no such dependency. A hard-killed dsh session may
  leave a stale forged record until Claude's own registry reaper drops it (harmless).
- Tests: `test_dsh_session.py` (dispatch), `TestDshRouting` (`test_hub_agent.py`: resolution,
  framing, opt-out, unknown name, inbound inject, teardown). RECEIVE's native delivery is HOST-PROOF
  only (private record format; this sandbox's own guard blocks forging a session record in CI).

## Why the Claude mechanics do NOT copy

- **No compaction outbox.** dsh's event log is append-only and has no pane, so `_dsh_send_input`
  keeps no `pendingInputs` outbox. Don't add one.
- **`notify_session` → a `source.kind` followup.** `_dsh_notify` sends `machine`/`peer` with
  `INBOX_PREFIX` (belt-and-suspenders). `crossSessionInbound` opt-out downgrades to `user`-sourced
  (the pane-fallback analogue). Returns True only when delivered peer-framed.
- **AskUserQuestion ↔ dsh HITL is register-as-answerer, not event-then-answer**: the plugin registers
  the `approval/request` waterfall + a `userQuestions` provider; dsh calling one emits `interaction`
  and BLOCKS on a Promise the hub resolves with `answer`. `_on_dsh_interaction` renders into the SAME
  `QUESTIONS_DIR/<sid>.req.json` shape every client already reads — no client changes. `_dsh_answer`
  sends the frame and clears the file. `_refresh_dsh_questions` bumps the req mtime each beat (dsh has
  no ask.py self-timeout to bound `QUESTION_STALE_AFTER_SEC`).
- **Caps reuse** `INPUT_MAX_CHARS`/`_store_uploads` — not re-reported.
- **Busy/"Working" is [D] (XERK-468), not [C].** `_on_dsh_state` records the socket edge in
  `self.dsh_status`; [C] doesn't wire the mirrors. Guard equivalent is [F]; [C] owns only the
  AskUserQuestion side of `agent-hooks.md`.

## Session naming — dsh's OWN title, and the two-title race

Named from dsh's `session/title` event, never `claude -p` (decision: `dsh.md` [D]). Tail captures
`data.title`; `_seed_dsh_summary` applies it on the beat.

- **dsh writes TWO `session/title` events.** A crude `source.kind=="fallback"` slice lands instantly
  at first turn; the real `source.kind=="provider"` title lands later (a separate LLM call that can
  outlast one `INTERVAL`). `title()` returns the latest; `title_final()` is true for any non-fallback
  source.
- **`_seed_dsh_summary` names in THREE tiers, weakest first, later overrides earlier**, run BEFORE
  `_summary_due` (which never re-checks once `summary` is set):
  - Tier 1 — GENERATED title (non-fallback): authoritative, kept in sync, drops provisional.
  - Tier 2 — deterministic FALLBACK title: provisional.
  - Tier 3 — first user PROMPT (`_first_user_text`): provisional. **Keeps the card non-blank when dsh
    emits NO title at all** (older dsh, title-route failure, no title plugin).
- **The override is SCOPED to this seeder's own PROVISIONAL name** — never clobbers a ticket's
  `<key> <summary>`, a migrated name, or `summaryManual`. (Guarding only `summaryManual` — clobbering
  ticket names — was a caught regression.)
- **A manager restart mid-naming**: `_reattach_dsh` restarts the tail at the log's EOF, so a title
  written before restart is behind EOF, unread. Self-heals on any later title.
- **Sibling-module skew guarded on the beat**: `hub-agent.py` calling `title()` on an old
  `dsh_session.py` degrades to "unnamed this beat", never a crash (XERK-395/402). Tests:
  `test_dsh_fallback_title_is_provisional_then_upgraded`,
  `test_dsh_generated_title_lands_first_no_provisional`, `test_title_final_*`,
  `test_captures_dsh_auto_title_*`.

## Pitfalls (each cost real time)

- **A BOUND control socket ≠ alive** (XERK-492): a load-time crash can abort dsh right after bind, so
  `_launch_dsh` calls `_confirm_dsh_launch` after `start()` — waits for the driver's **`agentUp`**
  field (set once `agents.create`/`resume` RESOLVES, distinct from `status`), fails fast if the tmux
  is gone or the window elapses. Failure RAISES through `_set_error`/`_refuse_start` (XERK-265). A
  driver too old to report `agentUp` falls back to "usable state reply == up". The driver EXITS(1) on
  agent-create failure (no lingering zombie). Tests: `TestConfirmDshLaunch`.
- **Control socket path must stay SHORT** (< ~108 bytes, `sun_path`). A long base path silently
  truncates bind/connect. Never move the socket under a deep path.
- **Forged peer inbox socket MUST be `cc-socks*/<pid>.sock` under the driver's OWN pid** (XERK-476) —
  Claude Code validates the path shape + `SO_PEERCRED`. A mismatch is refused; the session looks
  reachable but isn't.
- **`inject` must include `agentLoop`** — `@deepseek-ai/dsh-agent-loop` registers the agent factory;
  without it `agents.create()` throws.
- **On the MINIMAL profile, `agentPresets` mount FAILING is EXPECTED** (XERK-498): it succeeds on
  `web` (roster delivers tools) but is absent on `[base, driver]` — tools come from
  `@deepseek-ai/dsh-base`'s global layer instead. Never make the mount failure fatal. `input` waits
  for the agent to register before `followup`, or the initial prompt races ahead and drops.
- **Native event log lives under `<tid>/dsh/`, NOT the worktree** (XERK-469 [E]) — the raw archive
  layer excludes the worktree. `_launch_dsh` writes `TURMA_DSH_EVENTS` to
  `<PROJECTS_ROOT>/<slug>/<claude_sid>/dsh/events.jsonl`.
- **Guard composes via `- insert:`, not a bundle; install BOTH plugins in ONE `npm install`**
  (XERK-470 [F]) — a second sequential install drops the first's dependency. `approval/policy: ask` +
  `sandbox/mode: workspace-write` are pinned per-session by the DRIVER, over the guard's monotonic
  deny.
- **A DshControl callback must never call a send method** — `on_interaction`/`on_state`/
  `on_interaction_end` run on the reader thread; send methods block on an ack the reader delivers, so
  calling one from a callback deadlocks. `_dsh_answer` sends from the beat thread — hold that.
- **The single user-questions provider is owned by POLL-AND-DISPLACE** — `dsh web` registers it first
  and a second registration throws `DUPLICATE_PROVIDER`. The driver waits for an incumbent, THEN
  displaces it. A headless profile with none registers directly after a grace window.
- **Persistence is the DRIVER'S control socket, NOT a per-session web server** (XERK-498) —
  `net.createServer().listen(<sock>)` is the keep-alive; `_launch_dsh` runs bare `dsh --profile
  <DSH_PROFILE>` with no `--no-open`/`--port`. **The in-dashboard viewer is the Turma-native
  Trajectory view** (`turma-sessions.md`), NOT a proxied `dsh web` (no base-path flag, `dsh.md`
  XERK-498) — supersedes the fallback in `docs/dsh-session-lifecycle.md`. XERK-501 (below) is a
  second, direct-access viewer.
- **Profile prep is off the beat** — `_ensure_dsh_profile` primed on a worker at startup;
  `_launch_dsh` only reads `_dsh_profile_ready`, never runs setup on the beat (XERK-395).
- **Model API key is SOURCED from a 0600 env file, never argv'd** (`/proc/<pid>/cmdline` is
  world-readable).
- **An ADOPTED dsh session must be REATTACHED, not just re-ttyd'd.** The adopt path leaves the live
  process alone, but its socket + tail died with the manager. Without `_reattach_dsh` (reconnect the
  still-bound socket, restart the tail at the log's **current EOF** — `resume=True`, else the
  transcript doubles) an adopted session runs DARK. Best-effort, never raises, never kills the
  process. Tests: `test_adopts_dsh_reattaches_control_and_tail`, `test_reattach_dsh_*`.
- **A dsh-sibling version SKEW must not crash the beat** — `dsh_session.py`/`dsh_transcript.py` ship
  in lockstep with `hub-agent.py` (XERK-496); `_seed_summaries` GUARDS the `tail.title()` call so any
  skew degrades to "unnamed this beat" (XERK-395/402). Tests:
  `test_seed_summaries_survives_a_dsh_tail_without_title`.

## Host-wide `dsh web` viewer (XERK-501)

ONE supervised `dsh web` per host over the SHARED store, so a dsh chat can be confirmed in dsh's own
read-only UI too. Decision + legality vs XERK-498: `dsh.md`.

- **It only READS the on-disk store; never connects to live per-session processes** — the per-session
  HITL/provider-displacement pitfalls above do NOT apply. Never add HITL/driver wiring to it.
- **Reads the plaintext stores via a persistence `--patch`** (`compression: none` + restated `root`) —
  the `web` profile's zstd default cannot read them (the one real integration risk, host-verified).
  `_launch_dsh_web` runs `dsh --profile web --patch <p> --no-open --host <DSH_WEB_HOST> --port
  <DSH_WEB_PORT>`.
- **Exposure is a DIRECT host port, LOOPBACK by default** — `dsh web` is unauthenticated. `_dsh_web_url`
  advertises a URL only for a routable bind or explicit `DSH_WEB_URL`; loopback reports none and the
  chat header hides the link.
- **Always-on when `_dsh_web_enabled()`, supervised OFF THE BEAT** (`_dsh_web_loop` on a daemon
  thread, beat only reads cached status — XERK-395). Relaunches a crashed instance with capped
  backoff.
- **`running` means SERVING OUR dsh, not just launched** (XERK-492 lesson, on the port) —
  `has-session` alone isn't proof; `_confirm_dsh_web` and steady-state require `_dsh_web_serving`.
  - **`_dsh_web_serving` is an HTTP identity check, NOT a bare TCP connect** (XERK-502): it GETs the
    viewer's root and matches a dsh page marker (`DSH_WEB_MARKERS` — the `@deepseek-ai/dsh` client-
    module bootstrap in the first KB, or the `DeepSeek Harness` title), byte-bounded + short-timeout,
    off the beat. A blind connect (`_dsh_web_port_open`, kept as the connect primitive) reads ANY
    listener as up, so a service squatting `DSH_WEB_PORT` while dsh dies on EADDRINUSE misreported
    `running:true` and relaunched the doomed dsh at a flat cadence (backoff reset). Any probe failure
    (refused / non-200 / no marker) reads NOT serving, which engages the backoff. Host-verified against
    real `dsh web` 0.1.1-rc.2 (serving) and a dumb HTTP squatter on the port (not serving).
- **Adopts an in-place-updated instance**; `_handle_shutdown` does NOT kill it (like a dsh session's
  tmux).
- **Wire: `dsh.web = {running, port, url}`, OMITTED when down** — same capability-flag discipline as
  `available`. `normalizeDsh` whitelists it and length-caps `url` (XERK-348 peer-cell lesson).
  Android is decode-safe untyped (`android/PARITY.md`).
- Tests: `TestDshWeb` (URL rule, enable gate, payload, launch command, persistence patch, and the
  `_dsh_web_serving` HTTP identity check — dsh page marker vs. a squatter/500/dead port, over a real
  loopback HTTP server). Adopt/relaunch/plaintext-read are REAL-dsh QA, no CI.

## Tests

`test_dsh_session.py` (`DshControlTest` fake socket; `DshProjectionTailTest` real projector),
`TestDshRouting` (`test_hub_agent.py`). End-to-end against real dsh 0.1.1-rc.2:
`poc/turma-2.0-poc/test-real-dsh.sh`'s successor recipe, spawn→input→model→projection→kill.

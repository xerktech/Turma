---
paths:
  - "agent/dsh_session.py"
  - "agent/dsh-session-driver/**"
  - "agent/hub-agent.py"
  - "agent/tests/test_dsh_session.py"
---

# Driving a dsh session: input, interaction, and the projection (XERK-467 [C])

A dsh session is a headless dsh process in its own tmux (XERK-466 [B] process model,
`docs/dsh-session-lifecycle.md`). It has **no Claude TUI pane**: input, answers and liveness ride a
per-session UNIX control socket, and its transcript is a projection of dsh's own event log. This
file is the [C] layer over that seam; the runtime-selection field and capability flag are [A]
(`.claude/rules/dsh.md`), the projector is [S1] (`agent/dsh_transcript.py`).

## The three pieces

- **`agent/dsh-session-driver/`** — a cordis plugin loaded by the dsh process. Creates ONE agent on
  the pinned session id, binds `~/.turma/dsh/<id>.sock`, writes each raw dsh `session/event` as one
  JSONL line to the native event log (the projector's input), and speaks the control protocol. All
  per-session identity comes from the process ENVIRONMENT (`TURMA_DSH_*`), never plugin config —
  dsh hot-reloads config and every dsh sharing a `DSH_HOME` reads the same file, so config-borne
  identity would let an abandoned instance adopt another session's id (the PoC's
  `TURMA_FLEET_INSTANCE_ID` discipline).
- **`agent/dsh_session.py`** — the hub-agent (Python) end: `DshControl` (control-socket client) and
  `DshProjectionTail` (tails the native log through `DshProjector`, appending to the pinned
  `<claudeSessionId>.jsonl`). Both are stdlib-only and run off the beat.
- **`hub-agent.py`** — `_launch_dsh` (replaces [A]'s stub), the dsh arms of `send_input` /
  `notify_session` / `answer_question`, and the interaction callbacks.

## Control-socket contract (LDJSON, plugin BINDS / hub-agent CONNECTS)

hub→plugin (each acked `{ok:true|false,error?}`): `input{source:{kind:user|peer|machine},text}`,
`answer{requestId,optionIndex?|optionIndices?|text?}`, `state{}`, `kill{}`.
plugin→hub events: `state{status,eventCount}`, `interaction{requestId,kind,prompt,options,detail?}`,
`interaction_end{requestId}` (an interaction dsh aborted internally — clears the rendezvous file),
and the two peer-messaging events (XERK-476) `peer_send{name,text}` (the session's `send_message`
tool wants to reach a roster name) and `peer_inbound{from,text}` (a native Claude-peer SendMessage
arrived at the forged inbox socket). **Answer indices are 0-based positions into the emitted
`options[]`** (same as `answer_question`); the PLUGIN maps them to dsh's native answer — a question
option LABEL, or an approval OUTCOME.

## Cross-session peer messaging (XERK-476)

Match XERK-348 for dsh: the org-scoped roster and its messaging. The ROSTER half is
runtime-independent and already worked — `_peer_rows`/`_write_peers_file` list any running session,
`_launch_dsh` appends `PEERS_SYSTEM_PROMPT` (+ `DSH_PEERS_ADDENDUM`, since dsh's send tool is
`send_message` and it has no `ListAgents`), and `build_dsh_guard_config` grants the read of
`~/.turma/peers.tsv`. What [L] adds is the MESSAGING, hub-routed both ways:

- **SEND (dsh → peer).** The driver registers a `send_message` tool (`ctx.tools.register(defineTool
  {name:'send_message', to, message})`, dynamic-imported like the sandbox policy) that emits
  `peer_send`. `_on_dsh_peer_send` STAGES it; `_drain_dsh_peer_traffic` (on the beat, never the
  reader thread — a callback may not do a socket write to another session) resolves the name against
  THIS host's running sessions and delivers peer-framed: a Claude target via `_post_to_inbox` with
  the dsh session's own `rcName` as `from` and NO `INBOX_PREFIX` (indistinguishable from a native
  SendMessage — it is the same inbox socket), a dsh target via `ctl.input(kind="peer")`. Same-host
  only, which is same-org by construction and matches Claude's own per-machine (`isolatePeerMachines`)
  delivery; an unknown/ambiguous/cross-host name is dropped best-effort, as Claude's is.
- **RECEIVE (native Claude peer → dsh).** Claude's SendMessage only delivers to a socket its OWN
  registry lists by name (`~/.claude/sessions/<pid>.json` → `messagingSocketPath`). A dsh process is
  not there, so the DRIVER forges that record under its OWN live pid and binds `cc-socks/<pid>.sock`
  (the pid must be a live process the registry's liveness/peercred checks accept — the single-pid
  hub cannot masquerade as N sessions, which is why the driver holds it while the hub still owns
  resolution, policy and delivery). Inbound is verified against the wire `session_id`, forwarded as
  `peer_inbound`, and `_deliver_dsh_peer_inbound` applies `crossSessionInbound` opt-out before
  `ctl.input(kind="peer")`.
- **This depends on Claude Code's PRIVATE, versioned peer-record format** (`peerProtocol`,
  `procStart`/`pidDomain` liveness) — no CI, host-verified only, and it may drift across Claude
  releases. The SEND path and the roster have no such dependency. A hard-killed dsh session may leave
  a stale forged record until Claude Code's own registry reaper drops it (harmless — the socket the
  hub's `cc-socks` sweep reaps once the pid is dead, and the stale record is undeliverable).
- Tests: `test_dsh_session.py` (`peer_send`/`peer_inbound` dispatch), `TestDshRouting` in
  `test_hub_agent.py` (send resolution to a Claude vs dsh target, `from`/framing, opt-out, unknown
  name, inbound inject, teardown drops staged). The SEND path and roster are fully unit-covered; the
  RECEIVE path's native Claude delivery is HOST-PROOF only (a real dsh session exchanging messages
  with a Claude peer) because it rides Claude Code's private record format — and note this sandbox's
  own guard blocks forging a session record, so that leg is verified on a real host, not in CI.

## Reconciliations (why the Claude mechanics do NOT copy)

- **No compaction outbox for dsh.** The XERK-47 `pendingInputs` outbox guards a pane message a
  compaction can drop; a dsh event log is append-only and there is no pane, so `_dsh_send_input`
  keeps no outbox. Don't add one.
- **notify_session → a `source.kind` followup.** `_dsh_notify` sends `machine`/`peer` with
  `INBOX_PREFIX` in-band (the prefix is belt-and-suspenders over the source.kind, which dsh maps to
  `{kind:'plugin',plugin:'turma',form:'relay'}`). `crossSessionInbound` opt-out downgrades it to a
  `user`-sourced followup — the dsh equivalent of Claude's pane fallback (the repo keeps its nudges,
  un-peer-framed). Returns True only when delivered peer-framed.
- **AskUserQuestion ↔ dsh HITL.** dsh's HITL is **register-as-answerer**, not event-then-answer:
  the plugin registers the `approval/request` waterfall and a `userQuestions` provider, and when dsh
  calls one it emits an `interaction` event and BLOCKS on a Promise the hub resolves with `answer`.
  `_on_dsh_interaction` renders it into the SAME `QUESTIONS_DIR/<sid>.req.json` shape `_hook_question`
  and every client already read (the dsh `requestId` rides in the file, ignored by the readers), so
  no client changes. `_dsh_answer` sends the answer frame and clears the file. A long-pending
  interaction is kept alive by `_refresh_dsh_questions` (bumps the req mtime each beat) because a dsh
  interaction has no ask.py self-timeout to bound `QUESTION_STALE_AFTER_SEC`.
- **Caps** are the existing HOST-level heartbeat fields (`inputMaxChars`, `uploadMaxBytes`); the dsh
  input path reuses `INPUT_MAX_CHARS` / `_store_uploads`, so they are honored, not re-reported.
- **Busy / "Working" is [D] (XERK-468), not [C].** `_on_dsh_state` records the socket `state` edge in
  `self.dsh_status`; [C] does not wire the six "Working" mirrors. The guard equivalent is [F]
  (XERK-470); [C] owns only the AskUserQuestion side of `agent-hooks.md`.

## Pitfalls (each cost real time; do not re-learn)

- **A BOUND control socket is not proof the session is alive** (XERK-492). The driver binds the
  socket a moment before a load-time crash (a bad plugin, a missing dynamic import, a bad model
  route) can abort the dsh process, so `ctl.start()` succeeding can race ahead of a dead process —
  the old code then recorded a live-looking zombie (empty pane, `ctl.state()` → None, no events, no
  transcript). `_launch_dsh` now calls `_confirm_dsh_launch` after `start()`: a bounded wait for the
  driver's **`agentUp`** state field (set once `agents.create`/`resume` RESOLVES — distinct from
  `status`, which reads `idle` both while creating AND when creation has failed), failing fast if the
  tmux process is gone (dsh is that tmux session's only command, so a vanished session means it
  exited) or the window elapses. A failed confirmation tears down and RAISES, so the start routes
  through the caller's `_set_error` / `_refuse_start` (the XERK-265 channel) with a reason instead of
  a zombie. A driver too old to report `agentUp` falls back to "a usable state reply == up", so it is
  never false-failed. **The driver EXITS(1) on agent-create failure** rather than lingering agentless,
  turning the bad-model-route / failed-setup zombie into the same detectable tmux-death. Tests:
  `TestConfirmDshLaunch`.
- **The control socket path must stay short (< ~108 bytes, `sun_path`).** `~/.turma/dsh/<uuid>.sock`
  (~58) is fine; a long base path silently truncates bind/connect and the driver "cannot connect"
  while the socket file exists. Never move the socket under a deep path.
- **The forged peer inbox socket MUST be `cc-socks*/<pid>.sock` under the driver's OWN pid**
  (XERK-476). Claude Code validates that path shape before connecting (`_canonical_inbox_path`
  mirrors it) and re-checks the listener's `SO_PEERCRED` against the record's pid, so the record's
  `pid`, the socket-holder, and the `<pid>.sock` name must all be the dsh node process. A record
  written under any other pid, or a socket at a non-`cc-socks` path, is refused and the dsh session
  is unreachable by a Claude peer while the file sits there looking fine.
- **`inject` must include `agentLoop`.** `@deepseek-ai/dsh-agent-loop` registers the agent factory
  (`agents.setFactory`); without injecting it the driver can load first and `agents.create()` throws
  "no agent factory registered".
- **On the MINIMAL profile the tools come from base's GLOBAL host layer, and the `agentPresets`
  mount failing is EXPECTED** (XERK-498). The driver's setup calls `ctx.get('agentPresets').mount(
  agentCtx)`, which succeeds on the `web` profile (where a roster delivers the tools) but is ABSENT
  on the minimal `[base, driver]` profile — `agent-presets` was a `dsh-web-app` plugin. That is
  fine: a rosterless deployment gets its tools (bash/edit/read/str_replace_editor/web/subagent/…)
  from `@deepseek-ai/dsh-base`'s global layer, verified against real dsh (a `bash` `tool/call` ran on
  the minimal profile). The mount is tolerated ONLY for the rosterless case; never make a mount
  failure fatal, or the minimal profile has no agent. Because the async setup adds latency, the
  `input` op waits for the agent to be registered before `followup`, or the initial prompt races
  ahead and is dropped.
- **The native event log lives under `<tid>/dsh/`, NOT the worktree** (XERK-469 [E]): the raw
  archive layer excludes the worktree, so a log there is D3's canonical record retained by nothing.
  `_launch_dsh` writes `TURMA_DSH_EVENTS` to `<PROJECTS_ROOT>/<slug>/<claude_sid>/dsh/events.jsonl`;
  transient per-session files (env with the key, system-prompt) live under `~/.turma/dsh/`.
- **Composing the guard: `- insert:`, not a bundle, and install BOTH plugins in ONE npm command**
  (XERK-470 [F]). The guard package declares no `dsh.bundle`, so it CANNOT go in
  `dsh.profile.bundles` (a bare `- id:` there fails "cannot resolve profile bundle"; in the patch a
  bare `- id:` is a MODIFY and warns "entry not found") — it is `- insert:`ed via cordis.patch.yml,
  installed in node_modules so the name resolves. A second sequential `npm install <localdir>` drops
  the first's dependency, so the driver + guard install in one `npm install A B`. The launcher pins
  `approval/policy: ask` + `sandbox/mode: workspace-write` per session via the DRIVER (they are
  per-session runtime settings, set at agent creation from env), over the guard's monotonic deny.
- **A DshControl callback must never call a send method.** `on_interaction`/`on_state`/
  `on_interaction_end` run on the reader thread; `input`/`answer`/`state`/`kill` block on an ack that
  the reader delivers, so calling one from a callback deadlocks. In hub-agent the answer is sent from
  the beat thread (`_dsh_answer`), never a callback — hold that invariant.
- **The single user-questions provider is owned by POLL-AND-DISPLACE.** The `dsh web` host
  (apiproxy) registers it during load and the service throws `DUPLICATE_PROVIDER` on a second
  registration — whichever registers SECOND throws. The driver waits until an incumbent is present,
  THEN displaces it and installs Turma's (which can't make apiproxy throw, its apply having
  completed). A headless profile with no incumbent registers directly after a grace window. Turma
  owns HITL; the dsh web UI is a read-only viewer.
- **Persistence is the DRIVER'S control socket, NOT a per-session web server** (XERK-498). The
  per-session process boots a MINIMAL profile — `@deepseek-ai/dsh-base` + the driver, built fresh by
  `_ensure_dsh_profile` (package.json bundles written directly, no pnpm, base resolves from the dsh
  install) — and `_launch_dsh` runs bare `dsh --profile <DSH_PROFILE>` with NO `--no-open`/`--port`.
  The driver's own `net.createServer().listen(<sock>)` is a ref'd libuv handle that holds the event
  loop open; nothing else has to. This REPLACES the old `dsh --profile web` (the web-app's webserver
  was the only reason `--profile web` provided persistence — a full loopback web server per session).
  Verified end to end against real dsh 0.1.1-rc.2: process alive, socket bound, `agentUp:true`, a
  real bash tool call completed, and NO port bound. The old "removing `dsh-web-app` makes the process
  die" observation was really the DRIVER exiting(1) because removing web-app also removed
  `agent-presets` (its tools) — kept apart here, base carries the tools (next pitfall).
  - **The IN-DASHBOARD viewer is the Turma-native Trajectory view** (over the D3 native log,
    `.claude/rules/turma-sessions.md`), NOT a `dsh web` proxied through the tunnel: `dsh web` has no
    base-path flag (only `--host`/`--port`/`--trusted-host`/`--no-open`), so it cannot be sub-path
    -proxied per host under one domain the way ttyd's `-b /term/<id>` allows. The dsh-web fallback in
    `docs/dsh-session-lifecycle.md` is superseded by that blocker for the PROXY role. XERK-501 adds a
    SECOND, DIRECT-ACCESS viewer beside it — one host-wide `dsh web` (the "Host-wide dsh web viewer"
    section below) — which sidesteps the blocker precisely because it is not proxied per session.
- **Profile prep is off the beat.** `_ensure_dsh_profile` (npm/dsh setup) is primed on a worker
  thread at startup when `dsh_configured()`; `_launch_dsh` only reads the cached `_dsh_profile_ready`
  and refuses if not ready — it never runs the heavy setup on the beat (XERK-395).
- **The model API key is SOURCED from a 0600 env file, never argv'd** (`/proc/<pid>/cmdline` is
  world-readable) — the local-model-credential discipline. Same-uid sessions can already read the
  manager's `/proc/<pid>/environ`, so this adds no exposure; a `[F]` guard read-deny on
  `~/.turma/dsh/*.env` would be defence-in-depth.
- **An ADOPTED dsh session must be REATTACHED, not just re-ttyd'd.** `resume_on_boot`'s adopt path
  (the tmux survived a manager-only restart — the in-place-update case) leaves the live dsh PROCESS
  alone, but its control socket + projection tail live IN the manager and died with it. Without
  `_reattach_dsh(sess)` (reconnect the still-bound `~/.turma/dsh/<sid>.sock`, restart the tail at
  the event log's **current EOF** — `resume=True`, since the history was projected pre-restart and
  re-reading from 0 would double the transcript) an adopted dsh session runs DARK: input dropped
  ("no control socket"), transcript frozen. Best-effort by contract — it never raises (adopt would
  else `_set_error` a live session) and never kills the adopted process. Bounded cost: an event
  written during the seconds-long restart window is not re-projected (the native log keeps it).
  A claude session needs none of this (its tmux + transcript are self-sufficient). Tests:
  `test_adopts_dsh_reattaches_control_and_tail`, `test_reattach_dsh_*` in `TestResumeOnBootAdopt`.
- **A dsh-sibling version SKEW must not crash the beat.** `dsh_session.py`/`dsh_transcript.py` are
  siblings `hub-agent.py` imports; the native install ships + updates them in lockstep with it
  (XERK-496, `agent-native.md`). But before that landed, an update advanced `hub-agent.py` while
  freezing `dsh_session.py`, and a new `hub-agent.py` call into the old sibling (`tail.title()`,
  absent pre-4ff323b) raised `AttributeError` on the BEAT — the agent's MAIN process — crash-looping
  every dsh host (~15s), and the repeated `agents.resume` on each restart corrupted dsh's own store
  (a `session/end-seed` reseed re-using seq numbers → "corrupt session log: seq gap in committed
  region", the dsh web-UI error). Packaging keeps the files in step; the belt-and-suspenders is that
  `_seed_summaries` GUARDS the `tail.title()` call so ANY sibling skew (a partial update, a rollback)
  degrades to "unnamed this beat" instead of taking the host down — the XERK-395/402 beat-loop
  contract that an uncaught exception on the beat is the whole host, not a skipped cycle. Tests:
  `test_seed_summaries_survives_a_dsh_tail_without_title`.

## Host-wide `dsh web` viewer (XERK-501)

ONE supervised `dsh web` per host over the SHARED store (`DSH_HOME/sessions`), so a dsh session's
chat can be confirmed in dsh's OWN read-only UI beside Turma's native Trajectory. The DECISION and
why it is legal where XERK-498's per-session web server was not are in `.claude/rules/dsh.md`; the
mechanics and the invariants a change must not undo:

- **It only READS the on-disk store; it never connects to the live per-session dsh processes.** They
  are SEPARATE processes with their own service registries, so the per-session HITL / userQuestions
  provider-displacement pitfalls above DO NOT apply to it — never add HITL/driver wiring to it. Its
  one job is to browse the shared store.
- **It reads the per-session PLAINTEXT stores via a persistence `--patch`** (`_ensure_dsh_web_patch`:
  `compression: none` + a restated `root` == `DSH_SESSIONS_ROOT`), matching what the drivers write
  (XERK-475). The `web` profile's zstd default cannot read them — this is the ONE real integration
  risk, host-verified against real dsh, not CI. `_launch_dsh_web` runs
  `dsh --profile web --patch <p> --no-open --host <DSH_WEB_HOST> --port <DSH_WEB_PORT>`, `DSH_HOME`
  exported into the command (a routable var, not a secret — the viewer needs no model key to browse).
- **Exposure is a DIRECT host port, LOOPBACK by default** (`DSH_WEB_HOST`), because `dsh web` is
  unauthenticated (only a browser-trust fence). A LAN bind is a deliberate opt-in and the launch log
  says so. `_dsh_web_url` advertises a URL only for a routable bind host or an explicit `DSH_WEB_URL`;
  a loopback host reports none, and the Sessions chat header hides the "dsh web ↗" link rather than
  point it nowhere.
- **Always-on when `_dsh_web_enabled()`** (dsh configured AND `DSH_WEB` not turned off), **supervised
  OFF THE BEAT** (`_dsh_web_loop` on a daemon thread — the beat only READS the cached status via
  `_dsh_payload`/`_dsh_web_payload`, XERK-395). `_dsh_web_running` (`tmux has-session`) says the tmux
  is alive; the loop relaunches a crashed one with capped backoff.
- **`running` means SERVING, not just launched** — `has-session` alone is NOT enough (the XERK-492
  "a bound thing is not a live thing" lesson, on the port). A tmux that STARTED is not proof the dsh
  process bound its port: EADDRINUSE / a crash-on-boot ends it a moment later. So the loop reports up
  only after `_confirm_dsh_web` sees the port ACCEPT a connection (`_dsh_web_port_open`), and the
  steady-state check pairs `has-session` with the port too (a bound-then-wedged instance is torn down
  and relaunched). Reporting up off the tmux rc alone both misreported the heartbeat AND skipped the
  backoff on the dominant failure mode — a flat relaunch of a doomed process.
  - **Residual gap (LOW, XERK-502): `_dsh_web_port_open` is a blind TCP connect**, so an UNRELATED
    process holding `DSH_WEB_PORT` reads as "up" and the loop relaunches a doomed dsh flat. Benign for
    the realistic EADDRINUSE cause (a stale dsh over the SAME store — "up" is correct); only wrong on
    a deployment misconfig, and the loopback default hides the URL anyway. Closing it needs an
    HTTP-level check that the served thing is actually dsh, not a bare connect.
- **It ADOPTS an instance that survived an in-place update** — `has-session` True → leave it, for a
  zero-downtime viewer — and `_handle_shutdown` deliberately does NOT kill it (unlike the limits
  probe), exactly like a dsh session's tmux (`KillMode=process`). A container recreate takes it down
  with the rest of the stack.
- **Wire: `dsh.web = {running, port, url}`, OMITTED when down** (`_dsh_payload` — same capability-flag
  discipline `available` uses, so a pre-viewer agent and a down viewer read identically). The hub's
  `normalizeDsh` whitelists it and length-caps `url` (the XERK-348 peer-cell memory lesson). Android
  is untyped for now (decode-safe, `android/PARITY.md`).
- Tests: `TestDshWeb` in `test_hub_agent.py` (URL advertise rule, enable gate, payload, launch
  command, persistence patch). The adopt/relaunch/restart cycle and the plaintext-store read are
  REAL-dsh QA — no launcher-driven `dsh web` runs in CI.

## Tests

`test_dsh_session.py` (`DshControlTest` drives a fake plugin socket; `DshProjectionTailTest` runs the
real projector), `TestDshRouting` in `test_hub_agent.py` (the dsh arms + the interaction rendezvous).
The end-to-end drive against real dsh 0.1.1-rc.2 is `poc/turma-2.0-poc/test-real-dsh.sh`'s successor
recipe (profile + driver bundle + `dsh --profile web --no-open`), proven spawn→input→model→projection→kill.

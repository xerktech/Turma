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
and `interaction_end{requestId}` (an interaction dsh aborted internally — clears the rendezvous file).
**Answer indices are 0-based positions into the emitted `options[]`** (same as `answer_question`);
the PLUGIN maps them to dsh's native answer — a question option LABEL, or an approval OUTCOME.

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

- **The control socket path must stay short (< ~108 bytes, `sun_path`).** `~/.turma/dsh/<uuid>.sock`
  (~58) is fine; a long base path silently truncates bind/connect and the driver "cannot connect"
  while the socket file exists. Never move the socket under a deep path.
- **`inject` must include `agentLoop`.** `@deepseek-ai/dsh-agent-loop` registers the agent factory
  (`agents.setFactory`); without injecting it the driver can load first and `agents.create()` throws
  "no agent factory registered".
- **`agents.create` MUST pass a `setup` that mounts a preset — or the agent has NO tools.** With no
  `setup`, the agent is created with no bash/edit/ask-user/approval tools, so the model can neither
  do work nor raise a HITL request (it just prints tool JSON as prose) — the whole vertical looks
  alive but does nothing. dsh's own hosts compose a preset (`composeAgent`); the driver's setup calls
  `ctx.get('agentPresets').mount(agentCtx)` (default preset). A mount failure is tolerated only for a
  rosterless deployment (tools live in the global host layer); in the `web` profile the mount is what
  delivers the tools. Because the async setup adds latency, the `input` op waits for the agent to be
  registered before `followup`, or the initial prompt races ahead and is dropped.
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
- **Persistence keeps the web-app loaded.** `dsh-app-boot` exits after boot with no "app", so
  removing `dsh-web-app` makes the process die (tearing down the socket). `_launch_dsh` runs
  `dsh --profile web --no-open --port` — the web-app stays for persistence (a loopback web server
  per session, unexposed), and the driver owns HITL over it. A single host-wide read-only viewer is
  a follow-up.
- **Profile prep is off the beat.** `_ensure_dsh_profile` (npm/dsh setup) is primed on a worker
  thread at startup when `dsh_configured()`; `_launch_dsh` only reads the cached `_dsh_profile_ready`
  and refuses if not ready — it never runs the heavy setup on the beat (XERK-395).
- **The model API key is SOURCED from a 0600 env file, never argv'd** (`/proc/<pid>/cmdline` is
  world-readable) — the local-model-credential discipline. Same-uid sessions can already read the
  manager's `/proc/<pid>/environ`, so this adds no exposure; a `[F]` guard read-deny on
  `~/.turma/dsh/*.env` would be defence-in-depth.

## Tests

`test_dsh_session.py` (`DshControlTest` drives a fake plugin socket; `DshProjectionTailTest` runs the
real projector), `TestDshRouting` in `test_hub_agent.py` (the dsh arms + the interaction rendezvous).
The end-to-end drive against real dsh 0.1.1-rc.2 is `poc/turma-2.0-poc/test-real-dsh.sh`'s successor
recipe (profile + driver bundle + `dsh --profile web --no-open`), proven spawn→input→model→projection→kill.

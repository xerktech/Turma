# dsh session lifecycle & control-socket contract (XERK-466 [B])

Design of record for how a **dsh** session runs under `hub-agent.py`, the seam every sibling child
in XERK-460 builds on. It confirms the process model left open by the G0 ADR
(`.claude/rules/dsh.md`), fixes the hub-agent ⇄ dsh control-socket contract, and maps each lifecycle
operation onto it. Mechanics land in `.claude/rules/*.md` when the code ships; this is the spec the
implementation and the parallel children ([A] XERK-465, [C] XERK-467, S1 XERK-464) work against.

## The decision that was open, and how it resolved

- **ADR D1** records a **per-SESSION** dsh process: its own tmux, its own worktree, counting against
  `MAX_SESSIONS`, "launched the way a `claude --remote-control` session is."
- **G1 (XERK-463)** only ever validated the **per-HOST** shape: one long-running `dsh --profile web`
  process hosting many in-process agent handles, driven by a Cordis plugin over a socket — which
  **D2 marks out-of-scope** (that is the PoC Fleet-Hub path). dsh has **no TUI to `tmux send-keys`
  into**: input is a programmatic `agent.followup(UserMessage)` call inside the dsh process.
- So D1 (the recorded decision) is unproven against real dsh, and the naive "drive it like the
  Claude TUI" reading is impossible. Raised to Malcolm (XERK-466), **confirmed:**

**Per-session dsh process + tmux + a per-session control socket, run headless — PLUS one host-wide
read-only `dsh web` as a native Trajectory/metrics viewer.** Interaction happens over the socket and
Turma's own surfaces; the native web UI is observe-only.

This keeps D1 (per-session process/tmux/worktree/MAX_SESSIONS) and D2 (no Fleet Hub — the only peer
the dsh process talks to is the local `hub-agent.py`), and it is buildable on exactly what G1 proved
(the same `ctx.agents.create/followup/dispose` surface), by re-pointing the PoC plugin from the
Fleet Hub to a local per-session socket.

## Process model

- **One dsh process per Turma session**, launched by `_launch_dsh(sess)` in the session's own tmux
  (`agent-<id>`), cwd'd at the worktree. The worktree is detached-HEAD off the default branch and
  **the app still creates no branch** — identical to a Claude session (`_worktree_add` is reused
  unchanged). The tmux is the manager's supervision/reaping handle exactly as for Claude, so
  `resume_on_boot` adoption, `_kill_tmux`, and restart-in-place all reuse the existing machinery.
- **The session queue, `MAX_SESSIONS`, the repos-root pseudo-repo, and the new-work branching
  directive are process-agnostic and unchanged.** A dsh spawn queues (capacity / awaiting-clone /
  root-busy) and drains through `_provision_session` like any other; the only fork is the launch
  choke point. (Root/repos-root dsh sessions: same one-per-host rule; cwd is `REPOS_ROOT`, no
  worktree.)
- **Headless.** The dsh process runs with no interactive terminal a person types into. `paneBusy`,
  `panePrompt`, `_busy_from_capture`, `set_mode` and `tmux send-keys` **do not apply to a dsh
  session** — there is no Claude-style pane to parse. Liveness/"busy" comes from the dsh event log
  over the control socket (see the "Working" note below). A ttyd MAY still attach to the dsh tmux to
  show the process's raw stdout/logs for debugging, but it is not an input surface.
- **The dsh process loads a Turma-local driver plugin** (`@turma/dsh-session-driver`, derived from
  `poc/turma-2.0-poc/fleet-agent-plugin`, with the Fleet-Hub WebSocket client replaced by a local
  UNIX-socket server). On load it:
  1. `ctx.agents.create({ sessionId, meta:{ cwd }, agentOptions })` for **exactly one** agent — the
     `sessionId` is the **Turma session id pinned at launch** (so `_session_transcript_path` resolves
     the projection by name with no new resolver — the XERK-6 trap stays closed, per D3);
  2. binds the per-session control socket and speaks the protocol below to `hub-agent.py`;
  3. subscribes to `session/event` and **writes two things to disk**: the native dsh event log
     (SQLite + telemetry JSONL, retained under the worktree's `.dsh/` for the raw archive layer and
     the host-wide viewer — D3's canonical record) **and** the derived Claude-JSONL **projection**
     `<slug>/<sessionId>.jsonl` using S1's mapping (XERK-464). The projection is what every existing
     display surface reads; the socket carries control + liveness only, never the display stream.
  4. connects to **no** hub (D2).
- **Model selection follows D5:** `agentOptions.provider`/`model` come from the validated per-session
  spawn enum; there is **no Claude local-model failover** for a dsh session. The provider route
  (`dsh-llm-pi-ai` → DeepSeek or an OpenAI-compatible LiteLLM/Ollama gateway) is env/profile-config,
  gated by [A]'s `dsh_configured()`.
- **Identity follows D4:** the dsh session has no credential of its own; it runs under the host
  agent. `agentType` (from [A]) is presentational, grants nothing.

## Control-socket contract (`hub-agent.py` ⇄ driver plugin)

- **Transport:** a per-session UNIX domain socket at `~/.turma/dsh/<sessionId>.sock` (0600, under the
  agent-owned `~/.turma` the guard already governs — never in a worktree). The **plugin binds
  (server); `hub-agent.py` connects (client).** Line-delimited JSON (one compact object per `\n`).
- **Why a socket, not a pane:** dsh input is a programmatic `agent.followup()`; there is no keystroke
  surface. The socket is the one primitive [B] exposes and every other child drives through it.

### Requests — hub → plugin (each gets an ack `{"ok":true}` or `{"ok":false,"error":"..."}`)

| op | payload | plugin action |
|----|---------|---------------|
| `input` | `{"op":"input","source":{"kind":"user"\|"peer"\|"machine","clientId"?,"plugin"?},"text":"..."}` | `agent.followup(userMessage(text, source))`. **`source.kind` is required** and carries the operator-vs-peer/machine attribution — it maps to dsh `UserMessage.source`, the dsh analogue of Claude's `INBOX_PREFIX` role split ([C] XERK-467). |
| `answer` | `{"op":"answer","requestId":"...","optionIndex"?,"optionIndices"?,"text"?}` | deliver the operator's answer to a pending dsh-interaction/approval named by `requestId` (the AskUserQuestion round-trip [C] needs). |
| `state` | `{"op":"state"}` | reply `{"ok":true,"status":"running"\|"idle","eventCount":N,"pendingInteraction":bool}` — a liveness snapshot. |
| `kill` | `{"op":"kill"}` | `handle.dispose()` (stop loop + unregister + remove session), ack, then the process exits. `hub-agent.py` still `_kill_tmux`es as the backstop if the ack/exit doesn't come. |

### Events — plugin → hub (unsolicited, streamed on the same socket)

| evt | payload | meaning |
|-----|---------|---------|
| `state` | `{"evt":"state","status":"running"\|"idle","eventCount":N}` | agent turn/status edge — the input to "Working" for a dsh session. |
| `interaction` | `{"evt":"interaction","requestId":"...","kind":"approval"\|"question","prompt":"...","options"?:[{"number","label"}],"detail"?}` | dsh raised a `dsh-interaction`/approval. `hub-agent.py` writes it to `~/.turma/questions/<sid>.req.json` (reusing the AskUserQuestion bridge shape); [C] answers via the `answer` op. |

- **Option indexing is 0-based positional, matching Claude's AskUserQuestion bridge.** The
  `interaction` event's `options[]` carry a `number` for **display parity only** (1-based, i.e.
  position + 1, like `parse_pane_prompt`'s shape). `answer.optionIndex` / `optionIndices` are the
  **0-based positions into that same `options[]` array — never the `number` value.** [C] therefore
  passes the same 0-based indices it already uses for `answer_question` and does **no** translation;
  the driver plugin ([B]) maps a 0-based position back to dsh's native selection (including dsh's own
  1-based `number`, which stays a plugin concern and never crosses the socket as an answer key).
- **Display session events are NOT streamed here.** They are written to the projection JSONL on disk
  and read by the existing tail/history/archive surfaces. The socket stays small and never duplicates
  S1's projection.
- **`crossSessionInbound` / peer-message policy still applies:** a `machine`/`peer` `input` is the
  dsh analogue of `notify_session`; the hub decides operator-vs-inbox routing before it sends an
  `input`, and stamps `source.kind` accordingly.

## Lifecycle-op mapping (the [B] deliverable)

All of these reuse the existing skeleton; the fork is only which launcher runs and (for resume) which
dsh call is made.

- **spawn / provision:** `_provision_session` → at the launch choke point, `agentType=="dsh"` calls
  `_launch_dsh(sess)` instead of `_launch_tmux(sess)`. `_launch_dsh` starts the dsh process in the
  tmux, the plugin creates the one agent + binds the socket, and the **initial prompt is delivered as
  the first `input`** (never a positional CLI arg — there is none). The **new-work / ticket-branch /
  peers directives** (`NEW_WORK_SYSTEM_PROMPT` + `TICKET_BRANCH_PROMPT` + `PEERS_SYSTEM_PROMPT`) are
  passed to the plugin and **injected as the dsh agent's system-prompt append** (dsh assembles its
  own system prompt via `request/header`; there is no `--append-system-prompt`). A refused dsh start
  goes through **`_refuse_start` / `spawnFailures`** exactly as [A]'s placeholder guard does — the
  XERK-265 channel, so the card's Start wait ends with the reason (never a bare `log()`).
- **kill:** send `kill` (clean `dispose`) then `_kill_tmux` as backstop; `_kill_ttyd`. Worktree +
  projection + native `.dsh/` log KEPT (resumable). Reuses `kill()` / `_remember_closed`.
- **restart (clear context):** `_kill_tmux`, drop caches, relaunch dsh with a **fresh** agent (new
  dsh session → new projection transcript id, moved onto the record like Claude's `claudeSessionId`).
  Reuses `restart()`.
- **resume / start:** relaunch dsh, and the plugin uses **`ctx.agents.resume({ resumeSessionId })`**
  (not `create`) to reload the persisted dsh session from its retained `.dsh/` log — this is the one
  place dsh's `resume` vs `create` distinction matters (G1). The pinned transcript id (hence the
  projection) is preserved, so PR chips / usage / ticket links re-derive with no new code. Reuses
  `start()` / `resume()` / `_resume_at_cwd`.
- **delete:** `_kill_tmux` + `_worktree_remove` (the native `.dsh/` store lives in the worktree and
  goes with it); drop record + closed + uploads. Reuses `delete()`.
- **migration (XERK-101):** out of scope for [B] v1 — the migration bundle packs Claude transcript
  bytes; a dsh session's resumable bytes are its native `.dsh/` store, a separate follow-up.

## Consequences to fold into the cross-cutting contracts (when the code ships)

- **"Working" for dsh comes from the control-socket `state` status** (running|idle), since a dsh
  session has no pane to scrape. **Implemented in [D] (XERK-468) by REUSING the `paneBusy` wire field
  agent-side, NOT by adding a dsh signal the mirrors branch on** — `session_report` sources `paneBusy`
  from the cached dsh status, so all five/six mirrors and the CLAUDE.md "Working = paneBusy OR live
  agents" contract are unchanged and cannot drift. (The earlier "all mirrors read `agentType` and fall
  back to the dsh signal" framing was the rejected alternative — it multiplies the mirror edits the
  projection seam exists to avoid. See `.claude/rules/dsh.md` "[D]".)
- **The driver plugin ships in the agent image** (a Dockerfile/toolchain add — node + dsh + the
  plugin). Image/resource sizing is the DockerOps follow-up already flagged as ADR Q1.
- **`_session_transcript_path` is unchanged** — the projection is named by the pinned id (D3).
- **Host-wide read-only `dsh web`** over the shared retained event store is a per-host viewer link,
  built after the lifecycle lands; verify `dsh web` renders sessions it did not create in-process,
  else fall back to a Turma-native Trajectory view over the D3 logs.

## Build sequencing (why this is a design PR, not the launcher yet)

1. [A] (XERK-465) lands `agentType` + `dsh:{available}` + the `_refuse_start` launch-choke guard —
   the field and seam this replaces. **Gate: not yet merged.**
2. Stand up real dsh in the agent image and reuse the G1 harness (`test-real-dsh.sh`) to build and
   verify `@turma/dsh-session-driver` (the re-pointed plugin) and `_launch_dsh` against real dsh —
   never a mock (the G1 lesson: the mock hid a wrong API on every op).
3. Wire the lifecycle ops above + the "Working" dsh input; QA against real dsh.
4. S1 (XERK-464) supplies the event→JSONL projection mapping the plugin writes with; [C] (XERK-467)
   drives input/answers over the socket defined here.

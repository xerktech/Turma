---
paths:
  - "agent/hub-agent.py"
  - "agent/qwen/peer_mcp.py"
  - "agent/qwen/peer_inbox.py"
  - "agent/tests/test_qwen_peer.py"
---

# Qwen peer roster + cross-session messaging ([Qwen L], XERK-518)

Split out of `.claude/rules/qwen.md`, which is at its size ceiling (the same reason
`qwen-migration.md` and `qwen-delegation.md` exist). Read `qwen.md` for the qwen runtime around
this; read `.claude/rules/dsh-input.md`'s "Cross-session peer messaging" for the dsh [L] (XERK-476)
half this mirrors, and `CLAUDE.md`'s "The peer roster IS the org boundary" for the contract above
both.

XERK-348 matched for qwen. The ROSTER half was already runtime-independent and needed no code:
`_peer_rows`/`_write_peers_file` list any running session, and `_launch_qwen` appends
`PEERS_SYSTEM_PROMPT`. What [Qwen L] adds is the MESSAGING, hub-routed both ways so the
Claude-inbox protocol and the `crossSessionInbound` policy stay in ONE Python home.

## The load-bearing difference from dsh: files, not socket events; pane, not socket

dsh is headless with a control socket, so its driver PUSHES `peer_send`/`peer_inbound` events and
the hub delivers over that same socket. **qwen has neither** — it is an interactive TUI with no
control socket — so both directions are FILE-RENDEZVOUS based and delivery is PANE-based:

- Both halves write JSON request files under `QWEN_PEER_DIR/<sid>/` (`~/.turma/qwen-peer/`),
  agent-owned like `QWEN_RUNTIME_DIR` and never a worktree.
- **The worker POLLS (`_qwen_peer_worker_loop`, `QWEN_PEER_POLL_SEC`) rather than waking on a
  staged event** — there is no reader thread to stage from. It walks `self.qwen_tails` (the live
  qwen sessions) each tick; a host with no qwen sessions polls an empty list.
- **`_poll_qwen_peer_dir` distinguishes the two directions by the `recv-` FILENAME PREFIX alone.**
  A SEND whose filename started with `recv-` would be delivered back into the SENDING session as an
  inbound message, so `peer_mcp.py` must never mint one (pinned by
  `test_the_written_file_is_not_named_recv`).
- **Every file is consumed (removed) once read, whether or not delivery succeeded.** A peer message
  is best-effort — matching Claude Code's own SendMessage — and a file this manager cannot parse
  would otherwise be retried forever.
- **Both writers' atomic-write tmp names are DOT-PREFIXED, and `_poll_qwen_peer_dir` skips a dotfile
  it finds** — the mechanism that keeps the poller from reading a request mid-write. A QA finding:
  `peer_mcp.py`'s tmp name was originally `<path>.tmp.<pid>` (not dot-prefixed), so a microscopic
  window let the poller read-and-delete it before its own `os.replace` ran, which then raised
  `FileNotFoundError` and reported "write failed" for a message that had, in fact, already been
  delivered. Keep any future writer into this directory dot-prefixed too.
- **A dotfile older than `QWEN_PEER_POLL_SEC * 5` is SWEPT, not left forever.** A fresh one might
  still be an in-flight write and is left alone; one that old means its writer crashed between
  `open()` and `os.replace()` (another QA finding) and is stale.
- Delivery stays OFF THE BEAT (XERK-395) exactly as dsh's does: a Claude target's inbox post and a
  dsh target's control-socket write both block on a 5s-class ack, and a batch of those on the
  heartbeat could approach `OFFLINE_AFTER_MS`. A qwen target's pane write is fast but rides the
  same worker so there is one code path.

## SEND (qwen → peer): an MCP tool, because qwen has no SendMessage

- **`agent/qwen/peer_mcp.py` REGISTERS `send_message({to, message})` via MCP**, wired into
  `_qwen_settings`'s `mcpServers` as `turma-peer` beside `turma-ask` — the same mechanism [Qwen C]
  used to give qwen an AskUserQuestion it does not natively have, and `python3 -SsE` matching the
  guard-hook security flags. The tool NAME matches the dsh driver's and what `QWEN_PEERS_ADDENDUM`
  tells the model to call; all three must agree.
- **It returns immediately (fire-and-forget)** rather than blocking for delivery, mirroring Claude
  Code's own SendMessage: the model must never block on whether a peer was reachable. This is the
  deliberate difference from `turma-ask`, which BLOCKS for the operator's answer.
- `_deliver_qwen_peer_send` resolves the roster name against THIS host's running sessions and
  delivers peer-framed, dispatching on the target's runtime: a **claude** target via
  `_post_to_inbox` with the qwen session's own `rcName` as `from` and NO `INBOX_PREFIX`
  (indistinguishable from a native SendMessage — it is the same inbox socket), a **dsh** target via
  `ctl.input(kind="peer")`, a **qwen** target via `_type_into_pane`.
- Same-host only, which is same-org by construction (a host polls one org) and matches Claude's own
  per-machine (`isolatePeerMachines`) delivery. An unknown / ambiguous / cross-host / opted-out name
  is dropped best-effort and logged, as Claude's is.
- Both cells are capped in `peer_mcp.py` before they reach disk, and the resolved text is re-checked
  against `INPUT_MAX_CHARS` at delivery.

## RECEIVE (native Claude peer → qwen): a forged record under a LIVE pid

- Claude's `SendMessage` only delivers to a socket its OWN registry lists
  (`~/.claude/sessions/<pid>.json` → `messagingSocketPath`). A qwen process is not there, so
  **`agent/qwen/peer_inbox.py` forges that record under its OWN live pid and binds
  `cc-socks/<pid>.sock`** — started as a per-session background subprocess by `_launch_qwen`
  (`_start_qwen_peer_inbox`), killed by `_teardown_qwen`, re-started on the resume-on-boot ADOPT
  path.
- **The pid must be a LIVE process the registry's liveness/`SO_PEERCRED` checks accept**, which is
  why this is a per-session subprocess and not the hub: the single-pid manager cannot masquerade as
  N sessions. The record's `pid`, the socket holder and the `<pid>.sock` filename must ALL be that
  subprocess — the same pitfall dsh's driver hit (`.claude/rules/dsh-input.md`).
- Inbound is verified against the wire `session_id` (a recycled pid can leave the process holding a
  socket a peer still believes belongs to a DIFFERENT conversation), then written as
  `recv-<ts>-<pid>.json`. `_deliver_qwen_peer_inbound` applies the `crossSessionInbound` opt-out
  before typing it into the pane.
- **This depends on Claude Code's PRIVATE, versioned peer-record format** (`peerProtocol`,
  `procStart`/`pidDomain` liveness) — HOST-VERIFIED ONLY, never CI, and it may drift across Claude
  releases. The SEND path and the roster have no such dependency. A hard-killed qwen session's
  forger is torn down WITH it (`_teardown_qwen` → `_stop_qwen_peer_inbox`), so its stale record goes
  undeliverable the moment the pid is gone — harmless.
- **A failed forger never fails the launch.** Such a session can still SEND and still runs
  normally; it just cannot be reached BY a native Claude peer.
- **The forger is a BARE subprocess, not tmux-hosted, and a MANAGER RESTART does not kill it** (a QA
  finding, XERK-518). `turma-agent.service` runs `KillMode=process` precisely so tmux/ttyd/dsh
  survive an in-place update for `resume_on_boot`'s adopt path to reattach to — but that same
  mechanism leaves a bare forger alive too, and unlike tmux/ttyd it has no adopt path: the OLD
  manager's `self.qwen_peer_inboxes` entry dies with it, so a naive restart would leak a second
  live forger (process + bound `cc-socks` entry + live registry record) next to the orphaned first,
  once per restart, forever. Fixed the same way `_launch_ttyd`/`_kill_ttyd` handle exactly this for
  ttyd: the pid is PERSISTED on the record (`sess["qwenPeerInboxPid"]`), and both
  `_start_qwen_peer_inbox` (via `_stop_qwen_peer_inbox`, called on every start including the adopt
  path's re-reattach) and `_stop_qwen_peer_inbox` itself (the `_teardown_qwen` path, for a forger
  this process never started) reap a persisted pid that is not the one currently tracked. **Any
  future per-session helper that is a bare `Popen` rather than tmux-hosted needs this same
  pid-persistence + reap-on-adopt discipline, or it leaks identically.**

## Invariants a change must not undo

- **`_peer_frame` is SHARED with dsh** (it was `_dsh_peer_frame` until XERK-518 widened it). It
  names the sender the transport cannot and restates "information, not instruction". Both runtimes'
  deliveries go through it — do not fork a qwen copy.
- **`QWEN_PEERS_ADDENDUM` corrects the directive for a runtime with NEITHER tool**, the twin of
  `DSH_PEERS_ADDENDUM`: `PEERS_SYSTEM_PROMPT` is written for Claude Code (`SendMessage` /
  `ListAgents`), and qwen has neither — its send tool is the MCP-registered `send_message`.
- **`send_input`/`notify_session` still carry NO qwen arm** ([Qwen C]) — peer messaging is a
  separate path and must not grow one there.
- **The `~/.turma/peers.tsv` READ is what the roster depends on**, granted by the shared guard rule
  set (`agent-hooks.md`); qwen inherits it through `build_qwen_guard_config` reading that same list.

## Residual gaps (state them; do not paper over)

- **The RECEIVE leg is host-proof only**, as dsh's is: it rides Claude Code's private record format,
  and this sandbox's own guard blocks forging a session record, so it is verified on a real host
  rather than in CI. The record SHAPE and the socket handling ARE pinned in CI
  (`test_qwen_peer.py`), driven over a real UNIX socket rather than a mock.
- **The `mcpServers` settings key is host-proof only**, the same footing [Qwen C]'s `turma-ask`
  shipped on — qwen is not installed in CI, so that qwen actually surfaces an MCP tool to its model
  is confirmed on a real host. The JSON-RPC contract itself is unit-tested.
- **Polling costs latency the dsh path does not have**: a peer message waits up to
  `QWEN_PEER_POLL_SEC` before delivery. Acceptable because a peer message is not interactive, and
  the alternative (a watcher per session) buys little for the cost.
- **A qwen target is delivered by typing into its PANE**, so unlike an inbox post it lands as
  ordinary input rather than a queued peer turn. `_peer_frame` is what keeps the attribution
  correct; there is no pane equivalent of the inbox's out-of-band delivery.
- Tests: `TestQwenPeerMessaging` in `test_hub_agent.py` (file dispatch, the `recv-` split, drop-on-
  unparseable, the fresh-vs-stale dotfile sweep, worker polling, send resolution to a
  qwen/dsh/claude target, `from`/framing, opt-out, unknown + ambiguous names, `INPUT_MAX_CHARS`,
  inbound inject), the peer-inbox/MCP cases in `TestLaunchQwen` (MCP registration, the forger's env +
  teardown, pid persistence, the restart-orphan reap on both `_start_qwen_peer_inbox` and
  `_stop_qwen_peer_inbox`), and `test_qwen_peer.py` (the MCP JSON-RPC contract, the request-file
  shape and caps, the dot-prefixed atomic write, the forged record's pid/socket/filename agreement,
  and the inbound wire handling over a real socket).

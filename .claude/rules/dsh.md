---
paths:
  - "poc/turma-2.0-poc/**"
  - "agent/hub-agent.py"
  - "agent/dsh_transcript.py"
  - "agent/dsh_session.py"
  - "agent/dsh/**"
  - "agent/dsh-session-driver/**"
  - "agent/tests/test_hub_agent.py"
  - "agent/tests/test_dsh_transcript.py"
  - "agent/tests/test_dsh_session.py"
  - "turma/server.js"
  - "turma/public/sessions.html"
  - "android/**"
---

# dsh runtime — invariants (XERK-460)

dsh (DeepSeek Harness) is a per-session runtime **alongside** Claude Code: its own launcher inside
the existing agent, reporting through the existing hub, with a HEADLESS process model (no TUI pane).

**The decisions and their rationale (D1-D5, the G1 spike, open questions) are in
`docs/dsh-adr.md`** — read it for *why*; this file is the rules. Two load-bearing consequences it
establishes, which almost every invariant below descends from:

- **dsh's native event log is CANONICAL** (retained for metrics); the Claude-JSONL projection is a
  lossy DISPLAY derivative, never the record.
- **The projection exists to keep the parity mirrors at N, not 2N** — so no dsh work may add a
  reader, a transcript shape, or an `agentType` branch to a shared read path.

Naming trap: `agentType`/`agent_type` ALSO names Task-tool SUBAGENTS, an older unrelated concept.

## [A] (XERK-465) runtime field + capability flag

- **`agentType` ∈ {"claude","dsh"} is a per-session record field**, default "claude", validated at
  spawn (`resolve_agent_type`) like every spawn enum and carried on every record-rebuild path
  (spawn, `_remember_closed`, resume, resume-transcript, `_resume_at_cwd`, `receive_migration`) plus
  `_session_payload`. It is PRESENTATIONAL — it grants nothing and says nothing about the dsh
  process model. An agent predating it reports nothing; the hub coerces the session field to `""` in
  `normalizeSessions`, which reads as claude.
- **`dsh` is the heartbeat capability block `{available}`**, mirroring `localModel`: backed by
  `dsh_configured()` (env gate `TURMA_DSH`, OFF by default so every current host degrades),
  coerced strict-boolean by `normalizeDsh`, a `HEARTBEAT_KNOWN_KEYS` member, typed on Android
  (`AgentInfo.dsh: DshInfo?`). Absent/false = "this host cannot do dsh", so the composer HIDES the
  runtime selector rather than queue a spawn the host refuses. Both spawn routes 409 a `dsh` choice
  at a host with no capability (`checkSpawnAgentType`), and the agent re-validates.
- **`_launch_tmux` is the single launch choke point, and its FIRST action is the runtime dispatch**:
  `if sess.agentType == "dsh": self._launch_dsh(sess); return`. Do not hoist the dispatch to the ~6
  callers — they all funnel through `_launch_tmux`.
- **Composer only, no card badge**: `sessions.html` gates a "Runtime" `<select>` on
  `a.dsh.available`, sending `agentType` only for "dsh"; Android mirrors just that composer row
  (`core/Runtime.kt`, `SpawnDialog`). The web `⚙ dsh` marker, the glasses `ph-runtime`/G2 `·dsh`
  suffix and Android's `RuntimeBadge` were removed — do not re-add a runtime chip to the card.
- Tests: `TestSpawnOptionHelpers`/`TestSessionLifecycle` (agent), `normalizeDsh`/spawn-route/restore
  cases (`server.test.js`), the Runtime cases in `sessions.test.js`, `RuntimeTest`/`SpawnRequestTest`/
  `SpawnComposerTest`/`AgentDecodeTest` (android).

## S1 (XERK-464) the projection (`agent/dsh_transcript.py`)

`DshProjector.feed(event)` returns the 0+ Claude-JSONL entry dicts one dsh event projects to;
`project_log()` is the batch form. Pure, stdlib-only.

- **Incremental, one file, no new reader.** The launcher appends each event's projected entries to
  the pinned `<claudeSessionId>.jsonl`, and the EXISTING `_entry_blocks`/`entryBlocks`, `_entry_text`,
  usage accountancy, PR scan and live tail read it unchanged. There is **no JS translator** — the
  projection runs only in Python, and the "py/js parity" here is that the projected JSONL renders
  IDENTICALLY under `_entry_blocks` (py) and `entryBlocks` (js).
- **Only the three dsh SURFACE types project to entries** (`user/message`, `assistant/message`,
  `tool/result`). Every other event is log-only → `[]` — turn/step boundaries, `assistant/chunk`,
  `request/*`, `todo/write`, `session/*`. A user-cancelled `turn/end` (reason `aborted`/`user`)
  projects the `[Request interrupted by user]` marker.
- **Tool calls ride the assistant message, NOT the `tool/call` event.** dsh appends BOTH an
  `assistant/message` whose `content` includes the `tool-call` blocks AND a redundant standalone
  `tool/call` event (the loop itself reads calls back via `message.content.filter(b => b.type ===
  "tool-call")`). The projector emits tool_use from the assistant message and SKIPS `tool/call`, so
  exactly one tool_use appears — which is what makes PR attribution work: `gh pr create` lands as a
  real tool_use/tool_result pair, not opaque text.
- **`bash`→`Bash` name map**: `_scan_pr_line` attributes only a `Bash` tool_use and dsh's shell tool
  is `bash`. Widen PR attribution only by teaching `_scan_pr_line` another creation event, never by
  loosening this map.
- **Liveness is deliberately NOT in the projection.** dsh has no pane, so `paneBusy` has no
  transcript equivalent; the working signal is an in-flight turn, reported as a heartbeat field by
  [D] and read from dsh directly. Injecting a turn marker would force `entryBlocks` to grow a case.
- **The chat's live streaming also reads the native log, never the projection** (`tunnel-agent.js`
  `pollDshTurn`/`foldDshView`): `assistant/chunk` deltas stream into the same `/live` `turn` frames a
  claude pane scrape produces. It tails `events.jsonl` for the DISPLAY, projecting no chunks into
  JSONL and adding no reader.
- **usage + model ride the assistant entry**: dsh `TokenUsage` maps 1:1 to Claude's disjoint
  `input/output/cache_read/cache_creation`, and `message.model` comes from `message.source.model`. A
  step with no usage projects no `usage` key — never a fabricated zero, which poisons the per-model
  denominator.
- **uuids are deterministic** (uuid5 over session id + seq), so replaying the retained native log
  re-projects byte-identically without forking the file.
- **Verified against real dsh 0.1.1-rc.2, not a mock** (the G1 lesson): `dsh_corpus.json` is built by
  `dsh_corpus_gen.mjs` from dsh's OWN message constructors. `dsh_projected.jsonl` +
  `dsh_expected_blocks.json` are the SAME artifacts the py and js tests assert against, pinning both
  readers to one expected result.
- Tests: `test_dsh_transcript.py`, the `dsh projection` case in `tunnel-agent.test.js`.

## [D] (XERK-468) busy / ready / summary semantics

A dsh session is HEADLESS, so `paneBusy` cannot come from `_pane_status`; it comes from the driver
plugin's control-socket `state` (running|idle).

- **It REUSES the `paneBusy` wire field agent-side — it does NOT add a dsh signal to the mirrors.**
  `session_report(agent_type="dsh", dsh_status=…)` sources `paneBusy` from the cached dsh status
  (`dsh_pane_busy`) instead of scraping. So `sessionWorking`, `liveState`, the five `readyForReview`
  mirrors, the alert and summaries are UNCHANGED and cannot drift. **"All mirrors branch on
  agentType" was the rejected alternative — do not restore it.**
- **Everything OTHER than liveness stays transcript-derived** from the S1 projection: `lastRole`,
  `lastHasToolUse`, `transcriptAgeSec` and the PR scan read the projected `<claudeSessionId>.jsonl`
  unchanged, which is what makes readyForReview's finished-turn branch work identically.
- **A dsh session's NAME comes from dsh's OWN `session/title` event, never `claude -p`.** Log-only;
  the tail (`dsh_session.py`) captures `data.title` and `_seed_dsh_summary` names from it.
  `_start_summary` refuses an `agentType=="dsh"` session, so no Claude summarizer turn is spent on a
  runtime with no Claude login. Three tiers — generated title, fallback title, first prompt — so the
  card is never blank; a generated title overrides a provisional one. Mechanics in `dsh-input.md`.
- **`dsh_pane_busy` is a tri-state and deliberately NOT time-expired.** running→True, idle→False,
  unknown/missing→None ("can't tell", falling back to transcript freshness like an uncapturable
  Claude pane). A pending interaction reads False (blocked on a human, not its own turn). Expiring a
  stale "running" by AGE would reintroduce the transcript-freshness false-idle the socket signal
  exists to avoid — a long dsh tool call emits no status edge for minutes. Liveness-of-the-SIGNAL is
  the producer's job: it clears to unknown on socket disconnect, and the host-offline gate zeroes it.
- **The driver derives its `state` status from the TURN EDGE, never `agent.status` at emit time**
  (XERK-479 D3). Since the hub cannot age-expire a stale "running", the PRODUCER must deliver the
  idle edge: `running` on `turn/start`, `idle` on `turn/end`. Reading `ctx.agents.get(sid).status`
  inside the `turn/end` handler returns `running` (the agent has not settled), so no idle edge fires
  and a finished session reads "working" forever, never becoming ready-for-review. Keep the committed
  `dist/` in sync with `src/`.
- **`_on_dsh_state` stores the PARSED snapshot dict, via `_ingest_dsh_event`** — the reader's
  canonical fold. `dsh_pane_busy` is dict-only; storing the bare status STRING made paneBusy read
  None for every dsh session (XERK-479 D1). The callback and `_ingest_dsh_event` are one path.
- **The beat only ever READS an in-memory cache (`self.dsh_status`), never the socket**, so a wedged
  plugin cannot stall the heartbeat past `OFFLINE_AFTER_MS` (XERK-395). The producer filling it — the
  persistent per-session socket reader — is the launcher's, off the beat. Consumer seam:
  `_ingest_dsh_event(sid, event)`, `_set_dsh_status(sid, None)` on disconnect, and
  `refresh_dsh_status`/`dsh_query_state` (the off-beat one-shot). Dropped on kill/delete
  (`_forget_session_caches`) and restart.
- **`_ingest_dsh_event` handles the `state` event ONLY; `interaction` is [C]'s** — only a USABLE
  status (running|idle) updates the cache, so a malformed state event cannot clobber a known-good
  "running".
- Tests: `TestDshState`, `TestDshQueryState`, `TestDshLivenessInReport`, `TestDshLivenessSeam`.

## [E] (XERK-469) archive sync — the store-dir contract

- **The projection (`<slug>/<sid>.jsonl`) rides the RENDERED layer unchanged** — `_archive_manifest`
  enumerates every ledger slug's top-level `*.jsonl`. The native log (`<slug>/<sid>/dsh/...`) is
  nested, so it is NOT mistaken for a rendered transcript.
- **The native event log rides the RAW layer at `<slug>/<sid>/dsh/`** (`DSH_STORE_DIRNAME`), which
  `_session_files` already walks. **The launcher MUST write the store here, not in the worktree** —
  the raw layer excludes the worktree on purpose (those bytes are what prune/delete key on), so a
  worktree `.dsh/` is retained by nothing. This supersedes the `.dsh/` location in
  `docs/dsh-session-lifecycle.md`.
- **dsh's "raw" bytes are its append-only event log, not its SQLite.** The raw cursor ships bytes
  past an offset — right for an event-sourced JSONL stream, wrong for a page-mutating DB. The SQLite
  is a derived index dsh rebuilds from the log and must not land under `<sid>/dsh/`.
- **This `<sid>/dsh/` log is the DISPLAY/metrics feed, NOT what dsh resumes from** — dsh's own
  durable store is a separate file under `DSH_SESSIONS_ROOT` ([K]).
- **No beat-loop budget regression**: archive sync stays on the sync worker (XERK-395). Tests:
  `TestDshArchiveSync`, plus `TestArchiveSyncWorker`/`TestBeatLoopBudget`.

## Children that added NO new code path

Each proves the D3 "no new reader, no `agentType` branch" property for its own surface; the
mechanics live in the file named, whose `paths:` load beside this one.

- **[G] (XERK-471) usage** — spend charts identically with no schema change, because S1 already
  writes `message.usage`/`message.model` in the ledger's shape. Why the native log is never
  double-counted and why subscription `limits`/probe stay Claude-only: `agent-usage.md`. The one code
  change was hardening `_map_usage` to drop an all-zero block. Tests:
  `TestDshUsageReportEndToEnd`, `TestDshProjectionAccounting`.
- **[H] (XERK-472) PR/MR chips** — same chips, ledgers, attribution and comment/conflict delivery,
  keyed on S1's `bash`→`Bash` map. Nudges route `notify_session` → `_dsh_notify` (control socket),
  bounded by `DSH_ACK_TIMEOUT_SEC`, never raising. `refresh_pr_status` stays the same inline offender
  for BOTH runtimes (XERK-397's scope). Chips survive resume/migration via `_seed_prs` over the
  projected `<tid>.jsonl`. Mechanics: `agent-prs.md`. Tests: `TestDshPrAttribution` (real projector,
  real corpus).
- **[J] (XERK-474) delegation** — background-agent/workflow rows + `subagentHistory` work because the
  launcher SYNTHESIZES the Claude-Code on-disk shapes, so `_scan_agent_entry`, `_resolve_subagent`,
  `_resolve_workflow_run`, `_workflow_agents` and the usage/archive walks read a dsh delegation with
  no reader change (the XERK-304 contract, no new field). Mechanics + residual gaps:
  `dsh-delegation.md`. The `ctx.on('subagent/start', {global:true})` scope is the one thing live dsh
  must confirm.
- **[L] (XERK-476) peer roster** — the ROSTER was already runtime-independent (`_peer_rows`/
  `_write_peers_file` list any running session; `_launch_dsh` appends `PEERS_SYSTEM_PROMPT`;
  `build_dsh_guard_config` grants the `peers.tsv` read). [L] adds only the MESSAGING, HUB-ROUTED both
  ways so the Claude-inbox protocol and crossSessionInbound policy stay in ONE Python home.
  Mechanics + pitfalls: `dsh-input.md`.

## [I] (XERK-473) board — a ticket can run on dsh

- **The ticket runtime is a per-ticket PIN, mirroring the model pin (XERK-123), not a spawn-time
  flag.** Hub-owned durable state (`ticketRuntimes` on `/data`, keyed `<siteKey>/<issueKey>`) riding
  `spawnTicket` as `agentType`, so it must survive a hub restart and feed both the Start button and
  the auto-start sweep. Only a NON-default ("dsh") choice is stored — "claude" and clearing both
  release — so an unpinned ticket rides byte-for-byte the command it always did.
- **The DISPATCH filters the pool by runtime capability, not just triage** (XERK-296).
  `findTicketHost` restricts a dsh-pinned ticket to hosts reporting `dsh.available`, checked ahead of
  capacity so "no host offers dsh" reads as **blocked** (a freed slot would not add the runtime, so
  it ages out) rather than **full** (which clears itself). A pinned host lacking dsh is reported,
  never routed around. `orgOffersDsh` gates the pin server-side and `dshAvailable` hides the board
  option; the agent still re-validates.
- **The agent side is one forwarded argument** — `spawn_ticket(agent_type=…)` → `spawn()`, and the
  launch choke point already dispatches. So a dsh ticket session is "told its branch, cuts it itself,
  worktree stays detached" with NO new launch code.
- **Collectors, the two tracker writes and the `_board_column` mirrors are untouched** — the runtime
  pin is orthogonal to a ticket's column.
- **Web ⇄ Android parity**: the board Runtime row shipped on Android too (XERK-477). The vendored
  `board.cjs` stays byte-identical to `board.js`. Board mechanics: `turma-board.md`.
- Tests: `TestSpawnTicket` (`test_a_runtime_pin_lands_on_the_session_record`,
  `test_handle_commands_carries_the_runtime_pin`) agent-side; the `/runtime` route + dsh
  `findTicketHost` cases in
  `server.test.js`; the `runtime*` cases in `board.test.js`.

## [K] (XERK-475) migration + resume

`<sid>/dsh/` is the projection FEED; dsh resumes from its own `session-persistence-jsonl` store, a
distinct file. [K] is that store plus the resume the driver never wired.

- **dsh's durable store is `$DSH_HOME/sessions/<projectKey(cwd)>/<sid>/session.jsonl`**
  (`DSH_SESSIONS_ROOT`, `_dsh_store_dir`). `agents.create` on an already-persisted id THROWS, so the
  driver honors `TURMA_DSH_RESUME` → `ctx.agents.resume({resumeSessionId})`, falling back to create
  only if no store exists.
- **Migration carries the STORE, not the feed.** `export_session` packs `_dsh_store_dir` under the
  reserved `.dsh-store/` prefix; `import_session` unpacks to THIS host's key and re-points its header
  `cwd` to the localized worktree (`_reconcile_dsh_store_cwd`) — **dsh refuses a store whose on-disk
  path disagrees with its header cwd, so a cross-mount move MUST re-key.** The feed is deliberately
  NOT migrated: the resumed dsh does not replay history, so the target rebuilds it from new events
  and the projection tail starts at the kept log's EOF (`resume=True`), never doubling the transcript.
- **The store is PLAINTEXT.** `_dsh_cordis_patch` overrides the base profile's persistence to
  `compression: none` (re-stating `root`, since a patch REPLACES config) so the header cwd is edited
  in place — Python has no stdlib zstd.
- **`_dsh_project_key` ports dsh's `projectKey(cwd)` byte-for-byte** — golden-tested against a real
  store dir name, because the corruption guard compares the store's path to `logPath(root,
  header.cwd, id)`. Tests: `TestDshProjectKey`, `TestDshCordisPatchPersistence`, the dsh cases in
  `TestMigrateSession`, `DshProjectionTailTest` resume cases.

## XERK-498 — no per-session terminal or web server

- **Per-session dsh runs a MINIMAL `[dsh-base, driver]` profile, not `--profile web`.** The driver's
  own listening control socket is the keep-alive; `_launch_dsh` runs bare `dsh --profile
  <DSH_PROFILE>` with no `--no-open`/`--port` and allocates no port.
- **No ttyd for a dsh session** — `_launch_ttyd` early-returns on `agentType=="dsh"`, the ONE choke
  point covering every launch path. The chat header hides "Terminal ▸" and shows "Trajectory ▸".
- **The IN-DASHBOARD viewer is Turma-native over the D3 native log — NOT a proxied `dsh web`**, which
  has no base-path flag and so cannot be sub-path-proxied per host the way ttyd's `-b` allows.
  `archive.dshTrajectory` parses the log the raw archive already holds, served by `GET
  /api/dsh/<tid>/trajectory`. Tests: `dshTrajectory` in `archive.test.js`, the trajectory case in
  `server.test.js`.
- **XERK-501 adds ONE host-wide `dsh web` per host** over the shared store. The per-session proxy
  blocker does not apply: it has no sub-path, is reached DIRECTLY on the host, and only READS the
  store. Mechanics: `dsh-input.md`.

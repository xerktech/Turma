---
paths:
  - "poc/turma-2.0-poc/**"
  - "agent/**"
  - "turma/server.js"
  - "turma/public/sessions.html"
  - "android/**"
---

# dsh integration — architecture decisions (ADR)

Gate for XERK-460 (integrate DeepSeek Harness, `dsh`, as a first-class agent runtime **alongside**
Claude Code). This file records the five G0 decisions with rationale so the parallel children build
against one shape. It is a decision record, not a how-to — mechanics land in the component rules
files as each child ships, and this file's `paths:` widens then.

- **Background.** Two design docs frame dsh differently, and the difference is the whole point of
  this gate. `docs/turma-2.0-design.md` + `poc/turma-2.0-poc/` describe a **full rewrite** of Turma
  on dsh: a NEW separate "Fleet Hub" service, dsh running the web UI, every Turma concern
  reimplemented as a dsh plugin. `docs/deepseek-harness-integration.md` (Option A) describes an
  **incremental** path: dsh added as a selectable per-session runtime under the EXISTING agent and
  the EXISTING hub. **XERK-460's title says "alongside Claude Code" — so the epic is the incremental
  path, and these decisions choose it over the rewrite wherever the two conflict.**
- **No production code touches dsh yet.** Every `agentType`/`agent_type` in `hub-agent.py` and
  `server.js` is about Task-tool SUBAGENTS, unrelated to dsh. dsh lives only in `poc/` and `docs/`.
  These decisions are greenfield, not a description of scaffolding.
- **G1 (XERK-463) is done: go/no-go = GO.** All four operations are proven end-to-end against real
  dsh 0.1.1-rc.2, no mock, via `poc/turma-2.0-poc/test-real-dsh.sh --drive`. The go/no-go corrected
  the PoC plugin, which had spawn/input/kill written against a *guessed* `ctx.agents` API the mock
  never checked: real dsh is `agents.create({sessionId,meta:{cwd},agentOptions})`→handle (not
  `resume`), `agent.followup(msg)` (not `inbox.append`, which never wakes the driver), and
  `handle.dispose()` (not arg-less `cancel`). The model rides a hand-declared OpenAI-compatible
  `dsh-llm-pi-ai` route (D5). Detail + recorded run in `poc/turma-2.0-poc/README.md`.

## [A] (XERK-465) shipped: runtime field + capability flag

The runtime-SELECTION plumbing is in place; the dsh LAUNCHER is [B] (XERK-466). What landed, and the
invariants a later child must not undo:

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
  at a host with no capability (`checkSpawnAgentType`), and the agent re-validates
  (`resolve_agent_type`).
- **`_launch_tmux` is the single launch choke point, and its FIRST action is the runtime dispatch**:
  `if sess.agentType == "dsh": self._launch_dsh(sess); return`. `_launch_dsh` is [A]'s stub — it
  refuses via `_set_error("dsh runtime launcher not yet available (XERK-466)")`. **XERK-466 replaces
  that method's BODY with the real per-session dsh launch**; the dispatch line and choke point stay.
  Do not hoist the dispatch to the ~6 callers — they all funnel through `_launch_tmux`.
- **Composer + card**: `sessions.html` gates a "Runtime" `<select>` on `a.dsh.available` and sends
  `agentType` only when "dsh" (a bare spawn is unchanged); `runtimeMarkHtml` badges a dsh card.
  Android mirrors the composer (`core/Runtime.kt`, `SpawnDialog`'s Runtime row); the dsh card badge
  is deferred in `android/PARITY.md` alongside the local-model card mark.
- Tests: `TestSpawnOptionHelpers`/`TestSessionLifecycle` (agent), `normalizeDsh`/spawn-route/restore
  cases (`server.test.js`), the Runtime cases in `sessions.test.js`, `RuntimeTest`/`SpawnRequestTest`/
  `SpawnComposerTest`/`AgentDecodeTest` (android).

## D1 — Where dsh runs: inside the existing agent container

- **Decision: dsh runs as an additional per-session LAUNCHER inside the existing agent container,
  not in its own container.** A dsh session is launched the way a `claude --remote-control` session
  is — its own tmux, its own worktree, counting against `MAX_SESSIONS` — dispatched on a validated
  `agentType` spawn option (`{'claude','dsh'}`, allowlisted agent-side like every other spawn enum).
- **Why not its own container.** The fleet's whole model is one-container-per-host, and a host's
  identity is singular: one XERK-268 credential, one heartbeat, one org binding, one peer roster,
  one worktree pool under `.turma/worktrees`. A second container would be a second "host" to the
  hub — doubling the online count, the credential, and the roster for one physical machine, and
  forcing every cross-cutting contract to learn a split identity. Keeping dsh in-container means the
  runtime choice is per-session and invisible to the hub's host model.
- **Cost this accepts, and the follow-up it needs.** The image already carries a large toolchain;
  adding dsh (node + its npm tree — the PoC's `test-real-dsh.sh` installs ~460 packages) grows it
  further, and a live dsh session (node runtime + a model client) is not free on `mem_limit` /
  `pids_limit`, which DockerOps sizes against `MAX_SESSIONS`. Whether those ceilings need raising
  before dsh sessions run beside Claude sessions is a **DockerOps sizing follow-up** (child of this
  epic), not a code change here — flagged to Malcolm below (Q1).
- **`k8x` is the exception, as always.** Its agent is a StatefulSet in xerktech/ArgoCD
  (`ai/turma-agent/`), image pinned by tag with no Watchtower — so a dsh-carrying image reaches it
  only when someone deletes the pod. Image CONTENT edits still land in this repo.

## D2 — Coordinator: reuse the existing Turma hub; the PoC Fleet Hub is redundant for this epic

- **Decision: dsh reports through the EXISTING Turma hub via the existing `hub-agent.py`, not
  through a new hub or a dsh-plugin-to-hub link. The PoC's separate Fleet Hub
  (`poc/turma-2.0-poc/fleet-hub/`) and `@turma/dsh-fleet-agent` plugin are the FULL-REWRITE path and
  are out of scope for XERK-460.**
- **Why.** The existing hub already owns agent registry, org isolation (`orgBound`, trust-on-first-
  use), the ticket queue, the peer roster, the archive, usage aggregation, migration, and the mobile
  API. The PoC Fleet Hub reinvents all of it and is, by its own README, unauthenticated and bound to
  all interfaces. Standing up a second control plane would fork every cross-cutting contract in
  CLAUDE.md (the heartbeat wire contract, XERK-268 host proof, XERK-264 refusal semantics, XERK-258
  memory ceilings, XERK-348 peer boundary). Reusing the one hub keeps one set of those invariants.
- **What this means concretely.** `hub-agent.py` launches dsh as a child process, reads its session
  state (see D3), and surfaces it on the SAME heartbeat every Claude session rides. The hub does not
  learn a new protocol; a dsh session is just a session whose `agentType` is `dsh`. The heartbeat's
  degrade rule applies: older hubs/clients that don't know `agentType` treat the field as absent and
  render the session as they would any other — never break.
- **This does not delete the PoC.** It stays as validated evidence for the rewrite direction, which
  remains a SEPARATE future question (Q3 below). This decision only says the rewrite is not how
  XERK-460 ships.

## D3 — Transcript format: dsh's native event log is CANONICAL; Claude JSONL is a display projection

- **Decision: dsh's native event-sourced log is the CANONICAL session record and is retained in full
  fidelity — it is the better representation and the one we collect metrics from. The agent ALSO
  emits a derived Claude-Code JSONL PROJECTION of it, purely so the existing display surfaces keep
  reading one shape. The projection is lossy and is NOT the source of truth; the native log is never
  down-sampled to feed it.** Feeds S1.
- **Why keep dsh's format.** dsh manages session data far better than Claude Code's transcript: its
  Trajectory view breaks out every input, output, and tool call with the time each arrived, because
  a session is an append-only log of typed events (`turn/*`, `step/*`, `tool/call`, `tool/result`,
  `assistant/message` with token usage). That granularity is exactly what later metrics want —
  per-turn tokens, tool success rates, step timings, error rates — and flattening it into Claude
  JSONL turns would throw it away. So the native log is what we KEEP; the JSONL is what we DERIVE.
- **Why derive the JSONL at all (the projection).** Turma's read side is a web of parity contracts
  that already cost N-way edits: `readyForReview` (five mirrors), "Working" = paneBusy OR live agents
  (six mirrors), the board column rule (`categoryOf`, five mirrors), and the whole `hub-agent.py` ↔
  `tunnel-agent.js` py/js parity set. Teaching the archive and every client (hub, android, glasses,
  veiller) a SECOND transcript shape multiplies each of those (N → 2N). A single agent-side
  projection into the shape they already read keeps the mirrors at N — the exact reason the ticket
  names — WITHOUT making that projection the record. Display reads the projection; metrics read the
  native log. Neither impersonates the other.
- **Retention obligation — this is the load-bearing part of the decision.** The native dsh log
  (SQLite + telemetry JSONL) MUST be persisted durably and in full, not summarized. It rides
  XERK-338's raw archive layer, which already stores each session's own files byte-for-byte and is
  the only place anything Turma does not render survives the host. Two consequences for children:
  the raw-layer ceilings (`ARCHIVE_RAW_TRANSCRIPT_MAX_BYTES`, and that the layer excludes
  background-agent transcripts) must be checked against real dsh session sizes so metrics data is not
  silently truncated — fold into the sizing follow-up (Q1); and a future metrics / Trajectory surface
  is a downstream child that reads these retained native events directly, never the JSONL projection.
- **Session identity is preserved by construction.** The agent pins a session id at launch and names
  the projection JSONL by it, so `_session_transcript_path()` resolves a dsh session with no new
  resolver and no newest-mtime fallback (the XERK-6 trap). dsh's own internal session id is mapped to
  the pinned id, and the retained native log is keyed by that same id so the two representations of
  one session stay joinable.
- **Parity obligation.** The dsh→JSONL projection is itself a py/js parity surface if any of it runs
  in `tunnel-agent.js` for live tail; keep the mapping in one place and mirror it under test, the way
  `_entry_blocks`/`entryBlocks` are. The `corpus-eval` skill is the tool for proving old-vs-new here.

## D4 — Auth / session identity: dsh inherits the host credential; no new identity (XERK-268)

- **Decision: a dsh session has NO credential or fleet identity of its own. It runs under the host
  agent, which authenticates to the hub with its per-host token
  `<base64url(device)>.<HMAC(TURMA_AGENT_TOKEN, device)>` exactly as today.** dsh never talks to the
  hub directly (that follows from D2), so there is nothing new to authenticate.
- **Tracker / PR attribution rides the translated JSONL (D3), unchanged.** `_scan_pr_line` /
  `_seed_prs` detect `gh pr create` from transcript tool events; because dsh's shell/tool calls are
  translated into the same `tool_use`/`tool_result` JSONL shape, PR chips work with no new code —
  **provided the translator represents the tool call that runs `gh pr create` as a tool event, not
  as opaque assistant text.** That is a translator requirement, called out for S1. Git authorship is
  the host's git user on a worktree, unchanged.
- **Usage accounting rides the same JSONL, with one real new requirement.** Usage is counted
  per-MODEL from the transcript and kept in XERK-338's durable per-host ledger. dsh spend counts
  against the SAME host. The translator MUST populate the JSONL token-usage fields AND a real model
  id from dsh's `assistant/message` events — otherwise a dsh session spends tokens the ledger cannot
  attribute to a model. New (local / DeepSeek) model ids simply appear in the per-model breakdown;
  the ledger needs no schema change, only correct input. This covers the accounting TOTALS only;
  the richer per-turn / per-tool metrics come from the retained native log (D3), not the projection.
- **Consequence for the credential-binding contract.** Nothing in XERK-268 changes: the host is
  still proved by its token, not by what it types, and a dsh session cannot assert a different host
  or org. The `agentType` on a session is presentational, like a label — it grants nothing.
- **Left open (Q2 below):** whether PR/commit attribution should visibly DISTINGUISH dsh-authored
  from Claude-authored work (e.g. carrying `agentType` onto the PR chip). Not required for
  correctness; a product call.

## D5 — Models: the runtime picks the model mechanism; a dsh session has NO Claude failover

- **Decision: model selection is PER SESSION and follows the session's runtime. If `agentType` is
  `dsh`, there is NO Claude-Code local-model failover in play at all — the dsh model selector
  (`@deepseek-ai/dsh-llm-pi-ai`, YAML provider config: DeepSeek API natively, plus any
  OpenAI-compatible local endpoint — LiteLLM / Ollama / vLLM) is the WHOLE story for that session.
  If `agentType` is `claude`, its existing local-model failover stays exactly as today.** The two
  mechanisms never coexist within one session and G0 does not try to unify them.
- **Why not unify.** Claude's failover is subscription-limit-driven and specific to the Claude
  runtime (`LOCAL_MODEL_*` env, `localModel.available` capability flag). dsh has no subscription
  limit and no such concept — it just points its adapter at whichever providers are configured, and
  can run local models as PRIMARY (the rewrite doc's "local-first"). Merging the two would couple two
  runtimes at exactly the seam QA is told never to stub. Keep them parallel.
- **Model set to start.** dsh with (a) local models via the existing LiteLLM/Ollama infra and (b)
  DeepSeek API where a key is provisioned, model chosen per session like the Claude model enum. Both
  are validated agent-side against a fixed enum, same as every spawn option.
- **Provisioning is a product/cost call (Q1/Q4 below):** whether a `DEEPSEEK_API_KEY` is provided at
  all, or dsh runs local-only first; and whether dsh defaults local-first. Neither blocks the code
  shape decided here.

## S1 — the projection, implemented (`agent/dsh_transcript.py`, XERK-464)

D3's dsh→Claude-JSONL projection is built as a pure, stdlib-only module the dsh launcher (D1)
imports. `DshProjector.feed(event)` returns the 0+ Claude-JSONL entry dicts one dsh event projects
to; `project_log()` is the batch form. Invariants a change here must not undo:

- **Incremental, one file, no new reader.** The launcher appends each event's projected entries to
  the pinned `<claudeSessionId>.jsonl` as events arrive, and the EXISTING `_entry_blocks`/
  `entryBlocks`, `_entry_text`, usage accountancy, PR scan and live tail read it unchanged. There is
  **no JS translator** — the projection runs only in Python, and the "py/js parity" this ticket
  names is that the projected JSONL renders IDENTICALLY under `_entry_blocks` (py) and `entryBlocks`
  (js). Adding a second reader/shape is the mirror multiplication the whole seam exists to avoid.
- **Only the three dsh SURFACE types project to entries** (`user/message`, `assistant/message`,
  `tool/result`). Every other event is log-only and projects to `[]` — turn/step boundaries,
  `assistant/chunk`, `request/*`, `todo/write`, `session/*`. A user-cancelled `turn/end`
  (reason `aborted`/`user`) projects the `[Request interrupted by user]` marker.
- **Tool calls ride the assistant message, NOT the `tool/call` event.** dsh appends BOTH an
  `assistant/message` whose `content` includes the `tool-call` blocks AND a redundant standalone
  `tool/call` event (verified in `dsh-agent-loop/lib/index.js`: the loop itself reads calls back via
  `message.content.filter(b => b.type === "tool-call")`). The projector emits tool_use from the
  assistant message and SKIPS `tool/call`, so exactly one tool_use appears — which is what makes PR
  attribution (D4) work: `gh pr create` lands as a real tool_use/tool_result pair, not opaque text.
- **Liveness is deliberately NOT in the projection.** dsh has no pane, so `paneBusy` has no
  transcript equivalent; a dsh session's "working" signal is an in-flight turn (`turn/start` with no
  `turn/end`, i.e. `agent.status === 'running'`), reported as a heartbeat field by [D] and read from
  dsh directly. Injecting a turn marker into the JSONL would force `entryBlocks` to grow a case.
- **usage + model ride the assistant entry** (D4): dsh `TokenUsage` maps 1:1 to Claude's disjoint
  `input/output/cache_read/cache_creation` counts, and `message.model` comes from the event's
  `message.source.model`. A step with no usage projects no `usage` key (never a fabricated zero,
  which would poison the per-model denominator).
- **uuids are deterministic** (uuid5 over session id + seq), so replaying the retained native log
  re-projects byte-identically without forking the file.
- **Verification is against real dsh 0.1.1-rc.2**, not a mock (the G1 lesson): the corpus
  (`dsh_corpus.json`) is built by `dsh_corpus_gen.mjs` from dsh's OWN `createUserMessage`/
  `createAssistantMessage`/`createToolResultMessage`, and the event shapes and loop behaviour were
  read from the cached `@deepseek-ai/*` `.d.ts` + `dsh-agent-loop` source. `dsh_projected.jsonl` +
  `dsh_expected_blocks.json` are the SAME artifacts the py test and the js test in
  `tunnel-agent.test.js` both assert against — pinning both readers to one expected result.
- Tests: `test_dsh_transcript.py`, the `dsh projection` case in `tunnel-agent.test.js`.

## [D] (XERK-468) — busy / ready / summary semantics, implemented (`hub-agent.py`)

The read-side of a dsh session's state. A dsh session runs HEADLESS
(`docs/dsh-session-lifecycle.md`, [B]): no Claude TUI pane, so `paneBusy` — the "is its own turn
running" signal every working/ready mirror keys on — cannot come from `_pane_status`. It comes from
the dsh driver plugin's control-socket `state` (status running|idle). Invariants a change here must
not undo:

- **It REUSES the `paneBusy` wire field, agent-side — it does NOT add a dsh signal to the mirrors.**
  `session_report(agent_type="dsh", dsh_status=…)` sources `paneBusy` from the cached dsh status
  (`dsh_pane_busy`) instead of scraping the pane, and reports it in the same `paneBusy`. So
  `sessionWorking`, `liveState`, the FIVE `readyForReview` mirrors, the ready-for-review alert and
  summaries are **UNCHANGED and cannot drift** — the projection philosophy applied to liveness
  (keep the mirrors at N). The CLAUDE.md "Working = paneBusy OR live agents" contract holds verbatim;
  the [B] design note's "all mirrors branch on agentType" was the rejected alternative — do not
  restore it (it multiplies the very mirror edits S1 exists to avoid).
- **Everything OTHER than liveness stays transcript-derived**, from the S1 projection: `lastRole`,
  `lastHasToolUse`, `transcriptAgeSec`, the PR scan and the summary seed all read the projected
  `<claudeSessionId>.jsonl` with no change. This is what makes `readyForReview`'s finished-turn branch
  and summaries work identically for a dsh session — the only signal that is not transcript-derived is
  liveness, exactly as S1's "liveness is deliberately NOT in the projection" note carves out.
- **`dsh_pane_busy` is a tri-state and deliberately NOT time-expired.** running→True, idle→False,
  unknown/missing→None ("can't tell", so downstream falls back to transcript freshness exactly like an
  uncapturable Claude pane). A pending interaction reads False (blocked on a human, not its own turn —
  like a Claude `panePrompt`). Expiring a stale "running" by AGE would reintroduce the transcript-
  freshness false-idle the socket signal exists to avoid (a long dsh tool call emits no status edge for
  minutes) — the exact bug paneBusy's "esc to interrupt" solves for Claude. Liveness-of-the-SIGNAL is
  the producer's job: it clears to unknown on socket disconnect, and the host-offline gate zeroes it
  when the host dies.
- **The beat only ever READS an in-memory cache (`self.dsh_status`), never the socket** — so a wedged
  plugin cannot stall the heartbeat past `OFFLINE_AFTER_MS` (XERK-395). The PRODUCER that fills the
  cache — the persistent per-session socket reader — is the LAUNCHER's ([B] impl phase), off the beat.
  [D] owns the CONSUMER seam: `_ingest_dsh_event(sid, event)` (the launcher's reader forwards each
  streamed `state` line here), `_set_dsh_status(sid, None)` (what it calls on disconnect), and
  `refresh_dsh_status` / `dsh_query_state` (the off-beat one-shot a poller can use instead). The cache
  is dropped on kill/delete (`_forget_session_caches`) and restart (a fresh dsh agent).
- **`_ingest_dsh_event` handles the `state` event ONLY; the `interaction` event is [C]'s** (XERK-467) —
  surfacing a dsh approval/question as a pending `question` through the AskUserQuestion bridge is what
  leads a blocked dsh session into Ready-for-review's "waiting" lead. [D] leaves `interaction`
  untouched so the two seams don't collide, and only a USABLE status (running|idle) updates the cache
  (a malformed state event must not clobber a known-good "running").
- **Verified by unit test, not against real dsh** — no launcher exists yet, so no dsh session runs to
  drive end to end. `dsh_query_state` is tested against a real fake UNIX-socket server speaking the
  contract; the cache/mapping/seam are tested directly. When the launcher lands it wires its reader to
  `_ingest_dsh_event` and this lights up. Tests: `TestDshState`, `TestDshQueryState`,
  `TestDshLivenessInReport`, `TestDshLivenessSeam` in `test_hub_agent.py`.

## [E] (XERK-469) shipped: archive sync (rendered + raw) for dsh sessions

D3's retention obligation made concrete — a dsh session archives with BOTH layers and no new archive
code, which is the same symmetry S1 buys the read side: the projection needs no new READER, the
native log needs no new WRITER.

- **The projection (`<slug>/<sid>.jsonl`) rides the RENDERED layer unchanged** — `_archive_manifest`
  enumerates every ledger slug's top-level `*.jsonl`, and a dsh session is in the usage ledger like
  any other. The native log (`<slug>/<sid>/dsh/...`) is nested, so it is NOT mistaken for a rendered
  transcript.
- **The native event log rides the RAW layer unchanged** because it is placed under the project-slug
  session dir at **`<slug>/<sid>/dsh/`** (`DSH_STORE_DIRNAME`), which `_session_files` already walks.
  This RECONCILES the [B] design-of-record (`docs/dsh-session-lifecycle.md`), which proposed the
  worktree's `.dsh/` — a location the raw layer reaches into for nothing (it excludes the worktree on
  purpose; those bytes are what prune/delete key on). The launcher (XERK-466) MUST write the store
  here, not in the worktree, or D3's canonical record is retained by nothing.
- **dsh's "raw" bytes are its append-only event log, not its SQLite.** The raw cursor ships bytes
  past an offset — right for an event-sourced JSONL stream, wrong for a page-mutating DB. The SQLite
  is a derived index dsh rebuilds from the log, so it is not the archived artifact and must not land
  under `<sid>/dsh/`.
- **Resume/migration de-dup is free**: a resumed dsh session appends to the same native log under the
  same pinned id, so the per-file cursor ships only the tail — the same property a resumed Claude
  transcript has, and what a migration relies on (same id, byte-identical prefix).
- **Migration ([K]) is the one thing NOT free yet.** `_pack_bytes` packs `<tid>.jsonl` +
  `<tid>/subagents/` + `<tid>/workflows/` by name, not the whole `<tid>/` subtree, so [K] adds a
  single `tar.add(<tid>/dsh)` in that same convention — a one-liner precisely because the store lives
  in this subtree. Flagged out of scope for [B] v1 already.
- **No beat-loop budget regression**: archive sync stays on the sync worker (XERK-395); [E] adds no
  code to the beat or the archive functions, only the store-dir contract. Tests: `TestDshArchiveSync`
  (agent), and the existing `TestArchiveSyncWorker` / `TestBeatLoopBudget`.

## [I] (XERK-473) shipped: board integration — a ticket can run on dsh

A ticket is DISPATCHED to a runtime, and the board's collectors/triage/tracker-writes are
runtime-agnostic. Like [A]'s composer selector, the runtime choice is presentational plumbing over
the same spawn path — no new session model.

- **The ticket runtime is a per-ticket PIN, mirroring the model pin (XERK-123), not a spawn-time
  flag.** Hub-owned durable state (`ticketRuntimes` on `/data`, keyed `<siteKey>/<issueKey>`), it
  rides the `spawnTicket` command as `agentType` and so must survive a hub restart and feed both the
  Start button and the auto-start sweep. Only a NON-default ("dsh") choice is stored — "claude" and
  clearing both release — so an unpinned ticket rides byte-for-byte the command it always did.
  `POST /api/jira/<siteKey>/<issueKey>/runtime` is the board's Runtime row (a fifth tap-to-change
  picker beside Status/Repo/Agent/Model), authoritative on a 200 like the model pin.
- **The DISPATCH filters the pool by runtime capability, not just triage** (XERK-296). `findTicketHost`
  restricts a dsh-pinned ticket to hosts reporting `dsh.available` — the same shape as the triage
  filter, checked ahead of capacity so "no host offers dsh" reads as **blocked** (a freed slot would
  not add the runtime, so it ages out) rather than **full** (clears itself). A pinned host that lacks
  dsh is reported, never routed around. `orgOffersDsh` gates the pin server-side and `dshAvailable`
  hides the board option, so a dsh pin can only name a runtime the org can actually run — the agent
  still re-validates (`resolve_agent_type`).
- **The agent side is one forwarded argument.** `spawn_ticket(agent_type=…)` passes it to `spawn()`,
  validated by `resolve_agent_type` like every other spawn enum; the launch choke point (`_launch_tmux`)
  already dispatches on `agentType`, and `_launch_dsh` already appends the ticket-branch directive and
  delivers the built ticket prompt + attachments. So a dsh ticket session is "told its branch, cuts
  it itself, worktree stays detached" with NO new launch code — the whole point of the [A]/[B] shape.
- **Collectors and the two tracker writes are runtime-agnostic and untouched** — they gather tickets
  and write status/create, never spawn a session, so the runtime never reaches them. **The
  `_board_column` mirrors are untouched too** (the ticket's explicit ask): the runtime pin is
  orthogonal to a ticket's column.
- **Web ⇄ Android parity**: the board Runtime row is deferred to XERK-477 (the Android dsh-parity
  ticket) with an `android/PARITY.md` line; the hub side is live, so the row works fully on web.
  The vendored `board.cjs` copies (glasses/veiller) stay byte-identical to `board.js`.
- Tests: `TestSpawnTicket` (`test_a_runtime_pin_lands_on_the_session_record`,
  `test_handle_commands_carries_the_runtime_pin`) agent-side; the `/runtime` route + the dsh
  `findTicketHost` cases in `server.test.js`; the `runtime*` cases in `board.test.js`.

## Open questions flagged to Malcolm (recorded on XERK-462)

1. **Image + resource + retention sizing.** Is growing the agent image with dsh's node/npm tree
   acceptable, and do `mem_limit` / `pids_limit` need raising in DockerOps before dsh sessions run
   beside Claude sessions? Also: does the archive raw-layer ceiling
   (`ARCHIVE_RAW_TRANSCRIPT_MAX_BYTES`) fit real dsh session sizes so the canonical native log we
   keep for metrics (D3) is not silently truncated? A DockerOps / archive sizing follow-up, not code
   here.
2. **Attribution granularity.** Should PR/commit attribution visibly distinguish dsh-authored from
   Claude-authored work, or is host-level attribution enough? Not needed for correctness.
3. **Fate of the full rewrite.** These decisions treat the PoC Fleet Hub + dsh-plugin rewrite as out
   of scope for XERK-460. Confirm the "alongside" integration SUPERSEDES the Turma-2.0 rewrite (or is
   a deliberate stepping stone toward it), so `docs/turma-2.0-design.md` can be marked accordingly.
4. **DeepSeek API vs local-only, and default.** Provision a `DEEPSEEK_API_KEY` and accept DeepSeek-API
   spend, or start dsh local-only? And should dsh default to local-first?

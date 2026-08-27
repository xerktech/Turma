---
paths:
  - "turma/public/sessions.html"
  - "turma/public/chat.js"
  - "turma/tests/chat.test.js"
  - "turma/tests/chat-live.test.js"
  - "turma/tests/chat-selection.test.js"
  - "turma/tests/sessions.test.js"
---

# `turma/` — the Sessions page and its chat engine

Split out of `.claude/rules/turma.md` (which covers the rest of the hub UI) to keep both under the
40,000-character ceiling; read that file too for the shared chrome, the org filter and notifications.

## The page

- **The fleet payload is polled ONCE, at load, whenever SSE is healthy** — `fastPoll` returns early
  and the fallback interval only fires when it isn't. So anything on `cache` that must MOVE in the
  browser needs its own `es.addEventListener` in `connectSSE`; `agent`, `removed`, `orgColors` and
  `migrations` each have one. A hub-broadcast event with no listener here reads as a feature that
  works in tests and never updates in front of the operator (that was every in-flight move: its
  phase stayed at load state, so the follow never saw `importCmdId` and never surfaced a failure).
- Opens a running session in a **native chat view by default** (`turma/public/chat.js`) instead of
  the raw ttyd terminal, streaming over the `/live/<host>/<id>` WebSocket (ws-token auth, seeded
  from the heartbeat's cached tail, scrollback from `GET .../history`, `/history`-poll fallback when
  the socket is down).
- **The stage is dropped only on POSITIVE evidence that the SESSION went** (XERK-252) — its own host
  reporting it stopped, or reporting without it. Three things that are NOT that evidence, each of
  which used to evict the operator mid-read:
  - **A host whose terminal tunnel went offline.** Every hub restart flaps every host's control
    channel (they all reconnect within a second or two) while the sessions keep running and keep
    heartbeating. The stage holds, both bars show a chip (`setStageTunnel`, mirrored by Android's
    `liveMarker`), and the RETURN heals in place: the chat reconnects its socket at once
    (`TurmaChat.reconnectNow`, since the hub held the watch and re-arms it) and the ttyd iframe is
    re-navigated, because its WebSocket died with the tunnel and nothing inside the frame retries.
    Transitions only — re-navigating per beat restarts the terminal every few seconds.
    - The chip **says which fault it is**: a host still heartbeating reads "⚠ tunnel offline" and
      promises the session is running; one that has gone silent reads "⚠ host offline" and promises
      nothing. Since the stage no longer clears itself, the chip carries a **Close** beside it —
      otherwise a dead host with no other session to pick leaves no way off the stage.
    - `stageTunnelOnline` belongs to ONE staged subject: every path that re-points the stage calls
      `stageTunnelReset()`. Left stale, the next session's first beat reads as a tunnel RETURN and
      fires the heal at a view that never lost anything — which opened a duplicate `/live` socket.
  - **A beat that doesn't mention the host at all** (a hub answering before the first heartbeat
    lands, a failed refresh). Silence about a host says nothing about its sessions;
    `currentHostKey` is what tells the two apart.
  - **The org filter.** The check reads the WHOLE fleet (`sessionRecord`, like `sessionHit`), never
    the org-scoped `running` — scoping is a sidebar concern (XERK-62).
  - `loadHistory` bails before building its URL when the view has closed; without it a 202-retry
    timer fetches `/api/agents/null/sessions/null/history`.
  - **`startWs` is single-flight PER GENERATION** (`wsStarting`): it assigns `ws` only after the
    ws-token round trip, so two connects for one view (a retry timer and a nudge) each built a
    socket and `close()` — which knows only the last — leaked the other, leaving the hub a live
    client it never unwatched. Keyed by generation, not a bare flag, so opening a DIFFERENT session
    still connects. Tests: the tunnel-flap cases in `sessions.test.js`, `chat-live.test.js`.
- It renders chat bubbles — **user right, agent left** — with collapsible tool-action cards
  (tool_use + its paired tool_result, error-styled) and collapsed thinking traces, and the
  in-progress turn as a trailing bubble.
  - **A `TodoWrite` / dsh `todo_write` tool call renders as a CHECKLIST, not raw-JSON input**
    (`renderTodoCard`): a state glyph per row (○ pending / ◐ in-progress / ✓ done) and a one-line
    count on the summary (`1 in progress · 6 pending`) so it reads even collapsed. Both runtimes
    share the `{content, status, activeForm?}` snapshot the AGENT attaches to the block
    (`_tool_use_detail`/`toolUseDetail` → `todos`, capped `TODO_ITEMS_MAX`); dsh's todos ride the S1
    projection's `todo_write` tool_use, so this is one renderer for Claude and dsh with no new
    reader. Each call is a fresh whole-list snapshot (last-wins), so the newest card is the current
    list. Tests: the `todo_write`/`TodoWrite` cases in `chat.test.js`, `tunnel-agent.test.js`,
    `test_hub_agent.py`.
  - **No text ever types in** (XERK-251): a capture is painted whole the frame it arrives, in this
    and every other client. The typewriter was animation over an already-~1s-delayed pane scrape —
    it delayed the text further and bought nothing. Don't reintroduce one.
  - **dsh sessions genuinely stream** (unlike claude's pane scrape): `tunnel-agent.js` folds the
    dsh native event log's `assistant/chunk` deltas into the SAME `turn` frames a claude pane
    scrape produces (`pollDshTurn`/`foldDshView`), so a dsh response grows in the live bubble as it
    generates instead of appearing whole when `assistant/message` commits. It is a real-time stream
    over the existing `/live` socket, NOT a reintroduced typewriter — the committed
    `assistant/message` clears the bubble and the projected transcript tail owns it. This reads the
    native events file directly; the S1 projection is untouched, per the ADR. Tests: the
    `pollDshTurn`/`foldDshView`/`dshEventsPath` cases in `tunnel-agent.test.js`.
  - **A generating dsh turn frame carries a working `status`** (`dshStatus`): the fixed
    **"Deep diving…"** verb dsh's own web UI uses, plus an elapsed clock that appears only once the
    turn passes **15s** (`fmtDshElapsed`, matching dsh's `showClock = elapsedMs >= 15e3`). Elapsed
    is dsh's OWN event timestamps (`turn/start` → newest event), never a wall clock, so the frame
    stays deterministic. The status carries **`noStop: true`**, because a dsh turn has no
    pane-Escape interrupt (kill ends the whole session) — `composeBusy()` hides Stop on that flag
    while the bar still shows the verb. This REPLACES the earlier "dsh frames carry no status"; the
    six-mirror "Working" contract is unchanged (that keys on the heartbeat `paneBusy`/`dsh_pane_busy`,
    not the chat's `liveStatus` bar). Tests: the Deep-diving cases in `tunnel-agent.test.js`.
  - The live turn is the tmux **pane scrape's "last ● bullet"**, NOT monotonic (XERK-19): it SWAPS
    blocks mid-turn, so every `turn` frame is CLASSIFIED by `applyTurn` before it reaches the bubble
    — an empty frame or a tool-use bullet (`isToolBullet`, biased toward matching since a miss
    brings the flicker back) CLEARS it, the same prose block keeps the LONGER text and never shrinks
    (a shorter re-capture is the TUI redrawing mid-frame), a different one replaces it wholesale.
    Tests: `chat-selection.test.js`.
- Bubble prose is rendered by `renderProse`: **fenced ` ``` ` blocks** become `<pre
  class="md-code">` (language chip from the info string), inline **` `code` ` spans** become `<code
  class="md-code-inline">` chips (`renderInline`), GFM **tables** become real `<table>`s, else
  linkified.
  - Passes nest outward-in — fence, table, inline, link — so a code body is never linkified, and the
    fence pass runs above the table pass. An inline span never crosses a line break; an
    **unterminated fence renders as code**. A code-carrying bubble takes a **definite** `width:
    min(760px, 100%)` (`:has()`-scoped), out of shrink-to-fit sizing so overflow lands on its own
    scroller, not a grid track.
  - **Images/SVGs render inline (XERK-221)**: `![alt](url)` → `<img>` (`linkify`, src `http(s)` +
    `data:image/*`); a line-start raw `<svg>` (`renderSvgAndText`) or all-SVG fence body → a
    sandboxed `data:image/svg+xml` `<img>` (`svgToImg`) — **never DOM-injected**, so embedded
    `<script>`/`onload` can't run. SendUserFile deliveries render the same way (`renderToolFiles`:
    images inline, HTML in a fully sandboxed iframe, open by default). Android deferred
    (`android/PARITY.md`). Tests: `linkify`/`renderProse` in `chat.test.js`.
- A per-session **verbosity control** (Concise/Normal/Verbose presets + per-type
  thinking/tool-calls/tool-outputs toggles, persisted in `localStorage`) filters which `blocks[]`
  show — client-side, over the received buffer.
- Typed prompts go to `POST .../input`; pending `AskUserQuestion`s answer via option chips / custom
  text to `POST .../answer`.
- The pending-question box renders Claude Code's full picker: each option a card with its
  `description` + collapsible **`preview`**, a `header` chip and an "n of N" counter, riding
  `questionOptionsRich`/`questionHeader`/`questionIndex`/`questionTotal`/`questionMulti` beside the
  backward-compat `questionOptions` labels, so glasses/android keep the flat list. A
  **`multiSelect`** question renders checkboxes + a Submit that POSTs `optionIndices`;
  `optionCardHtml` builds each card.
- The raw ttyd terminal stays one **"Terminal ▸" toggle** away in the chat header (`#termPane`
  iframe). `GET /api/ws-token` also authenticates the web chat's `/live` socket. Tests:
  `chat.test.js`.
- **A dsh session is HEADLESS — it hides "Terminal ▸" and shows "Trajectory ▸" instead** (XERK-498):
  a Turma-native read-only view (`#trajPane`, `renderTrajectory`) over the dsh D3 NATIVE event log,
  which the raw archive layer already holds (`<tid>/dsh/*.jsonl`, XERK-469). `chatToTrajectory` fetches
  `GET /api/dsh/<transcriptId>/trajectory` (parsed server-side by `archive.dshTrajectory` into
  turns/steps/tool-calls/token-usage/timings — the richer telemetry the S1 projection flattens) and
  renders newest-turn-first. This REPLACES the removed per-session dsh terminal/web-server; there is
  no ttyd or dsh web server for a dsh session. A running session's log syncs to the archive within a
  few beats, so a just-opened dsh session may 404 until the first sync (the pane says so, ↻ Refresh).
  The dsh-web-through-tunnel path was ruled out — `dsh web` has no base-path flag, so it cannot be
  sub-path-proxied per host. Web-first; Android (`TerminalScreen`) + glasses in `android/PARITY.md`.
  Tests: the `dshTrajectory` cases in `archive.test.js`, `/api/dsh/<id>/trajectory` in `server.test.js`.

### The model and mode chips

- A third selector — **"Run against"** (`cc-source`, XERK-246) — moves the session between the Claude
  subscription and the host's self-hosted model. It follows the HOST's `localModel.available`
  exactly as the 📎 follows `uploadMaxBytes`; an agent reporting nothing cannot do it, so offering
  the switch would queue a command it silently drops. It is **also shown when the session is already
  `local`**, so one whose host later lost its configuration still has a visible way back. A `local`
  session is marked (🏠, warn colour) — it is a weaker model, and nobody should have to wonder which
  one wrote a turn. **Its two rows read "Claude subscription" / "Other"** (`modelSourceOpts`,
  `modelSourceLabel`) — the selector is subscription vs the host's own endpoint and does NOT name the
  model (the adjacent DROPDOWN below does), so the raw discovered id — e.g.
  `bedrock/us.anthropic.claude-opus-4-5-…` — stays out of it. Like the mode switch it paints from a MEMO, never an optimistic write onto
  `sess`, so a stale beat can't flash the old value back; the memo ages out so a switch that never
  lands doesn't pin the chip. **`normalizeLocalModel` coerces the block at ingest** — the block is
  typed on Android and `/api/agents` decodes atomically there, so one host's `available:"yes"` hid
  the whole fleet from the phone; see CLAUDE.md's heartbeat contract. Tests: the `model source:`
  cases in `chat.test.js`, `normalizeLocalModel` in `server.test.js`.
- **A LOCAL session's model is a live DROPDOWN of the endpoint's DISCOVERED models** (XERK-489,
  `localModelChipHtml`), not the old fixed `cc-model-fixed` label — each row is `id · 128k`, and
  selecting one POSTs the endpoint id to `.../sessions/<id>/model` (the same route, which now
  accepts an endpoint model for a local session). The menu also carries an **advanced context
  override** (`ccLocalCtx`) that may only SHRINK the served window; selecting a model auto-applies
  its window. With no discovered `models[]` (older agent / pre-discovery) it falls back to the fixed
  label. The spawn composer (`sessions.html`) reveals the same model dropdown + context field under
  "Run against: local". `normalizeSessions` now coerces the per-session `localModelName`/
  `localModelContext` (typed on Android). Android has the dropdown (chat + composer); the context
  override is web-only (`android/PARITY.md`). Tests: the `local model (XERK-489)` cases in
  `chat.test.js`, the composer cases in `sessions.test.js`, `/model` context + `normalizeSessions`
  in `server.test.js`.
- The compose footer's agent-mode / model selectors are joined by a compact **PR status chip**
  (`prFooterChip`) when it has one, and a `jira-chip` when the session has a ticket.
- **A context-fullness meter** (XERK-489 Phase 4, `contextMeterChip`) rides the compose footer and
  the dashboard session card (`contextMeterHtml` in `index.html`), warning before the ~95%
  auto-compaction (warn ~85%, danger ~95%). Numerator = the newest assistant turn's window
  occupancy (input + cache), agent-computed per-session as `lastTurnContextTokens` — NOT the
  cumulative usage totals, which keep climbing across compactions. Denominator = `contextWindowTokens`,
  agent-computed in `context_window_tokens`: EXACT for a local session (its selected model's window);
  for a subscription one, derived from the MODEL it runs (`_subscription_context_window` maps the
  `modelActual`/`model` family — the current Opus/Sonnet/Fable families serve 1M, so a flat 200k
  `SUBSCRIPTION_CONTEXT_ASSUMED` over-warned 5x and is now only the fallback for an unrecognised model
  or a session that has not named one). Still marked "~" (derived off `modelSource`): `message.model`
  is the bare family id, so the transcript can't tell a family's `[1m]` 1M variant from its 200k one,
  and the map errs toward 1M (under-warn) over the old cry-wolf. Both figures come off the HEARTBEAT
  transcript-sum, never a pane statusLine — that text needs a statusLine Turma refuses to wire
  because it breaks busy detection (XERK-130). Android mirrors it (`core/ContextMeter.kt` +
  `ContextMeterBar` on the card and chat bar). Tests: the `context meter` cases in `chat.test.js`,
  `dashboard-tiles.test.js`, `TestContextMeter` in `test_hub_agent.py`, `ContextMeterTest.kt`.
- The **model selector is accurate** (XERK-33) — never a hardcoded menu, and never rewriting the
  shared login's default:
  - the chip leads with the session's heartbeated `modelActual`, humanized by `prettyModel`
    ("claude-opus-4-8" → "Opus 4.8"), falling back to the picked alias, raw id in the tooltip;
  - the menu is `modelOpts` from the host's probed `models` block — curated to the aliases the
    /model picker can reach, "Default (<label>)" saying what it resolves to, the static four before
    a probe;
  - a just-picked switch holds its optimistic label until the agent confirms or
    `MODEL_SWITCH_SETTLE_MS` passes (`modelSwitchPending`); a DEFERRED pick (`session.pendingModel`)
    outranks the memo and shows an ellipsis. The mode chip shares the memo
    (`modeChipValue`/`modeSwitchPending`), retired when the heartbeat's `permissionMode` agrees;
  - `onPoll` carries the fresh host payload so the menu tracks the probe.
  - Tests: `modelOpts`/`prettyModel` in `chat.test.js`, the malformed-model case in
    `server.test.js`.

### Working-status bar and agent list

- A pinned **working-status bar** below the transcript mirrors the terminal's bottom region from the
  live `status` frame: the spinner verb + ↑/↓ token counters + elapsed, and Claude Code's rotating
  tip/active-task hint. When background agents run it shows a clickable **agent list**
  (`agentsHtml`: `main` a plain marker, each subagent a button carrying its type + description).
- **The bar outlives the turn when agents are still running** (XERK-245): `liveStatus` clears the
  moment the turn ends (it is what shows Stop), so the list is held in its own `liveAgents` off the
  frame's `agents` — falling back to `status.agents` for an older agent — and the bar then renders
  just the list under a "Background agents…" spinner. Without that split it either vanished mid-run
  or would have faked a running turn.
- Clicking a subagent opens its transcript read-only in the right stage (`openSubagentView` → `GET
  /api/agents/<host>/sessions/<id>/subagents/history?type=&label=&agentId=`, reusing the archive
  viewer + chat engine), with **Back** returning to the live session.
- **A `workflow` row opens the run's AGENT PICKER, not a transcript** (XERK-304): a workflow is N
  agents and has no conversation of its own. The reply carrying `agents` — **the empty list
  included** — is the whole signal, so `renderWorkflowAgents` runs on presence and never on length;
  an empty run reads "hasn't started any agents yet", which is a real answer and deliberately worded
  apart from the "unavailable" an unresolved row gets.
- **Back is three rungs deep there**, and `subagentListReturn` is the middle one: one agent of a run
  returns to that run's list, and only the list returns to the session. Every place that drops
  `subagentReturn` must drop it too — a stale middle rung sends Back into a list the pane is no
  longer showing. The back label names the rung it actually reaches ("Workflow" vs "Session").
  - **The middle rung is only taken when the list can still be FETCHED.** It is read from the
    session's host, so once that session leaves the cache `openSubagentView` early-returns on the
    missing host key and the press vanishes — the rung must fall through to the session rung, which
    already handles a session that ended, rather than consume it.
- **The picker is a SNAPSHOT per fetch**, like `/history`: agents starting while it is open do not
  appear until it is reopened. Acceptable for a finished run, visibly stale for a running one.
- **An unresolved row must not be rendered as a transcript.** No `agents` and no entries means the
  row did not resolve; handing that to the chat engine paints its "This session's transcript is
  empty.", the wording for a conversation that exists and is empty, which reads as if the agent did
  nothing. A background agent that has a transcript always has at least its prompt.
- Tests: `agentsHtml` in `chat.test.js`, the subagent-history cases in `server.test.js`, the
  XERK-304 drill-down cases in `sessions.test.js`.

### Queued sessions

- A **"Queued" section** above the live lists: static cards with the wait reason
  (`queuedReasonText`) and an arm-then-confirm **Cancel**. A followed spawn (`?spawn=<cmdId>`)
  landing there words its stage **"Queued — <reason>"**, flipping to the live session once
  provisioned; the dashboard's card mirrors this. Tests: `sessions.test.js`.

### Ready for review (XERK-224)

- The live sessions split three ways in reading order — **Ready for review** (stopped, waiting on
  YOU), **Active** (working), **Idle** (quiet).
- **A session running background agents is Active, and its card names them** ("1 background agent",
  `agentWorkLabel`; Android's `liveStateLabel(state, live)` matches). It is `liveState`, not
  `readyForReview`, that this changes — the working branch already disqualifies it — which is what
  stops the ready-for-review alert firing the instant work is delegated. See `CLAUDE.md`.
- `readyForReview(s, live)` is **derived from the signals alone** — there is no "I've reviewed this"
  action. It qualifies on a pending question/pane prompt (blocked on a human, so the busy read
  doesn't matter; it leads the section), a PR that hasn't landed, or a **finished turn**
  (`lastRole=="assistant"`, no `lastHasToolUse`) — the only trace a research task that opened no PR
  leaves, and the case a PR-only rule was asked to stop missing.
- Every PR reaching MERGED/CLOSED demotes it: merging IS the review, so it drops to Idle, where work
  merged but not yet verified is parked. `prLanded` counts an unknown state as still live; an
  unreadable one must never drop work off the list.
- **That demotion is scoped in TIME, never absolute**: a landed PR stops being a reason to look but
  must not become a reason NOT to. A session is a CONVERSATION, not a pull request — hand the same
  one a new task and it finishes with no new PR to show, which an absolute demotion hid for good.
  `newWorkSincePrs` (against the agent's `prsLandedTs`) says the conversation moved past it, and the
  rule then falls through to the finished-turn signal. False when unanswerable (older agent
  included), erring toward parking over a wrong claim.
- **FIVE mirrors must agree** — see CLAUDE.md's cross-cutting contracts. The card says WHY it
  qualified, on `.dot.review`. Tests: `sessions.test.js`, `readyForReview` in `server.test.js`.

### Ended sessions

- The sidebar's last section, **collapsed by default**. It merges the three channels an
  over-but-resumable session arrives on: **killed** (`a.closedSessions`), **stopped** (a non-running
  record still in `a.sessions`), and **resumable** (a transcript from each repo's `resumable` scan,
  no registry record behind it).
- The third channel makes the list **durable**: the first two read the capped `~/.turma` records,
  while `resumable` is re-derived every slow beat from the transcripts under `~/.claude/projects`.
- **Deduped on `<host>::<transcriptId>`**, a registry-backed record always winning; a kill that ages
  out of `closed.json` keeps listing, minus its PR chips. Sorted **most recently ended first**
  (`endedMs`, from `closedAt`/`stoppedAt`/`endedTs` — `resumableSession()` must copy `endedTs` onto
  the record, where `endedEntry` reads the key); an undated record sorts oldest.
- A **running** session is never also listed as ended: the agent re-cuts the cached scan against its
  live registry every beat (`_sorted_repo_entries`), and the page dedupes resumable rows against
  every reported session's `transcriptId` (why `_session_payload` reports it while running).
- **Clicking a row opens that session read-only on the stage** — the same `#transcriptPane` the
  archive/subagent views use: scrollable conversation + a verbosity control, **no terminal toggle
  and no compose box**. `resetEndedBar()` keeps the pane's shared PR/Resume bar from leaking into
  those views. The conversation is read from the hub's **archive** (`GET
  /api/archive/<transcriptId>`), so it works for an offline host; a just-killed session hasn't
  synced yet and says so.
- Its **PRs are chips on the stage bar and are LINKS there** (`prBadgeLinkHtml`); the sidebar copy
  stays an inert `<span>` (the card is a `<button>`).
- **Resume** sits on the row and stage bar, dispatching on how the session ended: killed →
  `.../resume` (same id), stopped → `.../start`, resumable → `.../transcripts/<id>/resume` with its
  origin cwd (the agent re-validates the path and re-creates the dir if a prune removed it). The
  list is DERIVED, so a resumed session drops out the beat the agent reports it running. The
  resumable path comes back under a **new id**, so it follows its queued command's `cmdId`. Resume
  needs the host **online**; reading doesn't.
- Tests: `sessions.test.js`, `TestRefreshPrStatus`, `TestSessionLifecycle`, `TestResumableReport`,
  `TestCardedSlugs`.

### Session card ⋯ menu

- Each sidebar session card carries a **⋯ overflow menu** — a sibling of the card `<button>`,
  absolutely positioned over it (a nested button is invalid HTML). **Rename…** swaps the card for an
  inline field POSTing to `.../sessions/<id>/summary`, painted optimistically; **Kill** arms-then-
  confirms; **Move** migrates the session (XERK-101). Its state lives in page variables, not the
  DOM.

### Send and Stop buttons

- **Send always sends, and ◼ Stop is its own button**, in both chat and terminal views. A message
  sent mid-turn QUEUES, so the button that talks must stay available while the agent works. The
  warning-coloured Stop appears beside Send only while a turn runs.
- Stop interrupts the turn (`chatComposeStop`/`termComposeStop` → `stop()` → `POST
  /api/agents/<host>/sessions/<id>/interrupt`). Unlike Kill it arms/confirms nothing and leaves the
  session on the stage. **Enter always sends**, like the button.
- The busy read driving Stop's visibility is `liveStatus` (the ~1s pane scrape), NOT the heartbeat's
  `paneBusy`. With the live socket down `liveStatus` stays null and Stop stays hidden (a Stop that
  can't see the turn is worse than no Stop).
- A clicked Stop **hides immediately** (`stopPendingAt`, `composeBusy()`); if the turn outlives
  `STOP_SUPPRESS_MS` the interrupt didn't take and Stop comes back. A failed POST paints "Stop
  failed" (`actionFailed`'s selector arg).
- **A pending `AskUserQuestion` hides Stop** (`composeBusy()` returns false while `questionActive`)
  — the answer is typed THROUGH the compose box, routed to `/answer` (`send()`'s `wasAnswer` path),
  and an accidental Stop would destroy the question (XERK-21). `updateQuestion` repaints the bar the
  instant a question appears/clears.
- `chat.js` paints every `.compose-action` + `.compose-stop` button from that one read, so the
  terminal's bar can't disagree with the chat's. Tests: `chat.test.js`,
  `termComposeAction`/`termComposeStop` in `sessions.test.js`.

### The compose draft survives the view toggle (XERK-122)

- The chat and terminal panes have a compose box each, but a session has ONE draft: each toggle
  **moves** the text across (`carryDraft`), clearing the source, so the two can never disagree. It
  is carried **after** the pane swap — `focus()` on a still-`hidden` textarea is a silent no-op.
  Focus follows only a NON-EMPTY draft, so toggling with an empty box doesn't pop a soft keyboard.
- **A compose box auto-grows to its `scrollHeight`, but only while it is laid out** (XERK-149): a
  hidden textarea (`.chat-pane`/`.term-pane[hidden]`, or a phone's `display:none` `.stage`) reports
  `scrollHeight` 0, and an unguarded `growCompose`→`autoGrow` during the toggle's `carryDraft` pins
  an inline `height:0px`. `autoGrow`/`autoGrowTermInput` bail on `offsetParent === null`, keeping
  the last laid-out height; `carryDraft` re-grows it when shown.
- Tests: `sessions.test.js`.

### Copying out of the terminal

- A copy made in the terminal view reaches the viewer's **real system clipboard** — three
  independent links, since the text has to survive the app, tmux AND xterm.js (XERK-7).
- Selecting at all needs a **modifier**, because the Claude TUI holds mouse tracking: **Shift**
  everywhere except macOS, where xterm.js honours **Alt** only when `macOptionClickForcesSelection`
  is on (defaults off) — `_launch_ttyd` passes it (cost: Mac's Alt+drag column-select). Once a
  selection exists ttyd copies it itself.
- **Every other copy — the app's own and tmux copy-mode's — travels as OSC 52**, needing all three
  of: `agent/tmux.conf` declaring an `Ms` capability (tmux emits OSC 52 only if the OUTER terminal
  advertises it, and xterm-256color / tmux-256color lack it); `set-clipboard on` (the default
  `external` forwards **no** application OSC 52); and the hub injecting xterm.js's missing OSC 52
  handler (`TERM_OSC52_JS`, in `proxyTerm`, via ttyd's `window.term`).
- The bridge is deliberately **write-only**: an OSC 52 READ request (`?`) is never answered (else
  any program in the pane reads the clipboard). An empty payload is dropped. It splits at the
  **first `;`** (an app sends `52;c;<b64>`, tmux `52;;<b64>`, both must land).
- Tests: `server.test.js`, `test_launch_ttyd_lets_a_mac_force_a_selection` in `test_hub_agent.py`.

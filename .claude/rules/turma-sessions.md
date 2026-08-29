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

Split out of `.claude/rules/turma.md` (shared chrome, org filter, notifications) to stay under the
40,000-char ceiling.

## The page

- **`chat.js` is VENDORED into glasses byte-identical** as `glasses/src/vendor/chat.cjs` (like
  `board.js`), asserted by `vendor.test.ts`, gated by `glasses-ci.yml`. Re-copy on every edit (`cp
  turma/public/chat.js glasses/src/vendor/chat.cjs`) or glasses CI fails.
- **The fleet payload is polled ONCE, at load, while SSE is healthy** — the fallback interval only
  fires when SSE isn't. Anything on `cache` that must MOVE in the browser needs its own
  `es.addEventListener` in `connectSSE` (`agent`, `removed`, `orgColors`, `migrations` each have one);
  an event with no listener silently never updates the UI (every in-flight move's phase used to stick
  at load state this way).
- Opens a running session in a **native chat view by default** (`chat.js`), not the raw ttyd
  terminal, over `/live/<host>/<id>` (ws-token auth, seeded from the cached tail, `/history` scrollback
  + poll fallback when the socket is down).
- **The stage drops only on POSITIVE evidence the SESSION went** (XERK-252) — its host reporting it
  stopped, or reporting without it. Three things that are NOT that evidence, each used to wrongly
  evict the operator mid-read:
  - **A host's terminal tunnel going offline** (every hub restart flaps every control channel for a
    second or two while sessions keep heartbeating). The stage holds, both bars show a
    "⚠ tunnel offline"/"⚠ host offline" chip (`setStageTunnel`, mirrored by Android's `liveMarker`,
    the wording says which fault it is) with a **Close** beside it, and the RETURN heals in place:
    chat reconnects at once (hub held the watch, re-arms it), ttyd re-navigates (transitions only, or
    it restarts the terminal every few seconds). `stageTunnelReset()` must be called by every path
    that re-points the stage, or a stale flag reads the next session's first beat as a false RETURN
    and opens a duplicate socket.
  - **A beat that doesn't mention the host at all** (pre-first-heartbeat reply, a failed refresh) —
    silence about a host says nothing about its sessions; `currentHostKey` distinguishes the two.
  - **The org filter** — the stage check reads the WHOLE fleet (`sessionRecord`), never the org-scoped
    `running` (scoping is a sidebar-only concern, XERK-62).
  - `loadHistory` bails before building its URL once the view has closed, or a 202-retry timer fetches
    `/api/agents/null/sessions/null/history`.
  - **`startWs` is single-flight PER GENERATION** (`wsStarting`) — two connects for one view (a retry
    + a nudge) otherwise each open a socket, and `close()` only knows the last, leaking the other as a
    live client the hub never unwatched. Keyed by generation so opening a DIFFERENT session still
    connects. Tests: the tunnel-flap cases in `sessions.test.js`, `chat-live.test.js`.
- Renders chat bubbles — user right, agent left — with collapsible tool-action cards (tool_use +
  paired tool_result, error-styled), collapsed thinking traces, in-progress turn as a trailing bubble.
  - **`TodoWrite`/dsh `todo_write` renders as a CHECKLIST, not raw JSON** (`renderTodoCard`): a state
    glyph per row + a one-line count so it reads collapsed. Both runtimes share the agent-attached
    `{content, status, activeForm?}` snapshot, capped `TODO_ITEMS_MAX` (dsh rides the S1 projection's
    `todo_write` tool_use, so
    one renderer serves both with no new reader). Each call is a fresh whole-list snapshot (last
    wins). Tests: the `todo_write`/`TodoWrite` cases in `chat.test.js`, `tunnel-agent.test.js`,
    `test_hub_agent.py`.
  - **No text ever types in** (XERK-251) — a capture paints whole the frame it arrives; a typewriter
    would only add delay on top of the ~1s pane-scrape delay. Don't reintroduce one.
  - **dsh sessions genuinely stream** (unlike claude's pane scrape): `tunnel-agent.js` folds the dsh
    native log's `assistant/chunk` deltas into the same `turn` frames a pane scrape produces
    (`pollDshTurn`/`foldDshView`), so a response grows live instead of appearing whole at commit. Reads
    the native events file directly; the S1 projection is untouched (`docs/dsh-adr.md`). Tests: the
    `pollDshTurn`/`foldDshView`/`dshEventsPath` cases in `tunnel-agent.test.js`.
  - **A generating dsh turn frame carries a working `status`** (`dshStatus`): the fixed
    "Deep diving…" verb dsh's own web UI uses, plus an elapsed clock past **15s**
    (`fmtDshElapsed`/`showClock`), using dsh's OWN event timestamps (deterministic, never wall-clock).
    Carries **`noStop: true`** — a dsh turn has no pane-Escape interrupt (kill ends the session), so
    `composeBusy()` hides Stop on that flag while the bar still shows the verb. The "Working" contract
    (paneBusy/dsh_pane_busy) is unaffected — this only drives the chat's `liveStatus` bar. Tests: the
    Deep-diving cases in `tunnel-agent.test.js`.
  - The live turn is the pane scrape's **"last ● bullet"**, NOT monotonic (XERK-19) — it SWAPS blocks
    mid-turn, so every frame is classified by `applyTurn` before reaching the bubble: an
    empty/tool-use frame CLEARS it, the same prose block keeps the LONGER text (a shorter re-capture is
    a mid-frame redraw), a different one replaces wholesale. Tests: `chat-selection.test.js`.
- Bubble prose via `renderProse`: fenced ` ``` ` → `<pre class="md-code">` (language chip); inline
  ` `code` ` → `<code class="md-code-inline">`; GFM tables → real `<table>`s; else linkified.
  - Passes nest outward-in (fence, table, inline, link) so code is never linkified; an inline span
    never crosses a line break; an unterminated fence renders as code.
  - **Images/SVGs render inline (XERK-221)**: `![alt](url)` → `<img>`; a raw `<svg>`/all-SVG fence →
    a sandboxed `data:image/svg+xml` `<img>` — **never DOM-injected**, so an embedded `<script>` can't
    run. SendUserFile deliveries render the same way (images inline, HTML in a sandboxed iframe).
    Android deferred (`android/PARITY.md`). Tests: `linkify`/`renderProse` in `chat.test.js`.
- A per-session **verbosity control** (Concise/Normal/Verbose + per-type toggles, `localStorage`)
  filters which `blocks[]` show client-side.
- Typed prompts → `POST .../input`; pending `AskUserQuestion`s answer via option chips/custom text →
  `POST .../answer`. The picker renders Claude Code's full card set (description + collapsible
  `preview`, header chip, "n of N" counter) with a backward-compat flat-list fallback for
  glasses/android; `multiSelect` renders checkboxes + a Submit posting `optionIndices`.
- Raw ttyd terminal is one **"Terminal ▸"** toggle away (`#termPane` iframe); `GET /api/ws-token` also
  authenticates the chat's `/live` socket. Tests: `chat.test.js`.
- **A dsh session is HEADLESS — hides "Terminal ▸", shows "Trajectory ▸"** (XERK-498): a read-only
  view (`#trajPane`) over the dsh D3 native event log (already in the raw archive,
  `<tid>/dsh/*.jsonl`), fetched via `GET /api/dsh/<transcriptId>/trajectory` and rendered
  newest-turn-first. Replaces the removed per-session dsh terminal/web-server. A log syncs to the
  archive within a few beats, so a just-opened dsh session may 404 until then (pane says so, ↻
  Refresh). The dsh-web-through-tunnel PROXY path is ruled out (`dsh web` has no base-path flag).
  Web-first; Android/glasses in `android/PARITY.md`. Tests: `dshTrajectory` in `archive.test.js`,
  `/api/dsh/<id>/trajectory` in `server.test.js`.
- **A dsh session's chat header also shows a "dsh web ↗" link** (XERK-501) to the host's single
  host-wide `dsh web` (direct-access viewer over the shared store, `dsh-input.md`) — shown only when
  the host reports a reachable `dsh.web.url` (a loopback-only host reports `null`, link stays hidden).

### The spawn composer's runtime + model (XERK-503)

- **ONE `Runtime` picker, not four selectors** — collapses the old Runtime (claude/dsh) + "Run
  against" (subscription/local) pair into "Claude Code" / "Claude Code Local" (if
  `localModel.available`) / "dsh" (if `dsh.available`), shown only when more than one exists. Maps
  onto UNCHANGED wire fields (local → `modelSource:local`+`localModel`; dsh →
  `agentType:dsh`+discovered `model`) — no backend contract moved.
- **A dsh session offers the endpoint's DISCOVERED models, never Claude aliases** — `dsh.models[]`
  ride the heartbeat like `localModel.models[]`, so dsh and local share a list when pointed at one
  LiteLLM URL. Spawn resolves a dsh model via `resolve_dsh_model` (the discovered set), NOT
  `resolve_model` (the Claude-alias allowlist that previously caused a "no configured model" lock: the
  pi-ai provider route now lists EVERY discovered model, not just one). `DSH_MODEL` is still the
  required default; discovery only widens the per-session choice.
- **Permission modes are consistent; `auto` is MODEL-gated, not provider-gated** — Claude Code/Local
  share the full list (`auto` needs Sonnet 5/Opus 4.7+/Fable 5, else Manual, offered with a hint
  rather than hidden). dsh uses `ask`/`never` + a sandbox mode, so the composer shows an
  "approvals managed by dsh" note instead. Android in `android/PARITY.md`. Tests: the
  `Runtime`/`dsh model list` cases in `sessions.test.js`, `normalizeDsh` in `server.test.js`,
  `TestDshModelDiscovery` in `test_hub_agent.py`.

### The dsh session footer (XERK-504)

- **A dsh footer reflects its RUNTIME, not the Claude subscription/local split** — a dsh session
  carries `modelSource:"subscription"` under the hood, so `isDshSession()` branches the footer to: a
  read-only **"⚙ dsh"** chip (not a picker — a running dsh conversation is an event log, not Claude
  JSONL, so it can't switch runtimes live), a live dsh model dropdown, and **no permission-mode chip**.
- **A dsh model switch is a real runtime relaunch** (`_switch_dsh_model`) — validates against the
  discovered set, sets `sess["model"]`, relaunches via `_launch_tmux(resume=True)` (dsh reloads its
  own store), reverting the record if the launch throws. `/model` takes the endpoint charset
  (`dshServes`) for a dsh session, like the local branch.
- Claude source chip relabeled to the composer's runtime names ("Claude Code"/"Claude Code Local").
  Android in `android/PARITY.md`. Tests: the `dsh footer`/`model source` cases in `chat.test.js`, the
  dsh `/model` case in `server.test.js`, `TestSwitchDshModel` in `test_hub_agent.py`.

### The model and mode chips

- **"Run against"** (`cc-source`, XERK-246) moves a session between the Claude subscription and the
  host's local model — follows the host's `localModel.available` (an agent reporting nothing can't do
  it), and is **also shown when already `local`** so a host that lost its config still has a way
  back. A `local` session is marked (🏠, warn colour). Rows read "Claude subscription"/"Other" — the
  selector is subscription-vs-endpoint, not the model name (the adjacent dropdown does that). Paints
  from a MEMO (never optimistic onto `sess`), aged out so a switch that never lands doesn't pin.
  **`normalizeLocalModel` coerces at ingest** (typed on Android, atomic decode — one bad host hides the
  fleet; CLAUDE.md's heartbeat contract). Tests: `model source:` in `chat.test.js`,
  `normalizeLocalModel` in `server.test.js`.
- **A LOCAL session's model is a live DROPDOWN of DISCOVERED models** (XERK-489,
  `localModelChipHtml`), each row `id · 128k`; selecting POSTs to `.../model` (accepts an endpoint
  model for a local session). An **advanced context override** (`ccLocalCtx`) may only SHRINK the
  served window; picking a model auto-applies its window. Falls back to the fixed label with no
  discovered `models[]`. Composer has the same controls. Android has the dropdown only (context
  override web-only, `android/PARITY.md`). Tests: the `local model (XERK-489)` cases in `chat.test.js`,
  the composer cases in `sessions.test.js`, `/model` context + `normalizeSessions` in `server.test.js`.
- Footer also carries a PR status chip (`prFooterChip`) and a `jira-chip` when applicable.
- **A context-fullness meter** (XERK-489 Phase 4, `contextMeterChip`) warns before ~95%
  auto-compaction (warn ~85%, danger ~95%). Numerator = the newest turn's window occupancy
  (`lastTurnContextTokens`, NOT cumulative usage). Denominator = `contextWindowTokens` — exact for a
  local session, else derived from the running model family (a flat 200k `SUBSCRIPTION_CONTEXT_ASSUMED`
  fallback over-warned 5x
  against the 1M families now served, so it's the fallback only). Marked "~" since a transcript can't
  tell a family's 1M variant from its 200k one. Reads off the heartbeat transcript-sum, never a pane
  statusLine (that breaks busy detection, XERK-130). Android mirrors it. Tests: `context meter` cases
  in `chat.test.js`, `dashboard-tiles.test.js`, `TestContextMeter`, `ContextMeterTest.kt`.
- **Model selector is accurate** (XERK-33), never a hardcoded menu: chip leads with heartbeated
  `modelActual` (humanized, raw id in tooltip); menu is `modelOpts` from the probed `models` block; a
  just-picked switch holds its optimistic label until confirmed or `MODEL_SWITCH_SETTLE_MS`; a
  DEFERRED pick shows an ellipsis. Mode chip shares the same memo pattern. Tests: `modelOpts`/
  `prettyModel` in `chat.test.js`, the malformed-model case in `server.test.js`.

### Working-status bar and agent list

- A pinned bar mirrors the terminal's bottom region from the live `status` frame: spinner verb + ↑/↓
  counters + elapsed + Claude Code's rotating tip. Background agents show a clickable **agent list**
  (`agentsHtml`).
- **The bar outlives the turn when agents are still running** (XERK-245) — `liveStatus` clears at
  turn-end, so the list is held separately (`liveAgents`, falling back to `status.agents` for an
  older agent) and renders under a "Background agents…" spinner alone; without the split it either
  vanished mid-run or faked a running turn.
- Clicking a subagent opens its transcript read-only (`openSubagentView` → `GET
  .../subagents/history?...`), Back returns to the live session.
- **A `workflow` row opens the run's AGENT PICKER, not a transcript** (XERK-304) — a workflow has no
  conversation of its own. `agents` present (**empty list included**) is the whole signal;
  `renderWorkflowAgents` runs on presence, never length, wording an empty run "hasn't started any
  agents yet" — deliberately distinct from an unresolved row's "unavailable".
- **Back is three rungs deep**; `subagentListReturn` is the middle one (one agent → that run's list →
  the session). Every place dropping `subagentReturn` must drop it too, or a stale middle rung sends
  Back into a list no longer shown. **The middle rung is only taken when the list can still be
  FETCHED** — once the session leaves the cache, the press falls through to the session rung instead.
- **The picker is a SNAPSHOT per fetch** (like `/history`) — agents starting while open don't appear
  until reopened.
- **An unresolved row must not render as a transcript** — no `agents` and no entries means the row
  didn't resolve, not that the conversation is empty (a background agent with a transcript always has
  at least its prompt). Tests: `agentsHtml` in `chat.test.js`, the subagent-history cases in
  `server.test.js`, the XERK-304 drill-down cases in `sessions.test.js`.

### Queued sessions

A **"Queued" section** above the live lists: static cards with the wait reason
(`queuedReasonText`) + arm-then-confirm Cancel. A followed spawn (`?spawn=<cmdId>`) landing there
words its stage "Queued — <reason>", flipping live once provisioned. Tests: `sessions.test.js`.

### Ready for review (XERK-224)

- Live sessions split, in reading order: **Ready for review** (stopped, waiting on you), **Active**
  (working), **Idle** (quiet).
- **A session running background agents is Active, named on its card** ("1 background agent") — it's
  `liveState` this changes, not `readyForReview` (the working branch already disqualifies it), which
  is what stops the alert firing the instant work is delegated.
- `readyForReview(s, live)` is **derived from signals alone** (no "I've reviewed this" action):
  qualifies on a pending question/pane prompt (blocked on a human, leads the section), an unlanded PR,
  or a **finished turn** (`lastRole=="assistant"`, no `lastHasToolUse` — the only trace a
  no-PR research task leaves).
- Every PR reaching MERGED/CLOSED demotes it (merging IS the review) to Idle; an unknown state counts
  as still live, an unreadable one must never drop work off the list.
- **That demotion is scoped in TIME, never absolute** — a landed PR stops being A reason to look but
  must not become a reason NOT to (the same conversation, handed new work, finishes with no new PR to
  show). `newWorkSincePrs` (against `prsLandedTs`) says the conversation moved past it, falling
  through to the finished-turn signal; false when unanswerable, erring toward parking.
- **FIVE mirrors must agree** — see CLAUDE.md. Card shows WHY it qualified (`.dot.review`). Tests:
  `sessions.test.js`, `readyForReview` in `server.test.js`.

### Ended sessions

- Sidebar's last section, collapsed by default — merges **killed** (`a.closedSessions`), **stopped**
  (a non-running record in `a.sessions`), and **resumable** (each repo's transcript scan, no registry
  record).
- **Resumable makes the list DURABLE** — the first two read capped `~/.turma` records; resumable is
  re-derived every slow beat from `~/.claude/projects`.
- **Deduped on `<host>::<transcriptId>`**, a registry-backed record winning. Sorted most-recently-ended
  first (`endedMs`); undated sorts oldest. A running session is never also listed ended (dedup against
  every reported `transcriptId`).
- **Clicking a row opens it read-only on the stage** (same `#transcriptPane` as archive/subagent
  views): scrollable conversation + verbosity control, no terminal toggle, no compose box. Read from
  the hub's **archive** (`GET /api/archive/<transcriptId>`), so it works for an offline host; a
  just-killed session hasn't synced yet and says so.
- PRs are LINKS on the stage bar; the sidebar copy stays an inert `<span>`.
- **Resume** dispatches on how it ended: killed → `.../resume` (same id), stopped → `.../start`,
  resumable → `.../transcripts/<id>/resume` (agent re-validates/re-creates the cwd if pruned). List is
  derived, so a resumed session drops out once the agent reports it running; the resumable path comes
  back under a NEW id. Needs the host online; reading doesn't. Tests: `sessions.test.js`,
  `TestRefreshPrStatus`, `TestSessionLifecycle`, `TestResumableReport`, `TestCardedSlugs`.

### Session card ⋯ menu

Each card carries a **⋯ overflow menu** (a sibling of the card button, absolutely positioned — a
nested button is invalid HTML). **Rename…** swaps the card for an inline field POSTing to
`.../summary`, painted optimistically; **Kill** arms-then-confirms; **Move** migrates (XERK-101).

### Send and Stop buttons

- **Send always sends, ◼ Stop is its own button**, in both chat and terminal — a mid-turn message
  QUEUES, so the button that talks must stay available while the agent works. Stop appears beside
  Send only while a turn runs.
- Stop interrupts (→ `POST .../interrupt`); unlike Kill, arms/confirms nothing and leaves the session
  on stage. **Enter always sends**, like the button.
- Stop's visibility reads `liveStatus` (the ~1s pane scrape), NOT the heartbeat's `paneBusy` — with
  the live socket down, `liveStatus` stays null and Stop stays hidden (a blind Stop is worse than none).
- A clicked Stop **hides immediately**; if the turn outlives `STOP_SUPPRESS_MS` the interrupt didn't
  take and Stop returns. A failed POST paints "Stop failed".
- **A pending `AskUserQuestion` hides Stop** — the answer is typed THROUGH the compose box (routed to
  `/answer`), and an accidental Stop would destroy the question (XERK-21). Tests: `chat.test.js`,
  `termComposeAction`/`termComposeStop` in `sessions.test.js`.

### The compose draft survives the view toggle (XERK-122)

- Chat and terminal panes each have a compose box, but a session has ONE draft: each toggle **moves**
  the text across, clearing the source. Carried AFTER the pane swap (`focus()` on a still-`hidden`
  textarea is a silent no-op); focus follows only a non-empty draft.
- **A compose box auto-grows to `scrollHeight`, but only while laid out** (XERK-149) — a hidden
  textarea reports `scrollHeight` 0, so an unguarded auto-grow during the toggle pins `height:0px`.
  `autoGrow`/`autoGrowTermInput` bail on `offsetParent === null`; the toggle re-grows on show. Tests:
  `sessions.test.js`.

### Copying out of the terminal

- A terminal-view copy reaches the viewer's real system clipboard via three independent links (the
  text survives app, tmux AND xterm.js, XERK-7).
- Selecting needs a **modifier** (the Claude TUI holds mouse tracking): **Shift** everywhere except
  macOS, where xterm.js honours **Alt** only with `macOptionClickForcesSelection` on (which
  `_launch_ttyd` sets — cost: Mac's Alt+drag column-select). ttyd then copies the selection itself.
- **Every other copy travels as OSC 52**, needing all three of: `agent/tmux.conf`'s `Ms` capability
  (tmux emits OSC 52 only if the OUTER terminal advertises it); `set-clipboard on` (default `external`
  forwards no application OSC 52); and the hub injecting xterm.js's missing OSC 52 handler
  (`TERM_OSC52_JS`).
- The bridge is **write-only** — an OSC 52 READ (`?`) is never answered (else any pane program reads
  the clipboard). Splits at the FIRST `;` (an app sends `52;c;<b64>`, tmux `52;;<b64>`, both must
  land). Tests: `server.test.js`, `test_launch_ttyd_lets_a_mac_force_a_selection` in
  `test_hub_agent.py`.

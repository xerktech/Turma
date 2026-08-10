---
paths:
  - "turma/**"
---

# `turma/` — central dashboard

Reached over the Cloudflare tunnel (the operator's public hub URL); port 8300 on the LAN. Read
`CLAUDE.md` first — the session model and cross-cutting contracts (notably **Web ⇄ Android parity**,
which makes an `android/` change part of the same PR) live there.

## Shared site chrome (`turma/public/nav.js`)

- The header and phone bottom-nav are built by one module (`nav.js`, dual-exported for tests) and
  are **identical on every page** — pages hand-roll neither. Each mounts them with `<header
  class="site-header" id="siteHeader" data-page="…" data-sub="…">` + `<nav class="bottom-nav"
  id="bottomNav">` and one `<script src="/nav.js">`; `data-page` lights that page's tab in both
  navs.
- Page-specific content goes in the two slots the page fills — `#hdrSub` (static) and `#hdrMeta`
  (dynamic). An unfilled slot collapses. The row **ends at the tabs**.
- Two more slots after the spacer are **filled by shared modules, not by any page**, and collapse
  when empty: **`#hdrNewTicket`** (`newticket.js`'s "New ticket" button + create modal; collapses
  until an org reports) and **`#hdrOrg`** (`org.js`'s fleet-wide org filter; collapses when no host
  reports a tracker org). Both live in the chrome so they're on every page at once.
- The header is full-bleed and `.site-header-in` caps its row at `--wrap` and centres it, so every
  page's chrome lands in the same column as a `.wrap` page's content. On `sessions.html` the
  two-pane `.sess-shell` below is capped at `--wrap` and centred too (XERK-28); the cap is inert
  below `--wrap`, so the phone layout is unchanged.
- Because that row is **centred**, `app.css` reserves the scrollbar gutter globally (`html {
  scrollbar-gutter: stable }`) — else the always-scrolling dashboard centres 15px narrower than the
  others. The gap under the header is a **margin, not padding**, so it collapses with the first
  content's margin. Mounted synchronously at the bottom of `<body>`, after both placeholders exist,
  before the page's script reads the slots.
- **`TurmaNav.preserveScroll(container, paint)` is the one wrapper every recurring innerHTML repaint
  must go through** (XERK-35), else the ~1s beat throws the window scroll and any inner
  `overflow:auto` region back to the start every second. It snapshots the window scroll plus every
  scrolled descendant of `container`, runs `paint()`, then restores them synchronously. Scrolled
  nodes re-match by a stable `id` anchor if in scope (so a REORDERED list maps its scroll to the
  right row), else by structural child-index path. Callers: `board.html`, `index.html`,
  `usage.html`.
  - Two recurring repaints keep their OWN bespoke logic and must NOT route through it: `chat.js`'s
    transcript `repaint` (stick-to-bottom vs hold-place + selection-guard), and `sessions.html`'s
    sidebar (its `scrollTop` restore is ordered against a focus/caret restore that can itself
    scroll). New recurring repaints without such a special case should use `preserveScroll`.
- **Any new shared `/*.js` must be in `server.js`'s `STATIC_ASSETS`** (an allowlist, not a directory
  serve) AND loaded by each page after `org.js` — a missing entry 404s and takes the module, and
  every page's render, down. Guarded by `newticket.test.js`.
- Tests: `nav.test.js`.

## The org filter (`turma/public/org.js`, XERK-62)

- **One org-scoping control, in the header, obeyed by all four pages.** A host polls exactly ONE
  org, so an org **partitions the fleet** — one selection filters tickets, hosts, sessions, usage.
- **Multi-select (XERK-222): the value is a SET of full `siteKey`s**, never display org names; empty
  = every org. Menu rows are checkbox toggles that stay highlighted while selected and keep the menu
  open; "All orgs" clears and closes. Persisted in `turma-org` as JSON (a pre-multi bare siteKey or
  the legacy `turma-board-org` reads as a one-org selection), re-read on `storage` so two tabs
  agree. `getKeys()` is the effective selection, `get()` only when exactly one applies.
- Each page: `TurmaOrg.update(data)` each beat, `TurmaOrg.filter(data.agents)` to scope what it
  builds, `TurmaOrg.subscribe(...)` to repaint on a change, `TurmaOrg.sse(es)` to take the hub
  broadcasts off the page's existing socket.
- Scoping applies to the **agent list**, once; everything downstream follows. Deliberately NOT
  applied to `findSession`/`sessionHit` (an open session must not be torn off the stage when its org
  leaves the sidebar) nor to pending-command reconciliation, which runs against the WHOLE fleet. A
  host with **no tracker block belongs to no org**: it shows only under "All orgs".
- **A pick for an org nobody reports doesn't apply, but is kept** (`effectiveKeys`, per key): else
  an org whose last host was removed leaves every page filtered to nothing with no chip to clear it;
  it resumes when the host returns.
- The per-org **auto-start switch (XERK-41) rides the menu's org rows** — `org.js` owns its
  optimistic flip, POST and rollback.
- Repaints are **skipped when the markup is unchanged**, so the beat can't churn the DOM under an
  open menu. Clicks are delegated; a handled click is flagged **on the event** — the repaint
  detaches the clicked node, so a `contains()` click-away test would close the menu on the click
  that opened it.
- It reads `board.js`'s org vocabulary, so **every page loads `board.js`** (order: board → nav →
  org).
- Tests: `turma/tests/org.test.js`.

## Dashboard (`index.html`)

### Fleet tree (host → repo → session)

- Each host row reads **`<hostname> - <org>`** — the org whose Jira it polls, from its `jira`
  block's `siteKey` via `TurmaBoard.orgName` (why the dashboard loads `board.js`).
- Each host has a **"Clone from GitHub" bar**: a dropdown of its `gh` login's repos (present ones
  disabled) plus a free-text `owner/repo` box, greyed out on hosts reporting no GitHub creds. With
  more than one git source the bar groups per source and reads "Clone a repo" (XERK-155).
- Each host expands into a top **⌂ Repos root** entry (no worktree/branch, so its composer hides the
  base-branch field, and "+ New session" goes once a root session runs), then its repos by
  `lastActivity`.
- A hub without FCM banners "mobile push is off" (`#pushWarn`) on `pushEnabled === false` — strict,
  so an older hub never false-alarms.

### Per-repo controls

- **"+ New session"** — one click, an instant bare spawn on today's defaults.
- A **▾ caret** opens a "New session" composer: task prompt, label and spawn options (base branch,
  model, permission mode), last-used remembered per repo in `localStorage`. It offers the same
  probed model list as chat (`modelChoices`).
- A **"Resume" picker** when the repo has resumable history (`repo.resumable`): any prior Claude
  session for the repo, resumed by transcript id via `POST
  /api/agents/<host>/transcripts/<transcriptId>/resume`, falling back to the last-5 killed
  `closedSessions` for older agents.
- An arm/confirm **"Prune"** sweeping that repo's worktrees + local branches merged into the latest
  default, leaving anything unmerged or dirty.

### Session cards

- Working/idle/waiting-on-question state, the worktree name, the agent's live branch (or
  "detached"), per-session token usage, and any **PR status** the session opened as the
  merge-readiness pill from `session.prs` (`prBadgeHtml`).
- Per-session **Attach / Restart (clear context) / Kill / Start / Delete**.

### Spawn/resume handoff

- **Starting or resuming a session hands off to the Sessions page and opens it there.** The id
  doesn't exist yet at POST time (the agent mints it), so `spawn()`/`resume_transcript()` echo the
  hub's queued-command id onto the record (reported as `session.spawnCmdId`), the POST's `{ok,
  cmdId}` reply is handed to `/sessions?spawn=<cmdId>`, and that page waits for the session
  reporting that `spawnCmdId` and selects it (`followSpawn`/`tryPendingSelect`). Resuming a
  **killed** session keeps its id, so that path deep-links `/sessions?session=<id>` directly.
- Both waits are one-shot, show a "Starting your session…" stage, expire after `SPAWN_FOLLOW_MS`,
  and cancel the moment the operator picks a session by hand.
- A third deep link, **`/sessions?ended=<transcriptId>`**, opens an ENDED session's read-only view
  (what the board's ticket chips use for anything not running), resolved through
  `findEndedByTranscript` → `openEndedSession`. It is **bounded** (`ENDED_FOLLOW_MS`) and cannot be
  folded into `?session=`, whose wait only resolves a **running** session.
- Tests: `sessions.test.js`, `TestHandleCommands`.

## History page (`/history`)

- Charts persistent daily/all-time cost from the agents' `repoUsage`/`usage` aggregates — not the
  live session list, so killed/deleted/pruned work still counts. **By repo** unifies a repo's usage
  across every host it runs on (matched by `remoteKey`); **By host** shows per-host totals.
- The usage page renders `(root)` as **Root**, folding older agents' `(other)`/`?` in
  (`normRepo`/`repoLabel`).
- Above the chart it shows the **Claude subscription's 5h/7d windows** (XERK-247) from each agent's
  `limits` block — pure carriage, hub-side: the numbers exist only inside Claude Code (see
  `.claude/rules/agent-usage.md` for how they're captured).
  - Every card is a **SNAPSHOT, and says so**: it carries "captured <age> ago" (amber past
    `LIMIT_STALE_SEC`), because a host only refreshes while it's working. Wording is "captured", not
    "updated" — the header's fleet-wide last-refreshed stamp was removed, and `nav.test.js` guards
    the page against re-growing one.
  - **A window whose `resetsAt` has passed renders as `—`, not as its last percentage**
    (`limitWindowView`'s `expired`): that window has since rolled over, so the stored figure
    describes one that no longer exists. The bar colours by headroom (75% warn, 90% crit).
  - A host reporting no window at all gets **no card** — an older agent, a non-subscription login and
    an unprobed host all mean "can't tell you", never 0% used. The section renders before the
    chart's empty-state returns, so headroom shows on a fleet that has charted nothing.
  - Tests: `usage.test.js`, the `limits` heartbeat case in `server.test.js`.

## Board page (`/board`)

See `.claude/rules/turma-board.md` — the Kanban, ticket detail panel, row pickers, ticket sessions,
auto-start/auto-stop and the two tracker writes.

## Sessions page (`/sessions`)

- Opens a running session in a **native chat view by default** (`turma/public/chat.js`) instead of
  the raw ttyd terminal, streaming over the `/live/<host>/<id>` WebSocket (ws-token auth, seeded
  from the heartbeat's cached tail, scrollback from `GET .../history`, `/history`-poll fallback when
  the socket is down).
- It renders chat bubbles — **user right, agent left** — with collapsible tool-action cards
  (tool_use + its paired tool_result, error-styled) and collapsed thinking traces, the in-progress
  turn typing in via a typewriter reveal (ported from glasses
  `live.ts`/`transcript.ts`/`reveal.ts`).
  - The live turn is the tmux **pane scrape's "last ● bullet"**, NOT monotonic (XERK-19): it SWAPS
    blocks mid-turn, so every `turn` frame is CLASSIFIED by `applyTurn` before the reveal and the
    streaming bubble is only for in-progress **prose** — an empty frame or a tool-use bullet
    (`isToolBullet`, biased toward matching since a miss brings the flicker back) CLEARS it, the
    same prose block keeps the LONGER text and never shrinks (`reveal.shown`), a different one
    retypes from 0 — standing in for glasses `advanceReveal`'s entryId snap, since the scrape has no
    id. `repaint`'s prefix check is a defensive clamp. Tests: `chat-selection.test.js`.
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

### The model and mode chips

- The compose footer's agent-mode / model selectors are joined by a compact **PR status chip**
  (`prFooterChip`) when it has one, and a `jira-chip` when the session has a ticket.
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
  /api/agents/<host>/sessions/<id>/subagents/history?type=&label=`, reusing the archive viewer +
  chat engine), with **Back** returning to the live session.
- Tests: `agentsHtml` in `chat.test.js`, the subagent-history cases in `server.test.js`.

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

## Durable archive

- The hub hosts a **durable, searchable archive of ended sessions** (`turma/archive.js`): agents
  push each inactive transcript in, landing as **organized files on `/data`** — one folder per repo,
  each renamed + dated `/data/archive/<repo>/<YYYY-MM-DD>__<summary>__<host>__<shortId>.jsonl` (+ a
  `.meta` sidecar), indexed in a **`node:sqlite` FTS5** DB (`/data/archive/index.db`, Node-core, no
  npm), rebuildable from the files.
- The Sessions page gains a search box (`GET /api/search?q=` — hub-local full-text search, ranked,
  `<mark>`-highlighted, grouped by `remoteKey`, working for offline hosts) and an "Ended sessions"
  browser (`GET /api/archive`); a result opens read-only (`GET /api/archive/<transcriptId>`). Ingest
  is agent-token-authed; the manifest cursors ride the heartbeat reply.
- Tests: `archive.test.js`, `server.test.js`.

## `POST /api/trigger` — external automation

- Starts a session from a single JSON body — `{hostname, repo, prompt}` all **required**, plus
  optional `label`/`baseRef`/`model`/`permissionMode`. Validates host and repo (against the host's
  reported `repos[]`, incl. `(root)`) before queuing the same `{type:"spawn"}` command the composer
  uses.
- Unlike `POST /api/agents/<host>/sessions` (user-auth only, repo-in-URL, prompt optional), it's
  gated by `triggerAuthorized`: a dedicated **`TURMA_TRIGGER_TOKEN`** bearer token OR the ordinary
  user login; with the token env unset it accepts the user login but no token caller. Tests: the
  `/api/trigger` cases in `server.test.js`.

## Notifications

- The hub pushes edge-triggered alerts to the **Android client via FCM**, the sole transport: host
  offline/recovered, restart loop, per-session ready-for-review / question waiting, Claude login
  required/expiring/restored.
- **A session gets ONE alert per piece of work** (XERK-224): "is ready for review", fired when it
  enters the Sessions page's Ready-for-review group (`readyForReview`, the hub's mirror of the
  page's rule) and replacing the separate "finished its turn" and "created a PR" notices; retracted
  `review:<host>:<id>` when it leaves. Tags `mag` → Android's `CH_TURN` (renamed "Ready for review",
  id kept so the operator's channel settings survive).
  - Fires only on something NEW — a turn that just finished (`sa.reviewAt`) or a PR that just
    settled (`sa.prNotes`) — so a session already sitting there at boot is not re-announced. A
    pending question **suppresses** it: the question alert is already that session's buzz, and says
    more.
  - **A PR still waiting on CI HOLDS it** (XERK-153) — never fire on the URL being scraped. A new
    URL enters a per-session wait list (`alerts.sessions[id].prWait`) that `prAlertDecision`
    re-judges each beat; a settled verdict banks on `prNotes` and is spent by the one alert, whose
    body names each PR and its verdict. `prSeen` keeps its old meaning (already alerted), so an
    older hub's PRs don't re-fire on upgrade.
  - **But the hold is read off `session.prs`, never that list alone**, which only the per-beat
    `newPrUrls` scrape fills: a PR scraped before this hub booted, or announced once and then worked
    on again, leaves it empty while still open.
  - `prAlertDecision`'s doc comment is the verdict table; four rules there must not be undone. **A
    CONFLICTING open PR never alerts** (XERK-223) — it merges nowhere however green its CI is, so
    the hold outlasts the age-out and reaches this alert too; the session still LISTS under Ready
    for review, and XERK-223's nudge is what clears it. **`failing` stays quiet permanently** (the
    alert is for the work being ready, not every trip through red). **Absent `checks` is "not
    fetched yet", never "no CI"** — a just-opened PR reads like a CI-less one while GitHub registers
    its workflows, so `checks: null` holds `PR_NO_CI_GRACE_MS` first. An inconclusive wait **ages
    out and fires anyway**: it may delay an alert, never lose it.
- **Claude login alerts** (XERK-98) fire in `heartbeatAlerts` off the agent's `claudeAuth` block:
  two edge-triggered states (chipped by `claudeAuthBadge`), deduped under `next.alerts` and cleared
  on recovery — `needsLogin` → urgent `key`-tagged "Claude login required", `expiringSoon` →
  default-priority "Claude login expiring". The hard state supersedes the soft (`claudeExpiringAt`
  dropped when `needsLogin`), so a lapse-then-recover fires only "restored". `key` routes to Android
  `CH_HOST`.
- Every alert funnels through one `notify()` (`turma/server.js`), fanning out via `turma/push.js`
  (FCM HTTP v1, service-account JWT minted with `node:crypto`, no npm — enabled by
  `FCM_SERVICE_ACCOUNT_JSON`) and carrying `tags`/`priority`/`click`/`route:{host,sessionId}` as
  message data, so the client picks a channel and deep-links a tap. A no-op with no device
  registered or FCM off. Devices register via `POST /api/devices` (user-authed,
  `/data/devices.json`), unregister via `DELETE /api/devices?token=`; dead tokens are pruned on
  send.
- **An addressed alert is retracted from the phone** (XERK-154): every session alert posts under a
  stable `notifKey` (`question:<host>:<id>`, `review:<host>:<id>`); `dismiss(notifKey)` sends a
  title-less `{action:"dismiss", notifKey}` FCM message (no-op with no device / FCM off), fired once
  per addressed edge. **Capability-gated** to devices declaring `features:["dismiss"]` — an older
  build renders a data-only message as a blank notification, so it keeps the stale alert;
  `DeviceRequest.features` is **required**, since `encodeDefaults=false` drops a defaulted value and
  the hub would retract nothing.
- **Push health is VISIBLE, not just logged** (XERK-152): a hub without `FCM_SERVICE_ACCOUNT_JSON`
  silently delivers ZERO mobile notifications, so `buildAgentsCache` reports hub-wide
  **`pushEnabled` = `push.fcmEnabled()`** on `/api/agents`. The key is deployment config, not in
  this repo.
- Tests: `push.test.js`, `prAlertDecision`/`readyForReview`/`XERK-154`/`pushEnabled` in
  `server.test.js`.

## Auth and the glasses surface

- UI, API, and the click-to-attach live terminal (`/term/<sessionId>/`, reverse-tunneled to that
  session's ttyd by port) sit behind single-user HTTP Basic auth (`TURMA_USER`/`TURMA_PASSWORD`).
  Agents authenticate heartbeats, tunnel WebSockets, and ttyd with one shared token (`TURMA_TOKEN`
  in the agent's env = `TURMA_AGENT_TOKEN` on the hub).
- The hub also serves the `glasses/` client: a CORS'd `/api/*` surface for that cross-origin
  WebView; per-session `input`/`history` endpoints; `GET /api/ws-token` for short-lived WebSocket
  auth; an `/audio` STT WebSocket (G2-mic PCM to the LiteLLM instance's transcription endpoint); and
  a `/live/<host>/<sessionId>` **live-transcript WebSocket** (ws-token auth) — the hub asks the
  host's tunnel-agent to `watch` the session, seeds it with the cached tail, fans the
  `{tail,entries}` deltas out, and `unwatch`es when the last viewer disconnects (re-arming on
  control reconnect).

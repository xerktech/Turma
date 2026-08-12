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
  `limits` block — the numbers exist only inside Claude Code (see `.claude/rules/agent-usage.md` for
  how they're captured).
  - **`normalizeLimits` coerces the block at ingest**, like the per-model usage lists beside it and
    for the same reason: it fans out to web, Android and glasses, and Android decodes it into TYPED
    fields, so a `usedPct` of `"lots"` from one buggy host would fail the decode of the WHOLE fleet
    payload rather than just its own card.
  - **A card is dropped past `LIMIT_MAX_AGE_SEC`, not just coloured** — the agent applies the same
    rule before reporting, but the hub keeps an OFFLINE host's last heartbeat for days, so without
    the client-side mirror a dead host shows a frozen 5-hour window that has since reset many times.
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

See `.claude/rules/turma-sessions.md` — the native chat view, the model/mode chips, the
working-status bar, ready-for-review, ended sessions, the composer and the terminal.

## Memory ceilings (XERK-258)

- **Every memory ceiling is DERIVED from the container's memory limit** (`detectMemoryLimit`: cgroup
  v2 then v1, `HUB_MEM_LIMIT_BYTES` to override), never a flat constant. The hub is deployed with a
  `mem_limit` far below the sum of the constants it used to carry — a 32 MiB per-beat cap with no
  concurrency bound, and a 128 MiB pending-upload ceiling, inside 256m. **A ceiling above the limit
  the kernel kills on is not a ceiling**, and the kill takes every host's control plane with it.
- **A per-request cap cannot bound concurrency, so there are two in-flight ceilings**, both reserved
  against BEFORE a body is read (`bodyBudget`, reserving off `Content-Length` and re-reserving as
  bytes actually arrive, so a chunked or under-declared body is bounded too):
  - `BODY_INFLIGHT_MAX` (an eighth of the container) over **charged** bytes — each body's first
    `BODY_MAX` is free, so one host's multi-MiB `/history` delivery can't 503 the whole fleet's
    ordinary beats.
  - `BODY_INFLIGHT_TOTAL_MAX` (a quarter) over **every** in-flight byte. The free floor needs its own
    ceiling or it is a hole the size of the first bug: many small bodies OOM-killed the hub exactly
    as two 30 MiB beats did.
- **A read alone in flight is always admitted to its own route cap.** `MIGRATE_BLOB_MAX` (65 MiB)
  exceeds the budget at the deployed limit, and refusing a lone request the hub is sized for would be
  an outage of our own making — concurrency is what the ceilings bound.
- **`release()` must run on every exit path**, which is why it is idempotent and guarded on `close`
  as well as `error`/`end`: a leaked reservation is never recovered, and enough of them refuse every
  large body for the life of the process.
- **A body's bytes understate what it costs to hold** — a 30 MiB JSON beat measured ~93 MiB above
  idle (accumulated string, then the parsed object graph). That factor is why the fractions are
  eighths and quarters rather than halves; measurements are in the PR for XERK-258.
- `readBody` decodes through a `StringDecoder`, not `data += chunk`: a UTF-8 sequence split across
  chunks became replacement bytes, silently corrupting transcript text hundreds of times in a
  multi-MiB beat.
- Tests: the `XERK-258` cases in `server.test.js` (each one pinned by mutation — removing the budget,
  the decoder or the derivation fails them).

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
  - **That socket is HELD across a host's control-channel flap, never closed** — it is what lets the
    client keep the conversation on screen and heal in place (XERK-252, `turma-sessions.md`). The
    client's half of the contract is that ONE viewer keeps ONE socket, so "last viewer gone →
    `unwatch`" still fires and the agent stops tailing.
  - `GET /api/agents/<host>/sessions/<id>/subagents/history` answers **202 while it fetches**, and
    the client polls that; a 202 is "not yet", never "none".

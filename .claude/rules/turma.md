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
- **"Delegated to sub-agents"** (`subagentCard`, XERK-302) names the share of those figures spent by
  background agents. It is a slice of every other number on the page and says so — a reader who adds
  it back double-counts.
  - **The share's denominator is `subagentOf`, not the fleet total**: only the spend that came with a
    split contributes to it, so one older host can't dilute the answer. A host reporting none is left
    out entirely, and with no series reporting one the card shows no percentage at all.
  - **`subagentOf` accumulates per CONTRIBUTION, not per series**, and the coverage caveat is
    measured in SPEND for the same reason: a series merges every host that ran that repo, so a
    series-level check reads full coverage on a series three quarters of whose tokens came from a
    host that can't answer.
  - Android's `SubagentLine` is the one-line rendering of the same three windows.
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
  Agents authenticate heartbeats, tunnel WebSockets, and ttyd with a **per-host** token —
  `TURMA_TOKEN` in the agent's env, `hostAgentToken()` = `<base64url(device)>.<HMAC(master, device)>`
  on the hub. See `CLAUDE.md`'s cross-cutting contracts for the rule; the mechanics:
  - The hub keeps only the master and **re-derives** the expected value for whatever host a request
    names, so adding a host needs no hub-side list and no restart. Print one with `node
    turma/server.js --agent-token <device>`. The name is IN the token, so a **host rename
    invalidates it** — deliberate, since the hub cannot tell a rename from an impersonation.
  - `agentBearerKind(req, host)` is the single resolver → `proved` (that host's derived token) /
    `operator` (the user login, allowed to name any host — it already drives them all) / `legacy`
    (the raw master, refused under `TURMA_AGENT_STRICT`) / null. `agentHostRefusal` turns it into
    the response. **Never settle for `agentAuthorized` where a host is in hand**: it answers "an
    agent", not "which".
  - The heartbeat is the one surface bound in its HANDLER, not at the route gate, since `device` is
    in the body. `agentPresented` is the gate: it says the credential is one the hub ISSUED, without
    saying which host, and **must keep refusing an unknown bearer** — it stands in front of a 32 MiB
    `readBody`, so admitting any `Bearer <anything>` is an unauthenticated remote OOM of the hub,
    and with it the whole fleet's control plane. **`TURMA_AGENT_STRICT` has to bite HERE too**, not
    only at the authorization check past it, or a leaked master still OOMs a fleet whose whole point
    was that the master had been retired. `agentPresentedRefusal` words that 403 without a host,
    since the host is still unread behind the gate.
  - **A wrong-host token answers 403 naming both hosts, not a bare 401.** The overwhelmingly likely
    cause is a host RENAME (the name is inside the token, so the credential silently stops matching);
    it leaks nothing, since the token names its own host on its face. `hub-agent.py` logs the hub's
    `{error}` body via `_http_error_detail` — the status line alone cannot say any of this.
  - `controlChannels`/`pendingChannels` are **null-prototype**: their keys come off the wire, and on
    a plain object a `ch` of `__proto__` read back as `Object.prototype` — truthy, so it passed the
    "is there a pending channel" check and killed the hub on the next property access.
  - `ttydAuth(host)` sends the token that host's ttyd is actually running (`tokenBound` on the
    record, from how its own heartbeat authenticated), so a half-rolled fleet keeps every terminal
    working. It is hub-derived and **stripped from the fleet payload** — putting it on the wire
    would make it a client contract.
  - Tests: the `XERK-268:` cases in `server.test.js`.

### The agent registry's ceiling (XERK-272)

- **`agents` is bounded as an AGGREGATE, not just per record.** `AGENT_RECORD_MAX` (8 MiB) bounds
  ONE record and `prune()` only reclaims at 7 days, so an unbounded NUMBER of `device` names was an
  unbounded amount of retained memory — 512 beats of 0.9 MiB under 512 names OOM-killed a 256 MiB
  hub, while the same 512 beats under ONE name peaked at 169 MiB.
  - **XERK-268 shrank who can do this; it did not bound it.** `device` is now PROVED by the
    credential, so this is no longer any-token-holder — but a compromised or buggy host still mints
    names under its own token, the `legacy` master a mid-rollover fleet accepts is not yet retired,
    and a host deriving its name from something unstable grows records with no attacker at all.
    Per-agent tokens and this cap are complementary, not alternatives.
- Two budgets, bounding different things: **`AGENTS_TOTAL_MAX`** (aggregate record bytes, defaulting
  to an eighth of the container's own cgroup limit, clamped 8–64 MiB) and **`AGENTS_MAX`** (record
  count, default 64). The count cap is not redundant — the byte budget measures what
  `agentRecordSize` measures, which EXCLUDES the on-demand caches, so it bounds their MULTIPLE and
  nothing bounds their SIZE. A ceiling above the limit the kernel kills on is not a ceiling: size it
  from the container, never pick a number.
- **A newcomer never displaces a host that is still around.** Past the cap a record is reclaimed
  only if it has been unseen for `AGENT_EVICT_IDLE_MS` (1h, ≫ `OFFLINE_AFTER_MS`) — a record holds
  an offline host's last known sessions, PR chips and usage, so a host rebooting or updating keeps
  its slot and the new `device` gets a 429 instead. Nothing is evicted when eviction could not
  satisfy the request anyway. The accepted cost is that a flood of names can squat slots and block
  onboarding a genuinely new host until it stops or `AGENTS_MAX` is raised.
- A host **already in the registry is always admitted** — turning the cap into a wall for the fleet's
  own hosts is the same outage from the other side.
- **The aggregate refuses only a host OVER its share** (`AGENT_FAIR_SHARE` = total/count, floored at
  64 KiB; 512 KiB deployed, against a measured largest-real-record of 0.30 MiB). Refusing a KNOWN
  host rolls it back to its previous record — `lastSeen` included — so a host refused every beat
  ages past `OFFLINE_AFTER_MS` and **reads offline while it is up**, indistinguishable from a
  network failure and invisible to the operator. A host inside its share is not why the registry is
  full, so it never pays; the refusal lands on the host the operator needs named. An OVER-share host
  is still refused silently — it freezes and ages to offline, or (if new) never appears at all, with
  only the throttled log to say why. That is the accepted cost, and the headroom is 1.7× the largest
  measured real record.
- **The cost of the exemption is a bounded overshoot, and the bound is an identity**: worst-case
  retained is `AGENTS_TOTAL_MAX + AGENTS_MAX × AGENT_FAIR_SHARE`. **So the share is DERIVED and
  never floored** — a floor makes the second term unbounded in `AGENTS_MAX`, and raising
  `AGENTS_MAX` is exactly what an operator with a growing fleet is told to do (at 2000 hosts a
  64 KiB floor was 3.9× the budget and OOM-killed the hub). **Raising the count means raising the
  budget with it**; a share under `AGENT_SHARE_SANE_MIN` warns at load rather than letting the two
  contradict silently. The flood path cannot reach the exemption at all — a new device is admitted
  only while the registry is inside the budget, so only an already-seated host can overshoot.
- **The state.json restore enforces the same budget** (`trimRestoredAgents`, keep-newest), and the
  file is **measured with `statSync` before it is opened** (`STATE_FILE_MAX`, container/4): the trim
  cannot protect a restore it never reaches, and `readFileSync` + `JSON.parse` of a flooded file
  killed the hub at init with no log line, every boot, forever. An oversized file is moved to
  `.oversized` and the hub boots empty — losing that cache is documented as harmless; not booting
  is not.
- **Every log line naming a host goes through `logName`** — `device` is agent-supplied and validated
  only for length and prototype keys, so a newline in it forged a line reading exactly like the
  hub's own. It strips C0, DEL **and C1** (`JSON.stringify` escapes none of the C1 block). All FIVE
  sites go through it: converting only the new ones left the two cheapest to reach — the 413, which
  is one request needing no registry pressure, and the unknown-field drop, which rides a 200.
  Refusal logs are throttled to one a minute with the suppressed count, because the flood the cap
  exists to survive is precisely the traffic that writes them.
- **A host is warned on the crossing into half its share** (`shareWarned`, the `recordSizeWarned`
  pattern). Without it the first signal is the host vanishing: the per-record ceiling's warning is at
  4 MiB and a share is 512 KiB, so a record drifts past its share — and starts being refused — with
  that warning still eight times away. This is what makes the eighth-of-the-container default safe;
  a record grows over weeks, which is ample notice provided somebody is told. If real records ever
  approach the share, raise `AGENTS_TOTAL_MAX` in the DockerOps compose beside `mem_limit` rather
  than moving the derived default for every deployment at once.
- Byte accounting is a side map (`recordBytes`), never a field on the record — anything on a record
  is served to every client — and `registryBytes()` re-measures unknown keys and forgets dead ones,
  so the many places that `delete agents[key]` need not remember it.
- New env knobs go through `positiveEnv`: a silently-obeyed negative cap refuses the whole fleet on
  its first beat, so a bad value is announced and ignored. The effective budget is printed at boot
  because it is DERIVED, not configured.
- Tests: `registry-cap.test.js` (small caps) and `registry-restore.test.js` (the restore, plus the
  DEGENERATE `AGENTS_MAX=2000` config — the overshoot bound only breaks when the derived share falls
  below what a floor would impose, which the small-cap rig never does). Each needs its own process
  because the caps are read at require time; `server.test.js` lifts `AGENTS_MAX` because ~100
  synthetic host names is not a fleet, so the cap's interaction with other routes lives only in
  those two files.
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

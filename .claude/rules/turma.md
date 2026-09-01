---
paths:
  - "turma/**"
---

# `turma/` — central dashboard

Reached over the Cloudflare tunnel (the operator's public hub URL); port 8300 on the LAN. Read
`CLAUDE.md` first — session model + cross-cutting contracts (notably **Web ⇄ Android parity**, which
makes an `android/` change part of the same PR) live there.

## Shared site chrome (`turma/public/nav.js`)

- One module (`nav.js`) builds the header + phone bottom-nav **identically on every page** — pages
  hand-roll neither. Mount: `<header class="site-header" id="siteHeader" data-page="…"
  data-sub="…">` + `<nav class="bottom-nav" id="bottomNav">` + `<script src="/nav.js">`; `data-page`
  lights that page's tab in both navs.
- Page content fills `#hdrSub` (static) / `#hdrMeta` (dynamic); an unfilled slot collapses. Two more
  slots are filled by SHARED modules, not pages, and collapse when empty: `#hdrNewTicket`
  (`newticket.js`) and `#hdrOrg` (`org.js`'s org filter).
- Header is full-bleed; `.site-header-in` caps its row at `--wrap` and centres it so every page's
  chrome lands in the same column as page content (`sessions.html`'s `.sess-shell` too, XERK-28).
  `app.css` reserves the scrollbar gutter globally (`scrollbar-gutter: stable`) so a centred,
  always-scrolling page doesn't sit 15px narrower than the others. The header-to-content gap is a
  **margin**, so it collapses with the first content margin; mounted synchronously at the bottom of
  `<body>`, before the page's script reads the slots.
- **`TurmaNav.preserveScroll(container, paint)` is the one wrapper every recurring innerHTML repaint
  must go through** (XERK-35) — else the ~1s beat throws window scroll and any inner `overflow:auto`
  region back to the start every second. It snapshots window + every scrolled descendant, runs
  `paint()`, restores synchronously; scrolled nodes re-match by stable `id` (a reordered list keeps
  its row's scroll) else by structural child-index. Callers: `board.html`, `index.html`, `usage.html`.
  - `chat.js`'s transcript repaint and `sessions.html`'s sidebar keep their OWN bespoke scroll logic
    and must NOT route through it (each has an ordering conflict with a caret/selection restore). New
    recurring repaints without such a conflict should use `preserveScroll`.
- **Any new shared `/*.js` must be in `server.js`'s `HASHED_ASSETS`** (an allowlist) AND loaded after
  `org.js` — a missing entry 404s and takes the module, and the page's render, down. Guarded by
  `newticket.test.js`.
- **Shared CSS/JS are served under a CONTENT-HASHED name, pages rewritten at boot to link it**
  (XERK-312) — else a warm browser pairs new HTML with the old stylesheet and the site renders
  unstyled after every deploy.
  - `HASHED_ASSETS` is the mutable set; `STATIC_ASSETS` serves both the hashed name (immutable, 1y)
    and the bare one — **the bare name must stay served, `no-cache`, never a TTL** (a cache holding a
    pre-deploy page still links it).
  - **A fingerprint a PREVIOUS release minted still serves the current body** (`supersededAsset`,
    cache `private`) — a 404 there is a fully unstyled page, worse than a stale sheet. A caller can
    mint 2^48 such URLs, so a shared cache must not retain one per guess.
  - **Asset routes answer HEAD as well as GET** — they're public, so a HEAD falling through to the
    auth gate 401s the very stylesheet the login page needs (what a CDN/uptime check sends).
  - `withHashedAssets` rewrites only `="/app.css"`-shaped attributes — prose mentions are untouched, a
    JS-built asset URL would be missed.
  - HTML shells also revalidate (`private, no-cache` + ETag → 304): a held shell keeps pointing at the
    previous release's hashed URLs otherwise. Every static asset carries an ETag and 304s on a
    conditional GET (`etagMatches` handles weak/list/`*` forms). Tests: `assets.test.js`.
- Tests: `nav.test.js`.

## The org filter (`turma/public/org.js`, XERK-62)

- **One org-scoping control, in the header, obeyed by all four pages.** A host polls exactly ONE org,
  so an org partitions the fleet — one selection filters tickets, hosts, sessions, usage.
- **Multi-select (XERK-222): the value is a SET of full `siteKey`s**, never display names; empty =
  every org. Persisted in `turma-org` as JSON (legacy single-key formats still read), re-read on
  `storage` so tabs agree. `getKeys()` is the effective selection, `get()` only when exactly one
  applies.
- Each page: `TurmaOrg.update(data)` each beat, `.filter(data.agents)` to scope, `.subscribe(...)` to
  repaint on change, `.sse(es)` to take hub broadcasts off the page's socket.
- Scoping applies to the **agent list**, once. Deliberately NOT applied to `findSession`/`sessionHit`
  (an open session must not be torn off-stage when its org leaves the sidebar) nor to pending-command
  reconciliation (runs against the whole fleet). A host with no tracker block belongs to no org, shown
  only under "All orgs".
- **A pick for an org nobody reports doesn't apply, but is kept** (`effectiveKeys`) — else an org
  whose last host was removed filters every page to nothing with no chip to clear; it resumes when
  the host returns.
- The per-org auto-start switch (XERK-41) rides the menu's org rows — `org.js` owns the flip/POST/
  rollback.
- Repaints skip when markup is unchanged (beat can't churn the DOM under an open menu). A handled
  click is flagged on the EVENT, not looked up after — the repaint detaches the clicked node, so a
  `contains()` click-away test would close the menu on the click that opened it.
- Reads `board.js`'s org vocabulary, so every page loads `board.js` (order: board → nav → org).
- Tests: `turma/tests/org.test.js`.

## Org binding and the peer roster (XERK-348)

Cross-component contract in `CLAUDE.md` ("The peer roster IS the org boundary"); this is the hub half.

- **`orgBound`** is the org the hub bound a host to on its first declaring beat (assigned after the
  payload spread, persisted, stripped from the served payload, reset only by `DELETE
  /api/agents/<host>`).
- **Drift is declaring a DIFFERENT org, never failing to declare one** — a host whose tracker goes
  quiet keeps its binding and its peers (treating silence as drift previously locked a host out of its
  own roster AND migration).
- **The migrate route is UNCHANGED by the binding: it compares the claimed org.** Do not bind-gate it
  — two attempts were reverted (comparing `orgBound` broke the UI both directions, since it's stripped
  from the served payload and no client can mirror it; refusing a drifted host bought almost nothing,
  one beat deep). **Neither closes the real hole**: two hosts that both declare NO org match each
  other regardless of binding — that, and the fix, are **XERK-349**. Pin any fix with a REQUEST
  against the route, not a copied predicate (that passed with the route reverted, twice) — and assert
  the exact status (a 503 from the shared in-flight cap is not the same as a 409).
- **THREE client mirrors of "an agent's org" exist**, not one: `org.js`'s `siteKeyOf`,
  `sessions.html`'s `siteKeyOfAgent` (what the Move menu uses), and Android's. Only the first mirrors
  the hub's coercion; `normalizeJira` server-side is what makes that safe.
- **`boundOrgOf`/`siteKeyOf` coerce to string** — `orgBound` is persisted, so an uncoerced value
  400'd every heartbeat from that host on restore, forever.
- **`orgPeers` bounds what it BUILDS, not what it returns** — building every row before slicing to
  `PEERS_MAX_ROWS` OOM-killed a 256 MiB hub; the per-cell cap (`PEER_CELL_MAX`) is separate — `rcName`/
  the spawn route's `label` are otherwise unbounded.
- `warnOrgDrift` de-dupes **by TIME** (`ORG_DRIFT_WARN_EVERY_MS`) — keying on the declared value OR a
  drifted flag both let an alternating host warn every beat. Interpolated keys capped at
  `ORG_KEY_LOG_MAX`.
- **Drift quarantine is self-healing**: the binding never moves, so a beat declaring the bound org
  again is served normally — don't reword this into "remove the host" as the only recovery.
- Tests: the `orgPeers`/`orgDrifted`/`migrate:` cases in `server.test.js`, `org.test.js`.

## Dashboard (`index.html`)

### Fleet tree (host → repo → session)

- Each host row reads `<hostname> - <org>` (`TurmaBoard.orgName`, why the dashboard loads `board.js`).
- A **"Clone from GitHub" bar**: dropdown of the `gh` login's repos (present ones disabled) + a
  free-text `owner/repo` box, greyed out with no GitHub creds; multiple git sources group per source
  (XERK-155).
- Each host expands into a top **⌂ Repos root** entry (no worktree/branch, composer hides base-branch,
  "+ New session" goes once a root session runs), then its repos by `lastActivity`.
- A hub without FCM banners "mobile push is off" on `pushEnabled === false` — strict, so an older hub
  never false-alarms.
- **A live-update event carries the agent record, never `retiredUsage`** (XERK-338); SSE-healthy pages
  skip the fallback poll, so the cached retired list only moves via two handlers: `removed`
  re-fetches (a removed host's spend MOVES from `agents` to `retiredUsage`, else it vanishes off the
  token tiles); `applyAgent` drops that key from cached `retiredUsage` (a returning host would
  otherwise double-count). Both coalesced per open tab. Tests: the live-update cases in
  `dashboard-tiles.test.js`, `usage.test.js`.
- **A background repaint the `<select>` guard skips is RE-ARMED** (`bgRender` + `flushSkippedRender`
  on `focusout`) — a full `#groups` swap would close a native popup mid-selection, and without the
  re-arm, hosts removed while SSE is healthy paint as still-present for the rest of the tab's life.
  Any new background update must go through `bgRender`, never `render`.
  - **The flush WAITS OUT A MOUSE PRESS** (`pointerDown`, released on `pointerup`/`pointercancel`/
    `click`) — `focusout` fires on mousedown, so flushing there before mouseup lands `#groups`'s swap
    between the two events and the browser dispatches NO `click` at all, silently eating the
    operator's first press on Start/Remove/etc. Tests: the `<select>` cases in
    `dashboard-tiles.test.js`.

### Per-repo controls

- **"+ New session"** — instant bare spawn on today's defaults.
- **▾ caret** opens a composer: task prompt, label, spawn options, last-used remembered per repo.
- **"Resume" picker** when `repo.resumable`: any prior session for the repo by transcript id (`POST
  .../transcripts/<id>/resume`), falling back to the last-5 killed `closedSessions` for older agents.
- **Prune** (arm/confirm): sweeps worktrees + local branches merged into latest default, leaving
  unmerged/dirty ones.

### Session cards

Working/idle/waiting-on-question state, worktree name, live branch (or "detached"), token usage, PR
merge-readiness pill (`prBadgeHtml`). Per-session Attach/Restart/Kill/Start/Delete.

### Spawn/resume handoff

- **Starting/resuming hands off to the Sessions page and opens it there.** The id doesn't exist at
  POST time, so `spawn()`/`resume_transcript()` echo the hub's queued-command id
  (`session.spawnCmdId`); the POST's `{ok,cmdId}` goes to `/sessions?spawn=<cmdId>`, which waits for
  that `spawnCmdId` and selects it. Resuming a **killed** session keeps its id, deep-linking
  `/sessions?session=<id>` directly.
- Both waits are one-shot, "Starting your session…", expire at `SPAWN_FOLLOW_MS`, cancel on manual
  pick. `/sessions?ended=<transcriptId>` opens an ENDED session read-only (bounded by
  `ENDED_FOLLOW_MS`, cannot fold into `?session=`, which only resolves a running one). Tests:
  `sessions.test.js`, `TestHandleCommands`.

## Usage page (`/usage`)

See `.claude/rules/turma-usage.md` — the token chart, ledger, sub-agent split, subscription-limit
cards, ingest coercions.

## Board page (`/board`)

See `.claude/rules/turma-board.md` — Kanban, ticket panel, row pickers, ticket sessions,
auto-start/stop, the two tracker writes.

## Sessions page (`/sessions`)

See `.claude/rules/turma-sessions.md` — native chat view, model/mode chips, working-status bar,
ready-for-review, ended sessions, composer, terminal.

## Durable archive

See `.claude/rules/turma-archive.md` (`turma/archive.js` + tests) — the two layers, size ceilings, how
the total is measured.

## `POST /api/trigger` — external automation

- Starts a session from `{hostname, repo, prompt}` (required) + optional
  `label`/`baseRef`/`model`/`permissionMode`. Validates host/repo against the host's reported
  `repos[]` before queuing the same `{type:"spawn"}` command the composer uses.
- Unlike `POST /api/agents/<host>/sessions` (user-auth only), gated by `triggerAuthorized`: a
  dedicated `TURMA_TRIGGER_TOKEN` bearer OR the ordinary user login; unset token env accepts the user
  login but no token caller. Tests: the `/api/trigger` cases in `server.test.js`.

## Notifications

- Hub pushes edge-triggered alerts to the Android client via **FCM**, the sole transport: host
  offline/recovered, restart loop, per-session ready-for-review/question, Claude login
  required/expiring/restored.
- **One alert per piece of work** (XERK-224): "ready for review" fires entering the Sessions page's
  Ready-for-review group (`readyForReview`), replacing the old separate turn/PR notices. Tags `mag` →
  Android's `CH_TURN` (renamed "Ready for review", id kept so channel settings survive); retracted
  when it leaves. Fires only on something NEW (a just-finished turn or just-settled PR); a pending
  question suppresses it (already that session's buzz).
  - **A PR still waiting on CI HOLDS the alert** (XERK-153) — never fire on the URL being scraped. A
    settled verdict is read off `session.prs`, never the per-beat scrape list alone (which empties on
    a PR scraped pre-boot or reopened later).
  - Four rules in `prAlertDecision`'s doc comment must not be undone: a **CONFLICTING** open PR never
    alerts (XERK-223 — merges nowhere however green); `failing` stays quiet permanently; absent
    `checks` is "not fetched yet" not "no CI" (`PR_NO_CI_GRACE_MS`); an inconclusive wait ages out and
    fires anyway (may delay, never lose).
- **Claude login alerts** (XERK-98): edge-triggered `needsLogin`/`expiringSoon` off `claudeAuth`,
  deduped, hard state supersedes soft (a lapse-then-recover fires only "restored"). Routes to Android
  `CH_HOST`.
- Every alert funnels through `notify()` → `turma/push.js` (FCM HTTP v1, service-account JWT via
  `node:crypto`, enabled by `FCM_SERVICE_ACCOUNT_JSON`), carrying `tags`/`priority`/`click`/
  `route:{host,sessionId}`. No-op with no device/FCM off. Devices register via `POST /api/devices`,
  unregister via `DELETE /api/devices?token=`; dead tokens pruned on send.
- **An addressed alert is retracted from the phone** (XERK-154): stable `notifKey`
  (`question:<host>:<id>`, `review:<host>:<id>`), `dismiss(notifKey)` sends a title-less FCM message,
  once per edge. **Capability-gated** to `features:["dismiss"]` — an older build renders a data-only
  message as a blank notification and keeps the stale alert.
- **Push health is VISIBLE, not just logged** (XERK-152): `pushEnabled = push.fcmEnabled()` on
  `/api/agents` (a hub with no `FCM_SERVICE_ACCOUNT_JSON` silently delivers zero notifications
  otherwise). Tests: `push.test.js`, `prAlertDecision`/`readyForReview`/`XERK-154`/`pushEnabled` in
  `server.test.js`.

## Terminal proxy (`/term/<sessionId>/`)

- ttyd runs with `-b /term/<id>` and answers the bare base path with a 302 to the slash form. **The
  hub adds that slash itself before proxying** rather than letting ttyd redirect — a hop that
  normalizes the slash away sends ttyd's redirect at itself (`ERR_TOO_MANY_REDIRECTS`); one
  cloudflared release did exactly that while agents stayed connected, so the symptom read as a Turma
  bug and was not one.
- Only the base path is rewritten (assets/WS below it never end in a slash). The slash is inserted
  into the ORIGINAL request target, only for origin-form requests, so the query survives byte-for-byte
  and an absolute-form/backslash target still 404s rather than resolving. Tests: the base-path cases
  in `server.test.js`.
- **Terminal scroll is unified at the TMUX layer, but routed by SCREEN MODEL — the two runtimes
  render into DIFFERENT screens, so one unconditional rule can't fit both.** Sessions run inside tmux,
  which repaints a fixed region (verified: xterm.js's `baseY` stays 0 through tmux). The runtimes
  differ: **Claude runs on the ALTERNATE screen** (`#{alternate_on}`=1, `history_size` 0) with its
  OWN scroll handler + SGR mouse; **qwen renders APPEND-ONLY on the MAIN screen**
  (`ui.useTerminalBuffer:false`, the flicker fix in `.claude/rules/qwen.md` [Qwen B]), so its history
  lives in TMUX's buffer. So the WHEEL must reach the APP for Claude but tmux copy-mode for qwen.
  - **`agent/tmux.conf` sets `mouse on` + rebinds `WheelUp/DownPane` CONDITIONALLY on
    `#{alternate_on}`** — `send -M` (forward to app) on the alt screen; `copy-mode -e` (tmux history,
    auto-exits at the live tail) on the main screen. Keyed on the screen model, NOT `agentType`, so
    it needs no runtime knowledge. **An UNCONDITIONAL copy-mode binding is a Claude REGRESSION** (QA
    caught it: steals Claude's wheel into an empty `[0/0]` copy-mode). Verified end-to-end in a real
    browser for both: Claude scrolls its own history, qwen scrolls tmux's; WheelDown off the bottom is
    a no-op.
  - **Trade-off:** `mouse on` means plain click-drag is tmux's copy-mode selection (copied out via the
    existing OSC52 bridge / `set-clipboard on`), not the browser's native selection. **Shift+drag**
    is the native-selection escape hatch (xterm.js honours it). Confirm OSC52 copy-out when touching
    this (QA confirmed both work).
  - **`proxyTerm` injects `TERM_SCROLL_BOTTOM` (a jump-to-bottom pill) on EVERY session** — one code
    path, no `agentType` gate (that gate + the `findSession`/`proxyTerm` `agentType` plumbing were
    removed). The pill dispatches wheel-DOWN on `.xterm`, which lands on whichever wheel path the
    screen model selects and drives it to the live bottom. It repeats bursts until the screen is
    unchanged for **STABLE consecutive polls** — a single read isn't enough: a redraw makes a full
    browser↔tunnel↔app/tmux round trip, so one poll can catch the pre-scroll frame and look "settled"
    when it isn't (a ~1/10 stop-short, worse over the tunnel). At a STREAMING live tail the busy
    footer animates every frame so the settle never trips; the busy-footer regex (unions Claude's
    "esc to interrupt" and qwen's "enter to steer"/"esc to cancel)") caps it rather than spinning to
    MAX.
  - **Android's `TerminalScreen` loads the same `/term/<id>/` WebView and tmux serves the same
    config**, so both reach it with no client change — server/agent plumbing, parity-exempt.
  - Tests: the `term:`/`scroll-to-bottom:` cases in `server.test.js` (mechanism-agnostic — model
    wheel-down + settle); the conditional tmux binding + real-browser pill (both screen models) are
    host-verified (no CI tmux).

## Auth and the glasses surface

- UI/API/terminal sit behind single-user HTTP Basic auth (`TURMA_USER`/`TURMA_PASSWORD`). Agents
  authenticate with a **per-host** token — `TURMA_TOKEN` in the agent env, `hostAgentToken()` =
  `<base64url(device)>.<HMAC(master, device)>` on the hub. See CLAUDE.md's cross-cutting contracts
  for the rule; the mechanics:
  - The hub keeps only the master and **re-derives** the expected value per host — no hub-side list,
    no restart to add a host (`node turma/server.js --agent-token <device>`). The name is IN the
    token, so a **host rename invalidates it** (the hub cannot tell a rename from an impersonation).
  - `agentBearerKind(req, host)` is the single resolver → `proved`/`operator`/`legacy` (refused under
    `TURMA_AGENT_STRICT`)/null; `agentHostRefusal` turns it into the response. **Never settle for
    `agentAuthorized` where a host is in hand** — it answers "an agent", not "which".
  - The heartbeat binds in its HANDLER, not the route gate (`device` is in the body). `agentPresented`
    must keep refusing an unknown bearer — it stands in front of a 32 MiB `readBody`, so admitting any
    bearer is an unauthenticated remote OOM of the whole control plane. **`TURMA_AGENT_STRICT` must
    bite HERE too**, or a leaked master still OOMs a fleet that thought it had retired it.
  - **A wrong-host token answers 403 naming both hosts, not a bare 401** — the likely cause is a host
    RENAME, and it leaks nothing (the token names its own host on its face).
  - `controlChannels`/`pendingChannels` are **null-prototype** — a wire key of `__proto__` on a plain
    object read back as `Object.prototype` (truthy), passing a pending-channel check and killing the
    hub on the next property access.
  - `ttydAuth(host)` sends the token that host's ttyd is ACTUALLY running (`tokenBound`), so a
    half-rolled fleet keeps every terminal working; hub-derived, stripped from the fleet payload.
  - Tests: the `XERK-268:` cases in `server.test.js`.

### The agent registry's ceiling (XERK-272)

- **`agents` is bounded as an AGGREGATE, not just per record.** `AGENT_RECORD_MAX` (8 MiB) bounds one
  record only; an unbounded NUMBER of `device` names is unbounded total memory. XERK-268 shrank who
  can mint names (credential-proved) but did not bound the count — a buggy host, a mid-rollover
  `legacy` master, or an unstable name-derivation can still grow records with no attacker.
- Two budgets: **`AGENTS_TOTAL_MAX`** (aggregate bytes, an eighth of the container's cgroup limit,
  clamped 8–64 MiB) and **`AGENTS_MAX`** (record count, default 64) — the byte budget excludes
  on-demand caches (XERK-235), so it bounds their MULTIPLE, not their size; the count cap covers that
  and **their SIZE is bounded separately** (XERK-292, below). **Size both from the container, never
  pick a number** — a ceiling above the kernel's own OOM limit isn't one.
- **The on-demand caches (`AGENT_CACHE_KEYS`) carry their OWN byte budget** (XERK-292): they are
  excluded from `agentRecordSize` so a legit ~6 MiB `/history` delivery never costs a heartbeat
  (XERK-235), which left them bounded only by COUNT (`HISTORY_MAX_SESSIONS` …) — one device name
  parking 8 oversized `historyResults` for their TTL OOM-killed a 256 MiB hub with no concurrency.
  - Two eviction bounds, container-sized like the registry: **`AGENT_CACHE_HOST_MAX`** (per host,
    floored ≥14 MiB — a staged 12 MiB delivery serializes with wrapper overhead to just over 12 MiB,
    so the floor clears it with headroom at every container size) and **`AGENT_CACHE_TOTAL_MAX`** (fleet-
    wide, container/8). Enforced by **eviction of the oldest-`fetchedAt` entry, NEVER by refusing a
    beat** — refusing would undo the XERK-235 exclusion. The just-delivered (freshest) entry survives;
    only run on a beat that actually delivered cache results.
  - **`serializeAgentsForSave` STRIPS `AGENT_CACHE_KEYS`** (same replacer as `agentRecordSize`): their
    ≤30-min TTL makes persisting them worthless, and leaving them in let `state.json` grow past
    `STATE_FILE_MAX` on one flooding host. A restart starts every cache empty; the heartbeat rebuilds.
  - Tests: `cache-budget.test.js`.
- **A newcomer never displaces a host that is still around.** Reclaimed only past
  `AGENT_EVICT_IDLE_MS` (1h) of silence; a host already IN the registry is always admitted (else the
  cap becomes a wall for the fleet's own hosts). Accepted cost: a name-flood can squat slots and block
  onboarding until it stops or `AGENTS_MAX` rises.
- **The aggregate refuses only a host OVER its share** (`AGENT_FAIR_SHARE` = total/count, floored at
  64 KiB). Refusing a KNOWN host rolls back to its previous record, so a host refused every beat reads
  offline while up — indistinguishable from a network failure. Accepted cost, with headroom over the
  largest measured real record.
- **Worst-case retained is `AGENTS_TOTAL_MAX + AGENTS_MAX × AGENT_FAIR_SHARE` — the share is DERIVED,
  never floored** (a floor makes that term unbounded in `AGENTS_MAX`; raising the count without
  raising the budget OOM-killed a hub at 2000 hosts). A share under `AGENT_SHARE_SANE_MIN` warns at
  load. The flood path cannot reach the exemption — only an already-seated host can overshoot.
- **`state.json` restore enforces the same budget** (`trimRestoredAgents`), and the file is
  **measured with `statSync` BEFORE it is opened** (`STATE_FILE_MAX`, container/4) — the trim can't
  protect a restore it never reaches, and an unbounded `readFileSync`+`JSON.parse` killed the hub at
  every boot with no log line. An oversized file moves to `.oversized`; booting empty is the accepted
  loss.
- **Every log line naming a host goes through `logName`** (strips C0/DEL/C1 — `JSON.stringify` escapes
  none of C1) — `device` is agent-supplied and otherwise unvalidated, so a newline in it forges a line
  reading as the hub's own. All FIVE call sites must go through it, not just the obvious ones.
  Refusal logs throttle to one/minute with a suppressed count.
- **A host is warned crossing half its share** (`shareWarned`) — the per-record warning fires too late
  (4 MiB vs a 512 KiB share) to give notice before a record starts being refused.
- Byte accounting is a side map (`recordBytes`), never a record field (anything on a record is served
  to every client); `registryBytes()` re-measures/forgets so deletion sites needn't remember it. New
  env knobs go through `positiveEnv` (a silent negative cap refuses the whole fleet). The effective
  budget prints at boot (it's derived, not configured).
- Tests: `registry-cap.test.js`, `registry-restore.test.js` (each its own process — caps read at
  require time); `server.test.js` lifts `AGENTS_MAX` for its ~100 synthetic hosts.
- The hub also serves the `glasses/` client: a CORS'd `/api/*`, per-session `input`/`history`, `GET
  /api/ws-token`, an `/audio` STT WebSocket, and a `/live/<host>/<sessionId>` live-transcript
  WebSocket (asks the host's tunnel-agent to `watch`, seeds the cached tail, fans deltas out,
  `unwatch`es on last-viewer-gone, re-arming on control reconnect).
  - **That socket is HELD across a host's control-channel flap, never closed** (XERK-252,
    `turma-sessions.md`) — lets the client keep the conversation on screen and heal in place.
  - `GET .../subagents/history` answers **202 while it fetches** — the client polls; 202 means "not
    yet", never "none".

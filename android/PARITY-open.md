# Android ⇄ Web UI parity — open gaps

Part of the parity tracker; `PARITY.md` is its entry point (map, deliberate differences,
Meetings tab).

## Open (subsequent installments), by screen and priority

Many of these need Android's wire model (`model/Models.kt`) to decode fields the web already renders;
those are marked `[MODEL]`.

### Dashboard (`index.html` → `FleetScreen`/`FleetDialogs`)

- **Add host dialog (XERK-2531) — web only.** The dashboard's "+ Add host" mints a one-time
  enrollment code (`POST /api/enroll-codes`), shows the copy-paste install/enroll commands, and
  lists/revokes recent codes. Android has no dialog yet; onboarding a host is a desk task (the
  commands are pasted into a terminal), and the hub routes need no client to work. No new
  `/api/agents` key, so nothing for Android to decode.
  - **Still web-only under tenancy (XERK-2553, deliberate).** A code mints into the minting user's
    tenant, so a tenant user adds a host from the web dashboard (or `turma-agentctl enroll --code`);
    the phone shows the host once it beats. A port is `POST/GET /api/enroll-codes` +
    `DELETE /api/enroll-codes/<id>` — no new `/api/agents` key.
- ~~P0 Session card detail~~ / ~~P0 queued/stopping + Cancel + optimistic pending~~ — done (XERK-78,
  see Done above). Still open from that pass: the spawn "ghost card" (a pending spawn shows only as
  the composer's toast today) — P2.
- P1 `[MODEL]` Host meta (memory, uptime/last-seen, repos-root, session counts), container-log toggle.
- P1 Host collapse persistence; Jira org label beside hostname; Remove-host for offline hosts.
- P1 Remove + revoke token (XERK-2383, WEB ONLY): `DELETE /api/agents/<host>?identity=revoke` behind a
  two-click button on any host card the hub marks `identityBound`, online included; Android has no Remove host at all yet.
- P1 Token binding (XERK-578, WEB ONLY for now): the host header shows a `⚠ shared token` chip on a
  host still on the fleet master (from the served `tokenBound`; a bound host shows no chip), and
  offers a **Roll token** button on a live, unbound host reporting the `tokenRoll` capability (rolls it onto its derived token, XERK-268/284). Both
  new fields ride `/api/agents`; Android does not type them yet, so `ignoreUnknownKeys` skips them
  (no decode risk). Mirror as a `FleetScreen` chip + a `FleetViewModel.rollToken` → `HubApi`
  `@POST("api/agents/{host}/roll-token")` trio (the same shape as `restartAgent`). A host can also
  self-enroll with no app at all (`turma-agentctl enroll` / `TURMA_AGENT_SELF_ENROLL=1`), so this is
  a convenience, not the only path.
  A mirror must handle the 409 `wouldBind` reply (XERK-2583): offer "Bind to my tenant + roll"
  (`?bind=1`) and "Roll only" (`?bind=0`) instead of showing it as a failure.
- ~~P1 Clone bar: collapse + search + multi-select + `🔒` private marker + clone-job status rows.~~
  Done (XERK-126, see Done below).
- P1 `[MODEL]` Repo blocks: branch/dirty meta (incl. XERK-1887 "git unreadable"), remote link, orphan repos, prune-note, empty state.
  - The prune-note now also covers a prune IN FLIGHT (XERK-256): the agent sweeps on a worker thread
    and reports `prunes[].status` as `queued`/`running` with a progress summary, which the web uses
    both for the note and to keep the Prune button spinning for the whole sweep (minutes on a big
    repo). Android's `prune()` fires and forgets, so its button releases immediately and the
    operator has no sign the sweep is still going. Decode `prunes[]` and mirror `repoBlock`'s rule:
    busy while `status` is `queued` or `running`.
- Repo Delete (XERK-2672) is at parity (XERK-2675): `core/RepoDelete.kt` holds the web's gating,
  busy and note rules; tests in `core/RepoDeleteTest.kt`.
- P1 Composer base-branch dropdown + per-repo option persistence.

### Sessions + Chat (`sessions.html` + `chat.js` → `SessionsScreen`/`ChatScreen`)
- **P1 Live-feed repair driven by DATA liveness (WEB ONLY for now).** The web chat no longer gates
  its `/history` fallback on `ws.readyState`: it reads the hub's new `{type:"watch", armed, reason}`
  ack, tracks when a frame last arrived, and — while the heartbeat reads the session busy — falls
  back to polling AND forces a reconnect once the feed has been silent for `LIVE_STALE_MS`
  (`liveDelivering` in `chat.js`; `.claude/rules/turma-sessions.md`). `LiveTail.kt` ignores the
  `watch` frame (its `when (frame.type)` skips unknown types, so there is no decode risk) and
  `ChatViewModel` still polls only around `LiveEvent.Connected(false)` — so an accepted-but-unarmed
  or silently-wedged socket leaves an Android chat frozen exactly as the web one used to be. Mirror:
  add `LiveEvent.Watch(armed, reason)`, and make the history poll's condition the same three-part
  read. The tail-frame SEED fix (the heartbeat preview carrying `blocks`) needed no Android change —
  `TailEntry.blocks` and `mergeTail`'s grow-only tie-break already consume it.
- **P1 Restore an archived session onto another agent (XERK-441).** The web archive viewer's bar has
  a "Restore…" button with a host picker: `POST /api/archive/<transcriptId>/restore {host}` packs the
  session's archived raw files hub-side and drives the same `importSession` a move does, so a session
  whose host has been REMOVED can be resumed elsewhere. Android's history/archive view has no such
  control, so on a phone an archived session is still read-only. The hub does all the work — the port
  is a button, an eligible-host list (online + has the repo, deliberately NOT org-scoped: an archived
  session has no agent left to compare an org against), and following the returned `migrationId`
  through the `migrations` payload exactly as the existing Move flow does. XERK-453 added a soft
  cross-org WARNING to the web picker (a `⚠ <org>` badge + a `confirm()` when the target's decided
  `org` differs from the archived row's served `siteKey`) — a heads-up, never a block; the port
  should carry it when the restore control is built.
- **P2 Say when a start was REFUSED (XERK-265, XERK-276).** Agents now report a declined resume/import
  on the heartbeat, and the hub serves it per cmdId as `agent.spawnRefusals[cmdId] = {error, at}`. The
  web ends its spawn-follow wait and toasts the reason ("Couldn't start session: the host is at
  MAX_SESSIONS (4)"); XERK-276 extended that to the KILLED-resume path too — the dashboard now carries
  the resume command's cmdId through the deep link (`/sessions?session=<id>&spawn=<cmdId>`) so a
  refused resume ends the by-id wait with the reason instead of spinning "Opening session…" forever.
  Android's Resume is fire-and-forget ("resume queued") and follows no cmdId, so a refusal there is
  still silent — the row simply never reappears, for BOTH the spawn and the killed-resume paths. The
  cheapest port is to keep the cmdId a resume POST answers with and surface a matching refusal as a
  snackbar.
- **P2 Local-model mark on session CARDS (XERK-246 remainder).** The two controls are done (see Done
  above); what's left is the web's 🏠 + warn-colour mark on live and ended session cards, so a
  glance at the list says which sessions are on the weaker model without opening each one. Read
  `session.modelSource == "local"`, titled with `modelSourceAt`. Both fields already decode onto
  `SessionInfo`.
- **P2 Trajectory generalized to claude/qwen (XERK-717, epic XERK-712).** Web now shows the
  Trajectory toggle for a claude/qwen session too — BESIDE "Terminal ▸" (not replacing it, since
  those runtimes keep their ttyd terminal), shown once the session has a `transcriptId`. It fetches
  the unified `GET /api/archive/<transcriptId>/trajectory` (runtime-dispatched, XERK-715) instead of
  the dsh-only `/api/dsh/...`, and `renderTrajectory` renders the XERK-712 SUPERSET
  (`docs/trajectory-contract.md`): per turn — the user message, model output blocks (text +
  thinking), tool-call rows WITH result snippets, per-turn + total tokens, model, duration; a
  `partial:true` (running) payload shows a "tokens after the session ends" note. dsh renders through
  the same code as its subset (missing fields absent). **Android is still on the dsh-only path**:
  `TrajectoryScreen`/`TrajectoryViewModel`/`HubApi.dshTrajectory` call `/api/dsh/<id>/trajectory` and
  only a dsh session exposes the action. To reach parity: switch the call to the unified archive
  endpoint, widen `DshTrajectory` (`TrajTurn`/`TrajCall`) to the superset fields (`user`, `output[]`,
  per-turn `model`, per-call `result`, `partial`, `runtime`), render user/output/result + the partial
  note, and offer the action for a claude/qwen session (beside Terminal, gated on a transcript id).
- **P3 host-wide "dsh web ↗" link in the dsh chat header (XERK-501).** The web shows a link to the
  host's single host-wide `dsh web` viewer for a dsh session whose host reports a reachable
  `dsh.web.url` (`AgentInfo.dsh.web = {running, port, url}`, hub-whitelisted; absent/`url:null` on a
  loopback-only host, so the link hides). Android's `DshInfo` does not yet type a `web` field (which
  is decode-SAFE — `ignoreUnknownKeys` skips it until typed); to reach parity, type `DshInfo.web:
  DshWebInfo?` and add an equivalent link/affordance on the dsh session/chat screen.
- **P3 per-host default runtime pre-select in the spawn composer (XERK-521).** A host reports its
  EFFECTIVE default runtime as top-level `AgentInfo.defaultRuntime` (`{claude,dsh,qwen}`, absent on
  an older agent → treat as claude; hub-coerced), and the web composer PRE-SELECTS it in the Runtime
  dropdown so a bare "+ New session" shows which runtime it will run on. The unpinned-spawn BEHAVIOUR
  is entirely agent-side (the claiming host applies its own default), so a session Android spawns
  without touching the runtime already runs on the host default with no app change — this gap is only
  the visual pre-select. `AgentInfo` does not type `defaultRuntime` yet (decode-SAFE —
  `ignoreUnknownKeys` skips it until typed); to reach parity, type `AgentInfo.defaultRuntime: String?`
  and default `SpawnDialog`'s runtime choice to it (falling back to claude when absent or not on
  offer), mirroring `sessions.html`'s `hostDefault`/`selRuntime`. **AND — the load-bearing half — an
  explicit "Claude Code"/"Claude Code Local" pick must SEND `agentType:"claude"` when the host default
  is non-claude** (the web does this in `startSession`): a claude/local spawn normally OMITS
  `agentType`, but an omitted `agentType` resolves to the host default agent-side, so on a
  non-claude-default host omitting it silently runs the default runtime. Build the pre-select WITHOUT
  this and Android reintroduces the exact XERK-521 defect an explicit claude pick is supposed to beat.
- **P2 To-do checklist card + the dsh "Deep diving…" verb (Enable DSH To-Dos).** The web renders a
  `TodoWrite` / dsh `todo_write` tool call as a CHECKLIST (state glyph per row + a `1 in progress ·
  6 pending` count on the summary) instead of raw-JSON input — `renderTodoCard` in `chat.js`, fed by
  the `todos` the agent attaches to the block (`toolUseDetail`). `core/ChatItems.kt` currently
  renders it as a plain tool card; the port is a checklist branch reading the same `todos`. Also:
  a generating dsh turn frame now carries a working `status` (`{verb:"Deep diving", noStop:true}` +
  an elapsed clock past 15s) so the web chat shows the verb; `noStop` keeps Stop hidden (a dsh turn
  has no pane-Escape interrupt). Android's chat working bar should read the same `status.verb`/
  `elapsed` and suppress its Stop control on `status.noStop`.
- ~~P2 dsh runtime badge on session CARDS (XERK-465 remainder).~~ Removed: the `⚙ dsh` session-card
  chip was dropped from every surface (web, Android) — see the Done section below.
- ~~P2 board ticket "Runtime" row (XERK-473 → XERK-477).~~ Done (XERK-477, see Done below): the board
  ticket detail sheet's fifth tap-to-change row, pinning which runtime a ticket's session spawns on.
- ~~P0 Jump-to-latest pill + stick-bottom scroll.~~ Done (XERK-78, see Done above).
- ~~P0 Ended sessions: stopped + `repo.resumable` channels + live-list exclusion.~~ Done (XERK-78,
  see Done above; the read-only review itself was XERK-70).
- ~~P0 Per-card ⋯ menu: Rename (inline) + arm/confirm Kill.~~ Done (XERK-71): each live session card
  carries a `MoreVert` menu (`SessionCardMenu`) — Rename swaps the card for an inline seeded field
  (`SessionRenameCard`, painted optimistically until the agent reports the name back or a TTL passes),
  Kill arms "Confirm kill" then confirms. `vm/FleetViewModel.kt` `setSummary`; `net/HubApi.kt`
  `setSummary`/`SummaryRequest`.
- P1 Sidebar sections: Ready for review / Active / Idle / Sleeping split done (XERK-73 + XERK-224
  + XERK-2704 Sleeping,
  `rankRunning` → `LiveGroups`); the dedicated Queued section done (XERK-78; the old Stopped group
  folded into Ended). Each live card now carries the web's colored state line, and a
  Ready-for-review card spells out why it qualified ("PR awaiting review" / "finished · awaiting
  review" / "awaiting your test").
- ~~P1 SendUserFile inline previews (XERK-221).~~ **Done**: the app now has an image pipeline (Coil +
  `SafeSvgDecoder` over AndroidSVG, sized like a browser's SVG `<img>`, wired via
  `TurmaApplication : ImageLoaderFactory`). `SendFile`/`files[]`/`caption` are on
  `ToolUseBlock` (decoded) → `ChatItem.Tool` (`ChatItemsTest`), and `TranscriptView` renders each file:
  an image/SVG via Coil `AsyncImage` (data: URIs decoded to a `DataImage` that keeps their declared
  type, so a `data:image/png` holding SVG markup is broken as on the web, XERK-2161; remote URLs
  pass through), an HTML page in a **JS-disabled, navigation-blocked, null-origin
  WebView** (the `sandbox` iframe's analogue), else a name chip — open by default, caption below, matching
  the web's `renderToolFiles`. **Click-to-zoom (XERK-221 lightbox):** tapping an image preview opens a
  full-screen viewer (`ImageLightbox`, pinch-zoom + pan, ✕ / back to close) — the analogue of
  `sessions.html`'s `#imgLightbox`. It covers inline prose images too (next bullet), as on the web.
- ~~P1 Inline images in **PROSE** (the OTHER half of XERK-221).~~ **Done (XERK-1932)**: a markdown
  `![alt](url)` (http(s) or `data:image/*`) parses to `Span.Image` and a line-start raw `<svg>…</svg>`
  or an all-SVG fence to `ProseBlock.Svg` (`core/Prose.kt`, mirroring `chat.js`
  `linkify`/`renderSvgAndText`/`SVG_FENCE`). `ProseInline` splits a paragraph / heading / list row /
  table cell around each image (`splitImages`) and renders it via Coil `AsyncImage` at its own aspect
  ratio, capped at its natural width and 320dp tall; SVGs sit on a white backdrop, and a tap opens the
  same `ImageLightbox` as SendUserFile previews. A source that fails to load shows its alt text.
- ~~SVG sizing and remote SVG types (rollup XERK-2109).~~ **Done**: an SVG is sized as Chrome sizes
  an `<img>` (`core/SvgGuard.kt` `svgNaturalSize`/`svgFilledSize`, from the parsed root's own width
  and height): one side alone takes the other from the viewBox, else 300 wide / 150 tall; a viewBox
  alone fills the width offered. A remote SVG renders only when served as image/svg+xml
  (`ServedContentType` stops Coil guessing the type from an `.svg` extension); bitmaps are sniffed.
  - Remaining gap (P3): a `data:image/png` (or any non-SVG `data:image/*`) URI whose bytes are SVG
    markup renders here (the bytes are sniffed) and is broken on the web, which trusts the declared
    type. `ex` is taken as 8px; Chrome's depends on the font (9px in headless Chrome).
- ~~Command output collapsed (rollup XERK-2109).~~ **Done**: a `/slash` command's output and an
  output whose command is outside the window ("› output") start collapsed behind their chip, a tap
  toggling it (chat.js `renderCommandCard`); a `!` command's output stays open (`renderBashCard`).
- P2 **Share INTO the app as an attachment (XERK-234 follow-up).** Attaching from the picker is done
  (see "Done" above); the phone-idiomatic counterpart of the web's drag-and-drop is the system share
  sheet, which needs an `ACTION_SEND`/`ACTION_SEND_MULTIPLE` intent filter routing the Uri(s) into the
  open session's `ChatViewModel.attach`. No new wire work — the upload path is already there.
- P1 Verbosity NORMAL: tool card collapsed (output on expand) to match web; persist per-card open.
- ~~P2 Live status bar: token counters + elapsed + spinner + hint lines + subagent list.~~
  Done (XERK-75) — see "Done" below.
- P2 `[MODEL]` Compose bar: Jira ticket chip; filter modes to `permissionModes`;
  optimistic model/mode update. (All PR chips: done — XERK-46.)
- ~~P2 New-session composer in the Sessions list (web can spawn from here).~~ Done (XERK-44): a "+"
  in the Sessions header → host/repo picker → `SpawnDialog`.
- P3 Deep links (`?session=`/`?ended=`), streaming caret, in-place terminal toggle.
- P1 `[MODEL]` **Accurate model selector (XERK-33).** The footer model chip offers a hardcoded menu
  and shows `model` ("default"); the web now heartbeats the login's REAL model list per host
  (`agent.models`) and the model actually answering per session (`session.modelActual`), and switching
  uses "this session only". Port: decode `models`/`modelActual`, populate the chip from the real list,
  show the actual model.
- P1 **Classify bookkeeping turns + queued prompts (#256, chat-view-classification).** The chat should
  render, as the web now does: `[Request interrupted by user]` as a centred status marker; the
  `system/away_summary` recap as a collapsed assistant
  card; and queued (not-yet-sent) prompts as dimmed bubbles. Logic belongs in `core/ChatItems.kt`
  (JVM-tested against the web shapes) — the biggest new chat gap.
- P1 **Rich tool-call payloads + transcript markers (chat-transcript-fidelity).** The web chat now
  renders, from new block fields the agent emits: an Edit call's actual change as a −/+ diff
  (`block.edit {old,new,replaceAll}`), a Write's file body (`block.content`), an ExitPlanMode plan as
  markdown open-by-default (`block.plan`), any tool's human `description` beside the arg
  (`block.desc`), AskUserQuestion cards titled with the question text, plus two status markers:
  `compact_boundary` ("Context compacted (auto) — 123.4k → 5.9k tokens") and `pr_link` ("Opened PR
  #N", linked, one marker per URL at its first sighting — Claude Code re-stamps pr-links every turn,
  so a port that renders them per-entry shows the same PR ~6 times). Android decodes these to
  `UnknownBlock`/ignored keys today (safe degrade); port the fields onto `model/Models.kt`'s
  `ToolUseBlock` + new marker blocks, build items in `core/ChatItems.kt`, render in `ChatScreen`.
### Usage
- P2 **Table-view state persistence (XERK-31).** The web keeps the usage table open + the page put
  across SSE re-renders. Moot until Android grows a usage table view (see the Usage P1 above).

### Board (`board.js` → `BoardScreen`/`core/Board`)

- P1 **New-ticket attachments (XERK-2935) — web only.** The web form uploads each picked file to
  `POST /api/jira/<site>/uploads?name=` (raw body, answers `{uploadId, name, size}`) and sends the
  ids as `uploadIds` on the create; the poll waits up to 5 min when files ride. Android's
  `CreateTicketSheet` creates without files. A port adds a file picker + those two calls; no new
  `/api/agents` key (the `ticketAttachments` capability is untyped and skipped).
  - The web form also takes files pasted from the clipboard (XERK-3021); a port's picker is the
    Android equivalent — no wire change.
- Azure DevOps org support (XERK-43) is at parity for free: the agent reports Azure work items in the
  SAME `jira` heartbeat block, ticket shape and detail shape as Jira (with `source:"azure"`), so the
  board renders them unchanged. The only client-side change was `orgName` — now takes the last path
  segment of an Azure siteKey (`dev.azure.com/myorg` → `myorg`); ported to `core/Board.kt` and tested
  in `BoardTest`. The detail sheet's "Open in Jira" label is source-aware on the web (derived from the
  ticket URL); Android's equivalent label is not yet source-aware — see P1 below.
- ~~P0 Per-card Start button (4 states incl. clone-first) + session chips + optimistic sweep.~~
  ~~P0 Ticket cards: type, age, status pill, priority pill, due/overdue.~~ Both done (XERK-78, see
  Done above).
- P1 `[MODEL]` Detail sheet full field grid + "Open in Jira" + error state. (Web's link label is now
  source-aware — "Open in Azure DevOps" for an Azure ticket, XERK-43; Android still says "Jira".)
- P1 Repo picker: cloned/not-cloned optgroups, "Currently set" orphan, `nameWithOwner`, save-error.
- P1 Agent picker (XERK-38, shipped): inline save-error on the row (Android toasts like the repo
  picker's; the web paints "Couldn't save" on the row itself).
- P2 Likely-duplicate chip (XERK-484): the web card's `kc-dup` chip (links to the `triage.dedupeOf`
  twin) and the detail panel's "Duplicate of" row — not ported to Android yet; `TicketTriage`
  already decodes `dedupeOf`, so only the chip + row need drawing (the Jira Duplicate link itself is
  hub/agent-side, not a client surface).
- P2 Mobile scroll-snapping columns with peek; deep-link (`?ticket=&site=`).
- ~~P2 Board refresh outcome/landing.~~ **Done:** the board Refresh button now holds its spinner until
  the re-poll ACTUALLY lands (the web `jiraRefreshPending`/`newestFetchedAt` land-detection ported to
  `core/Board.kt`, `BoardViewModel.refresh`), with a 45s timeout, and toasts "Refresh failed"/"Refresh
  timed out" on a bad outcome (web shows the outcome inline in the button label — a toast is the
  phone-idiomatic equivalent). Success stops the spinner silently, fresh data being the signal.
- P3 Card org-chip placement; empty-column + truncation notes. (The org chips themselves are gone —
  XERK-62 — and their "offline · synced N ago" note now rides the header control's org rows.)
- P3 Org control: no cross-tab sync (the web follows a `storage` event when a second tab re-scopes;
  a phone has one instance) and no "Currently set" carry-back for a stored-but-unreported org — the
  pick is kept and resumes, it just isn't listed while nothing reports it, same as the web.
- ~~P1 Epic Builder composer + progress (XERK-726).~~ **Done (XERK-731, see Done below):** the "✨ New
  epic" composer + the progress strip with the "Arm Auto Epic run" action shipped on Android.

### Usage (`usage.html` → `UsageScreen`)
- ~~P0 30-day stacked daily chart.~~ ~~P0 Legend with per-series + per-group toggles, persisted,
  rescoping.~~ Both done (XERK-78, see Done above); series colors are the categorical palette now.
- P1 Move "By model" out of the grouping tabs into a standalone "Tokens by model" card (Today / Last
  7 days / All-time). Add a collapsible table view with the in/out and cache splits.
- **`fmtTokens` must agree digit for digit on both platforms**, and there are three copies of it:
  `turma/public/usage.html`, `turma/public/index.html` and `ui/UsageScreen.kt`. The same fleet
  figures head the Usage page, the dashboard tiles and both Android screens, so a formatter that
  disagrees shows one number in the browser and another on the phone with nothing to say which is
  right. Two traps, both of which the obvious implementation falls into: rounding a float (Java's
  `%.1f` rounds the shortest decimal HALF_UP, JS `toFixed` rounds the binary double — they part
  company on every `.x5` boundary, ~1% of values), and Java's `format` following the **device
  locale** (`1,2k` in de_DE, `١٫٢k` in ar_EG). Both sides now do integer arithmetic and build the
  string by hand. The web copies must also never return a non-numeric input verbatim — `tokenCell`
  interpolates the result into `innerHTML` — and their "can't state a figure" sentinel is **`–`,
  never `0`**, since `0` asserts a measurement an idle fleet would show too. Agreement holds up to
  2^53: past that `JSON.parse` cannot hold the count exactly and the two can differ by a tenth
  (`9007411349999999` → `9007411.3B` on the phone, `9007411.4B` in the browser). Only BigInt
  parsing would close that, and no real fleet reaches it. Tests: `fmtTokens` cases in
  `turma/tests/usage.test.js` and `turma/tests/dashboard-livestate.test.js` ↔ `ui/FmtTokensTest.kt`,
  sharing vectors. The same locale trap lives in every `String.format`/`.format` on a user-facing
  figure — `Locale.US` explicitly, or the phone disagrees with the browser about one value.
- The **headline totals** (Today / This week / All-time, with the all-time cache split under them)
  are at parity. Android had them first and the web page did not; `fleetTotals`/`renderTotals` in
  `usage.html` are the port of `UsageViewModel.compute`'s window sums, tested against the SAME
  vectors (`turma/tests/usage.test.js` ↔ `UsageViewModelTest`). Both prefer a host's aggregate
  `usage` block and fall back to summing its `repoUsage` only when it reports none — never both,
  which would double-count. Platform difference: Android puts the row above the grouping tabs, the
  web above the limits section, since its grouping bar sits lower.
- The **cache split** (`N cached · N written · N% hit`) is at parity, laid out platform-idiomatically:
  the web hangs it under every token figure in the table view and by-model card, Android under each
  `UsageRow` and the headline stat row, since Android has no table view yet (the P1 above). The
  `CacheSummary` reducer is `UsageViewModel`'s, tested against the same vectors as the web's
  `cacheHitRate` (`UsageViewModelTest` ↔ `turma/tests/usage.test.js`).
- The **subscription limits section** (XERK-247, XERK-301) is at parity: one card per SUBSCRIPTION
  reporting the 5h/7d
  windows, each with the percentage used, a headroom-coloured bar, the countdown to reset, and the
  "captured <age> ago" stamp that goes amber once stale. `limitCards`/`limitView`/`fmtDuration` are
  ports of the web's `limitGroups`/`limitWindowView`/`fmtDuration`, tested case for case
  (`UsageViewModelTest` ↔ `turma/tests/usage.test.js`). Platform difference: the web lays the cards
  out in a wrapping flex row, Android stacks them at the top of the usage list.
- The **sub-agent split** (XERK-302) is at parity in substance: both surfaces name the delegated
  share of Today / Last 7 days / All-time, take it against only the hosts that report a split, and
  show nothing at all when none does. Platform difference: the web is a "Delegated to sub-agents"
  card with a row per window (delegated tokens beside the share), Android is one `SubagentLine` under
  the headline stats carrying the three shares and the all-time token figure — the same condensation
  as the cache split above, and for the same reason (no table view yet).
- P2 Per-day tooltip; the web's texture channel for series 9+ (Android reuses hues past 8).

### Meetings review (Meetings tab, XERK-2510 / XERK-2858)
- **At parity (XERK-2511, XERK-2858)**: Approve / Approve + start / Edit / Reject / Log decision /
  Reopen, the same review states and refusal words. `meetingProposals` decodes PER MEETING.
- A proposal whose ticket may exist (`review.maybeCreated`, XERK-2865) reads "Maybe created — …"
  and offers Reject only, on both; Reopen of that rejection returns it to the warning.
- Platform differences: a created ticket's key and a "May duplicate" key are text, not board
  links; quote/Tenir links open the system browser.
- Phone-only: the "N proposals from <meeting>" push (channel "Meeting proposals"); a tap opens
  the Meetings tab with that org unfolded on Needs review.

- **Calendar feed link (XERK-2992) is web-only for now**: the calendar ⚙'s "Subscribe in Google
  Calendar" mints the link (`/api/calendar/feed`). Android has no control; the link works anywhere.
- **Calendar blocks (XERK-3057) are web-only for now**: an Outlook event's panel has "Block other
  calendars" (orgs + Meeting alias, `PUT /api/agents/<host>/calendar/blocks`) and the block's right
  bar of those orgs' colors. Android ignores the served `blocks` (untyped); the hub writes the copies
  either way. Port: the section in `CalendarScreen`'s detail, the bar in its block.

### Nav / Login
- **Native Authentik SSO is IMPLEMENTED on Android (XERK-591).** `LoginScreen.kt` shows a "Sign in
  with SSO" button beside the Hub-URL + break-glass credential fields. It opens the hub's existing
  `/auth/oidc/login` in a **Chrome Custom Tab** (system browser, so passkeys/WebAuthn work — a plain
  WebView breaks them) with a PKCE `mobile` challenge; the hub deep-links a single-use code back to
  `turma://oidc-callback`, which the app redeems (with its verifier) at `/api/oidc/mobile/exchange`
  for the SAME opaque `hub_session` token the web cookie carries. Thereafter requests authenticate as
  `Cookie: hub_session=<token>` (`HubClient`), NOT Basic. `core/Oidc.kt` (PKCE + deep-link parse) +
  `net/OidcController.kt` (probe/exchange) + `Config` (session token, pending verifier). The `turma://`
  redirect is hub↔app only — never sent to the IdP — so it needs no Authentik change.
  - **The SSO-outcome messages have Android analogues now**: `?error=forbidden` (signed in but not in
    an access group, XERK-594) and a failed exchange surface on the login screen via
    `OidcController.ui.error`, worded from `login.html`'s `OIDC_ERRORS`.
  - **Group-based access (XERK-594) stays hub-side** in the OIDC callback and gates only the session
    that flow issues. The break-glass username/password path is unchanged and deliberately not
    group-gated (the IdP-independent local credential).
  - **OIDC sessions are the hub's shorter `OIDC_SESSION_TTL_MS`** (default 24h): a 401 on an SSO token
    drops it (`HubClient` → `Config.clearSession`), and `TurmaApp` returns to the login screen to
    re-authenticate. A break-glass password login keeps the 30-day session.
  - Tests: `core/OidcTest` (PKCE golden vector, deep-link parse), `net/OidcControllerTest` (probe /
    exchange / cookie auth / forbidden / 401-drop over MockWebServer).
- **The admin panel is WEB-ONLY (XERK-2552, deliberate).** `/admin` (users, local groups and roles,
  delete user, audit log) has no Android screen; Android's `AdminOnlyScreen` points an admin-only
  account at the web. The web header's Admin tab (shown for the admin role) has no phone twin.
- **Who is signed in, and admin-only accounts (XERK-2553).** Both clients read `GET /api/me`
  (`{kind, name, source, roles, tenant, adminOnly}`, built field by field by the hub's `meView`;
  Android TYPES it as `model.Me`, every field defaulted).
  - The name: web puts "Signed in as <name>" on Sign out's tooltip (a visible label would move the
    right-aligned header row after first paint, XERK-2432); Android shows the same words as a
    disabled item above Sign out in every `ScreenHeader` ⋮ menu (`LocalAccount`).
  - ADMIN-ONLY = the hub's call: admin role, no tenant, AND no host it may drive. Break-glass and an
    admin-role user drive every UNTENANTED host, so before the migration (XERK-2554) they are the
    fleet's operators, never admin-only; an open hub's principal never is. The admin panel
    (XERK-2552) is web-only, so web shows `ADMIN_ONLY_NOTE` under the header on every page and
    Android covers the app with `AdminOnlyScreen` (same words + Sign out) — Android only while its
    loaded fleet is still empty (`showAdminOnly`), so a host enrolled later lifts it on the next
    poll; web re-asks `/api/me` every 15s while its note shows and drops it once the hub stops
    saying admin-only. Null / an older hub's 404 = not admin-only, so nothing changes against an older hub.
  - `net/AccountRepository` re-reads it whenever the stored credential changes, so a sign-in as
    somebody else never shows the previous account; a token refresh for the same sign-in re-reads
    in place (no blink), a 5xx or network failure retries, a 4xx stops.
  - A session route's 404 (an unknown id OR another account's — XERK-2534 answers both alike) reads
    "This session isn't available — it has ended, or it belongs to another account (<hub words>)"
    (`sessionUnavailableMessage`, from `HubClient.mapHistory`). Every list is already tenant-scoped
    by the hub, so only a stale deep link (a push from a previous sign-in) reaches one.
  - Tests: `core/AccountTest`, `net/AccountRepositoryTest`, `ui/AdminOnlyScreenTest`,
    `net/MapHistoryTest`; web `XERK-2553` in `nav.test.js`; hub `XERK-2553` in `server.test.js`.
- **An administrator's password reset (XERK-2630) — choosing the new password is WEB-ONLY.** After a
  reset the hub refuses `/api/login` with 403 `{error, mustChangePassword}` until the user sets a new
  password at `POST /api/password`. Web's sign-in form asks for it in place; Android shows the hub's
  words on its login screen (`HubClient.login`'s 403-with-`{error}` branch) and the user sets it on
  the web. Web also shows the reset (`/api/me`'s `passwordResets`) under the header for a week and in
  Sign out's tooltip; Android does not show it (deliberate: a small surface, web is where it is set).
- **Password sign-in goes through `POST /api/login`, as `login.html` does** (XERK-2569). The hub
  checks Basic against its break-glass credential only — never a local account's password — so
  `HubClient.signIn` posts the username/password and carries the returned `hub_session` cookie,
  exactly like an SSO token. Basic is the fallback only when `/api/login` yields no session.
  - On a 401 with a password stored, `HubClient` signs in again and retries once (this also moves a
    pre-XERK-2569 install onto a session); a password `/api/login` now refuses signs the app out.
  - Tests: `net/PasswordLoginTest`, the `sessionTokenFrom` cases in `core/LoginTest`.

- **Chat render performance + two render refinements are WEB-ONLY (XERK-860 / Track B PR 2).** The
  web chat rebuilt its entire transcript's HTML twice a second (`repaint()` on both the `tail` and
  the `turn` frame), which destroyed and re-created every `data:` image and sandboxed `<iframe>` in
  view once per second. PR 2 coalesces the two frames into ONE `requestAnimationFrame` repaint,
  splits the painted HTML at the BODY / LIVE-region seam so the in-progress turn no longer rewrites
  settled items, and memoizes per-item HTML keyed by `(item, detailsEpoch)`. **None of this ports**:
  Android renders through Compose, which recomposes only what changed, so it never had the defect
  the web fix exists to remove. There is nothing to mirror.
  - **The selection-freeze fix is web-only for the same reason** — it is a DOM-selection concern
    (`selectionIn`), which Compose does not have.
  - **`XERK-860`, hidden thinking, now MATCHES on Android across all three verbosities.** Thinking is
    hidden at the default verbosity while the terminal always shows it, so an elided turn read as a
    quiet one. The three presets treat it three ways (`core/ChatItems.kt` `ThoughtDisplay`, web parity
    with `chat.js` `thoughtDisplay`): **Concise** drops it entirely (no marker, no trace); **Normal**
    folds a run of consecutive thoughts into ONE muted, counted, EXPANDABLE `💭 n thought(s)`
    marker that CARRIES the traces (`ChatItem.FoldedThoughts` + `ui/TranscriptView.kt`
    `TranscriptFoldedThoughts`, collapsed by default, a tap reveals them in place); **Verbose** shows
    the traces expanded by default (`TranscriptThinking` now defaults open, matching the web's
    `openAttr(key, true)`). Web source is `renderFoldedThoughts` (a collapsed `<details>` carrying the
    traces). The web builds
    every thinking item then folds runs at render; Android's single-pass `buildItems` folds inline but
    breaks a run on exactly what the web's item stream breaks it on — a bubble, a tool_use, an orphan
    tool_result or a task note, each an item there even when its card is hidden — so the counts agree in
    every verbosity. Tests: `core/ChatItemsTest.kt` (the `XERK-860` cases) +
    `ui/TranscriptFoldedThoughtsTest.kt` (the expand-on-tap render), the web twin in `chat.test.js`.
  - **The Edit line diff (B4) is web-only so far.** An `Edit` card used to stack the whole old body
    over the whole new body; the web now renders an interleaved per-line diff with unchanged lines as
    context, off the `{old,new}` already on the wire (no wire change). **Android still stacks the two
    blobs.**
  - **The terminal grey-heal watchdog (XERK-879) is web-only.** The sessions page reloads a ttyd
    terminal that loaded but whose WS never delivered a byte (the grey stall), driven by the two
    beacons the server injects into `/term` (`turma-term-loaded` / `turma-term-live`, server.js
    `TERM_LIVE_BEACON`). The beacons ARE served to Android's `TerminalScreen` WebView (server-side,
    parity-exempt), but it loads `/term` at top level (no parent iframe) and does not run the
    sessions-page watchdog, so its terminal has no grey-heal. `TerminalScreen` should watch a
    WebView load/connect signal and reload on a stall, or add a manual refresh control.

# Android ⇄ Web UI parity — closed gaps (XERK-481 onward)

Part of the parity tracker; `PARITY.md` is its entry point (map, deliberate differences,
Meetings tab).

## Done (XERK-481 — triage data model + heartbeat contract)

- **Type the field + capability flag** so `/api/agents` keeps decoding once agents report the triage
  assessment (XERK-480's foundation, landing before B/E): `AgentInfo.triage: TriageInfo?` (the
  `{available}` capability block, mirroring `qwen`) and `JiraTicket.triage: TicketTriage?` (the
  per-ticket assessment: `priority`/`priorityName`/`type`/`value`/`actionable`/`dedupeOf`/`reason`/
  `at`/`source`, every field nullable). Both are the "typed on Android in the same change" half of
  the wire contract — a field is only decode-fatal once a client types it, and `/api/agents` decodes
  atomically here. The hub coerces both (`normalizeTriage`, `sanitizeTicketTriage` inside
  `normalizeJira`), so an absent/malformed block reads as "not assessed"/"can't triage", never a
  fabricated priority. No UI yet — a data-model-only ticket; the board rendering is a later child.
- Pinned by `model/AgentDecodeTest.kt` (`the triage flag and per-ticket assessment decode`).

## Done (XERK-465 — dsh runtime selection + capability flag)

- **Type the field + capability flag** so `/api/agents` keeps decoding once agents report them:
  `SessionInfo.agentType` ("claude"|"dsh", "" for a pre-dsh agent, coerced hub-side) and
  `AgentInfo.dsh: DshInfo?` (the `{available}` capability block, mirroring `localModel`). Both are
  the "typed on Android in the same change" half of the wire contract — a field is only
  decode-fatal once a client types it.
- **A "Runtime" row in the spawn composer**, gated on the target host's `dsh.available` exactly as
  "Run against" is gated on `localModel.available` — a host that doesn't offer dsh renders no row,
  so nobody picks a runtime the host would only refuse (the hub 409s it). Defaults to Claude Code;
  only a real "dsh" pick reaches the wire (`SpawnRequest.agentType`), so a bare spawn is unchanged.
  A host that stops offering dsh while the composer is open resets a picked dsh back to claude
  (`LaunchedEffect`), the same reset the local-model row has.
- Pure half in `core/Runtime.kt` (`RuntimeTest.kt`); the composer call site in
  `ui/SpawnComposerTest.kt`; the wire body in `vm/SpawnRequestTest.kt`.

## Done (XERK-503/504 — unified Runtime picker; dsh model list; dsh chat footer)

- **The spawn composer collapses to ONE Runtime picker** (`ui/FleetDialogs.kt` `SpawnDialog`),
  matching web `sessions.html`: "Claude Code" / "Claude Code Local" (host reports `localModel`) /
  "dsh" (host reports `dsh`), shown only when there is more than one runtime. **"Run against" is
  gone** — its subscription/local choice IS the runtime now. The one choice maps onto the unchanged
  `agentType`/`modelSource` wire fields at spawn (`Runtime.composerRuntimes`/`spawnAgentType`/
  `spawnModelSource`); no field from another runtime leaks. The Model row adapts per runtime (Claude
  aliases / the discovered local list / the discovered dsh list), and dsh shows an "approvals managed
  by dsh" note instead of the permission dropdown (dsh's policy is `ask`/`never`, not Claude's modes).
- **`DshInfo` now types `models`/`defaultModel`/`contextTokens`** (`model/Models.kt`, reusing
  `LocalModelOption`), coerced hub-side by `normalizeDsh`, so a dsh session offers the endpoint's
  DISCOVERED models (the fix for the pi-ai "no configured model" lock) instead of Claude aliases.
  `core/Runtime.kt` gained the dsh model helpers mirroring `ModelSource`'s local ones
  (`dshModels`/`dshOptions`/`currentDshModel`/`dshModelLabel`/`dshModelPickable`).
- **The chat footer reflects a dsh session's runtime** (`ui/ChatScreen.kt` `ChatFooter`,
  `vm/ChatViewModel.kt` `ChatUiState.dsh`): a read-only "⚙ dsh" chip (a dsh conversation can't switch
  to a Claude runtime live), a live dropdown of the host's discovered dsh models (switched via the
  same `/model` POST, which the agent turns into a dsh-process relaunch — `_switch_dsh_model`), and
  NO permission-mode chip. The Claude source chip is relabeled "Claude Code" / "Claude Code Local"
  (was "Subscription"/"Other") to match the composer (`ModelSource.label`/`options`).
- Tests: `RuntimeTest`/`ModelSourceTest` (pure), `SpawnComposerTest` (the unified picker end to end),
  `ChatModelChipsTest` (the dsh footer + relabel), `AgentDecodeTest` (the dsh model list decodes),
  and the target-host wiring in `FleetSpawnLocalModelTest`/`SessionsPaneSpawnTest`. Full
  `testDebugUnitTest` green (450 tests).

## Done (XERK-477 — board runtime row; runtime badge on cards removed)

- **The `⚙ dsh` session-card runtime badge is GONE, on every surface.** The web dropped it
  (`runtimeMarkHtml` / `.runtime-mark` removed from `sessions.html`), so Android dropped it too:
  `RuntimeBadge` is removed from `ui/CommonUi.kt` and no longer rendered on the live session cards or
  the ended rows in `ui/SessionsScreen.kt`. `Runtime.isDsh` stays as the shared runtime
  predicate; the Trajectory viewer and composer still tell a dsh session apart.
- **`EndedSession`/`ClosedSessionInfo.agentType` stay typed** — the hub serves them and they decode
  cleanly; they are simply no longer read for a card badge. Tests: the closed-`agentType` decode in
  `model/AgentDecodeTest.kt`, the `Runtime.isDsh` cases in `core/RuntimeTest.kt`.
- **The board ticket "Runtime" row** (web `board.js` `runtimePinOf`/`runtimeFieldHtml`/
  `runtimePickerHtml`, XERK-473) — the fifth tap-to-change row in the ticket detail sheet
  (`RuntimeSection` in `ui/BoardScreen.kt`), beside Status/Repo/Agent/Model, pinning which runtime a
  ticket's session spawns on. Hub-owned durable state: it reads the `ticketRuntimes` map off the
  fleet payload (typed as `AgentsResponse.ticketRuntimes` → `FleetState.ticketRuntimes`, refreshed by
  the poll and the `ticketRuntimes` SSE event) and writes with `POST
  /api/jira/<siteKey>/<issueKey>/runtime` (`vm.setTicketRuntime`), authoritative on a 200 like the
  Model pin. A non-default runtime is offered only when the org has a capable host — "dsh"
  (`BoardSite.dshAvailable`) and, since XERK-515, "qwen" (`BoardSite.qwenAvailable`), each OR'd over
  every host's `dsh.available`/`qwen.available` in `mergeSites` — with an existing pin always
  releasable (`Runtime` row `runtimeEditable`). Pure ports
  (`runtimePinOf`/`prettyRuntime`/`runtimeEditable`) in `core/Board.kt`, tested in
  `core/BoardTest.kt`; the `ticketRuntimes` decode in `model/AgentDecodeTest.kt`.

## Done (XERK-498 — dsh Trajectory replaces the terminal, no empty page)

- **A dsh session is HEADLESS (no ttyd), so its chat header shows a Trajectory action, not Terminal.**
  Before this the header always showed Terminal and tapping it opened an empty `/term` WebView — the
  reported bug. `ui/ChatScreen.kt` now gates the header action on `Runtime.isDsh(session.agentType)`
  (web `sessions.html` hides "Terminal ▸" / shows "Trajectory ▸"): a dsh session gets an Analytics
  icon that routes to `Routes.trajectory(host, transcriptId)`; a claude session keeps Terminal.
- **`ui/TrajectoryScreen.kt` is the Android port of web `renderTrajectory`** — a read-only render of
  the dsh D3 native event log from `GET /api/dsh/<transcriptId>/trajectory` (`net/HubApi.dshTrajectory`,
  a `Response<DshTrajectory>` so a 404 is handled apart), driven by `vm/TrajectoryViewModel`. It shows
  the header (title/model/turn+tool-call+error counts/token totals/duration) and turns newest-first,
  each with its tool calls (✓/✗/• + args + duration), mirroring the web. A 404 reads as "not synced
  yet — ↻ Refresh in a moment" (the ordinary case for a just-opened running dsh session), kept apart
  from a real error.
- **Wire model** (`model/Models.kt`): `DshTrajectory` + `TrajTotals`/`TrajTokens`/`TrajTurn`/
  `TrajTurnTokens`/`TrajCall`. Timestamps decode as `Double?` (dsh's own epoch-ms, can be fractional),
  token counts as `Long` (floored hub-side). Not part of the atomic `/api/agents` decode, so a
  wrong-typed field breaks only this screen.
- Route `trajectory/{host}/{tid}` in `ui/TurmaApp.kt`, wired through the chat route and `SessionsRoute`
  (`onTrajectory`). `TerminalScreen` is unchanged (a claude session still uses it); the dsh session
  simply never navigates there now.
- Tests: `vm/TrajectoryViewModelTest` (200/404/500/blank-id outcomes over MockWebServer),
  `ui/DshChatActionTest` (a dsh session shows Trajectory not Terminal, carries the transcript id; a
  claude session keeps Terminal — the wiring the `core/`-tested `Runtime.isDsh` gate does not cover),
  `ui/TrajectoryFormatTest` (the `trajMs`/`trajNum` formatters).

## Done (XERK-488 — client triage parity: Triage lane, verdicts, org policy)

- **Android has FULL triage parity** with the web (XERK-485/486): all four surfaces ported.
  - **Triage lane** — `core/Board.kt` mirrors `board.js` `triageLaneOf`/`triageActionOf` (pure,
    tested in `core/BoardTest.kt`); `ui/BoardScreen.kt` renders the lane FIRST in the column strip
    (`listOf("triage" to "Triage") + BOARD_CATEGORIES`), holds untriaged + held To Do cards, and is
    **never a drop target** (the drag target resolver does `takeIf { c -> c != "triage" }`, like
    web `board.html`'s drop guard).
  - **Verdict chip + Triage row** — `TriageSection`/`TriagePicker` in the detail sheet mirror
    `triageFieldHtml`/`triagePickerHtml`: Auto / Approve / Hold / Reject, a pick IS the save
    (`vm.setTicketTriage` → `POST /api/jira/<site>/<key>/triage`), "Auto" is the release; the card
    chip renders the `TriageActionPin` (`model/Models.kt`) read off the fleet payload's
    `ticketTriageActions`.
  - **Per-ticket approve/hold/reject** rides the same durable hub state as the pins — works with
    the org's hosts offline; the fleet payload + SSE keep the verdict fresh.
  - **Org triage policy sheet** — `TriagePolicySheet` (header "Triage policy" button, like the web
    board bar): the six knobs (minPriority / excluded types / repo allow / repo deny / rateMax /
    includeNotActionable, XERK-2209)
    via `vm.saveTriagePolicy` → `POST /api/jira/<site>/triage-policy`; `null` clears a knob.
- **Platform-form notes (parity by intent, not omission):** Android's lane is the first item of
  the same horizontal `LazyRow` strip (no separate scroll surface); the verdict picker is a
  dropdown dialog in the detail sheet rather than the web's in-place inline swap (sheet rows do not
  reflow); the policy editor is a full sheet vs the web's header-bar menu — same wire calls, same
  semantics, different gesture chrome.
- Tests: `core/BoardTest.kt` (lane/chip pure functions), `ui/BoardTriageTest.kt` (4 Robolectric
  cases: lane placement incl. held card, chip rendering, verdict save over MockWebServer, policy
  editor). All suites green.

## Done (XERK-731 — Epic Builder composer + progress strip)

- **Android has FULL Epic Builder parity** with the web board (XERK-725/726/728): the idea→epic
  composer AND the live progress strip, a client-only additive build (no column-rule/lane mirror is
  touched, so no re-port).
  - **`epicBuilders` is TYPED on the fleet payload** — `AgentsResponse.epicBuilders: Map<String,
    EpicBuilder>` (`model/Models.kt`), decoded via `FleetRepository`/`HubApi` and mirrored on
    `FleetState` + the `"epicBuilders"` SSE event. Per the XERK-338 decode-fatality rule, `EpicBuilder`
    has every field defaulted (state defaults `"queued"`), so a partial/older/malformed entry defaults
    rather than throwing the whole atomic `/api/agents` decode; the hub (`sanitizeEpicBuilderRecord`)
    only ever emits clean entries. Pinned by `AgentDecodeTest` (well-formed + partial + absent + the
    rest of the fleet still decodes).
  - **Progress strip** — `core/Board.kt` `epicBuilderRows`/`epicBuilderStateLabel` mirror `board.js`
    (pure, drop no-siteKey/no-title, coerce the state, org-scope by the header filter, newest-first
    sort), tested in `core/BoardTest.kt`; `ui/BoardScreen.kt`'s `EpicBuilderStrip` renders above the
    board: a state chip, title, org + dispatched host, and a tail — a done run links the produced epic
    to the board's OWN detail (not out to Jira) and offers a one-click **Arm Auto Epic run** (reusing
    `vm.startEpicRun`, the XERK-638 epic-run arm), a failed run shows the hub's error, an in-flight run
    spins; each carries a ✕ that cancels/dismisses via `DELETE /api/jira/<site>/epic-builder/<id>`
    (404 = already gone), optimistically dropped and reconciled on the beat (`ebDismissed`/
    `sweepEpicBuilders`, the `cancelQueued`/`sweepQueue` idiom).
  - **Composer sheet** — `EpicBuilderSheet` (header "✨ New epic" button, gated on a reporting org)
    mirrors `epicBuilderComposerHtml`: title + free-form idea + optional repo/host picked off the
    org's own `mergeSites` `repoOptions`/`hostOptions` pools (uncloned repos and offline hosts
    flagged), POSTing `{title, idea, repo?, targetHost?}` to `POST /api/jira/<siteKey>/epic-builder`.
    A hub refusal lands inline in the hub's own words (`hubErrorMessage`, XERK-264); the swipe-down /
    Cancel discard guard (XERK-218) matches `CreateTicketSheet`.
- **Platform-form notes (parity by intent, not omission):** the strip is a `Column` of cards above the
  board's own scroll surface (the web's `#epicBuilders` region); the composer is a modal sheet with
  dropdown pickers vs the web's inline modal — same wire calls, same semantics, different gesture
  chrome. Web-first precedent for a low-frequency operator authoring action, like the org auto-merge
  switch (XERK-550).
- Tests: `core/BoardTest.kt` (`epicBuilderRows`/label/terminal cases), `model/AgentDecodeTest.kt`
  (the `epicBuilders` decode + tolerance case).

## Done (XERK-1566 — permission policy editor)

- **Android has the board's permission policy editor** (web `permissionRules*` panel in
  `board.html`): the per-org text the agent's permission judge decides a blocked Bash command
  against.
  - **Its OWN route, never `/api/agents`** — `HubApi.getPermissionPolicy`/`setPermissionPolicy` →
    `GET|POST /api/jira/<site>/permission-policy`, read into `PermissionPolicyResponse` (every field
    optional: absent `text` = "", absent `isDefault` = the default, as the web reads them). Nothing on
    the fleet payload changed, so the atomic decode is untouched.
  - **`PermissionPolicySheet`** (a labelled "Permission policy" item in the header's ⋮ overflow —
    the web folds it behind its ⋯ menu; a header icon squeezed the org filter to "…" on a phone —
    shown only with a reporting org — the web panel bails with no `policySites`): the org picker, the
    web's note wording with the status on its own line, a 16000-character field (`PERMISSION_POLICY_MAX`, the hub's limit), **Use
    default** (`{text:null}`, off while already default), Cancel, **Save policy** (`{text}`; "" turns
    the judge off for the org). State lives in `BoardViewModel.permission`.
  - **No optimistic success**: only the hub's 200 changes the sheet (it shows what the hub stored); a
    refusal shows the hub's own words (`hubErrorMessage`, XERK-264) and keeps the operator's edit. Save
    waits for a successful load, so a failed GET is never saved over the org's real text (the web
    leaves Save live after a failed load — Android is deliberately stricter there).
- **Platform-form notes:** a modal sheet vs the web's narrow panel, and a successful Save closes it
  (the triage sheet's pattern) where the web panel stays open — same wire calls, same semantics.
- Tests: `ui/BoardPermissionPolicyTest.kt` (load, save, refused save keeps the edit, Use default,
  absent fields, refused load blocks Save, org-less board has no button — Robolectric over
  MockWebServer), `vm/PermissionPolicyResultTest.kt` (the response reading).


---
paths:
  - turma/server.js
  - turma/tests/server.test.js
  - turma/public/board.js
  - turma/public/board.html
  - turma/tests/board.test.js
---

# Epic Builder — hub route + dispatch + run tracking (XERK-725, epic XERK-721)

The operator hands the hub an **idea** (a title + free-text description) and the hub dispatches a
builder SESSION to a capable host, which expands the idea into an Auto-Epic-ready Jira epic. This
file is the HUB half (D). The plan/run data contract is `turma/epic-plan.js` (A, XERK-722); the
builder session + its agent-side tracker writes are XERK-723 (C); the operator UI is a later subtask
(E). The Auto-Epic RUN that later EXECUTES the produced epic is `turma-epic-run.md`.

## The durable store (`epicBuilders`)

- **Hub-owned durable state, the exact shape/lifecycle of `epicRuns`**: a `/data` JSON file
  (`EPIC_BUILDERS_FILE`, NOT `state.json`), its own SSE frame (`sseBroadcast("epicBuilders", …)`),
  and a top-level key on `/api/agents`. **Keyed by a minted id** (`crypto.randomBytes` hex), NOT
  `(siteKey,issueKey)` — there is no epic yet (the builder PRODUCES one), so a builder is not a Jira
  ticket and has no issue key.
- **It MUST persist.** A builder queued when the hub restarts would otherwise lose its idea; the
  record carries the idea so the driver re-dispatches it after a reboot.
- **Externalized to the shared store under HA (XERK-769)** via `registerExternalStore`, exactly like
  `epicRuns` — visible across replicas, surviving a pod restart, seeded up from the local file on a
  cutover. `epicBuildersCoerce` runs the SAME `sanitizeEpicBuilderRecord` per-record whitelist; that
  sanitizer's field order matches the RUNTIME insertion order (base → dispatch's host/dispatchedAt →
  advance's epicKey/error) so a live record is a coerce FIXED-POINT and the own-write watch echo dedups
  under HA. `persistEpicBuilders()` (via `publishEpicBuilders`) replaces `scheduleEpicBuildersSave`.
  Mechanics: `.claude/rules/turma-ha-store.md` (wave-3 pattern).
- **Record**: `{id, siteKey, title, idea, state, startedAt, updatedAt}` + optional
  `repo, targetHost, host, epicKey, dispatchedAt, error`. `state ∈ {queued, researching, creating,
  done, failed}` (`EPIC_BUILDER_STATES`). `queued` covers both "waiting for a host" and "dispatched,
  awaiting the builder's first report"; the agent's report advances it past `queued`.
- **Loaded with a per-field whitelist at boot** (`sanitizeEpicBuilderRecord`): a record with no
  id/siteKey/title is DROPPED, not restored. Its bounds are **INLINE LITERALS** (64/200/500/8000),
  never the `EPIC_BUILDER_*` consts — it runs at module-init where those consts are in their TDZ (the
  sibling-normalizer rule). Bounded `EPIC_BUILDERS_MAX` runs, oldest-`updatedAt` evicted (never the
  just-armed one).
- **Older clients degrade**: `epicBuilders` is a NEW top-level payload key an older web/Android build
  ignores.

## The route — `POST /api/jira/<siteKey>/epic-builder`

- **Operator-authed, 200-authoritative** like the pin/triage/epic-run routes. Body
  `{title, idea, repo?, targetHost?}`.
- Validation ORDER (each a distinct fact): **400** on a missing/empty title or idea, or an
  over-long title / bad repo|targetHost type → **413** on an idea over `EPIC_BUILDER_IDEA_MAX` (a
  SIZE refusal, since the idea rides both the served record and the dispatch command) → **404** when
  no host reports the org, a named `repo` is not cloneable, or a named `targetHost` does not report
  the org.
- **`orgReportsRepo` accepts a repo CLONED (on-disk `repos[]`) OR merely LISTED (`jira.repoOptions`)**
  — a gh-clonable repo no host has cloned yet. The composer (E, XERK-726) offers uncloned repos
  (flagged "(not cloned)") like the manual Start/repo pickers, and dispatch clones on demand
  (`findTicketHost` → `needsClone`); checking only the on-disk set 404'd every uncloned pick the UI
  presents (QA seam). A repo in NEITHER set is still not cloneable → 404. Tests: `XERK-726:` in
  `server.test.js`.
- On success `armEpicBuilder` mints the run (`queued`), then the route calls `epicBuilderDriveSweep()`
  INLINE so a free fleet dispatches at once. Returns `{ok, run}`.
- **`DELETE /api/jira/<siteKey>/epic-builder/<id>`** cancels: drops the hub record (the dispatched
  session is not hub-reachable and is left to end). 200 `{cleared:true}` or 404. Placed BEFORE the
  ticket-session-cancel DELETE (`parts[4]==="session"`); the length-5 DELETE at the `/api/agents`
  block is scoped to `parts[1]==="agents"`, so neither collides.

## Dispatch — `epicBuilderDriveSweep` (the epicRuns pattern, NOT the ticketQueue)

- **DECISION (XERK-725): a builder does NOT ride the `(siteKey,issueKey)` ticketQueue.** The ticket
  said "dispatch through the SAME hub ticket queue + findTicketHost … capacity/backpressure and host
  selection inherited, not re-implemented." Read literally, pushing a non-ticket into `ticketQueue`
  would break every consumer (`ticketQueuePayload` serves entries as tickets; `drainTicketQueue`
  assumes a Jira row + runs ~15 ticket-specific guards; `board.js`/Android render entries as
  tickets) — cross-client parity work that belongs to the UI subtask (E), and a destabilisation of
  the hub's hottest loop. So this MIRRORS epicRuns instead (own store + SSE + payload + driver
  sweep), and "the shared queue" is honoured as **the shared host-selection + capacity path**:
  `findTicketHost(siteKey, repo||null, null, {requireFree:true, rows})`. A null issueKey vacuously
  satisfies findTicketHost's triage/runtime/OS pins, so this reuses the Start button's EXACT host
  selection (online host of the org, cloned-repo preferred, most-available, capacity-gated,
  subscription-pause-aware) with no ticket. **If a reviewer wants a literal ticketQueue entry
  instead, that is an E-scoped client change — do not add it here without the client mirrors.**
- Runs on the 15s sweep (beside `epicRunDriveSweep`) and inline after the route. For each `queued`
  run with no `host`, it picks a host (or holds if none free — self-clearing backpressure, retried
  next tick), queues a **`spawnEpicBuilder`** command (`{builderId, siteKey, title, idea, repo?}`)
  and stamps `run.host`/`run.dispatchedAt`. One dispatch per host per pass.
- **A `targetHost` pin** is used only when that host is a live, free host of the org (a pin says
  WHICH host, never around it); else the run HOLDS.
- **Acked-no-session recovery**: a dispatched run still `queued` after `EPIC_BUILDER_REDISPATCH_MS`
  has its `host` claim cleared so it re-dispatches — the epic-child backoff shape
  (`turma-epic-run.md`), flat (a builder is rare) so it never churns.

## Advancing the run — the per-agent heartbeat field

- **The builder reports progress via a per-agent heartbeat field `epicBuilderStatus`**
  (`[{id, state, epicKey?, error?}]`; the agent side is XERK-723/C). A `HEARTBEAT_KNOWN_KEYS` member,
  coerced by `normalizeEpicBuilderStatus` (whitelist): a non-array dropped, elements filtered to
  plain objects, wrong-typed sub-fields dropped (never stringified), strings re-capped. It coerces
  SHAPE only — the state VALUE is validated by `advanceEpicBuilder` on ingest, so the normalizer
  touches no `EPIC_BUILDER_*` const (the loadState-TDZ reason; it is reached from the restore loop).
  Absent = "can't tell", advancing nothing.
- `ingestEpicBuilderStatus(hostKey, next)` runs in the heartbeat handler after the other ingests. A
  host may only advance a builder **dispatched to it** (`run.host === hostKey`) — the ownership rule
  `ingestSpawnFailures` follows for cmdIds — so one host cannot advance another's builder. `error`
  is kept only while `failed`.

## The operator UI (E, XERK-726) — composer + progress strip (`board.js`/`board.html`)

The board is the operator surface. **Purely ADDITIVE** — no column-rule/lane mirror is touched, so it
triggers no re-vendor/re-port.

- **The composer** is a board-bar "✨ New epic" button opening a narrow modal (`epicBuilderComposerHtml`,
  the triage-policy modal's backdrop/`td-narrow` pattern): title + free-form idea + an OPTIONAL repo
  and host, picked off the org's own `mergeSites` `repoOptions`/`hostOptions` (the same pools the Start
  pickers use). It POSTs `{title, idea, repo?, targetHost?}` to `POST /api/jira/<siteKey>/epic-builder`.
  The panel DOM stays STABLE while open (typing keeps focus) — field values are read at submit
  (`ebReadForm`), and only an org change or a busy/error transition repaints it. A refusal surfaces the
  hub's own words (`TurmaNav.refusalText` off the RESPONSE BODY, XERK-264), not a bare status.
- **The progress strip** (`epicBuilderProgressHtml`, rendered ABOVE the board, before the empty-board
  early return so a fresh org's queued builder still shows) reads `epicBuilderRows(data.epicBuilders,
  orgFilter)` — the hub's `epicBuilders` map, org-scoped by the header filter, malformed rows DROPPED
  (degrade like `epicRunOf`). One row per run: a live state chip (queued→researching→creating→
  done/failed) + host + a ✕ that CANCELS in-flight (DELETE) or dismisses a terminal one; a `done` run
  LINKS the produced epic to the board's OWN detail (`/board?ticket=<epicKey>&site=<siteKey>`, the
  XERK-16 pattern, never out to Jira) and offers **"▶ Arm Auto Epic run"** — which reuses
  `startEpicRun(epicKey, siteKey)`, the XERK-638 epic-run POST, NOT a new route. A `failed` run shows
  the hub's `error`.
- **`epicBuilders` is a LIVE_MAPS/SSE key** (`@epicBuilders`) — its own `epicBuilders` SSE event
  whole-value-patches the cache like `epicRuns`, so the strip stays live across boards, and an
  in-flight `/api/agents` snapshot can't clobber a fresher patch (XERK-546).
- **Web ⇄ Android parity: WEB-ONLY**, tracked in `android/PARITY.md` (P1). `epicBuilders` is a NEW
  untyped top-level key Android's `ignoreUnknownKeys` skips (decode-SAFE — the full-array atomicity
  risk needs a TYPED field). Same web-first precedent as the org auto-merge switch (XERK-550).
- Tests: the `XERK-726:` cases — `epicBuilderRows`/`epicBuilderStateLabel`/`epicBuilderProgressHtml`/
  `epicBuilderComposerHtml` in `board.test.js`, plus the `epicBuilders` entry in `BOARD_LIVE_MAPS`
  (the SSE keep-live).

## Tests

- The `XERK-725:` cases in `server.test.js`: route validation (bad title/idea 400, idea 413,
  no-org 404, uncloneable repo 404, bad targetHost 404, nothing created by a refusal); arm +
  inline dispatch to a findTicketHost pick + the run on the payload; full-fleet backpressure
  (held `queued`, no command) then a freed slot dispatching; a host's report advancing the run
  through the states + the ownership refusal; restart restore (malformed dropped);
  `normalizeEpicBuilderStatus` coercion; the `epicBuilders` SSE frame; DELETE cancel + 404 on repeat.

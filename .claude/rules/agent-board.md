---
paths:
  - "agent/hub-agent.py"
  - "agent/tests/test_hub_agent.py"
---

# Board sources, repo triage and ticket sessions

The agent half of the board: collecting tickets from Jira or Azure DevOps, the only two writes back
to a tracker, deciding which repo a ticket belongs to, and spawning a session to work one. All in
`hub-agent.py`; the hub/UI half is `.claude/rules/turma-board.md`.

- Optional and **source-agnostic**: Jira Cloud creds (`JIRA_SITE`/`JIRA_EMAIL`/`JIRA_TOKEN`) or an
  ADO PAT (`AZDO_URL`+`AZDO_TOKEN`, optional `AZDO_PROJECT`/`AZDO_USER`/`AZDO_API_VERSION`) heartbeat
  that user's tickets into the same `jira` block; `source:"jira"|"azure"` flags UI copy differences.
  **Azure emits the SAME wire contract as Jira** (XERK-43).
- **An agent serves exactly ONE org** (a host is Jira or Azure, never both).
  `board_source()`/`board_configured()`/`collect_board()`/`fetch_board_issue()`/`board_site_key()`/
  `valid_issue_key()` are the dispatch shims every gate goes through; downstream reads `self.jira`
  unchanged.
- Unset creds = feature off, **zero tracker HTTP**, `available:False`. **Nothing writes to the
  tracker except the operator's own create (XERK-137), status change (XERK-138), the hub-driven
  triage priority write-back (XERK-483), and hub-driven duplicate linking (XERK-484).**
- **On-demand issue detail**: a `{type:"jiraIssue", issueKey}` command (allowlist-checked against
  the key grammar) calls `fetch_jira_issue`/`fetch_azure_issue`, staging onto `jiraIssueResults`.
  **Every failure path stages a result carrying an `error` instead of raising**; an ADO
  comments-endpoint failure degrades to no comments. Rich text flattens agent-side
  (`adf_text`/`adf_plain`; `azure_html_to_text`/`azure_plain`), `_shape_issue_detail` capping the
  newest `JIRA_COMMENT_MAX` comments (+ `commentTotal`).
- **Self-hosted is the point for ADO.** `AZDO_URL` is any base; PAT auth is Basic with empty
  username (`:PAT`).
- **siteKey keeps the org/collection PATH** (`normalize_azure_site`), unlike the Jira host-only key,
  else every cloud org merges into one board.
- **Work-item ids are bare integers** (`AZDO_KEY_RE` accepts `^[0-9]+$` alongside `PROJECT-123`).
  Ticket sessions get a human branch base `<project>-<id>` (`ticket_branch_base`), not a bare number.
- **State → column**: Azure's per-type metastate comes from the states API when reachable
  (`_azure_state_map`, cached), falling back to a static name map then `todo` — mapped to
  todo/inprogress/done as Jira's `statusCategory`. Raw name rides as `status`.
  - **Metastate field is `category`** (`WorkItemStateColor`), unchanged 4.1→7.2 — reading
    `stateCategory` returned `[]` on every real org: no `statusOptions`, no Change button (XERK-250).
  - **`_azure_type_meta` caches per-type reads**: success for `AZDO_META_TTL_SEC`, an EMPTY result
    only `AZDO_META_RETRY_SEC` (else one 503 disables status changes until restart). Logs once per
    key until success, so a permanently-down endpoint doesn't bury the log.
  - **`_azure_status_options` also drops transitions the type's PROCESS forbids**
    (`_azure_transitions`) — offering a state ADO refuses is as bad as an empty picker. Unreadable
    map = offer everything; known-empty = nothing allowed. Kept off the per-ticket path (~35 KiB
    form definition per type).
  - **A malformed transitions entry fails OPEN** (omitted, not stored empty — storing it would
    reproduce the no-Change-button symptom). Tests: `test_an_unreadable_entry_fails_OPEN_not_closed`.
  - **Known gap**: states/transitions have independent TTLs, so a newly-added state can be live but
    unoffered for up to `AZDO_META_TTL_SEC`. Bounded; better than the restart it replaced.
  - **ADO's `Resolved` metastate is `inprogress` on the wire**; the board carves it into In Review by
    NAME (`_REVIEW_STATUS_RE`) — a non-English/custom "resolved" state shows as In Progress instead.
- Tests: `TestAdfText`, `TestShapeIssueDetail`, `TestFetchJiraIssue`, `TestStageJiraIssue`,
  `TestNormalizeAzureSite`, `TestAzureBase`, `TestCollectAzure`, `TestShapeAzureItem`,
  `TestAzureCategory`, `TestAzureHtmlToText`, `TestFetchAzureIssue`, `TestBoardSourceDispatch`.

### Writing back to the board

- `create_board_issue`/`board_create_meta`/`board_issue_types` dispatch by source
  (`create_jira_issue` POSTs `/rest/api/3/issue`, plain-text→ADF via `_text_to_adf`;
  `create_azure_issue` POSTs a JSON-Patch work item, `;`-joined `System.Tags`). Jira labels split on
  whitespace+commas, Azure tags on commas. The new ticket **self-assigns to the tracker user**
  (best-effort, reported) so it lands on the board.
- **A refusal carries the tracker's own words; a create bends to the TYPE and IDENTITY** (XERK-151):
  - `_http_error_detail` keeps the body urllib's `HTTPError` drops, else every refusal reads "HTTP
    Error 400: Bad Request".
  - The description goes in the field the type HAS (`_azure_description_field`: Agile/Scrum **Bug**
    has ReproSteps, not Description).
  - Assignment walks a **ladder** of spellings then unassigned, keeping the FIRST error,
    re-sending only after a 4xx (proof nothing was created). Best candidate is **HARVESTED, not
    guessed** (`_azure_mine_identities` reads `System.AssignedTo` off the board's `@Me` WIQL, ahead of
    `AZDO_USER` guesses); `_azure_identity_strings` spells each four ways. An unassigned success warns
    with the tracker's own refusal, never "set `AZDO_USER`".
- `set_board_status` **re-reads the available options and applies only a `value` still on offer** —
  the board's workflow decides what a ticket can move to, not the browser.
- A drag-and-drop move POSTs the target **COLUMN**, not a transition: `_status_option_for_column`
  picks the first fresh option whose `_board_column(name, category)` matches; **no match refuses**.
  `_board_column` mirrors `board.js` `categoryOf` — see `CLAUDE.md`'s cross-cutting contracts.
- **An agent that predates a write command still ACKs it** (a poison command must not retry
  forever), so these commands **stage their result in the SAME `handle_commands` call** — never move
  the staging to a later beat.
- `createDuplicateLink` (XERK-484) links two Jira issues as Duplicates
  (`POST /rest/api/3/issueLink`, outward = the flagged ticket, inward = its `triage.dedupeOf` twin).
  **Jira-only**: an ADO host stages a refusal, no HTTP. Idempotency is layered —
  1. a live `GET /issue/{key}/links` read is the source of truth: the link already exists →
     `ok, action:"no-op"`, no POST;
  2. the durable ledger `~/.turma/jira-duplicate-links.json`
     (`DUPLICATE_LINK_LEDGER_PATH`, `<siteKey>/<issueKey>` → twin, bounded
     `DUPLICATE_LINK_LEDGER_MAX`) makes HUMAN REMOVALS sticky — a pair we linked that Jira no longer
     shows as linked is `ok, action:"skipped"`, never re-linked;
  3. success → ledger entry + `ok, action:"linked"`. Every failure path (bad key, unconfigured,
     HTTP error) stages `ok:false` with a bounded error, so the hub's suppression map can retry
     (errors) or drop (oks) instead of re-queuing every sweep. Staged on `ticketLinkResults`,
     same held-across-a-failed-POST lifecycle as the other results. Tests: `TestCreateDuplicateLink`.
- Tests: `TestSetBoardStatus`, `TestAzureStatusOptions`, `TestCreateAzureIssue`,
  `TestAzure*Identit*`, `TestHttpErrorDetail`, `TestBoardColumn`.

## Repo triage (`repoGuess`)

- Each heartbeated ticket carries an optional `repoGuess` — which repo that ticket's work belongs in.
- Decided **agent-side** by the host's already-authenticated `claude -p` (no external API/key/cost
  env) — this host is the only place the three inputs meet: board creds, scanned repos, `gh` sweep.
- `_triage_candidates()` = the host's cloned repos (marked `[cloned]`, prompt-preferred) plus every
  repo its `gh` login can clone. The reply is **allowlist-validated back against that list**
  (`_parse_triage`). Purely presentational; **no ticket text reaches a shell, path, or URL**.

### Ticket triage assessment (`triage`, XERK-481 — foundation for XERK-480)

- A SIBLING of `repoGuess`: each heartbeated ticket also carries an optional `triage` block
  `{priority, priorityName, type, value, actionable, dedupeOf, reason, at, source}` — the
  gate/prioritize/dedupe assessment. `priority` is a normalized P0..P3 band; `priorityName` is the
  tracker's OWN label. `_apply_triage` stamps it INDEPENDENTLY of the repo decision (a ticket can be
  prioritized before/without a repo), ahead of the repoGuess decided-gate, from the ledger entry's
  `triage` sub-dict. **Absence == "not assessed"** (no key at all), never a fabricated priority —
  same contract as an untriaged `repoGuess`.
- **The wire shape has ONE builder, `build_ticket_triage`** (pure, drops any unusable field), and
  THREE mirrors that must agree: it (agent), `sanitizeTicketTriage` inside `normalizeJira`
  (hub — `jira` is a KNOWN key so `sanitizeHeartbeat` never looks inside it), and Android's
  `TicketTriage` (typed, so a malformed block would fail the atomic `/api/agents` decode). Change one,
  change all.
- **`triage.available`** is the top-level capability flag (`_triage_payload`, gated on
  `board_configured()`), coerced by `normalizeTriage` exactly like `qwen`/`dsh` — absent reads as
  "this host can't triage", never "triaged, unknown".
- **[A] is the data model + wire contract only** — the PRODUCER (computing priority/type/dedupe into
  the ledger entry) is B/E, so the stamping is dormant-but-wired until then. Tests:
  `TestJiraTriage` (`build_ticket_triage`, `_apply_triage` stamping), `TestSpawnOptionHelpers`
  (`_triage_payload`); hub `normalizeTriage`/`normalizeJira` cases in `server.test.js`; Android
  `AgentDecodeTest`.

### The triage ledger

- Cached in `~/.turma/jira-repos.json`, keyed `<siteKey>/<issueKey>` — triage runs **once per
  ticket, not per beat**.
- Each entry holds two independent things: the **decision** (repo/cloned/reason/`at`+
  `ticketFp`/`candFp`) and the **attempt run** (`attempts`/`retryAt`+`tryTicketFp`/`tryCandFp`) —
  keeping them apart is what makes the cache safe.
- `_triage_stale()` re-triages on ticket-text change (`_ticket_fingerprint`, deliberately NOT
  `updated`, which moves on any field edit) or candidate-set change (`_candidates_fingerprint`:
  names+cloned-ness only, sorted before truncating). A manual pin is exempt (`_triage_due` skips it,
  no attempt spent).
- **Stale means "re-triage this", never "stop showing it"** — the old answer keeps rendering until a
  replacement lands, else one clone or gh sweep blanks every chip on the board.
- **`attempts` is scoped to the question, not the ticket's lifetime** — a changed ticket/candidate
  set gets a fresh budget, else a lifetime counter permanently bans re-triage.

### Scheduling and failure handling

- `_start_jira_triage` only updates candidates from a **successful** gh sweep — `refresh_github`
  blanks to `repos:[]` on any error, indistinguishable from empty, and triaging against it re-runs
  the whole board twice.
- Batched (`JIRA_TRIAGE_BATCH`), **one job in flight**, attempted every beat, bounded-retry with
  backoff (`JIRA_TRIAGE_MAX_ATTEMPTS`/`JIRA_TRIAGE_BACKOFF_SEC`) **armed up-front** so a restart
  mid-batch neither loops nor loses retries. Tuned by `JIRA_TRIAGE_MODEL` (default `haiku`) /
  `JIRA_TRIAGE_TIMEOUT_SEC`.
- `_parse_triage` splits the model's two non-answers: explicit `null` is a verdict
  (`repoGuess.repo=null`, "no repo fits"); anything unreadable is a **failed attempt** whose key is
  omitted, leaving the ticket undecided for retry. Conflating them paints a confident chip the model
  never asserted. An untriaged ticket carries **no `repoGuess`** at all.
- `_apply_triage()` re-stamps the ledger onto tickets after every poll and merge (else chips blank
  each slow beat).
- Tests: `TestTriageCandidates`, `TestTriageFingerprints`, `TestParseTriage`, `TestJiraTriage`.

### Manual repo override

- `setJiraRepo` → `set_jira_repo()` writes a ledger entry flagged `manual`. **A human's answer
  wins**: `_triage_due` skips it; `_finish_jira_triage` drops a reply for a ticket pinned mid-batch;
  `_prune_triage_ledger` evicts manual entries **last** (a pin cannot be regenerated).
- Three answers, deliberately distinct (`auto` is a separate field, not an absent `repo`):
  `{repo:"<name>"}` pins; `{repo:null}` is a manual "no repo fits"; `{auto:true}` releases the pin,
  re-triaging with a fresh attempt budget.
- **Un-cloned repos are offerable** — name allowlist-checked host-side against that host's own
  candidates, stored repo/cloned/`nameWithOwner` read off the CANDIDATE, never the request.
  Heartbeated as `jira.repoOptions` (`_refresh_triage_candidates`) so the picker offers exactly what
  `set_jira_repo` accepts.
- `_apply_triage` re-reads clone state from CURRENT candidates rather than the stored decision — a
  pin never re-triages, so a stale `cloned:false` would outlive a clone forever. A repo absent from
  the list keeps its stored state.
- `set_jira_repo` is **idempotent** — the hub fans a pin to every host reporting that org, offline
  ones included. Writes the **agent's ledger, not the tracker**.
- A pin also decides **where a ticket session spawns**: `spawn_ticket` re-derives the repo from this
  host's ledger, where a pin outranks the model, and still re-checks `scan_repos()`.
- Tests: `TestSetJiraRepo` (incl. `test_no_agent_side_auto_start_flag`).

## Ticket sessions

- `{type:"spawnTicket", issueKey}` → `spawn_ticket()`. **The hub only ROUTES**, sending just the
  issue key; everything else re-derives from LOCAL state — repo from this host's triage ledger
  (still in `scan_repos()`), ticket from a fresh fetch.
- **The triage ledger is per-HOST, a routing input not just a lookup** (XERK-325): `findTicketHost`'s
  `hostTriagedTicket` filters the pool by each host's published `repoGuess`. A refusal here means
  routing and triage disagreed — ordinary timing, not operator error.
  - **`_apply_triage`'s three published states are the routing contract**: no entry/undecided
    publishes none; "nothing fits" publishes `repo:null`; only a decided repo is dispatchable.
    Changing which state carries `repoGuess` silently changes fleet routing.
- **Every refusal in `spawn_ticket` goes through `_refuse_start`, never a bare `log()`** (XERK-265's
  failure class) — a log-only refusal is indistinguishable from a slow spawn, spinning out the
  board's follow window. Tests: the refusal cases in `TestSpawnTicket`.
- The fetched ticket becomes the **initial prompt** (`build_ticket_prompt`: fields, description, the
  newest `TICKET_PROMPT_COMMENTS` comments, its attachments) — the session has no board creds of its
  own, so that text is all it sees.
- **A ticket's own attachments come with it** (XERK-242): downloaded into the uploads tree on
  XERK-234's terms, paths named in the prompt (`ticket_detail=`, not `prompt=`). Tests:
  `TestStoreTicketAttachments`.
- `ticket` = `{key, siteKey, url, summary, branch}` on the record, persisted and heartbeated,
  surviving kill/resume. **That record IS the ticket ↔ session link** — no hub-side ticket store;
  the board reverse-indexes the fleet payload.
- The record only answers **while it exists**; a durable `transcriptId → ticket` ledger
  (`~/.turma/jira-sessions.json`, `TICKET_LEDGER_PATH`) answers afterwards. `_remember_ticket` writes
  it in `_launch_tmux` on every launch (idempotent). `_backfill_ticket_ledger()` adopts older
  sessions (bounded `TICKET_LEDGER_MAX`), deliberately NOT pruned against on-disk transcripts — an
  archived session is still the answer. Tests: `TestTicketLedger`.
- A ticket-backed session is **named from its ticket** instead of paying a `claude -p`. A failed
  fetch raises to `handle_commands`, which logs and acks.
- **A ticket can run on the dsh OR qwen RUNTIME** (XERK-473 dsh, XERK-515 qwen): the hub's per-ticket
  runtime pin rides the command as `agentType`, which `spawn_ticket` forwards to `spawn()`
  (validated by `resolve_agent_type`, refused where that runtime is not configured) — the launch
  choke point already dispatches on it, so a dsh/qwen ticket session needs NO new launch code. The
  hub routes each only to a host offering that runtime (`.claude/rules/dsh.md` [I],
  `.claude/rules/qwen.md` [Qwen I]).
- Tests: `TestSpawnTicket` (incl. the runtime-pin cases), `TestBuildTicketPrompt`.

### Ticket branch naming

- The branch is **decided at spawn** (`_reserve_ticket_branch`) and injected into the appended
  system prompt (`TICKET_BRANCH_PROMPT`) — the -1/-2 suffix needs a branch scan the agent has no
  reason to do right.
- `next_ticket_branch` hands out the bare key, else the first free `key-1`/`key-2`/… — **filling a
  gap** left by a deleted branch rather than counting how many existed.
- **"Taken" is the union of git and the registry**: `branch_names()` reads local heads + remote
  branches (short-bounded fetch), while a session that hasn't branched YET owns its name with git
  knowing nothing — so two sessions started back-to-back aren't both told `PROJ-123`.
- **The app still creates no branch**: the worktree stays `--detach`. This decides the NAME only. A
  resume re-tells the persisted name rather than reserving a fresh one.
- Tests: `TestNextTicketBranch`, `TestBranchNames`, `TestSpawnTicket`.

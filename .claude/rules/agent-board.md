---
paths:
  - "agent/hub-agent.py"
  - "agent/tests/test_hub_agent.py"
---

# Board sources, repo triage and ticket sessions

The agent half of the board: collecting tickets from Jira or Azure DevOps, the only two writes back
to a tracker, deciding which repo a ticket belongs to, and spawning a session to work one. All of it
lives in `hub-agent.py`; the hub/UI half is `.claude/rules/turma-board.md`.

- Optional and **source-agnostic**: with Jira Cloud creds (`JIRA_SITE`/`JIRA_EMAIL`/`JIRA_TOKEN`) or
  an ADO PAT (`AZDO_URL` + `AZDO_TOKEN`, optional `AZDO_PROJECT`/`AZDO_USER`/`AZDO_API_VERSION`),
  the agent heartbeats the tickets assigned to that user into the same `jira` block.
  `source:"jira"|"azure"` rides it for the few places UI copy varies. **Azure emits the SAME wire
  contract as Jira** (XERK-43).
- **An agent serves exactly ONE org** (a host is Jira or Azure, never both).
  `board_source()`/`board_configured()`/`collect_board()`/`fetch_board_issue()`/`board_site_key()`/
  `valid_issue_key()` are the dispatch shims every gate goes through; everything downstream reads
  `self.jira` unchanged.
- Unset creds = feature off, **zero tracker HTTP**, `available:False`. Writes are only the
  operator's own create (XERK-137) and status change (XERK-138); **nothing else ever writes to the
  tracker.**
- **On-demand issue detail**: bodies are too big to heartbeat per ticket, so a `{type:"jiraIssue",
  issueKey}` command (allowlist-checked against the key grammar) makes `_stage_jira_issue` call
  `fetch_jira_issue`/`fetch_azure_issue`, staging the result onto the next beat as
  `jiraIssueResults`. **Every failure path stages a result carrying an `error` instead of raising.**
  An ADO comments-endpoint failure degrades to no comments. Rich text is flattened agent-side
  (`adf_text`/`adf_plain`; `azure_html_to_text`/`azure_plain` via stdlib `HTMLParser`), capped by
  `_shape_issue_detail` — description, the newest `JIRA_COMMENT_MAX` comments (+ `commentTotal`),
  people and labels. `collect_jira`/`collect_azure` shape the heartbeat list (`_shape_issue`) into
  `_jira_payload`.
- **Self-hosted is the point for ADO.** `AZDO_URL` is any base (`https://tfs.company.com/Collection`
  or `https://dev.azure.com/org`); PAT auth is Basic with empty username (`:PAT`).
- **siteKey keeps the org/collection PATH** (`normalize_azure_site` → `dev.azure.com/myorg`), unlike
  the Jira host-only key, else every cloud org merges into one board. Percent-encoded into
  `/api/jira/<siteKey>/...`.
- **Work-item ids are bare integers**, so `AZDO_KEY_RE`/`valid_issue_key` accept `^[0-9]+$`
  alongside `PROJECT-123`. Ticket sessions get a human branch base `<project>-<id>`
  (`ticket_branch_base`), not a bare number.
- **State → column**: Azure's per-type `stateCategory` comes from the states API when reachable
  (`_azure_state_map`, cached), falling back to a static name map then `todo` — mapping to
  todo/inprogress/done as Jira's `statusCategory` does. The raw name rides as `status`.
- Tests: `TestAdfText`, `TestShapeIssueDetail`, `TestFetchJiraIssue`, `TestStageJiraIssue`,
  `TestNormalizeAzureSite`, `TestAzureBase`, `TestCollectAzure`, `TestShapeAzureItem`,
  `TestAzureCategory`, `TestAzureHtmlToText`, `TestFetchAzureIssue`, `TestBoardSourceDispatch`.

### Writing back to the board

- `create_board_issue`/`board_create_meta`/`board_issue_types` dispatch by source
  (`create_jira_issue` POSTs `/rest/api/3/issue`, plain-text→ADF via `_text_to_adf`;
  `create_azure_issue` POSTs a JSON-Patch work item, `;`-joined `System.Tags`). Jira labels split on
  whitespace+commas, Azure tags on commas. The new ticket **self-assigns to the tracker user** so it
  lands on the board (Jira `accountId` via `/myself`; Azure the identity ladder below) —
  best-effort, and reported.
- **A refusal carries the tracker's own words; a create bends to the TYPE and IDENTITY** (XERK-151):
  - `_http_error_detail` keeps the body urllib's `HTTPError` drops, else every refusal reads "HTTP
    Error 400: Bad Request".
  - The description goes in the field the type HAS (`_azure_description_field`: the Agile/Scrum
    **Bug** has ReproSteps, not Description).
  - Assignment walks a **ladder** of spellings then unassigned, keeping the FIRST error and
    **re-sending only after a 4xx** (proof nothing was created). The best candidate is **HARVESTED,
    not guessed** — `_azure_mine_identities` reads `System.AssignedTo` off an item the board's `@Me`
    WIQL returns, ahead of the `AZDO_USER`/connection-data guesses; `_azure_identity_strings` spells
    each four ways (on-prem often takes one). Cached **empty included**, so nothing assigned yet
    falls through until one lands. An unassigned success `warning`s with the tracker's own refusal,
    never "set `AZDO_USER`" — already a candidate.
- `set_board_status` **re-reads the available options and applies only a `value` still on offer** —
  the board's workflow, not the browser, decides what a ticket can move to. It stages
  `ticketStatusResults` plus the re-fetched issue into `jiraIssueResults`.
- A drag-and-drop move POSTs the target **COLUMN**, not a transition (a board card never loaded the
  ticket's transitions): `_status_option_for_column` picks the first fresh option whose
  `_board_column(name, category)` matches; **no match refuses**. `_board_column` mirrors `board.js`
  `categoryOf` — see `CLAUDE.md`'s cross-cutting contracts.
- **An agent that predates a write command still ACKs it** (a poison command must not retry
  forever), so these commands **stage their result in the SAME `handle_commands` call** — an ack
  with no result is how the hub detects the gap. Never move the staging to a later beat.
- Tests: `TestSetBoardStatus`, `TestAzureStatusOptions`, `TestCreateAzureIssue`,
  `TestAzure*Identit*`, `TestHttpErrorDetail`, `TestBoardColumn`.

## Repo triage (`repoGuess`)

- Each heartbeated ticket carries an optional `repoGuess` — which repo that ticket's work belongs
  in.
- Decided **agent-side** by the host's already-authenticated `claude -p`, so there is **no external
  API, key, or cost env**. It runs here because this host is the only place the three inputs meet —
  board creds, scanned repos, the `gh` sweep.
- `_triage_candidates()` = the host's cloned repos (marked `[cloned]`, which the prompt prefers)
  plus every repo its `gh` login can clone. The reply is **allowlist-validated back against that
  list** by `_parse_triage`. Purely presentational; **no ticket text reaches a shell, path, or
  URL**.

### The triage ledger

- Cached in `~/.turma/jira-repos.json`, keyed `<siteKey>/<issueKey>`, so triage runs **once per
  ticket, not per beat**.
- Each entry holds two independent things and **keeping them apart is what makes the cache safe**:
  the **decision** (repo/cloned/reason/`at` + `ticketFp`/`candFp` — the question it *answers*) and
  the **attempt run** (`attempts`/`retryAt` + `tryTicketFp`/`tryCandFp` — the question being
  *asked*).
- `_triage_stale()` re-triages when the ticket's text changes (`_ticket_fingerprint`, deliberately
  **NOT** `updated`, which moves on any field edit) or the candidate set does
  (`_candidates_fingerprint` — repo names + cloned-ness ONLY; `_triage_candidates` sorts the gh tail
  by name before truncating so an `updatedAt`-ordered cut can't move the surviving names). A
  **manual pin** is the exception (`_triage_due` skips it, no attempt spent).
- **Stale means "re-triage this", never "stop showing it"** — the old answer keeps rendering until a
  replacement lands, else one clone or gh sweep blanks every chip on the board.
- **`attempts` is scoped to the question, not the ticket's lifetime** — a changed ticket/candidate
  set gets a fresh budget, else a lifetime counter permanently bans re-triage and freezes a wrong
  chip.

### Scheduling and failure handling

- `_start_jira_triage` only updates its candidates from a **successful** gh sweep
  (`self.triage_gh_repos`): `refresh_github` blanks the block to `repos:[]` on any error,
  indistinguishable from "no repos", and triaging against it would re-run the whole board twice.
- Batched (`JIRA_TRIAGE_BATCH`), **one job in flight**, attempted every beat, bounded-retry with
  backoff (`JIRA_TRIAGE_MAX_ATTEMPTS`/`JIRA_TRIAGE_BACKOFF_SEC`) **armed up-front** so a restart
  mid-batch neither loops nor loses the retries owed. Tuned by `JIRA_TRIAGE_MODEL` (default `haiku`)
  / `JIRA_TRIAGE_TIMEOUT_SEC`.
- `_parse_triage` draws a sharp line between the model's two non-answers: an **explicit `null`** is
  a verdict → `repoGuess.repo = null` ("no repo fits"), while anything **unreadable** is a **failed
  attempt** whose key is omitted, leaving the ticket undecided for retry. Conflating them paints a
  confident chip the model never asserted, left there for good since decisions aren't re-triaged. An
  untriaged ticket carries **no `repoGuess`** at all.
- `_apply_triage()` re-stamps the ledger onto tickets after every poll and merge (`collect_jira`
  builds fresh dicts, else chips blank each slow beat).
- Tests: `TestTriageCandidates`, `TestTriageFingerprints`, `TestParseTriage`, `TestJiraTriage`.

### Manual repo override

- `setJiraRepo` → `set_jira_repo()` writes a ledger entry flagged `manual`. **A human's answer
  wins**: `_triage_due` skips it; `_finish_jira_triage` drops a reply for a ticket pinned while its
  batch was in flight; `_prune_triage_ledger` evicts manual entries **last** (a pin cannot be
  regenerated).
- Three answers, deliberately distinct — which is why `auto` is a separate field, not an absent
  `repo`: `{repo:"<name>"}` pins; `{repo:null}` is a manual "no repo fits"; `{auto:true}` releases
  the pin, re-triaging with a **fresh** attempt budget.
- **Un-cloned repos are offerable.** The name is **allowlist-checked host-side against that host's
  own candidates**, and the stored repo/cloned/`nameWithOwner` are read off the **candidate**, never
  the request. That list is heartbeated as `jira.repoOptions` via `_refresh_triage_candidates` — one
  list serving the model's prompt and the board's picker, so the picker offers exactly what
  `set_jira_repo` accepts.
- `_apply_triage` re-reads clone state from the **current** candidates rather than trusting the
  decision: a pin never re-triages, so a stored `cloned:false` would outlive a clone forever. A repo
  absent from the list keeps its stored state (the list blanks on a failed gh sweep).
- `set_jira_repo` is **idempotent** — the hub fans a pin to every host reporting that org, offline
  ones included. This writes the **agent's ledger, not the tracker**.
- A pin also decides **where a ticket session spawns**: `spawn_ticket` re-derives the repo from this
  host's ledger, where a pin outranks the model, and still re-checks `scan_repos()`.
- Tests: `TestSetJiraRepo` (incl. `test_no_agent_side_auto_start_flag`).

## Ticket sessions

- `{type:"spawnTicket", issueKey}` → `spawn_ticket()`. **The hub only ROUTES**, sending just the
  issue key; everything else is re-derived from LOCAL state — the repo from this host's triage
  ledger (still in `scan_repos()`), the ticket from a fresh fetch.
- The fetched ticket becomes the **initial prompt** (`build_ticket_prompt`: fields, description, the
  newest `TICKET_PROMPT_COMMENTS` comments, its attachments) — the session has no board creds of its
  own, so that text is all it sees, which the prompt says.
- **A ticket's own attachments come with it** (XERK-242): downloaded into the uploads tree on
  XERK-234's terms, paths named in the prompt (hence `ticket_detail=`, not `prompt=`). The rules not
  to undo are on `fetch_board_attachment`. Tests: `TestStoreTicketAttachments`.
- `ticket` = `{key, siteKey, url, summary, branch}` on the record, persisted and heartbeated,
  surviving kill/resume. **That record IS the ticket ↔ session link** — no hub-side ticket store;
  the board reverse-indexes the fleet payload.
- The record only answers **while it exists**, so a durable `transcriptId → ticket` ledger
  (`~/.turma/jira-sessions.json`, `TICKET_LEDGER_PATH`) answers afterwards. `_remember_ticket`
  writes it in `_launch_tmux`, where a conversation is named, so **every** launch records it
  (idempotent; restart-clear-context adds its NEW transcript beside the old).
  `_backfill_ticket_ledger()` adopts older sessions, bounded `TICKET_LEDGER_MAX` oldest-first, and
  is deliberately **not** pruned against on-disk transcripts — one archived off this host is still
  the answer. Tests: `TestTicketLedger`.
- A ticket-backed session is **named from its ticket** instead of paying a `claude -p`. A failed
  fetch raises to `handle_commands`, which logs and acks.
- Tests: `TestSpawnTicket`, `TestBuildTicketPrompt`.

### Ticket branch naming

- The branch is **decided at spawn** (`_reserve_ticket_branch`) and injected into the appended
  system prompt (`TICKET_BRANCH_PROMPT`) — the -1/-2 suffix needs a branch scan the agent has no
  reason to do right.
- `next_ticket_branch` hands out the bare key, else the first free `key-1`/`key-2`/… — **filling a
  gap** left by a deleted branch rather than counting how many existed.
- **"Taken" is the union of git and the registry**: `branch_names()` reads local heads + remote
  branches (after a short-bounded fetch), while a session that hasn't branched YET owns its name
  with git knowing nothing — so two sessions started back-to-back aren't both told `PROJ-123`.
- **The app still creates no branch**: the worktree stays `--detach`. This decides the NAME only. A
  resume re-tells the persisted name rather than reserving a fresh one.
- Tests: `TestNextTicketBranch`, `TestBranchNames`, `TestSpawnTicket`.


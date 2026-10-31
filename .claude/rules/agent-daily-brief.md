---
paths:
  - "agent/hub-agent.py"
  - "agent/tests/test_hub_agent.py"
  - "bench/daily-brief/**"
  - "bench/tests/test_daily_brief.py"
  - "docs/daily-brief-adr.md"
---

# Daily Brief — the agent-side ticket collector (XERK-2392, epic XERK-2390)

`collect_daily_brief_data(day_from, week_from, until, projects)` returns the TURMA USER's ticket
activity for a standup window as compact JSON for a model: `closed` (tagged `day`/`week`), `open` (in
progress) and `next` (To Do candidates). Board mechanics it reuses: `agent-board.md`.

- **It is NOT the board collection and must not reuse its queries.** The board keeps Done by
  `updated`; a standup needs Done by RESOLUTION date (Jira `resolutiondate`, ADO `ClosedDate`).
- **The brief is ONE person's standup: the host's tracker user** (operator, XERK-2398). Every
  query ANDs `assignee = currentUser()` (Jira) / `[System.AssignedTo] = @Me` (ADO) onto the
  scope, the custom overrides included. An org-wide brief read every teammate's work aloud.
- **Scope = the org's projects**, `daily_brief_projects(self.jira)` (the projects this host's
  board rows live in), then the assignee clause above. Overrides: `TURMA_DAILY_BRIEF_JQL_SCOPE`
  (Jira) / `TURMA_DAILY_BRIEF_WIQL_SCOPE` (ADO), operator-set clauses used verbatim. ADO's
  `AZDO_PROJECT`, when set, wins over the board's projects. No scope → `None`, never an org-wide
  query.
  - A derived Jira project key must match `_DAILY_BRIEF_PROJECT_RE` before it is put in JQL; ADO
    names are `'`-escaped. Board rows come from the tracker, so treat them as untrusted text.
- **The window is enforced CLIENT-SIDE on the returned timestamp**, `[week_from, until)`, `day` at
  or after `day_from`. JQL dates are read in the Jira user's own timezone and WIQL compares at day
  precision, so both queries are widened by a day and must never be trusted as the boundary.
- **Closed = statusCategory done AND resolved in the window** (a reopened ticket keeps no row).
  ADO `Removed` is excluded in the WIQL.
- **Candidates are To Do work tied to what moved**: same parent as closed or in-progress work, or
  a blocker that closed in the window (from the closed ticket's `blocks`). Ranked by priority
  (`_brief_priority_rank`: Jira names, ADO `P1..P4`, unknown = Medium), then oldest `created`,
  capped at `DAILY_BRIEF_MAX_NEXT`.
- **Only OPEN blockers count, and blocked work is never a candidate** (XERK-2398 QA, live Jira):
  the shaped `blockedBy` keeps a blocker already Done, so 4 of 5 "blocked" tickets were not, and
  "unblocked by X" was read aloud while Y still held it. `_brief_open_blockers` drops a blocker
  the raw `issuelinks` (`_fields`) report Done or the brief saw closed; `open[].blockedBy` and
  `counts.blocked` use it, and a To Do ticket with any open blocker is left out of `next`.
- **ADO carries no `blockedBy`** (the board reads no ADO links), so its candidates come from shared
  parents alone. The output SHAPE is still identical (XERK-43, pinned by `test_azure_parity`).
- **This text goes to a model**: summaries only, no descriptions. `_brief_text` drops format
  chars (a zero-width split), then replaces any `scheme://`, `mailto:`/`file:`, scp-style
  `git@host:path` and `www.` with `[link]`, and any email with `[email]` — a display name can BE
  an email (ADO guests). Every list is row-capped and the whole JSON char-capped
  (`DAILY_BRIEF_MAX_CHARS`), shedding the longest list's last rows, then `scope` itself
  (`"trimmed"`); any cut sets `truncated`.
- **Next-up keys come from IN-WINDOW closed work only** (`_brief_in_window`): the widened query
  returns a day before `week_from`, which must not name parents or unblock anything.
- **`_brief_ts` pads/cuts the fraction to 6 digits**: ADO writes 1-7 and Python < 3.11's
  `fromisoformat` takes only 3 or 6, so a host on 3.9/3.10 silently dropped closed tickets.
- **Raw extra fields ride `_fields`** from `fetch_jira_issues`/`fetch_azure_items(extra_fields=)`;
  only this collector asks for them. The heartbeat calls both without, so its wire is unchanged —
  never let `_fields` reach a heartbeat ticket.
- **Blocking network I/O: call it on a worker, never the beat** (XERK-395). Tracker errors
  propagate to that worker.
- Tests: `TestDailyBrief` (window boundaries incl. a `+0400` offset, fraction lengths, URL and
  email scrubbing, candidate ranking + cap, in-window seeding, row/char/scope caps, unsafe keys in
  JQL, WIQL quoting, no `_fields` on heartbeat tickets, Azure parity). Run it on python3.9 too.

## The standup prompt (XERK-2393)

`DAILY_BRIEF_INSTRUCTION` + `daily_brief_input(data)` is the whole model input; the reply must
pass `parse_daily_brief` (sections `DAILY_BRIEF_SECTIONS`, schema `DAILY_BRIEF_SCHEMA`). Default
model `DAILY_BRIEF_MODEL`. Evidence and the model decision: `docs/daily-brief-adr.md`.

- **The input is the collector JSON and nothing else** — summaries are tracker text anyone in the
  org can write, so the prompt frames them as data. Run it under `ATTENTION_HINT_LOCKDOWN`.
- **`counts` are computed for the model, never left to it**: in the eval both Haiku and Sonnet
  misstated a 14-ticket day when counting the list themselves.
- **An unassigned ticket is credited to no one, and not called ownerless aloud** (XERK-2404):
  Haiku rarely names a plausible person, and without the line nearly always says "no owner".
  The parser cannot check either; the eval's `unassigned-work` case can, over many reps.
- **The parser rejects, never repairs**: wrong keys, markdown, a Jira-shaped key not in the data,
  an `upNext` key not in `next`, or a day/week section past `DAILY_BRIEF_WORDS_SLACK` x budget
  → None (retry). The eval scores with the same `daily_brief_problems`, so tightening one
  without the other makes the ADR's numbers stale — re-run `bench/daily-brief/run_eval.py`.
- Tests: `TestDailyBriefPrompt`; corpus/scrub: `bench/tests/test_daily_brief.py`.

## The render worker (XERK-2394)

`renderDailyBrief` → `_stage_daily_brief` (beat: validate + queue only) → ONE worker
(`_daily_brief_worker_loop`) → `_run_daily_brief` → `dailyBriefResults` outbox. Wire: the contract.

- **Collect once, then the model up to `DAILY_BRIEF_MAX_ATTEMPTS`** with backoff; the collector,
  the `claude -p` and the sleeps are all on the worker, never the beat (XERK-395).
- **The model run is `_run_lockdown_oneshot`** (the wait classifier's runner): ATTENTION_HINT_LOCKDOWN,
  cwd REGISTRY_DIR, stdin closed, mkstemp output, process group killed on timeout. Its prompt
  signature is in `INTERNAL_TOOL_PROMPT_SIGS`, so its transcript never shows as a repo.
- **A new one-shot scratch prefix goes in `ONESHOT_SCRATCH_PREFIXES`**: `_sweep_oneshot_scratch`
  drops those files at manager start, since a manager killed mid-run never removes its own.
- **Only `claude` is offered** (`daily_brief_runtimes`), and only while `claudeAuth.needsLogin` is
  false. Do not add `qwen -p` until a host run shows it can be made tool-less: the input is tracker
  text anyone in the org writes.
- **The siteKey must be this host's board** (`board_site_key`), else `failed`: the collector reads
  this host's tracker, never another org's.
- Tests: `TestDailyBriefWorker` (validation, replacement, re-delivery, retry/timeout, malformed
  output, runtime fallback, login, outbox, cleaner vectors).

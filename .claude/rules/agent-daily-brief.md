---
paths:
  - "agent/hub-agent.py"
  - "agent/tests/test_hub_agent.py"
---

# Daily Brief — the agent-side ticket collector (XERK-2392, epic XERK-2390)

`collect_daily_brief_data(day_from, week_from, until, projects)` returns the org's ticket activity
for a standup window as compact JSON for a model: `closed` (tagged `day`/`week`), `open` (in
progress) and `next` (To Do candidates). Board mechanics it reuses: `agent-board.md`.

- **It is NOT the board collection and must not reuse its queries.** The board is assignee-scoped
  and keeps Done by `updated`; a standup needs the whole org, Done by RESOLUTION date
  (Jira `resolutiondate`, ADO `ClosedDate`).
- **Scope = the org's projects**, `daily_brief_projects(self.jira)` (the projects this host's
  board rows live in), never `assignee = currentUser()`. Overrides: `TURMA_DAILY_BRIEF_JQL_SCOPE`
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

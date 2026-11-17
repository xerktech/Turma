---
paths:
  - agent/hub-agent.py
  - agent/tests/test_hub_agent.py
---

# What a session wrote to its own ticket (XERK-3034, epic XERK-3032)

The ticket-update poller must not hand a session back its own comment or status change.
`_ticket_self_authored(sess, event)` answers that from the record's `ticketWrites` ledger.

- **Author identity is useless here**: host tracker creds, the session's CLI/MCP and the
  operator are usually one account. Never replace the ledger with an author check.
- **Two sources, one ledger** (`{u, t, kind, key, id?, fp?, fields?}`, `merge_ticket_writes`):
  - the manager's close-ticket evidence comment: `add_board_comment` returns the tracker's
    comment id; the WORKER stages it as `selfWrite`, the BEAT records it (`_apply_closed_tickets`);
  - the session's own writes, folded by `_scan_ticket_write_entry` inside `_scan_entry_line`.
- **`_scan_pr_line`'s discipline**: a structured `tool_use` (Bash or an MCP tool) on an
  assistant entry, recorded only from ITS OWN non-error `tool_result` on a user entry. Prose,
  a command that prints/greps one, another tool's output and a backgrounded call never count.
  - Bash shapes are read off shlex'd COMMAND words (`ticket_writes_from_bash`): the `jira` helper,
    `acli jira workitem`, `az boards work-item update`, curl to Jira/ADO comment/edit endpoints.
    A `bash -c '…'`-wrapped write is missed — that errs toward delivering the update, never hiding one.
- **Match order**: comment id, then body fingerprint (`ticket_body_fingerprint`: tags, Markdown
  link targets, punctuation and case dropped — ADF, Markdown and ADO HTML hash alike), then an
  edit/transition of an overlapping field within `TICKET_SELF_EDIT_WINDOW_MS`. Field names use the
  `_tw_field` vocabulary (status, summary, description, assignee, labels, priority…).
- **The ledger lives on the record, never re-derived per beat**: a restart primes the scan to EOF.
  Bounded `TICKET_WRITES_MAX` (newest kept), carried on the closed record, re-seeded from the whole
  transcript on resume/migration (`_seed_ticket_writes`, beside `_seed_prs`). Never on the wire.
- Tests: `TestTicketWrites`, `test_xerk3034_*` in `TestCloseTicketRequest`.

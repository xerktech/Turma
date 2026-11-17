---
paths:
  - agent/hub-agent.py
  - agent/tests/test_hub_agent.py
---

# Ticket updates delivered into the session (XERK-3035, epic XERK-3032)

New comments and edits on a running session's ticket reach that session via `notify_session`.

- **A FETCH/DELIVER split, like the PR-comment poller** (XERK-543), on the board cadence
  (`JIRA_REFRESH_EVERY`). Never put the reads on the beat or the slow-refresh worker.
  - Beat: `_stage_ticket_update_fetch` stages `{key: {sids, full}}` (one read per ticket, however
    many sessions) and wakes the worker; `_deliver_ticket_updates` drains, baselines, filters,
    `save()`s and notifies. Both never raise onto the beat.
  - Worker: `_fetch_ticket_updates` runs `tickets_changed_since` for tickets it read before and
    `ticket_update_events` for the changed ones; `full` keys (a session with no baseline) skip
    the pre-check. Results REBOUND under `_ticket_upd_lock`.
- **`ticketUpdateBase = {key, seen}` on the record**: a missing base, or one for another key, is
  first sight → baselined SILENTLY. Resume/migration/adoption build a record without it (never
  carry it), so they baseline; a clear-context restart keeps the record, so it keeps it.
  - A failed read or pre-check (None) keeps the baseline and delivers nothing.
- **Filters, in order**: `_ticket_self_authored` (the record's `ticketWrites`, via
  `_ticket_update_self_event`), then `_ticket_update_wanted`: comments; description, summary,
  acceptance criteria, priority; an ADDED attachment; status only when it moves BACKWARDS by
  board column. A forward move or Done is never delivered: auto-stop owns Done.
  - Unknown columns read "can't tell direction" → not delivered.
- One message per session per round (`_ticket_update_message`), newest `TICKET_UPDATES_MAX`
  events, each a flattened capped line. Tracker text is third-party: framed as context to weigh,
  never as instructions; `INBOX_PREFIX` names the relay.
- Only RUNNING, non-shadow sessions whose `ticket.siteKey` is this host's board. dsh/qwen get it
  through `notify_session`'s own arms.
- `TURMA_TICKET_UPDATES=0` turns it off and drops the directive line (`TICKET_UPDATES_PROMPT`,
  "do not poll the ticket"). No heartbeat capability: nothing client-side reads it.
- Tests: `TestTicketUpdates`.

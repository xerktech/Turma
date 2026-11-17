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
  first sight.
  - Kill + resume CARRIES the base (`_remember_closed` → `resume()`), so the resumed session gets
    exactly what it never read: the unread tail before the kill and what landed while down.
    Never anchor a resume on a time instead: reads are a cadence apart, so any anchor drops
    that tail (QA). A closed record with no base anchors at its `closedAt`.
  - Migration and resume-any build a record without the base (the hub carries none), so they
    anchor at their own `createdAt`; a clear-context restart keeps the record and its base.
  - First sight baselines only events created at or before `ticketUpdateSince` (adoption, or a
    base-less resume), else `createdAt`; later ones are delivered.
  - Why: the first read lands up to a cadence after the spawn, and an operator's "also handle X"
    written in that window was otherwise lost (QA).
  - A key is marked seen only once delivery did not raise, so a failed notify retries.
  - A failed read or pre-check (None) keeps the baseline and delivers nothing.
- **Filters, in order**: `_ticket_self_authored` (the record's `ticketWrites`, via
  `_ticket_update_self_event`), then `_ticket_update_wanted`: comments; description, summary,
  acceptance criteria, priority; an ADDED attachment; status only when it moves BACKWARDS by
  board column. A forward move or Done is never delivered: auto-stop owns Done.
  - Unknown columns read "can't tell direction" → not delivered.
- One message per session per round (`_ticket_update_message`), newest `TICKET_UPDATES_MAX`
  events, each a flattened capped line. Tracker text is anyone's with access to the ticket:
  every value is quoted (`_ticket_quote`, its own `"` made typographic), author names lose
  `[`/`]`, and lines are DROPPED to fit `TICKET_UPDATE_MESSAGE_MAX` — never the closing framing.
- **Self-matching needs both sides in one vocabulary**: comment events carry `fp` of the WHOLE
  body (the read-back `body` is capped), fence language tags are ignored by
  `ticket_body_fingerprint`, and `_tw_field` falls back to `ticket_field_name`.
- Only RUNNING, non-shadow sessions whose `ticket.siteKey` is this host's board. dsh/qwen get it
  through `notify_session`'s own arms.
- The directive line (`TICKET_UPDATES_PROMPT`, "do not poll the ticket") uses the SAME check
  (`_ticket_update_key(running=False)`), so a session on another board is never promised it.
- `TURMA_TICKET_UPDATES=0` turns it off. No heartbeat capability: nothing client-side reads it.
- Tests: `TestTicketUpdates`.

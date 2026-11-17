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
  - **Deliver runs on EVERY full beat, stage only on the cadence beat** (XERK-3036): delivering
    on the cadence beat alone handed out the PREVIOUS read, so an update waited up to two
    cadences (20-28 min measured live) and a restart dropped a fetched batch. Deliver is a
    no-op while nothing is fetched.
  - Worker: `_fetch_ticket_updates` runs `tickets_changed_since` for tickets it read before and
    `ticket_update_events` for the changed ones; `full` keys (a session with no baseline) skip
    the pre-check. Results REBOUND under `_ticket_upd_lock`.
- **`ticketUpdateBase = {key, seen}` on the record**: a missing base, or one for another key, is
  first sight.
  - Kill + resume CARRIES the base (`_remember_closed` → `resume()`), so the resumed session gets
    exactly what it never read: the unread tail before the kill and what landed while down.
    Never anchor a resume on a time instead: reads are a cadence apart, so any anchor drops
    that tail (QA). `ticketUpdateSince` is carried too, so a run killed before its first read
    keeps its own anchor; only a record predating both keys anchors at its `closedAt`.
  - Migration and resume-any build a record without the base (the hub carries none), so they
    anchor at their own `createdAt`; a clear-context restart keeps the record and its base.
  - First sight baselines only events created at or before `ticketUpdateSince` (adoption, or a
    base-less resume), else `createdAt`; later ones are delivered.
  - Why: the first read lands up to a cadence after the spawn, and an operator's "also handle X"
    written in that window was otherwise lost (QA).
  - A key is marked seen only once delivery did not raise, so a failed notify retries.
  - A failed read or pre-check (None) keeps the baseline and delivers nothing.
  - **Jira status categories unread with none cached FAILS the read** (`_jira_status_categories`
    raises, XERK-3036): judged with no map a backward move read "can't tell", was marked seen and
    lost for good. A malformed reply still degrades to `{}`.
  - **`mark` on the base = the newest `created` seen** (XERK-3036): the comment read is the newest
    `TICKET_UPDATE_COMMENTS_MAX`, so deleting one slid an OLDER, never-seen comment into view and
    it was delivered as new. Events created more than `TICKET_UPDATES_SLACK_MS` before `mark` are
    history. A base without `mark` filters nothing. Residual: more than
    `TICKET_UPDATE_COMMENTS_MAX` comments between two reads drops the oldest unseen.
- **Filters, in order**: `_ticket_self_authored` (the record's `ticketWrites`, via
  `_ticket_update_self_event`), then `_ticket_update_wanted`: comments; description, summary,
  acceptance criteria, priority; an ADDED attachment; status only when it moves BACKWARDS by
  board column. A forward move or Done is never delivered: auto-stop owns Done.
  - Unknown columns read "can't tell direction" → not delivered.
  - **A still-running call's write is HELD, not delivered** (XERK-3052): its writes reach the
    ledger only with its tool_result, and a live check saw the poller hand a session its own
    comment 13s before its timed-out result landed. An event matching a pending call's write in
    the scan's `twCalls` (`_ticket_update_pending_match`; any comment while the pending body is a
    file) is neither delivered nor marked seen, nor moves `mark`, until the call resolves.
    A call older than `TICKET_PENDING_HOLD_MAX_MS` holds nothing (lost to a restart).
- One message per session per round (`_ticket_update_message`), newest `TICKET_UPDATES_MAX`
  events, each a flattened capped line.
  - The header names the CURRENT summary: a delivered-pass summary edit rewrites
    `sess["ticket"]["summary"]` (the card's field too).
  - An edit's before/after excerpts start a little before their first difference
    (`_ticket_diff_window`), else an edit past 160 chars read identical on both sides.
  - `INBOX_PREFIX` names ticket text as other people's words beside PR text.
  - Tracker text is anyone's with access to the ticket: every value is quoted (`_ticket_quote`, its own `"` made typographic), author names lose
  `[`/`]`, and lines are DROPPED to fit `TICKET_UPDATE_MESSAGE_MAX` — never the closing framing.
- **Self-matching needs both sides in one vocabulary**: comment events carry `fp` of the WHOLE
  body (the read-back `body` is capped), fence language tags are ignored by
  `ticket_body_fingerprint`, and `_tw_field` falls back to `ticket_field_name`.
- Only RUNNING, non-shadow sessions whose `ticket.siteKey` is this host's board. dsh/qwen get it
  through `notify_session`'s own arms.
- The directive line (`TICKET_UPDATES_PROMPT`, "do not poll the ticket") uses the SAME check
  (`_ticket_update_key(running=False)`), so a session on another board is never promised it.
- `TURMA_TICKET_UPDATES=0` turns it off. No heartbeat capability: nothing client-side reads it.
- Each delivering pass with news logs `ticket updates for <sid> on <key>: N new, M delivered`.
- Tests: `TestTicketUpdates`, `TestTicketUpdateEvents`.

## Host-verified (XERK-3036, 2026-11-17, agent 2.4.135-136, Jira, scratch XERK-3049)

- Ran on k8x-01 (auto-start picked the host; the hub Start route needs an operator login, the
  agent token gets 401). Same ticket-update code as TrueNAS. ADO not tested: no host has `AZDO_*`.
- Verified: an operator comment, a description edit, an added attachment and In Review → In
  Progress each delivered once, framed as quoted third-party text; forward moves and Done not
  delivered, Done auto-stopped the session; self-comments via the `jira` helper, the Atlassian MCP
  and close-ticket evidence never fed back; update restarts redelivered nothing; a live Jira 503
  caused no burst; an injection comment was quoted and refused; no slow beats.
- Two sessions on one ticket = one read, both delivered: harness only (no free slot live).
- Delivery latency was 20-28 min before the every-beat deliver fix; expect ≤ one cadence
  (`JIRA_REFRESH_EVERY` × `TURMA_INTERVAL`, ~10 min) plus the fetch.

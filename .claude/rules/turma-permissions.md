---
paths:
  - "turma/permission-ledger.js"
  - "turma/tests/permission-ledger.test.js"
  - "turma/public/usage.html"
  - "agent/hooks/permlog.py"
  - "agent/tests/test_permlog.py"
---

# The permission ledger (XERK-1563, epic XERK-1560)

Every permission prompt a session hit, how long it held the session, and the allow rule that would
retire it — so an allow-list change is measured, not guessed. Agent half in `hub-agent.py`
(`_permission_edges`, the hook-log tail) + `agent/hooks/permlog.py`; hub half in
`turma/permission-ledger.js` + `server.js` (`permissionEvents` ingest, `GET /api/permissions`,
`/metrics`); surface on `usage.html`. Android has only a `PARITY.md` line (XERK-1576 adds the screen).

## The three kinds — each has a different fix, so the row must say which

- **`dialog`** — the numbered TUI dialog (rule/manual prompt, plan approval, sandbox escape). Source:
  the `panePrompt` EDGES the beat already scrapes. `dialogKind` = `permission`/`plan`/`sandbox`/`other`
  off the dialog text (`classify_pane_dialog`; wording is the TUI's, so unknown = `other`).
  - On None→dialog the row opens and attaches the PENDING CALL: the newest `tool_use` in the
    transcript tail with no `tool_result` (`pending_tool_call`), its `head`/`digest` computed by
    permlog.py's OWN functions (`_permlog_module`) so pane and hook rows aggregate together.
  - On dialog→gone it closes: `waitedMs`, and `answer` = Turma's `answer_pane_prompt` number mapped
    through that option's label (`via:"turma"`), else the call's result (`tool_call_outcome`: a
    refusal's words → `deny`, any other result → `allow`, `via:"terminal"`), else `allow` if the pane
    went busy with no result yet (it is running), else `unknown`.
  - A `PermissionRequest` hook row merges into its dialog by `toolUseId` (its `rulesMatched`); one no
    dialog claims within `PERMISSION_HOOK_HOLD_SEC` (answered between two beats) is its own row.
  - **A dialog raised inside a foreground sub-agent** has the parent's `Agent`/`Task` call as its
    pending call (`PERMISSION_DELEGATING_TOOLS`). The sub-agent's hook row (its own `toolUseId`)
    OVERRIDES tool/head/digest/toolUseId on that row — one prompt, counted once, named by the real
    call — instead of being held and emitted as a second, mis-attributed row.
- **`classifier-denied`** — auto mode's soft block shows NO dialog: the model is told no and turns to
  the human in chat. Only the `PermissionDenied` hook sees it. A complete row on its own.
- **`ask-in-chat`** — the session ended its turn asking for permission in prose. INTERIM: a cheap
  regex (`PERMISSION_ASK_RE`) on the last assistant message, once per turn, on the agent's
  ended-turn edge (idle pane, nothing pending, last word the assistant's with no tool call); closed by
  the next operator `input` (`via:"turma"`). Sessions already sitting there on a manager's first beat
  are PRIMED, not re-filed. Replaced by the wait classifier (a later XERK-1560 child).
  - **Answered OUTSIDE Turma** (the terminal, claude.ai) it closes `via:"terminal"` once the session
    moves past the asking turn: the pane went busy, a newer `user` entry, or a NEWER ended turn. An
    open row blocks every later ask of that session, so it must not wait for a Turma `input`. A
    trailing entry of another role (a `system` line) is not an answer.
- **A session that leaves `running`** without a kill/delete (exited, errored, stopped) closes its
  open rows on the next beat (`_permission_close_departed`), as kill/delete already did.
- **Accepted: a manager restart re-files a live dialog.** `_perm_open` is in memory, so a dialog up
  across a restart stays open on the hub under its old id and is opened again under a new one.
- **A sandbox escape is not hookable at all** — the pane is its only source.
- **Open question (record the answer here):** what the TUI shows for a classifier block. The first
  week of real data answers it; until then nothing assumes it shows a dialog.

## Agent-side wire discipline (XERK-395)

- **The hook-log tail runs on its OWN worker** (`_permission_fetch_worker_loop`, the
  `_fetch_pr_comments` shape) — never on the beat, never on the slow-refresh worker. Per-file cursor
  `(inode, offset)`, worker-owned; a changed inode drains the rotated `.1` first; the first pass of a
  process PRIMES every log to EOF (a restart replays nothing). Rows are staged in
  `_permission_rows_fetched`, REBOUND under `_permission_lock`; the beat drains and owns every row.
- **The log is session-written** (Bash walks past the `Edit` deny): every read is `O_NONBLOCK` +
  `O_NOFOLLOW` + regular-file only + bounded (`_read_permission_log`, guard.py's `_read_text`
  discipline), every line re-shaped (`parse_permission_log_lines`), over-long lines skipped.
- **The pane edges read the transcript tail ONLY on an edge** — the same bounded tail read
  `session_report` already does every beat.
- **`permissionEvents`** rides the heartbeat oldest-first, at most `PERMISSION_EVENTS_MAX` (200) a
  beat, snapshotted under `_permission_lock`, cleared BY IDENTITY in `_clear_delivered_staged`, and
  NEVER shed by `_drop_on_demand_results` (a row is an event that exists nowhere else). The outbox
  is bounded (`PERMISSION_OUTBOX_MAX`, oldest dropped, logged). Rows are COPIES; an open row is sent
  again closed under the same `id`, and the hub upserts.

## Hub ingest bounds

- `permissionEvents` is a `HEARTBEAT_KNOWN_KEYS` member, extracted + deleted BEFORE the record
  spread (never stored on the record, never on `/api/agents`), and ingested AFTER every refusal gate.
- **`sanitizePermissionEvent` is a WHITELIST**: strict enums (`kind`, `dialogKind`, `answer`, `via`),
  capped strings (C0/DEL/C1 replaced — rendered and logged), `id`/`sessionId` charset-checked, finite
  times, `openedAt` required and never more than a day in the future, `closedAt >= openedAt`,
  `answerNumber` 1..9. A wrong-typed field drops to absent ("can't tell"), never a plausible value.
- Bounds: `EVENTS_PER_BEAT` (200) per beat, `PERMISSION_LEDGER_HOST_MAX_ROWS` per host (a flooding
  host cannot evict the fleet), `PERMISSION_LEDGER_MAX_ROWS` (20000) store-wide, oldest-`openedAt`
  first; `PERMISSION_LEDGER_DAYS` (30) retention.
- **And a BYTE budget**, oldest first: every cap is in chars, so a row reaches ~15 KB of UTF-8 and
  20000 of them would be a file `load()` refuses (the ledger lost at the next boot). The budget is
  the smaller of 0.9 x `PERMISSION_LEDGER_FILE_MAX` and a sixteenth of the container limit
  (`setMemoryLimit`, from server.js's `containerMemoryLimit()`, logged at boot);
  `PERMISSION_LEDGER_MAX_BYTES` may only lower it. `writeNow` trims before writing as a backstop, so a
  written file always loads.

## The suggestedRule table — deterministic, never a judgement

| Row | Rule |
|-----|------|
| `ask-in-chat` | `model behaviour: see CLAUDE.md step 0` |
| `dialog` `sandbox` naming a host | `sandbox.network.allowedDomains: <host>` |
| `classifier-denied` | `autoMode.environment: allow <tool rule>` (else the deny reason's subject) |
| Bash | `Bash(<head>:*)` |
| MCP | the full `mcp__<server>__<tool>` |
| WebFetch | `WebFetch(domain:<d>)` |
| a plan approval, a file path, anything else | none |

`head` = the Bash command's first word, two for a subcommand CLI (`git push`, `npm test`), leading
`VAR=x` skipped; the file path; the MCP tool name; the WebFetch domain. The LLM judge (XERK-1566)
consumes this table; it does not replace it.

## Persistence

- **Non-HA: a `/data` file** (`PERMISSION_LEDGER_FILE`), the usage-ledger FILE skeleton — measured
  before it is read, re-sanitized on load, debounced write, flushed on graceful shutdown. HA `/data` is
  a per-pod emptyDir, so this is NON-HA only.
- **HA: a Postgres APPEND table** (`permission_event(host, id, opened_at, doc)`, PK `(host, id)`) via
  the hub's shared `pgclient.js` pool; upsert by `(host, id)`, retention `DELETE` hourly, rescanned on
  the pool's ready edge and on LEADER PROMOTION (`rehydrate()` in `onLeaderPromoted`). Writes are
  queued and drained off the request path, bounded (`PG_QUEUE_MAX`, oldest dropped).
  **Never `registerExternalStore`** — rows churn every beat.
  - **A failed write is put BACK and retried** (next write or the ready edge, which drains BEFORE it
    rescans). Dropping it let a rescan read the stale OPEN copy over a hot CLOSED row, and the agent
    sends a closed row once — the close was lost in both places.
  - **The rescan is newest-wins, never a blind replace**: a hot row further along (`rowProgress`:
    closed > open, then has `rulesMatched`) is kept and re-queued so the table catches up.
  - **One INSERT never carries the same `(host, id)` twice** — Postgres refuses ("cannot affect row a
    second time") and an outage backlog holds a row open AND closed; the batch keeps the last copy.
- **Aggregates are computed from the hot in-memory model in both modes**, not by SQL `GROUP BY` —
  the usage ledger's "read model stays hot + synchronous" posture. Under XERK-919 the leader receives
  every beat and serves every read, and a promoted standby rescans, so the model is complete where
  it is read. (Deviation from the ticket's "PG-served aggregates", recorded in the PR.)

## Serving

- **`GET /api/permissions?org=<site>[,<site>]&days=7`** (user-authed) → `{days, top, recent}`; `top`
  = groups by `(kind, dialogKind, tool, head)` with `count/allowed/denied/medianWaitMs/lastAt/
  suggestedRule`, most frequent first. **Org-scoped off the LIVE fleet** (hosts currently declaring
  one of those orgs, like `retiredUsage`), so a removed host's rows show only under "All orgs".
- **Groups are fleet-wide, not per host** — a deliberate deviation from the ticket's
  `(host, kind, tool, head)`: one allow rule retires a prompt on every host, so per-host groups would
  split one fix into N rows. The host rides each `recent` row; scope by org to narrow.
- **`/metrics`** (UNAUTHENTICATED) appends `turma_permission_prompts{kind}` and
  `turma_permission_wait_seconds{kind}` — per-kind aggregates over the retention window ONLY;
  never a host, session or command. **GAUGES, not counters**: they fall as rows age out, and
  Prometheus reads a counter's drop as a reset (false `rate()` spikes).
- **`usage.html`'s "Permission prompts (7 days)"** card reads its own route (not `/api/agents`), so
  the beat's SSE patches never repaint it; refetched on load, on an org-filter change and every 60s.
  Every agent-supplied field is escaped; each rule has a Copy button.
  - That repaint goes through `TurmaNav.preserveScroll` and re-applies "Recent prompts"' open state
    (`permRecentOpen`, caught on capture — `toggle` does not bubble); an unchanged card is not
    repainted. A fresh `<details>` defaults closed, which snapped it shut once a minute.

## Tests

`test_permlog.py` (event shapes, bounds, fail-open incl. FIFO/symlink, rotation, `-SsE`);
`TestPermissionLedgerEdges` + `TestPermissionLogTail` (`test_hub_agent.py`); the `test_guard_settings.py`
pins (deny equality, every-hook-event `-SsE`, the PreToolUse matcher list); `permission-ledger.test.js`
(ingest bounds, aggregates, the rule table, scoping, file + fake-Postgres backends); the `XERK-1563:`
cases in `server.test.js` (ingest, org scoping, auth, `/metrics`) and `usage.test.js` (the card).

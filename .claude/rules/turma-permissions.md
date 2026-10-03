---
paths:
  - "turma/permission-ledger.js"
  - "turma/tests/permission-ledger.test.js"
  - "turma/public/usage.html"
  - "turma/server.js"
---

# The permission ledger (XERK-1563, epic XERK-1560)

Every permission prompt a session hit, how long it held the session, and the allow rule that would
retire it — so an allow-list change is measured, not guessed. Agent half in `hub-agent.py`
(`_permission_edges`, the hook-log tail) + `agent/hooks/permlog.py`; hub half in
`turma/permission-ledger.js` + `server.js` (`permissionEvents` ingest, `GET /api/permissions`,
`/metrics`); surface on `usage.html`. Android has only a `PARITY.md` line (XERK-1576 adds the screen).
This file is the HUB + web half; the agent half (row kinds, dialog edges, the hook merge, the
beat discipline) is `.claude/rules/agent-permissions.md`, scoped to the agent files it governs.

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
- **A newer `dialog` row for a session closes that session's older OPEN dialog row on the same host**
  (`closeSuperseded`, `answer`/`via` "unknown", no `waitedMs`). A pane shows one dialog at a time and
  the agent closes before it opens, so only a lost row (a manager restart) is still open — else it
  reads "open" for 30 days. A real closed copy arriving later replaces it by id.
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
| `classifier-denied` | `autoMode.environment: allow <tool rule>`; NONE without a tool rule |
| Bash | `Bash(<head>:*)`; NONE for an interpreter/wrapper/keyword head, a bare subcommand CLI, a malformed one |
| MCP | the full `mcp__<server>__<tool>` |
| WebFetch | `WebFetch(domain:<d>)` |
| a plan approval, a file path, anything else | none |

- **A classifier block with no tool rule gets NO rule** — a sentence lifted from its deny reason
  pastes nowhere. Its group carries `denyReason` instead, shown as the "why" under "no rule".
- The ask-in-chat entry is a pointer, not a setting: the card shows it as text with no Copy.
- **Never an allow-everything Bash rule** (`BASH_NEVER_HEADS`): `Bash(python3:*)`, `Bash(sudo:*)`,
  `Bash(env:*)`… run whatever follows. A head outside `BASH_HEAD_RE` (`(cd`, a glob) would be a
  malformed rule. Both get no rule — the table is copied verbatim, and XERK-1566 consumes it.
- **The never-list names each exec under EVERY spelling**: an alias or parent noun heads as itself
  (`docker container run` → `docker container`, `docker compose run` → `docker compose`, `npm x`,
  `yarn exec`, `go run`), and a wrapper/runner whose head is the bare CLI (`stdbuf`, `nsenter`,
  `poetry`, `conda`) covers its argument. Add a new exec form here, with a test row, as it is found.
- **A versioned or `.exe` interpreter binary is its family** (`bashFamily`): `python3.11`, `php8.2`,
  `node22`, `python.exe` are checked with the version/`.exe` cut. Over-matching only withholds a rule.
- **Nor a BARE subcommand CLI** (`git`, `docker`, `kubectl`, `make`…; `SUBCOMMAND_CLIS`, a
  parity-tested mirror of permlog.py's set). permlog keeps the subcommand only as the SECOND word, so
  `git -C /repo push` / `kubectl -n prod exec` head as the bare CLI, whose rule allows every
  subcommand — the never-listed `docker run`/`kubectl exec` and `git -c alias.x='!sh'` included.

`head` = the Bash command's first word, two for a subcommand CLI (`git push`, `npm test`), leading
`VAR=x` skipped; the file path; the MCP tool name; the WebFetch domain. The LLM judge (XERK-1566)
consumes this table; it does not replace it.

## Persistence

- **Non-HA: a `/data` file** (`PERMISSION_LEDGER_FILE`), the usage-ledger FILE skeleton — measured
  before it is read, re-sanitized on load, debounced write, flushed on graceful shutdown. HA `/data` is
  a per-pod emptyDir, so this is NON-HA only.
- **HA: a Postgres APPEND table** (`permission_event(host, id, opened_at, progress, doc)`, PK `(host, id)`) via
  the hub's shared `pgclient.js` pool; upsert by `(host, id)`, retention `DELETE` hourly, rescanned on
  the pool's ready edge and on LEADER PROMOTION (`rehydrate()` in `onLeaderPromoted`). Writes are
  queued and drained off the request path, bounded (`PG_QUEUE_MAX`, oldest dropped).
  **Never `registerExternalStore`** — rows churn every beat.
  - **A failed write is put BACK and retried** (next write or the ready edge, which drains BEFORE it
    rescans). Dropping it let a rescan read the stale OPEN copy over a hot CLOSED row, and the agent
    sends a closed row once — the close was lost in both places.
  - **The rescan is newest-wins, never a blind replace**: a hot row further along (`rowProgress`:
    closed > open, then has `rulesMatched`) is kept and re-queued so the table catches up. A hot row
    the table lacks entirely (trimmed past `PG_QUEUE_MAX`) is re-queued too — but only by a replica
    that holds it; one that never did cannot, so a long outage past the cap can still lose rows.
  - **The upsert is MONOTONE** (`WHERE EXCLUDED.progress >= permission_event.progress`, `progress` =
    `rowProgress`): a late retry of an OPEN copy (an old leader's ready edge after a handover) never
    reverts a CLOSED row. Equal progress → the newer write wins.
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
- **An `ask-in-chat` group is keyed on its QUESTION** (`askKey`: letters only, lower-cased, capped
  at `ASK_KEY_MAX`), since it has no tool or head — keyed without it, every ask merged into one
  generic row. The group serves its newest `prompt` as the subject and `allowed`/`denied` = `null`
  (an ask is answered in prose; 0/0 would read "ignored"), which the card renders as "—".
- **Each group also serves `open`** = rows with no `closedAt` AND no `answer` (still holding a
  session). A group whose every row is open renders "open", never 0/0 ("asked and ignored"); a mixed
  one appends "· N open". A never-closed row WITH an answer (a request answered between beats) is
  not open. An older hub without `open` keeps the plain answers.
- **A `recent` ask-in-chat row is served WITHOUT `answer`** (its stored `unknown` is not an answer):
  the table shows "—" for its group, so the recent list must not say "unknown" for it either.
- **Groups are fleet-wide, not per host** — a deliberate deviation from the ticket's
  `(host, kind, tool, head)`: one allow rule retires a prompt on every host, so per-host groups would
  split one fix into N rows. The host rides each `recent` row; scope by org to narrow.
- **`/metrics`** (UNAUTHENTICATED) appends `turma_permission_prompts{kind}` and
  `turma_permission_wait_seconds{kind}` — per-kind aggregates over the retention window ONLY;
  never a host, session or command. **GAUGES, not counters**: they fall as rows age out, and
  Prometheus reads a counter's drop as a reset (false `rate()` spikes).
- **`usage.html`'s "Permission prompts (7 days)"** card reads its own route (not `/api/agents`), so
  the beat's SSE patches never repaint it. Every agent-supplied field is escaped; each rule has a Copy
  button.
  - **Its first fetch waits for the first render's `TurmaOrg.update`** (`syncPermissionsScope`):
    before it org.js knows no sites, `getKeys()` is `[]` and the fetch would be fleet-wide under a
    scoped header — and `update()` never notifies, so nothing would refetch. Each render refetches
    when the org keys moved (`permFetchedKeys`); the 60s refresh runs only once scoped.
  - **Below 600px each group reflows to a stacked block** (CSS only, same markup): kind + subject;
    one line of count / answers / wait (`data-label`); the rule + Copy on its own line. No sideways
    scroll — the sticky Prompt column used to cover the rule column on a phone.
  - **A recent row's host · wait · age ride ONE `.perm-meta` group, host first** (an empty part is
    dropped, not left as a blank slot); below 600px that group takes a full line, so the host always
    starts the second line. Loose spans put the host in a different place row to row.
  - **Only a command/tool subject (`.perm-subj.cmd`) breaks mid-token**; an ask's question is prose
    and wraps between words.
  - That repaint goes through `TurmaNav.preserveScroll` and re-applies "Recent prompts"' open state
    (`permRecentOpen`, caught on capture — `toggle` does not bubble). A fresh `<details>` defaults
    closed, which snapped it shut once a minute.
  - An unchanged card is not repainted: the skip compares the last PAINTED string (`permPainted`),
    never `$perms.innerHTML`, which a browser re-serializes (`open` → `open=""`) so it never matched.

## Tests

Agent-side tests are listed in `agent-permissions.md`. `permission-ledger.test.js`
(ingest bounds, aggregates, the rule table, scoping, file + fake-Postgres backends); the `XERK-1563:`
cases in `server.test.js` (ingest, org scoping, auth, `/metrics`) and `usage.test.js` (the card).

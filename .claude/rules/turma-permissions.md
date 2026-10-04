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
`/metrics`); surface on `usage.html`, ported to Android's Usage screen (XERK-1576, `android.md`).
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
- A host also keeps at most a QUARTER of the byte budget, oldest first. The row share alone does not
  protect the fleet: the binding limit is bytes, and a host's row share of max-size rows fills most of
  it. Tests: `one host's max-size rows cannot push another host's rows out`.
- **The hub closes rows the agent lost** (a manager restart forgets its open rows), each with
  `answer`/`via` "unknown" and no `waitedMs`; a real closed copy arriving later replaces it by id.
  Else a lost row reads "open" for the 30-day window.
  - `closeSuperseded`, on the same host: a newer `dialog` row for a session closes that session's
    older OPEN dialog row (a pane shows one dialog at a time and the agent closes before it opens);
    ANY newer row for a session closes its older OPEN `ask-in-chat` row (the session ran past it).
    `closedAt` = the newer row's `openedAt`. A dialog is never closed by an ask or a classifier row.
  - `ageOut`, on EVERY host at every ingest, `load()` and rescan: a row open past `OPEN_MAX_MS` (24h)
    closes with `closedAt` = now. This is what closes a lost row whose session never files again (a
    session deleted while the manager was down, a host gone). A prompt really open that long reads
    closed-unknown until the agent's own close arrives.
- **And a BYTE budget**, oldest first: every cap is in chars, so a row reaches ~15 KB of UTF-8 and
  20000 of them would be a file `load()` refuses (the ledger lost at the next boot). The budget is
  the smaller of 0.9 x `PERMISSION_LEDGER_FILE_MAX` (16 MiB) and a SIXTY-FOURTH of the container
  limit (`setMemoryLimit`, from server.js's `containerMemoryLimit()`, logged at boot; an unknown limit
  is budgeted as the deployed 512m); `PERMISSION_LEDGER_MAX_BYTES` may only lower it. `writeNow` trims
  before writing as a backstop (`fileBytes`, from the cached row sizes), so a written file always loads.
  - **Sized from the XERK-287 margin, not the container** (`turma-limits.md`): 8 MiB at 512m. At 1/16
    the store plus a save's whole-file string was ~69 MiB — the whole margin. Typical rows fit ~8k.
  - **A save streams**: `writeSnapshot` writes chunks (`SAVE_CHUNK_CHARS`) to `<file>.tmp` and renames
    it over the ledger, so no second whole copy sits on the heap and a crash mid-save keeps the old
    file. One save at a time; saves asked for meanwhile share ONE follow-up save.
  - A failed rename deletes the `.tmp`; never write the ledger in place. Tests: `a save that fails
    before its rename leaves the previous file whole`.

## The suggestedRule table — deterministic, never a judgement

| Row | Rule |
|-----|------|
| `ask-in-chat` | `model behaviour: see CLAUDE.md step 0` |
| `dialog` `sandbox` naming a host | `sandbox.network.allowedDomains: <host>`; no readable host → NONE plus `noRuleReason` |
| `classifier-denied` | `autoMode.environment: allow <tool rule>`; NONE without a tool rule |
| Bash | `Bash(<head>:*)` ONLY for a head on the allowlist; any other head gets NONE plus `noRuleReason` |
| MCP | the full `mcp__<server>__<tool>` ONLY (`MCP_TOOL_RE`); anything else NONE plus `noRuleReason` |
| WebFetch | `WebFetch(domain:<d>)` |
| a plan approval, a file path, anything else | none |

- **A classifier block with no tool rule gets NO rule** — a sentence lifted from its deny reason
  pastes nowhere. Its group carries `denyReason` instead, shown as the "why" under "no rule".
- The ask-in-chat entry is a pointer, not a setting: the card shows it as text with no Copy.
  - Each ask row reads "Instructions, not a setting — see the note below"; ONE note under the
    table (`PERM_BEHAVIOUR_NOTE`) names the fix: step 0 of "Delivering work" in each host's global
    `~/.claude/CLAUDE.md`. The hub's terse pointer repeated per row told the operator nothing.
- **Never an allow-everything Bash rule, by construction: a POSITIVE allowlist.** `BASH_SAFE_HEADS`
  (single words: `ls`, `cat`, `grep`, `jq`…) and `BASH_SAFE_SUBCOMMANDS` (`git status`, `gh search`,
  `docker ps`…) are the ONLY Bash heads that get `Bash(<head>:*)`. A prefix rule allows the head with
  ANY arguments, so a head is listed only when no argument it takes can run code. Every other head —
  an interpreter, shell, wrapper, runner, unknown CLI, a path to a binary — gets `null`.
  - **A deny list cannot be the safety**: an open list always misses a spelling (`pkexec`,
    `podman exec`, `xonsh`, `firejail`, `sed -e`). `BASH_NEVER_HEADS` stays only as a SECOND check
    and to word the reason; a versioned/`.exe` binary is its family there (`bashFamily`).
  - **Left off on purpose** (an argument runs a command or writes any file): `git diff`/`log`/`show`
    (`--output`), `git fetch`/`pull`/`push` (`--upload-pack`/`--receive-pack`), `git rebase`
    (`--exec`), `kubectl get` (`--kubeconfig` exec plugin), `npm test`/`run` (`--node-options`,
    `--script-shell`), `go test` (`-exec`), `cargo` (`--config`), `make` (variable overrides), `find`,
    `rg` (`--pre`), `sort` (`--compress-program`). Add a head only with its argument surface checked,
    and a test row. Missing one only withholds a suggestion.
  - **A subcommand GROUP is off too**: a two-word head's rule covers every verb under it. `gh pr`/
    `glab mr` (`merge --admin` past branch protection, `checkout -R` runs another repo's hooks),
    `gh run` (`download -D` writes any dir), `gh issue`/`glab issue` (tracker writes), `git commit`/
    `switch`/`add`/`branch` (session-editable hooks, `branch -D`). A per-verb rule (`gh pr view`)
    needs a three-word head permlog.py does not emit yet.
  - **A no-rule Bash group serves `noRuleReason`**, WHY there is none (runs whatever follows it / a
    path / a bare subcommand CLI / not on the read-only list / not a plain command name). The card
    shows "no safe rule — review it" over the reason, with NO Copy button. Groups with
    no rule for another reason (a plan, a file path) serve no `noRuleReason`. `ruleVerdict` returns
    both; `suggestedRule` is its rule. XERK-1566's judge reads this table's shape unchanged.
- **Every rule is built from a fixed shape, never echoed.** `tool` is agent-supplied (a session can
  write its hook log with Bash), so an MCP rule needs a FULL `mcp__<server>__<tool>`: a bare
  `mcp__github` or `mcp__github__*` would allow every tool on that server.
- **A sandbox prompt never gets the call's Bash rule** — no tool allow rule retires a sandbox
  NETWORK prompt, so one with no readable host gets none.
  - A head outside `BASH_HEAD_RE` (`(cd`, a glob) would be a malformed rule; a BARE subcommand CLI
    (`git`, `docker`; `SUBCOMMAND_CLIS`, a parity-tested mirror of permlog.py's set) says nothing
    about what ran — permlog keeps the subcommand only as the SECOND word, so `git -C /repo push`
    heads as `git`.

`head` = the Bash command's first word, two for a subcommand CLI (`git push`, `npm test`), leading
`VAR=x` and leading `cd <dir>` segments skipped (`cd` only when nothing follows); the file path;
the MCP tool name; the WebFetch domain. The LLM judge (XERK-1566) consumes this table; it does not
replace it.

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
  - **A failed read with no view yet paints "Could not load … (HTTP n)"**, never an endless
    "Loading…"; a failed REFRESH keeps the last view silently.
  - **Below 600px each group reflows to a stacked block** (CSS only, same markup): kind + subject;
    one line of count / answers / wait (`data-label`); the rule + Copy on its own line. No sideways
    scroll — the sticky Prompt column used to cover the rule column on a phone.
  - An answered ask's "—" answers cell is hidden there (`perm-stat-na`); an all-open group reads
    "still open", so the label never sits over a bare "—" or "open".
  - **A rule and its Copy share one flex line (`.perm-rule-line`) at every width**: the rule shrinks
    and wraps inside its box, Copy keeps its place beside it. An inline-block rule at 100% width
    pushed Copy under a long rule (`sandbox.network.allowedDomains: …`) and broke the column.
    `permRuleCodeHtml` adds `<wbr>` after `(` and a value-starting `:`, so a narrow box wraps there,
    not mid-name; Copy copies the raw rule.
  - **A classifier block's "why" is its `denyReason` ALONE.** `noRuleReason` (served for its Bash
    head) is about Bash allow rules, not why the classifier said no; it shows only with no deny reason.
  - **A recent row's host · wait · age ride ONE `.perm-meta` group, host first** (an empty part is
    dropped, not left as a blank slot); below 600px that group takes a full line, so the host always
    starts the second line. Loose spans put the host in a different place row to row.
  - **Only a command/tool subject (`.perm-subj.cmd`) breaks mid-token**; an ask's question is prose
    and wraps between words.
  - **An ask's question is the session's markdown, rendered** (`permProseHtml`): escaped first, then
    `code` spans become `<code>` and `**` markers drop, in ONE pass; `__` is left alone
    (`__init__.py`). An unpaired marker stays as typed. A command subject is never read as markdown.
  - That repaint goes through `TurmaNav.preserveScroll` and re-applies "Recent prompts"' open state
    (`permRecentOpen`, caught on capture — `toggle` does not bubble). A fresh `<details>` defaults
    closed, which snapped it shut once a minute.
  - An unchanged card is not repainted: the skip compares the last PAINTED string (`permPainted`),
    never `$perms.innerHTML`, which a browser re-serializes (`open` → `open=""`) so it never matched.

## Tests

Agent-side tests are listed in `agent-permissions.md`. `permission-ledger.test.js`
(ingest bounds, aggregates, the rule table, scoping, file + fake-Postgres backends); the `XERK-1563:`
cases in `server.test.js` (ingest, org scoping, auth, `/metrics`) and `usage.test.js` (the card).

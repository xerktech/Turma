---
paths:
  - "turma/server.js"
  - "turma/tests/server.test.js"
  - "agent/hub-agent.py"
  - "bench/run_policy.py"
  - "bench/run_bench.py"
  - "bench/tests/test_policy.py"
  - "turma/public/board.js"
  - "android/app/src/main/java/com/xerktech/turma/core/Board.kt"
---

# Ticket model ladder (XERK-1827)

An UNPINNED claude ticket session starts on haiku; each start after a session of that ticket ENDED
UNDELIVERED runs one tier up (haiku → sonnet → opus, capped). Evidence: `docs/routing-spike-phase2-3.md`.

- **Per session, never per turn.** A mid-conversation switch makes the new model re-cache every
  turn it missed (the spike's -8.2% vs -36.3%). Never route inside a session from this.
- **The ladder is DERIVED, not stored** (`ticketLadderPick`): a ticket session no longer running,
  with no PR (`prs`/`prUrls`) and no close-ticket `outcome`, is a failed attempt on its `model`.
  - A live `error`/`queued` record is not finished (Start resumes an error; it holds its slot), so
    a failed clone or launch never climbs the ladder. A paused sleeper is waiting, not failed.
  - Only ladder aliases count: a model-less session (an older agent, a pre-ladder login-default
    session) is no evidence, so forgotten closed history only ever costs a cheaper retry.
  - Read only on hosts DECIDED into the ticket's org (`decidedOrgOf`) — the served `org` the
    board's port filters on; `boundOrgOf` there made the row say Haiku while a drifted host's
    history made Start send Sonnet.
  - Known over-count: a PR opened outside `_scan_pr_line` attribution, or a migration's killed source
    record, reads as an undelivered attempt (rollup).
  - Needs the agent's `closedSessions[].model` (added for this); `normalizeClosedSessions` keeps it
    only as a plain alias.
- **Read at DISPATCH by both spawn sites** (`ticketSpawnModelFields`: Start route + queue drain).
  The operator's model pin wins; a dsh/qwen runtime pin gets nothing, and neither does an unpinned
  ticket routed to a host whose `defaultRuntime` is not claude (a qwen host would send `haiku` to
  its OpenAI endpoint as `OPENAI_MODEL`).
- **A retry carries `escalatedFrom`**; the agent appends `TICKET_RETRY_DIRECTIVE` to the prompt
  (charset-checked like a model alias). The bench's `RETRY_PREAMBLE` mirrors it minus the branch
  sentence.
- **Escalation happens on the NEXT start only.** Auto-start never re-dispatches a ticket that has
  any session (`startedTicketKeys`), so a failed ticket is retried by an operator Start or the
  queue — nothing auto-restarts it, and nothing kills a running session for it.
- `TICKET_MODEL_LADDER` (hub env, comma aliases) replaces the ladder; `off` restores the login
  default for unpinned tickets — the rollback lever.
- **Ticket sessions' sub-agents default to haiku** (`CLAUDE_CODE_SUBAGENT_MODEL`,
  `TURMA_TICKET_SUBAGENT_MODEL`, "" = off) — never for a local-model session or over an operator's
  own setting; an agent definition naming its own model still wins.
- **The replay gate**: `bench/run_policy.py` runs `ladder` and `always-opus` over the 25 `turma-*`
  tasks and prints solve rate + dollar cost side by side. Its `ladder` must equal
  `TICKET_MODEL_LADDER_DEFAULT` (`TestPolicyMatchesHub`). Re-run it for any ladder change.
  - Each policy gets its own workroot + runs dir: two policies on one tier/task otherwise share
    and wipe a worktree under `--jobs >1`.
  - Delivered = tests green AND committed. An infra/setup failure ends the walk unscored.
  - Usage is reduced per `requestId` to the max of each counter (output is cumulative on the last
    line) — summing lines over-counts.
  - Needs a gateway key (`TURMA_LOCAL_API_KEY`); run the cloud models `--jobs 1` (429s otherwise).
- **The board mirrors the pick** (XERK-1830): `/api/agents` serves `ticketModelLadder`, and
  `board.js`/`Board.kt` `ladderPickOf` re-derive each ticket's tier for the Model row. Change the
  delivered/failed rule or the runtime exclusions here → change both ports (`turma-board.md`).
  - Client-side, not a served per-ticket map: with SSE healthy the board never re-reads
    `/api/agents`, so a served map goes stale; per-agent SSE keeps the sessions it reads live.
  - No ladder served (older hub, or `off`) → the old "Default (<probed>)" row.
- Tests: `XERK-1827:` in `server.test.js`; `test_a_ladder_retry_*`/`test_*subagent*`/
  `test_an_ended_ticket_session_reports_its_model` in `TestSpawnTicket`; `bench/tests/test_policy.py`.

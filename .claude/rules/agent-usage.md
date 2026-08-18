---
paths:
  - "agent/hub-agent.py"
  - "agent/hooks/statusline.py"
  - "agent/tests/test_hub_agent.py"
  - "agent/tests/test_statusline.py"
---

# Usage aggregates, the attribution ledger and subscription limits

The agent half of the Usage page: how much this host SPENT (token aggregates re-parsed from every
transcript, and the ledger that keeps them attributable after a session is gone) and how much of the
Claude subscription is LEFT (the 5h/7d windows, which only Claude Code can answer). All of it lives
in `hub-agent.py` plus `hooks/statusline.py`; the hub/UI half is `.claude/rules/turma.md`.

## Usage aggregates and the attribution ledger

- The heartbeat carries **usage aggregates independent of the live registry** — per-repo
  `repoUsage[]` and host-level `usage`, from re-parsing *every* known transcript
  (`repo_usage_report()`). Each entry carries a `remoteKey` (`normalize_remote()`) so the hub can
  unify a repo across hosts.
- **A slug's transcripts are BOTH the conversations and the background agents' own**
  (`_project_transcripts`, XERK-302): `<slug>/<id>.jsonl`, plus `<slug>/<id>/subagents/agent-<x>.jsonl`
  and a Workflow run's `subagents/workflows/wf_<run>/agent-<x>.jsonl`. Reading only the flat listing
  left **every delegated token uncounted** — 19% of one host's real spend, rising with how much the
  fleet delegates.
  - The nesting under `subagents/` is Claude Code's and has already grown a level, so it is
    **walked**, never hard-coded at either depth; and it is anchored on the `subagents` dir, not on
    the parent transcript still existing (the tokens were spent either way).
  - **Offsets key on the RELATIVE path**, never the bare filename: two parents' agents routinely
    share `agent-<x>.jsonl`, and a name-keyed map silently skips one of them.
  - Delegated tokens fold into `totals`/`days`/`models` like any other turn and are counted a second
    time into **`usage.subagent`** ({totals, today, week}) — a **SLICE**, never an addend, so no
    client adds it back. `sessions` still counts CONVERSATIONS only, else it inflates by the fan-out.
  - Absent `subagent` = "that agent can't tell you"; a zeroed one asserts nothing was delegated —
    and a genuine all-zero report must survive, or a non-delegating host is excluded and the share
    OVER-states. The Usage page divides by these, so `normalizeSubagentUsage` **validates and drops,
    never repairs**: a repaired block is indistinguishable from that genuine zero, so `{}` or
    `{totals:{input:"9"}}` would land in the denominator with a fabricated 0 on top. Figures must be
    non-negative SAFE INTEGERS — a float or a `1e308` decodes into a Kotlin `Long` and fails the
    whole `/api/agents` array.
  - **Every token figure is coerced where it leaves the transcript** (`_token_count`, XERK-306).
    A figure travels untouched to a Kotlin `Long` on Android, where a float or an out-of-range one
    fails the decode of the WHOLE `/api/agents` array and empties every OTHER host from that phone's
    fleet list; a string raised straight out of `_add_tokens`, costing this host its whole report.
    Unusable counts as 0, a FRACTIONAL one truncates (the count is real, only its type is wrong),
    and a bool is not a count. The hub coerces again at ingest because it must survive any agent.
  - **Only REGULAR FILES are enumerated, on both branches.** A `*.jsonl` directory would read as a
    conversation and skip its own `subagents/` tree; a FIFO named `*.jsonl` blocks a read forever,
    on the heartbeat's critical path. Nothing in the walk raises — an escape there is a host that
    reads offline.
  - `repo_usage_report` gates the host block on **tokens OR conversations**: `sessions` counts
    conversations, so a slug left holding only a pruned session's `subagents/` tree has real spend
    and a zero count, and gating on the count alone reported per-repo usage beside a null host block.
  - Tests: `TestSubagentUsage`, `subagentCard` in `usage.test.js`, the split cases in
    `UsageViewModelTest`.
- The per-model breakdown **excludes `<synthetic>`** (and any `<...>` model): Claude Code stamps
  fabricated entries with that model and an all-zero usage block, so `_accumulate_usage` keeps them
  out of `acc.models`, else the usage page lists a phantom model that ran nothing. Their tokens
  still fold into the grand totals. Mirrors `_scan_model_entry`'s guard.
- A durable worktree→{repo, remote, slug} **attribution ledger** (`~/.turma/repo-usage.json`) keeps
  a transcript traceable after its session and worktree are gone, so **usage history survives
  kill/delete/prune**. Written at spawn (`_remember_usage`), backfilled from registry/closed
  history, reconciled each usage beat by `_reconcile_orphan_transcripts()`, pruned only when a
  transcript dir disappears. `repo_usage_report()` folds only slugs the ledger names, so
  **reconciliation is what makes it cover every transcript on disk**.
- Orphans are adopted best-effort in order: (1) exact repo + git origin when the worktree exists;
  (2) the repo from the worktree-shaped slug; (3) the repo from the transcript's recorded `cwd`
  (`_repo_from_transcript_cwd`); (4) the root bucket (`ROOT_REPO_NAME`) — **there is no "(other)"
  bucket**.
- **A derived name (case 2/3) only stands when it names a repo this host scans** (XERK-147): both
  heuristics are lossy and unvalidated they mint phantom repos. `_sanitize_junk_repo_entries`
  retires persisted junk the same way each beat (a stored name stands only with a recorded git
  remote or a scanned repo), and is a **no-op when the repo scan is empty** so an unreadable
  `REPOS_ROOT` can't fold real history into root.
- **No real session is excluded.** The one carve-out is the manager's OWN internal `claude -p`
  helpers (naming, triage, models probe), which run with `cwd=REGISTRY_DIR` yet write into the
  shared projects dir — else the reconciler adopts the agent's overhead as a phantom repo (XERK-27).
  `_is_internal_tool_slug` knows them by the registry dir's slug, or a harness's temp slug via
  `INTERNAL_TOOL_PROMPT_SIGS`; the models probe's prompt is a slash command (which
  `_first_user_text` skips) so it goes by `_first_command_name` = `/model`. Such a slug is
  **tombstoned** (`{internal:true}`); `_sanitize_internal_tool_entries` retires entries earlier
  builds adopted.
  - **But the `REPOS_ROOT` slug is never `internal`**: the check reads only the newest transcript,
    and a root session where the operator typed only `/model` reads exactly like the models probe.
    The sanitizer lifts such a tombstone.
- **This ledger is also the archive's input** (`_archive_manifest` enumerates ledger slugs), so
  reconciliation *intentionally* widens archival too — decouple them only if the scopes should
  diverge.
- Tests: `TestReconcileOrphanTranscripts`, `TestSanitizeJunkRepoEntries`, android
  `UsageViewModelTest`.

## Subscription limits and the limits probe (XERK-247)

- The heartbeat's **`limits`** block is how much of the Claude SUBSCRIPTION's 5-hour and 7-day
  windows is gone — a different question from the token counts above, on a pool shared with
  claude.ai. There is no API behind it (the Usage & Cost API is org-scoped, admin-keyed, and reports
  API spend), so the numbers exist **only in the blob Claude Code hands a `statusLine` command**.
- It is the early warning for the condition the **local-model failover** exists to handle (XERK-246,
  `CLAUDE.md`): running out of Claude usage stops every session on a host at once. Reading the
  headroom and failing a session over are deliberately separate controls — nothing here switches a
  session automatically.
- The probe runs against the **mounted subscription login, never the failover's endpoint** — a local
  model has no such windows, so every probe would time out having spent a real turn. That holds
  because the failover's credentials are sourced into one session's launch line rather than exported
  process-wide; the probe's command sources nothing. Tests: `TestLimitsSnapshot`.
- `hooks/statusline.py` captures that blob into `~/.turma/limits.json`; the beat re-validates the
  file (`read_limits_snapshot`) and reports it. A snapshot **older than `LIMITS_MAX_AGE_SEC` is
  refused outright** — a day-old 5-hour window has reset several times since, so it is wrong data,
  not stale data. Absent = "this host can't tell you", never 0% used.
- **The statusLine is NEVER wired into a session's settings**, only into the probe's own
  (`build_limits_settings`, a separate file from `build_guard_settings`). Configuring one makes
  Claude Code stop painting the footer's `esc to interrupt`, which is what `_busy_from_capture` and
  tunnel-agent's `paneShowsBusy` read: measured on a 54-column pane mid-stream, busy detection falls
  from 53/54 captures to 10/41 (the XERK-130 defect), on every session on the host.
- So the capture happens in a **throwaway probe whose pane nothing parses**: `_start_limits_probe`
  runs an interactive claude in its own tmux (`LIMITS_TMUX`) on a daemon thread — print mode never
  invokes a statusLine, so it can't be a `claude -p` one-shot like the summary/models helpers — and
  kills it once the snapshot lands. cwd is `REGISTRY_DIR`, so its transcript is tombstoned as
  internal overhead by the same rule as those helpers.
- The probe is **a real turn billed against the very windows it measures** — ~36k tokens, nearly all
  of it prompt cache, and ~15s wall clock when measured on a real host — so it is sized down (the
  cheapest model, a one-line `--system-prompt` replacing the default, `--strict-mcp-config`, a
  one-word answer) and spent sparingly: only with no snapshot at all, or once one ages past
  `LIMITS_PROBE_SEC` **and a session is actually running**. A settled host lets its snapshot go
  stale, which is the honest rendering of "nothing has moved these numbers here".
  - **`--model haiku` is a request, not a guarantee.** It sets the session's model, but a login
    whose routing picks per turn answers with what that routing chooses — every interactive probe
    measured came back `claude-sonnet-5`. Don't restate the cost as a Haiku cost.
- **A probe that captures nothing backs off, doubling to `LIMITS_PROBE_MAX_BACKOFF_SEC`.** The
  failure that matters is the permanent one: a login with no subscription windows (API key, Bedrock,
  Vertex) can NEVER produce a snapshot, and the "only while a session runs" gate doesn't apply to
  the no-snapshot branch — so without the backoff such a host spends a real turn every beat forever.
- It answers the trust-folder dialog with one `Enter` — that dialog blocks the turn entirely, so
  without it a first probe in an untrusted `~/.turma` captures nothing.
- **Its prompt is a distinctive signature, not a bare "ok"** (`INTERNAL_TOOL_PROMPT_SIGS`): where
  `~/.turma` is a SYMLINK, claude resolves the path before slugifying it, so the probe's transcript
  lands under the resolved dir's slug and `_is_internal_tool_slug`'s direct `REGISTRY_DIR` match
  never fires — the prompt signature is then the only thing keeping the agent's own overhead dir off
  the usage page (XERK-27), and a bare "ok" would also match a real session that opened with "ok".
- **The probe's tmux is reaped in three places**, because its own `finally` is not enough: it runs on
  a daemon thread, whose `finally` does NOT run when the interpreter exits, and tmux outlives the
  manager. So `_kill_limits_probe` is also called from `_handle_shutdown` (the native updater's
  SIGTERM is a routine path) and from `resume_on_boot` (a crash mid-probe).
- **`read_limits_snapshot` never raises**, and that is load-bearing: it runs on the beat's critical
  path, `~/.turma` is NOT in the guard's deny list (any session can write there), and `NaN`/`inf`
  pass an `isinstance(x, float)` gate and then raise inside `int()`. An escape crash-loops the agent
  on every restart until someone deletes the file. It also size-caps the read (a path pointed at
  `/dev/zero` is an unbounded allocation), bounds both epochs, and refuses a FUTURE `capturedAt`,
  which would otherwise read as freshly captured forever and never go stale.
- Tests: `TestLimitsSnapshot`, `TestLimitsSettings`, `test_statusline.py`.

## Which subscription a host is on (XERK-301)

- Those windows belong to the **ACCOUNT, not the machine**: every host logged into one Claude
  account reads and spends the same pool, so the Usage page draws one card per subscription. The
  heartbeat's **`subscription`** block (`subscription_identity()`) is the key it groups on.
- The identity comes from **`oauthAccount.accountUuid` in Claude Code's own config file**, tried at
  both real layouts (`CLAUDE_CONFIG_PATHS`: inside the config dir, then beside it). The credentials
  file next to it cannot answer this — its tokens rotate, and `subscriptionType` names a PLAN, which
  two different accounts share.
  - **Every path is tried until one ANSWERS**, not until one EXISTS: `~/.claude/` sits beside
    `~/.claude.json`, so falling through only on a missing path lets an accountless first file
    permanently suppress the layout holding the login.
- **What rides the wire is a hash, never the uuid, org uuid or email.** The hub persists every beat
  into `state.json` and fans it out to web, Android and glasses, and grouping only ever asks whether
  two hosts are equal.
- **Absent means "this host can't tell you"**, and the clients keep such a host on a card of its own
  — two hosts that both report nothing are not thereby on one plan. `TURMA_SUBSCRIPTION_KEY` pins a
  group by hand for a host whose config this can't read; it is hashed the same way, so two hosts
  given one string group.
- `subscription_identity` **never raises and never blocks** — it runs inline on the beat over a path
  the agent does not own, so `_subscription_from_config` takes **regular files ONLY** (a FIFO there
  blocks `open()` until somebody writes, and the host would simply stop heartbeating with nothing
  anywhere to say why) and bounds the **READ**, never `st_size` (a char device reports 0 and then
  hands over bytes forever — the trap `read_limits_snapshot` spells out).
- Cached on the file's `(mtime, size)`, per path — it is ~120 KiB of caches, so re-parsing it every
  beat would be pure waste, while a re-login still wins.
- Tests: `TestSubscriptionIdentity`.

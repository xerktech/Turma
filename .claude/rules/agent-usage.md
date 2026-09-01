---
paths:
  - "agent/hub-agent.py"
  - "agent/hooks/statusline.py"
  - "agent/dsh_transcript.py"
  - "agent/dsh_session.py"
  - "agent/qwen_transcript.py"
  - "agent/qwen_session.py"
  - "agent/tests/test_hub_agent.py"
  - "agent/tests/test_statusline.py"
  - "agent/tests/test_dsh_transcript.py"
  - "agent/tests/test_qwen_transcript.py"
---

# Usage aggregates, the attribution ledger and subscription limits

The agent half of the Usage page: how much this host SPENT (token aggregates re-parsed from every
transcript, plus a ledger keeping them attributable after a session is gone) vs. how much of the
Claude subscription is LEFT (5h/7d windows, answerable only by Claude Code). All in `hub-agent.py` +
`hooks/statusline.py`; hub/UI half: `turma.md`.

## Usage aggregates and the attribution ledger

- The heartbeat carries **usage aggregates independent of the live registry** — per-repo
  `repoUsage[]` and host-level `usage`, from re-parsing *every* known transcript
  (`repo_usage_report()`). Each entry carries a `remoteKey` (`normalize_remote()`) so the hub unifies
  a repo across hosts.
- **A slug's transcripts are BOTH the conversations and the background agents' own**
  (`_project_transcripts`, XERK-302): `<slug>/<id>.jsonl` plus nested `subagents/agent-<x>.jsonl` and
  workflow-run paths. A flat listing left delegated tokens uncounted entirely.
  - The nesting is WALKED, never hard-coded at a depth, and anchored on the `subagents/` dir (tokens
    were spent whether or not the parent transcript still exists).
  - **Offsets key on the RELATIVE path, never the bare filename** — two parents' agents routinely
    share `agent-<x>.jsonl`.
  - Delegated tokens fold into `totals`/`days`/`models` AND count a second time into **`usage.subagent`**
    (a **SLICE**, never an addend — no client adds it back). `sessions` counts CONVERSATIONS only.
  - Absent `subagent` = "can't tell"; a genuine all-zero must survive as zero, so
    `normalizeSubagentUsage` **validates and drops, never repairs** (a repaired block is
    indistinguishable from genuine zero). Figures must be non-negative safe integers — a float or
    `1e308` fails the whole `/api/agents` Kotlin decode.
  - **Every token figure is coerced where it leaves the transcript** (`_token_count`, XERK-306) —
    else a bad type fails the WHOLE `/api/agents` decode on Android or crashes `_add_tokens` agent-
    side. Unusable→0, fractional→truncated, bool rejected. The hub coerces again at ingest.
  - **Only REGULAR FILES enumerated, both branches** — a `*.jsonl` directory would misread as a
    conversation; a FIFO named `*.jsonl` blocks the heartbeat's critical path forever. The walk never
    raises.
  - `repo_usage_report` gates the host block on **tokens OR conversations** — a slug holding only a
    pruned session's `subagents/` tree has real spend and a zero count.
  - Tests: `TestSubagentUsage`, `subagentCard` in `usage.test.js`, the split cases in
    `UsageViewModelTest`.
- The per-model breakdown **excludes `<synthetic>`** (any `<...>` model) — Claude Code stamps
  fabricated entries with that model and an all-zero block; `_accumulate_usage` keeps them out of
  `acc.models` (tokens still fold into grand totals). Mirrors `_scan_model_entry`'s guard.
- A durable worktree→{repo, remote, slug} **attribution ledger** (`~/.turma/repo-usage.json`) keeps a
  transcript traceable after its session/worktree are gone, so **usage history survives
  kill/delete/prune**. Written at spawn (`_remember_usage`), reconciled each beat
  (`_reconcile_orphan_transcripts()`), pruned only when a transcript dir disappears.
  `repo_usage_report()` folds only slugs the ledger names — reconciliation is what makes it cover
  every transcript on disk.
- Orphans adopt best-effort: (1) exact repo + git origin if the worktree exists; (2) repo from the
  worktree-shaped slug; (3) repo from the transcript's recorded `cwd`; (4) the root bucket — **no
  "(other)" bucket**.
- **A derived name (2/3) only stands when it names a repo this host scans** (XERK-147, both
  heuristics are lossy/unvalidated). `_sanitize_junk_repo_entries` retires persisted junk the same
  way each beat, no-op when the repo scan is empty (so an unreadable `REPOS_ROOT` can't fold real
  history into root).
- **No real session is excluded.** The one carve-out is the manager's OWN `claude -p` helpers
  (naming/triage/models probe: `cwd=REGISTRY_DIR`, but writing into the shared projects dir) —
  `_is_internal_tool_slug` tombstones them (`{internal:true}`) by registry-dir slug or
  `INTERNAL_TOOL_PROMPT_SIGS`; the models probe goes by `_first_command_name` = `/model`.
  - **The `REPOS_ROOT` slug is never `internal`** — a root session where the operator typed only
    `/model` reads like the probe; the sanitizer lifts such a mistaken tombstone.
- **This ledger is also the archive's input** (`_archive_manifest` enumerates ledger slugs) — decouple
  reconciliation from archival only if the scopes should diverge.
- Tests: `TestReconcileOrphanTranscripts`, `TestSanitizeJunkRepoEntries`, android
  `UsageViewModelTest`.

## Subscription limits and the probe (XERK-247)

- The heartbeat's **`limits`** block is how much of the Claude SUBSCRIPTION's 5h/7d windows is gone —
  a different question from the token counts above, on a pool shared with claude.ai. No API answers
  this (Usage & Cost API is org-scoped/admin-keyed, reports API spend only) — the numbers exist
  **only in the blob Claude Code hands a `statusLine` command**.
- Early warning for what **local-model failover** (XERK-246, `agent-sessions.md`) handles: reading
  headroom and failing a session over are deliberately separate controls.
- The probe runs against the **mounted subscription login, never the failover's endpoint** (a local
  model has no windows and every probe would time out). Tests: `TestLimitsSnapshot`.
- `hooks/statusline.py` captures the blob into `~/.turma/limits.json`; the beat re-validates
  (`read_limits_snapshot`). **A snapshot older than `LIMITS_MAX_AGE_SEC` is refused outright** — wrong
  data, not stale data. Absent = "can't tell", never 0% used.
- **A window's `usedPct` is floored at its per-window HIGH-WATER MARK, keyed on `resetsAt`**
  (`carry_window_high_water`, statusline write-time). A fixed window's used % only RISES until it
  resets, so a reading that DROPS while `resetsAt` is unchanged is spurious — Claude Code 2.1.x
  intermittently reports a window's `used_percentage` as **0** on a fresh probe session (observed: a
  7-day window read 14% then 0% 30 min later with 130h still to reset, which then painted the Usage
  page at 0%). Flooring stops one bad zero clobbering a good reading; a genuine reset brings a NEW
  `resetsAt` and starts a fresh mark (so a 5-hour window rolling over to ~0 still shows), and the floor
  only ever raises toward MORE usage / LESS headroom — the safe direction for a headroom gauge.
  **Exact `resetsAt` match** (no tolerance): erring toward not-flooring never crosses a real reset.
  Sound because `resets_at` is a **fixed window boundary, not a sliding `now + remaining`** — verified
  on a real 2.1.257 host: `seven_day.resets_at` was byte-identical across probe reads seconds and
  ~30 min apart, so a window's used % only accumulates until that fixed instant (a rolling window
  would show a drifting `resets_at`, which it does not). Tests: `TestCarryWindowHighWater`.
- **The statusLine is NEVER wired into a session's settings**, only the probe's own
  (`build_limits_settings`, separate from `build_guard_settings`) — configuring one on a session stops
  Claude Code painting the footer's `esc to interrupt`, breaking busy detection for every session on
  the host (the XERK-130 defect).
- So the capture happens in a **throwaway probe whose pane nothing parses**: `_start_limits_probe`
  runs an interactive claude in its own tmux (`LIMITS_TMUX`) on a daemon thread (print mode never
  invokes a statusLine, so it can't be a `claude -p` one-shot) and kills it once the snapshot lands.
  cwd `REGISTRY_DIR` → tombstoned as internal overhead.
- The probe is **a real turn billed against the windows it measures** (~36k tokens, mostly cache) —
  sized down (cheapest model, minimal system prompt, `--strict-mcp-config`) and spent sparingly: only
  with no snapshot at all, or once one ages past `LIMITS_PROBE_SEC` **and a session is actually
  running**.
  - **`--model haiku` is a request, not a guarantee** — a login whose routing picks per turn may
    answer with a different model regardless. Don't restate the cost as a Haiku cost.
- **A probe that captures nothing backs off, doubling to `LIMITS_PROBE_MAX_BACKOFF_SEC`** — a login
  with no subscription windows (API key, Bedrock, Vertex) can NEVER produce one, and the
  no-snapshot branch ignores the "only while running" gate, so without backoff such a host spends a
  real turn every beat forever.
- Answers the trust-folder dialog with one `Enter` (blocks the turn otherwise).
- **Its prompt is a distinctive signature, not a bare "ok"** (`INTERNAL_TOOL_PROMPT_SIGS`) — a
  symlinked `~/.turma` resolves to a different slug before the direct `REGISTRY_DIR` match can fire,
  so the signature is the only thing keeping this overhead off the usage page (XERK-27), and a bare
  "ok" would also match a real session.
- **The probe's tmux is reaped in three places** since its own `finally` doesn't run on interpreter
  exit and tmux outlives the manager: `_kill_limits_probe` also from `_handle_shutdown` (routine
  SIGTERM) and `resume_on_boot` (crash mid-probe).
- **`read_limits_snapshot` never raises** — beat critical path, `~/.turma` is NOT guard-denied so any
  session can write there, and `NaN`/`inf` pass an `isinstance(x, float)` gate then raise inside
  `int()`. Size-caps the read, bounds both epochs, refuses a FUTURE `capturedAt` (else it never goes
  stale).
- Tests: `TestLimitsSnapshot`, `TestLimitsSettings`, `test_statusline.py`.

## Which subscription a host is on (XERK-301)

- Windows belong to the **ACCOUNT, not the machine** — every host on one Claude account spends the
  same pool, so the Usage page draws one card per subscription. The heartbeat's **`subscription`**
  block (`subscription_identity()`) is the grouping key.
- Identity comes from **`oauthAccount.accountUuid` in Claude Code's own config file**, tried at both
  real layouts (`CLAUDE_CONFIG_PATHS`). The credentials file can't answer this — tokens rotate, and
  `subscriptionType` names
  a PLAN two different accounts share.
  - **Every path is tried until one ANSWERS, not until one EXISTS** — falling through only on a
    missing path lets an accountless first file permanently suppress the layout holding the login.
- **The grouping KEY that rides the wire is a hash, never the uuid, org uuid or email** — grouping
  only ever asks whether two hosts are equal.
- **A separate `label` is the card's human-readable NAME** (XERK-541) — the account's own
  `organizationName` (`_subscription_label`, else displayName/fullName/emailAddress), so the usage
  page can say WHICH subscription instead of only listing its hosts. Unlike the key it is meant to be
  read, so it carries a real name — a personal Max plan's org name embeds the login email.
  - **`TURMA_SUBSCRIPTION_LABEL` overrides it** on both sources — the privacy/friendliness escape
    hatch, and the ONLY label an env-pinned key (no account to derive from) ever gets. An empty
    override never blanks a derived one. Bounded (`SUBSCRIPTION_LABEL_MAX`), re-bounded at the hub.
- **Absent means "can't tell"** — such a host gets its own card, never merged by default.
  `TURMA_SUBSCRIPTION_KEY` pins a group by hand, hashed the same way; a login with no nameable field
  carries no label (the card falls back to its hosts).
- `subscription_identity` **never raises and never blocks** — `_subscription_from_config` takes
  **regular files ONLY** (a FIFO blocks `open()` forever) and bounds the **READ**, never `st_size` (a
  char device reports 0 then hands over bytes forever).
- Cached on the file's `(mtime, size)`, per path — a re-login still wins. Tests:
  `TestSubscriptionIdentity`.

## dsh and qwen sessions ride all of this UNCHANGED (XERK-471 [G], XERK-513 [Qwen G])

Both runtimes spend tokens through a different model client, but reach every surface above through
the SAME code with NO `agentType` branch — because each runtime's projection (`dsh_transcript.py` /
`qwen_transcript.py`) writes spend into the exact `message.usage`/`message.model` shape this file
already reads. **Adding an `agentType` branch to the aggregation is the regression to avoid.**

- **Token aggregates + the ledger cost NEITHER runtime new code.** Each is an ordinary session here:
  `_remember_usage` records its worktree→repo at spawn like any other, and its spend is the
  PROJECTION transcript, whose assistant entries carry `message.usage` (mapped 1:1 by `_map_usage`)
  and a real `message.model`. So `_accumulate_usage`/`_token_count`/`repo_usage_report` fold it,
  `retiredUsage` (XERK-338) carries it after the host is gone, and the per-model breakdown attributes
  it — all by construction. No heartbeat field is added; usage is `agentType`-agnostic.
- **Local/DeepSeek/OpenAI-compatible model ids just APPEAR in the per-model breakdown and may
  DOMINATE a host's turns.** They are not `<synthetic>`, so `_accumulate_usage`'s guard leaves them
  in — correctly. The one runtime-specific care is at the projection: `_map_usage` drops an all-zero
  usage block to `None` for BOTH runtimes, so a local endpoint reporting no counts does NOT plant a
  phantom zero-token model row (the `<synthetic>` guard's job, done at the projector instead). Tests:
  `TestDshProjectionAccounting`/`TestDshUsageReportEndToEnd`/`test_all_zero_usage_projects_no_usage_key`
  (dsh), `TestQwenUsageReportEndToEnd`/`TestQwenProjectionAccounting`/`TestQwenUsageMapping` (qwen).
- **The native event log is NEVER counted; the projection is the single copy, for both.** qwen's own
  live home (`QWEN_PROJECTS_ROOT`, `~/.qwen/projects/<slug>/chats/<id>.jsonl`) is never walked at all;
  its raw ARCHIVE sidecar at `<slug>/<id>/qwen/`, and dsh's log at `<slug>/<id>/dsh/`, are neither
  top-level `*.jsonl` nor under
  `subagents/`, so `_project_transcripts` skips both — counting either would double that session's
  spend. **Do not teach the walk to read `<sid>/dsh/` or `<sid>/qwen/`.**
- **Subscription limits, the probe, and the CARD stay Claude-only for both runtimes.** Neither dsh
  nor qwen has a 5h/7d window (each is a local/API route with no pool shared with claude.ai, D5), so
  nothing either spends touches `limits`; there is deliberately no dsh/qwen limits path. `
  _start_summary` REFUSES both runtimes (no Claude summarizer turn on a login-less runtime). The
  probe runs against the mounted Claude login regardless of what runtime is active, and
  `subscription_identity` is per-HOST off the Claude config, so a dsh/qwen session never moves the
  card (the host is still logged into Claude, which powers summaries/triage/the probe). **Never wire
  dsh or qwen spend into `limits`.**

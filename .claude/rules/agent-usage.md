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
- The probe is **a real turn billed against the very windows it measures** — ~50k tokens, nearly all
  of it cache reads, and ~14s wall clock when measured on a real host — so it is sized down (Haiku, a
  one-line `--system-prompt` replacing the default, `--strict-mcp-config`, a one-word answer) and
  spent sparingly: only with no snapshot at all, or once one ages past
  `LIMITS_PROBE_SEC` **and a session is actually running**. A settled host lets its snapshot go
  stale, which is the honest rendering of "nothing has moved these numbers here".
- It answers the trust-folder dialog with one `Enter` — that dialog blocks the turn entirely, so
  without it a first probe in an untrusted `~/.turma` captures nothing.
- Tests: `TestLimitsSnapshot`, `TestLimitsSettings`, `test_statusline.py`.

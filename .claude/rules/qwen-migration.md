---
paths:
  - "agent/hub-agent.py"
  - "agent/tests/test_hub_agent.py"
---

# Qwen session migration + resume ([Qwen K], XERK-516)

Split out of `.claude/rules/qwen.md` (size ceiling); read it for the qwen runtime around this piece
(launcher [Qwen B], projection [Qwen S1], drive/liveness [Qwen C], archive [Qwen E]).

XERK-101 (`CLAUDE.md`, "Migrating a session to another agent") extended to qwen — the dsh [K]
(XERK-475, `.claude/rules/dsh.md`) analogue. **Load-bearing difference from dsh**: qwen is
Claude-shaped, so its NATIVE LOG at `~/.qwen/projects/<slug>/chats/<id>.jsonl` *is* the durable store
`qwen --resume <id>` reloads from — no separate store like dsh's `DSH_SESSIONS_ROOT` (distinct from
dsh's `<sid>/dsh/` display feed). So a qwen migration carries the native log itself. Full mechanics +
rationale are in the `QWEN_STORE_ARCNAME` comment in `hub-agent.py`; invariants a change must not
undo:

- **RESUME (process-death `--resume`, boot-adopt) was already wired by [Qwen B]/[Qwen C]; [K] only
  PINS it.** `_launch_tmux(resume=True)` dispatches to `_launch_qwen(resume=True)` → `qwen --resume
  <id>` at the transcript's origin cwd, and `_start_qwen_tail(resume=True)` restarts the projection
  at the native log's EOF so it never re-projects/doubles the kept `<id>.jsonl` (the deterministic-
  uuid projection is already there; qwen appends in place). Boot-adopt reattaches the tail the same
  way. Never add a resume path that re-reads the native log from 0.
- **MIGRATION carries the NATIVE LOG, not the projection feed.** `export_session` GLOB-locates it
  (`_qwen_native_log`, `<id>.jsonl` across `QWEN_PROJECTS_ROOT/*/chats/`, the slug-rule-independent
  discipline the tail/`_qwen_runtime_file` use) and packs it under the reserved `.qwen-store/chat.jsonl`
  prefix (twin of dsh's `.dsh-store/`), truncated to its last complete line like the main transcript
  (a live log is appended by its process). `_unpack_transcript` routes that member to a single target
  FILE (`_qwen_store_dest`), **NEVER a dir** — the shared `chats/` dir holds every cwd-cohabiting
  session's log, so it places exactly this session's `<id>.jsonl`. It is un-droppable resumable data,
  so an oversized bundle is refused (like the dsh store) rather than shipped un-resumable.
- **The `<slug>/<sid>/qwen/` raw-archive mirror ([Qwen E]) is the DISPLAY/metrics feed and is NEVER
  carried by migration** — the target rebuilds it from new events past the log's EOF (the tail's
  `_mirror_native` primes from the fresh mirror's size 0 and copies the whole placed native log).
  Keep the two straight: resume reads the native log, not the mirror. This is the [K] correction the
  ticket names.
- **Cross-mount re-key is MANDATORY (upstream issue #2373: qwen keys the store on the working dir).**
  The log lands under the TARGET cwd's slug — and qwen's slug rule is `_project_slug` (every
  non-alnum→`-`, VERIFIED against real on-disk qwen project dirs; the G0 note's `/`→`-` was
  imprecise), not a qwen-specific port. `_reconcile_qwen_store_cwd` then re-points the `cwd` carried
  on EVERY native-log row (qwen has no single header line like dsh) from the source cwd (read from the
  first row) to the localized worktree, so the placed log is self-consistent with where it now lives.
  A no-op on a same-mount move (source cwd == target); never raises the migration over a store detail.
- **A qwen session migrated to a host without qwen falls back to CLAUDE cleanly** via the existing
  per-runtime `agent_type_configured` rebuild guard in `_resume_at_cwd`. `want_qwen`
  (`agentType=="qwen" and qwen_configured()`) gates the unpack, so a claude-fallback import DROPS the
  `.qwen-store/` member (no resume to feed it), exactly as a stray dsh store is dropped.
- **Model/endpoint re-validation is against the TARGET host's config on every launch.** `_launch_qwen`
  reads the TARGET's `QWEN_MODEL_BASE_URL`/`QWEN_MODEL_API_KEY_ENV` (never the source's) and keeps a
  carried `model` only if it passes `QWEN_IDENT_RE`, else the host default. qwen has NO model-list
  discovery (unlike local-model failover), so an id the target's endpoint does not actually serve is
  caught at `_confirm_qwen_launch` (clean teardown + a reason via `_refuse_start`), not pre-validated.
- Tests: the qwen cases in `TestMigrateSession` (`test_a_qwen_bundle_carries_the_native_log_*`,
  `test_a_claude_import_drops_a_stray_qwen_log`, `test_import_places_and_rekeys_the_qwen_log_cross_mount`,
  `test_import_drops_the_qwen_log_when_target_lacks_qwen`, `test_qwen_store_dest_uses_the_project_slug_rule`,
  `test_reconcile_qwen_log_cwd_is_a_noop_on_same_mount`). A real cross-host move actually resumed by
  qwen is host-proof only — qwen is not installed in CI — the footing [Qwen C]/[Qwen E] shipped on.

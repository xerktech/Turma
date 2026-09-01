---
paths:
  - "agent/hub-agent.py"
  - "agent/tests/test_hub_agent.py"
---

# Qwen session migration + resume ([Qwen K], XERK-516)

Split out of `qwen.md` (size ceiling); read it for the qwen runtime around this piece. XERK-101
(`CLAUDE.md`) extended to qwen — the dsh [K] analogue. **Load-bearing difference from dsh**: qwen is
Claude-shaped, so its NATIVE LOG at `QWEN_PROJECTS_ROOT` (`~/.qwen/projects/<slug>/chats/<id>.jsonl`)
*is* the durable store
`qwen --resume <id>` reloads from — no separate store like dsh's `DSH_SESSIONS_ROOT`. So a qwen
migration carries the native log itself. Full mechanics: the `QWEN_STORE_ARCNAME` comment in
`hub-agent.py`.

- **RESUME was already wired by [Qwen B]/[Qwen C]; [K] only PINS it.** `_launch_tmux(resume=True)` →
  `_launch_qwen(resume=True)` → `qwen --resume <id>` at the transcript's origin cwd, and
  `_start_qwen_tail(resume=True)` **RE-PROJECTS the whole native log from 0 over a RESET transcript**
  (XERK-530, design 1) — the deterministic uuid `uuid5(session:seq:index)` derives from a per-feed
  `seq` that restarts at 0 with every fresh `QwenProjector`, so a tail that skipped to EOF would mint
  `seq=0` for the FIRST post-resume event and collide its uuid with the conversation's first turn
  (the chat merge keys on uuid → mis-update). Re-reading from 0 continues the `seq`/`parentUuid`
  chain unbroken; the determinism reproduces the kept history BYTE-IDENTICALLY (no fork, usage de-dup
  exact) and self-heals any events written while the tail was dead. Boot-adopt reattaches the same
  way. **Re-reading from 0 on resume is REQUIRED — the old "never re-read from 0" rule is superseded**
  (the resume-at-EOF optimization skipped `seq` continuity and was the bug).
- **MIGRATION carries the NATIVE LOG, not the projection feed.** `export_session` GLOB-locates it
  (`_qwen_native_log`, slug-rule-independent) and packs it under `.qwen-store/chat.jsonl` (twin of
  dsh's `.dsh-store/`), truncated to its last complete line. `_unpack_transcript` routes that member
  to a single target FILE (`_qwen_store_dest`), **NEVER a dir** — the shared `chats/` dir holds every
  cwd-cohabiting session's log. Un-droppable resumable data — an oversized bundle is refused, not
  shipped un-resumable.
- **The `<slug>/<sid>/qwen/` raw-archive mirror ([Qwen E]) is NEVER carried by migration** — it's the
  display/metrics feed; the target rebuilds it on its own cursor by mirroring the migrated native log
  (whole, then new events). Resume reads the native log, never the mirror.
- **Cross-mount re-key is MANDATORY** (upstream #2373: qwen keys the store on the working dir). The
  log lands under the TARGET cwd's slug (`_project_slug`, every non-alnum→`-`, verified against real
  on-disk dirs). `_reconcile_qwen_store_cwd` re-points the `cwd` on EVERY native-log row (qwen has no
  single header line like dsh) to the localized worktree. No-op on a same-mount move.
- **A qwen session migrated to a host without qwen falls back to CLAUDE cleanly** via the existing
  `agent_type_configured` rebuild guard — `want_qwen` gates the unpack, so a claude-fallback import
  DROPS the `.qwen-store/` member, exactly as a stray dsh store is dropped.
- **Model/endpoint re-validation is against the TARGET host's config on every launch** — `_launch_qwen`
  reads the TARGET's `QWEN_MODEL_BASE_URL`/`QWEN_MODEL_API_KEY_ENV`, keeps a carried `model` only if
  it passes `QWEN_IDENT_RE`, else the host default. No model-list discovery (unlike local-model
  failover), so a bad id is caught at `_confirm_qwen_launch` (clean teardown, reason via
  `_refuse_start`), not pre-validated.
- Tests: the qwen cases in `TestMigrateSession` (`test_a_qwen_bundle_carries_the_native_log_*`,
  `test_a_claude_import_drops_a_stray_qwen_log`, `test_import_places_and_rekeys_the_qwen_log_cross_mount`,
  `test_import_drops_the_qwen_log_when_target_lacks_qwen`, `test_qwen_store_dest_uses_the_project_slug_rule`,
  `test_reconcile_qwen_log_cwd_is_a_noop_on_same_mount`). A real cross-host resume is host-proof only.

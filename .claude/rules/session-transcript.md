---
paths:
  - "agent/hub-agent.py"
  - "agent/tunnel-agent.js"
  - "turma/server.js"
  - "turma/public/sessions.html"
  - "agent/tests/test_hub_agent.py"
  - "agent/tests/tunnel-agent.test.js"
  - "turma/tests/server.test.js"
---

# Which transcript is a session's

Split out of `CLAUDE.md` to keep that file under its size ceiling. This is the hub↔agent contract for
resolving a session's conversation on disk; `.claude/rules/session-migration.md` carries how a session
moves between agents and how a refused start is reported.

- Every launch **pins claude's session id** — `--session-id <uuid4>` in `_launch_tmux`, or the
  `--resume` id — persisted as `claudeSessionId`, so the conversation is `<claudeSessionId>.jsonl`
  under its cwd's project slug, known by name before its first byte.
- `_session_transcript_path()` is the one resolver every surface goes through; the hub heartbeats the
  id so `tunnel-agent.js`'s live tail agrees. **Never go back to a newest-mtime rule** (XERK-6): a
  root session's dir holds every root session's transcript, so the newest is the PREVIOUS session's.
- **A pinned session with no transcript on disk resolves to nothing.** Never add a newest-mtime
  fallback — an empty conversation before the first turn is the truth. A session from an agent
  predating the pin carries no id and keeps the newest-mtime rule.
- **A transcript that exists but has no RESUMABLE entry still resolves as a read PATH, but NOT as a
  --resume id** (XERK-868 / XERK-892). `claude --resume` needs one real entry (a message, or a
  system/local-command line); a 0-byte, mode-only, summary-only or all-meta transcript exits "No
  conversation found" and kills its tmux — and because the record still names the id, every Start
  relaunches the same doomed `--resume`, an endless dead-tmux loop the sweep reports as a crash
  (verified on Claude Code 2.1.x). `_session_transcript_path` keeps returning the path
  (tail/history/pending-scan an empty/meta file harmlessly); `_session_transcript_id` — the resume
  feeder — gates on `_transcript_has_resumable_entry` and returns None, so `_launch_tmux` opens a
  FRESH conversation. **The gate FAILS SAFE toward resumable** (`_UNRESUMABLE_META_TYPES` is the
  closed set of types that carry no turn; an unrecognised/unparseable line reads as resumable) —
  misclassifying a live conversation as unresumable would silently ABANDON it. **The durable backstop
  is in `_sweep_dead_sessions`**: a resume-launched tmux that dies without ever being seen alive
  (`resumeRelaunch` set at every `--resume` launch, cleared the moment it is live) is relaunched
  FRESH once instead of reported — closing the loop for a shape the predicate let through (a future
  meta type, or a lone `file-history-snapshot`), independent of Claude's private resume rule. Keep
  the resumability gate on the resume feeders, never on the shared path resolver. Tests:
  `TestTranscriptResumable`, the resume/sweep cases in `TestRootSessionIsolation`/`TestSweepDeadSessions`.
- A watch is sent once and held, so `rearmMovedWatches` re-sends it when a watched session's
  `transcriptId` moves. Only "Restart (clear context)" moves it; without the re-arm that session's
  chat freezes on the pre-restart conversation.
- Two things stay slug-keyed, sharing one identity across a root session's neighbours: archival's
  `_running_slugs` exclusion and the summary/date an archived transcript inherits.
- Tests: `TestRootSessionIsolation`, `sessionTranscript` in `tunnel-agent.test.js`, `server.test.js`.

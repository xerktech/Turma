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
- **An EMPTY (0-byte) transcript is not RESUMABLE, though it still resolves as a read path**
  (XERK-868 follow-up). Claude Code creates `<id>.jsonl` at launch; a session that never took a first
  turn leaves it 0 bytes. `_session_transcript_path` keeps returning its path (tail/history/pending
  scan an empty file harmlessly), but `_session_transcript_id` — the ONLY caller that feeds `claude
  --resume` (via `_launch_tmux`) — gates on `getsize > 0` and returns None, so a resume opens a FRESH
  conversation. Without that gate `claude --resume <empty id>` exits "No conversation found", killing
  its tmux, and because the record still names the id EVERY Start relaunches the same doomed
  `--resume` — an endless failure loop `_sweep_dead_sessions` reports as a crash. Keep the emptiness
  gate on the resume-id resolver, not on the shared path resolver.
- A watch is sent once and held, so `rearmMovedWatches` re-sends it when a watched session's
  `transcriptId` moves. Only "Restart (clear context)" moves it; without the re-arm that session's
  chat freezes on the pre-restart conversation.
- Two things stay slug-keyed, sharing one identity across a root session's neighbours: archival's
  `_running_slugs` exclusion and the summary/date an archived transcript inherits.
- Tests: `TestRootSessionIsolation`, `sessionTranscript` in `tunnel-agent.test.js`, `server.test.js`.

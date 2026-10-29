---
paths:
  - "turma/public/board.js"
  - "turma/tests/board.test.js"
  - "android/app/src/main/java/com/xerktech/turma/core/Board.kt"
  - "android/app/src/test/java/com/xerktech/turma/core/BoardTest.kt"
  - "agent/hub-agent.py"
  - "agent/tunnel-agent.js"
  - "agent/tests/test_hub_agent.py"
  - "agent/tests/tunnel-agent.test.js"
---

# Ported mirrors that must agree

Logic implemented more than once (a source plus its ports). Change one, change all.

- **`turma/public/board.js` has THREE mirrors of its column rule** (`categoryOf` / `REVIEW_STATUS_RE`):
  the source and its two ports — `_board_column` in `hub-agent.py` and `categoryOf` in
  android's `core/Board.kt`. The agent resolves a dropped column against its OWN read, so drift
  silently refuses valid drops. Tests: `TestBoardColumn`, `board.test.js`, `BoardTest.kt`.
- **The Triage lane + verdict chip are ported too** — `triageLaneOf`/`triageChipHtml` in
  `board.js` and Android's `Board.kt` port. The verdicts themselves are HUB-OWNED wire state
  (`ticketTriageActions` on `/api/agents`, set via `POST /api/jira/<site>/<key>/triage`); the lane
  is a board view that never writes to the tracker. Change the lane or chip → re-port in the same
  PR. Mechanics: `.claude/rules/turma-triage.md`.
- **`hub-agent.py` ↔ `tunnel-agent.js` are a parity contract** for everything both parse:
  `_entry_blocks`/`entryBlocks`, `_entry_text`, `transcript_tail`, `_busy_from_capture`/
  `paneShowsBusy`, `_fold_queue_op`/`foldQueueOp`, `_send_user_file_detail`/`sendUserFileDetail`.
  Parity-tested in `tunnel-agent.test.js`.
  - **`device_name`/`deviceName` + `_usable_hostname`/`usableHostname` are on that list too.** They
    must resolve the SAME name: `openChannel` keys `controlChannels` by it, so a tunnel and a manager
    under different names is a host whose commands work while its terminal, live tail and heartbeat
    poke are dead — and a ghost card `DELETE` cannot reach. The native launcher exports an
    operator-set `DEVICE_NAME` to both processes unvalidated, so an env-path divergence is the one
    that bites. Tests: `TestDeviceName`, `usableHostname`/`deviceName` in `tunnel-agent.test.js`.

---
paths:
  - "agent/hub-agent.py"
  - "agent/tunnel-agent.js"
  - "agent/tests/test_hub_agent.py"
  - "agent/tests/tunnel-agent.test.js"
---

# Transcript entry blocks (`_entry_blocks` / `entryBlocks`)

Split out of `agent.md` (size ceiling).

- Each tail entry carries a rich **`blocks[]`** beside the flat `text` (`_entry_blocks`/
  `entryBlocks`), preserving thinking text, tool_use inputs and tool_result outputs that
  `_entry_text` flattens away.
- Turns ABOUT the session are classified: interrupt marker; `!` shell passthrough →
  command/command_output shapes (name `!`, stderr wins only when non-empty); `away_summary` with
  its config hint stripped (every other system subtype dropped); `tool_reference` in a tool_result
  → `[tool: <name>]`.
- **A known tool call carries its reviewable payload on the tool_use block** (`_tool_use_detail`/
  `toolUseDetail`): Edit→`edit`, Write→`content`, ExitPlanMode→`plan`, TodoWrite/dsh
  `todo_write`→`todos` (one branch for both runtimes), any tool's `description`→`desc`.
  AskUserQuestion titled by its question text, not the input JSON.
  - **SendUserFile → `files[]`+`caption`** (XERK-221, oversize past `SEND_FILE_MAX_BYTES` → name-only
    chip): image/SVG as base64 data URI, a `render` page
    as raw markup, else a name chip (never opened). Only image/html paths are read and bounded.
- **A plugin's prompt is not the operator's** (XERK-2135, `_plugin_message`/`pluginMessage`): a
  user entry with `origin.kind == "plugin"` becomes ONE `text` block with Claude Code's
  "The <name> plugin sent a message:" frame stripped and `origin` set — `"turma"` for the bridge
  mod, `"system"` for another plugin. Keyed on the structured origin, never the text; its text
  is never re-read as a notification or command. Clients take a tagged origin over
  `messageOrigin` (`chat.js` `MSG_ORIGIN_TAGS`, Android `TextBlock.origin`), and
  `_is_operator_row` does not count it. Tests: `TestPluginMessage` ↔ its `tunnel-agent.test.js` twin.
- **A `!` command that printed nothing keeps its output row**: an empty `command_output` block
  (renderers say "(no output)") and flat text `NO_OUTPUT_TEXT`; without it `! true` read like a
  pending command. A slash command's empty stdout still drops (most print none), and so does
  prose QUOTING empty bash tags: the flag needs the turn to OPEN with the tag.
- The tag-lead and caveat regexes take `[ \t\r\n]`, never `\s`: python's and JS's `\s` differ.
- **Slash output is read to its LAST closing tag**: Claude Code writes it UNESCAPED, so output
  printing `</local-command-stdout>` lost its tail. A turn OPENING with an output tag is output: a
  `<command-name>`/`<bash-*>`/other-stream tag inside its body is text.
- `compact_boundary` and `pr-link` markers; pr-link entries carry no uuid so the feeds synthesize a
  stable id from the URL alone, deduped over the whole conversation (Claude re-stamps pr-links atop
  every user turn, so one PR yields ~6 entries — folding only consecutive repeats is not enough).
- **A prompt consumed MID-TURN is an `attachment`/`queued_command`, never a `user` entry**
  (XERK-2372, `_queued_prompt_entry`/`queuedPromptEntry`): Claude Code 2.1.30x writes no user twin
  (0 of 47 checked). `_entry_role`/`_entry_text`/`_entry_blocks`, `_pending_scan` and
  `_operator_entries` rewrite it into that user entry (uuid kept, `isMeta`/`origin` from the
  attachment). Without it the operator's message vanished from the chat when it left the queue,
  and the compaction outbox never saw it delivered (a resend would duplicate it). Queued
  `<task-notification>`s ride the same path. Tests: `TestQueuedPromptEntry` ↔ its js twin.
- **Still-queued prompts ride beside entries, not inside them**: both feeds fold
  `queue-operation` FIFO (`_fold_queue_op`/`foldQueueOp`) and ship survivors as `queued[]`. Display
  filtering happens at REPORT time (`_queued_display`/`queuedDisplay`), never at fold time.
- Blocks ride the live tail, `history` and the archive push at ONE fidelity (`BLOCK_CAPS`, mirrored
  in `tunnel-agent.js`) — a tool_result-only turn is kept when it has blocks.
  - **Never give the live path tighter caps again** (XERK-347) — a frame is bounded by the ~128 KB
    window it is parsed from; text caps at `INPUT_MAX_CHARS`, shown WHOLE.
  - **`transcript_tail` (the HEARTBEAT preview) carries blocks too, at its OWN tighter caps** —
    it used to be text-only, and that made the row LIE to the chat, which seeds its buffer from it:
    `_entry_text` flattens a tool call to the literal `[Bash]`, so the operator read a prose bubble
    whose whole content was `[Bash]`, and the `TAIL_MSG_CHARS` cut arrived with no flag so the
    renderer's `… clipped to fit` mark never showed. Both are wire fields now: a clipped row says
    `truncated`, and `blocks` is the same shape every other feed ships, so no client needed a new
    code path (web/android both merge grow-only on `blocks` already, and the hub already
    coerced `tail[].blocks` in `coerceLiveSignals`).
    - `text` is UNCHANGED and stays the flat, lossy string.
    - Caps are `TAIL_PREVIEW_CAPS`, spent NEWEST-first against `TAIL_BLOCKS_BUDGET`; past it an
      older row degrades to `TAIL_PREVIEW_CAPS_MIN` — prose kept, tool payloads emptied. **Never
      degrade a row to NO blocks**: that is exactly what puts `[Bash]` back in a prose bubble.
    - `_entry_blocks(..., preview=True)` SKIPS `_tool_use_detail`, which reads files off disk
      (SendUserFile base64, XERK-221). Affordable once for one watched session, never for every
      session on every beat. **Do not call the rich path from the heartbeat.**
    - A zero `input` cap means "this feed ships no argument summary", which the empty `input`
      already says, so it is not marked `truncated` — else every seeded tool card wears a clip mark.
    - Tests: `TestTranscriptTail`, `buildItems` preview cases in `chat.test.js`.
  - **`history`: operator messages are exempt from the window** (XERK-186): bounded read (last
    4 MiB + `HISTORY_MAX_MSGS`, capped in `_history_entries` — callers must not re-slice), but
    every user-authored turn folds back in ahead of the window on any cut (id-deduped,
    `HISTORY_USER_MSGS` backstop); tool traffic otherwise evicts. Tests: `TestHistoryCommand`.
    - A `!` shell command counts as operator input there, its output row kept beside it (XERK-2112).
    - The cap counts a command + its output as ONE message (`_operator_units`), never cutting them
      apart.
    - The byte trim (`_fit_history_budget`) never keeps an output without its command either
      (`_splits_operator_unit`); the entry window needs no check, the rescue re-adds the command.
  - **`history` is bounded in WIRE BYTES, never chars** (`HISTORY_MAX_BYTES`/
    `HISTORY_STAGED_MAX_BYTES`, dropping the OLDEST) — `json.dumps` is ensure_ascii, so a CJK char
    is six bytes and a char budget under-states it 6x.
  - **A 413 on the beat DROPS those staged results** — held until a POST succeeds, so a refused
    body would otherwise re-send verbatim forever (XERK-235).
- Tests: `TestEntryBlocks`, tool-detail/marker cases in `tunnel-agent.test.js`.

---
paths:
  - "agent/hub-agent.py"
  - "agent/tunnel-agent.js"
  - "agent/tests/test_hub_agent.py"
  - "agent/tests/tunnel-agent.test.js"
---

# SendUserFile inline previews: what a turn may embed (XERK-221, XERK-355)

Split out of `.claude/rules/agent.md`, which it had grown past the size ceiling. That file has the
rest of the block shapes and the archive sync around this. The two implementations are a parity
contract (`CLAUDE.md`): `_send_user_file_detail` / `_PreviewBudget` in `hub-agent.py` and
`sendUserFileDetail` / `PreviewBudget` in `tunnel-agent.js`, mirrored byte-for-byte.

## The block shape

- **SendUserFile → `files[]`+`caption`**: image/SVG as a base64 data URI (`kind:"image"`), a
  `render` HTML page as raw markup (`kind:"html"`), else a name chip (`kind:"file"` —
  attach-mode HTML, oversize past `SEND_FILE_MAX_BYTES`, missing, or a non-renderable type, all
  **never opened**). Only image/html paths are read.
- **`shed:True` on a chip means "dropped to fit", and it is a different statement from a plain
  chip.** `turma/public/chat.js` and android's `TranscriptView` both render it as "… preview
  dropped to fit", so the operator can tell a turn that asked for too much from a file that was
  never previewable. An oversize file therefore stays a PLAIN chip: the file is too big, not the
  turn, and no budget would have shown it.

## The budget — the thing the per-file caps do not bound

- **A preview is read from DISK, so no transcript window bounds it.** `TAIL_READ_BYTES` (~128 KB)
  and the block caps bound what is parsed, not what is embedded — measured, one entry of
  `SEND_FILE_MAX_FILES` x `SEND_FILE_MAX_BYTES` produced an 11,185,184-byte row out of a 2 KB
  transcript, 48 such blocks a ~537 MB frame that `JSON.stringify` refuses outright, and three
  sessions ending in such a turn a 33,565,253-byte beat the hub 413'd.
- **`_PreviewBudget` bounds it at the EMBED, in the UTF-8 bytes of the `src`/`html` payload** — the
  same measure `_block_payload_bytes` and the archive budget spend. Two halves, answering different
  questions, and both are needed:
  - `SEND_FILE_ENTRY_MAX_BYTES` (2 MiB) bounds ONE entry. This is what covers a history reply's
    NEWEST row, which `_fit_history_budget` may not drop, and one archive chunk.
  - `SEND_FILE_PASS_MAX_BYTES` (4 MiB) bounds a whole read — one tail frame, one history delivery.
    The per-entry half cannot: a window holds many delivery turns, each refilling its allowance.
  - 0 disables either half, the `ARCHIVE_PAYLOAD_MAX` convention. `byteCeiling` in `tunnel-agent.js`
    mirrors `_byte_ceiling` on both of its rules (an explicit 0 is honoured; a non-digit value is a
    typo to reject, not a 4-byte ceiling), because the two processes read one operator value.
- **NOTHING is read while the transcript is parsed, and that is the whole design.** Both readers
  parse a window and then return its NEWEST slice (`tail.slice(-TAIL_MSGS)`,
  `entries[-HISTORY_MAX_MSGS:]`), so a budget spent in parse order is spent on the rows the caller
  is about to discard. Measured on an ordinary 40-turn session with one 200 KB screenshot a turn:
  **zero previews reached the operator**, 15 shed chips, where the pre-budget code showed 15
  previews — and at 120 turns not one of 100 delivery rows kept a preview, in a 48 KB reply against
  a 6 MiB ceiling. `defer()` records the candidate and stamps a handle; `_fill_previews` /
  `fillPreviews` embeds afterwards, **newest row first**, so what is on screen wins the budget and
  what scrolled off is what degrades. **Do not move the read back into the parse to simplify it.**
- **The handle is an INT index into the budget's table, never the path** (`PREVIEW_HANDLE_KEY`,
  `"_p"`). A chip whose row the window drops is never filled, so the key reaches a client; an int is
  inert there and a path would be filesystem disclosure to every viewer of that chat.
- **The unit is WIRE bytes — `_payload_cost` / `payloadCost`, the length of the JSON form
  `_json_bytes` measures — never UTF-8 bytes.** `json.dumps` is ensure_ascii, so U+FFFD costs 6
  there against 3 UTF-8 bytes and an astral char 12 against 4: a budget kept in UTF-8 admitted 2-3x
  its ceiling in wire bytes, and `_fit_history_budget` paid the difference by evicting rows —
  measured, a 302-row reply collapsed to **one**, taking every message the operator had typed, which
  is precisely what XERK-186's exemption exists to prevent. **`JSON.stringify` cannot stand in for
  this on the JS side** (it leaves non-ASCII unescaped), so `payloadCost` walks UTF-16 code units to
  reproduce Python's escaping table; a differential test pins the two against real `python3`.
- **The cost is a RESERVATION from the file's stat size, reconciled to the real length after the
  read — and the read is ALWAYS charged, even when its bytes are thrown away.** The counters go
  negative rather than refusing a charge. Both halves of that were learned the hard way: charging
  only on success let `fits()` keep admitting reads it then rejected (960 files / 503 MB for an
  89 KB frame; 3.36 GB / 20 s on the history path, i.e. latency against `OFFLINE_AFTER_MS`), and
  refunding an over-run read let a file whose stat UNDER-states its content — a `/proc` entry, or
  one being appended to — be projected at nearly nothing, read whole and rejected, over and over
  (160 opens / 83.9 MB / 45.1 s for a 28,910-byte reply). **Only the EMBED is ever refused; the read
  is never free.** An under-run refunds.
- **The stat decides three things before any open**, and each is load-bearing rather than an
  optimisation, because the checks after the read produce an identical chip and are therefore
  deletable without one: **regular files only** (a FIFO stats at 0 bytes, passes every ceiling, then
  blocks the read forever — on `pollWatcher`'s interval and on the beat thread staging `history`),
  **oversize → the plain chip, unread**, and the projected cost. `readCapped` mirrors Python's
  `read(cap + 1)` so a file that grows between the stat and the read cannot cost the two processes
  different memory.
- **Who owns a pass:** `transcriptTail` (the frame), `_history_entries` (the delivery, shared with
  `_operator_entries` — those rows ride the same reply and fill last, being the ones the window
  already cut), and the archive sync, one budget per transcript scoped exactly like the
  `payload_sent` beside it. A caller that passes no budget fills inline at one entry's worth, so a
  new read path is bounded, and leaks no handle, before anyone remembers it.
- **The archive's pass half is `ARCHIVE_PAYLOAD_MAX`, and it must not be 0/off.** `payload_sent`
  brakes on what is EMBEDDED, so a chip that is read and then refused advances it by nothing: with
  a per-entry ceiling alone the reads grew linearly with the transcript — 40 entries read 83.9 MB
  in 31 s to post a 124 KB body, on the beat. Reusing the archive's own ceiling costs no fidelity
  (that ceiling already bounds what may be stored) and bounds the work as well as the bytes.
- **A caller that BUILDS a row and then discards it must `rollback` its deferrals.**
  `_operator_entries` scans the whole transcript and keeps roughly 1% of it, so retaining a
  `(path, mime)` pair per chip of the rest cost +570 MB of RSS on a 359 MB transcript. Handles are
  indexes into that table, so rolling back to a `mark()` is safe only for rows nothing else holds.
- **The per-entry ceiling is not a bound on an archive POST's body** — a chunk holds thousands of
  entries, and what bounds that body is `ARCHIVE_CHUNK_BYTES` and the shed. (The hub reads that
  route with a 1 MiB `BODY_MAX` against the agent's 8 MiB chunk: XERK-373.)
- **The ceilings are a product decision about what one turn may SHOW, so they are pinned by value in
  both suites, not merely asserted equal.** A test that only checks py == js passes with both moved
  to 1 KiB, which sheds every preview on the fleet.
- **Every test here drives a REAL reader, not just `_entry_blocks`.** With unit tests alone, each
  line that installs the budget on a reader was individually deletable with the whole suite green —
  `transcriptTail` losing its budget took a frame from 88,313 to 42,032,632 bytes and
  `_history_entries` losing its fill left the operator with no previews at all, both silently. The
  same applies to the stat guards, whose post-read equivalents mask them: assert on the OPEN.
- **The live tail's `JSON.stringify` stays inside its `try`** (XERK-347) now that the frame is
  bounded: it runs in a `setInterval` with no `uncaughtException` handler, so anything the serialize
  refuses kills the tunnel and `entrypoint.sh` restarts it in a loop for as long as that session is
  watched. The bound must not be the only thing between a parse bug and every terminal on the host.
- Tests: `TestSendFilePreviewBudget`, the `preview budget:` cases in `tunnel-agent.test.js`.

## Shedding at the boundaries, which the budget does not replace

- **The archive is where a preview is shed for DURABILITY** (`_shed_block_payloads`, XERK-267): the
  payloads are bounded per delivery but unbounded relative to the transcript, so a screenshot-heavy
  session archives orders of magnitude larger than what it records (measured: 28 KB of transcript →
  447 MB archived). Past `ARCHIVE_PAYLOAD_MAX` the rest of that transcript ships as name-only chips
  flagged `shed`.
  - **A transcript already shedding never READS what it will drop** (`_drop_deferred_previews`).
    Embedding and then calling `_shed_block_payloads` meant one sync pass read 3.36 GB off disk to
    throw 611 MB of it away; the deferral is what lets the verdict be applied first. It flags `shed`
    only where a preview was really possible — a missing, FIFO or oversize file stays the PLAIN chip
    the live path gives it, or the archived copy of a turn says "preview dropped to fit" where the
    live copy of the same turn shows a bare name. The dropped
    bytes are reported from each file's stat, so the log line still means something.
- **`_shed_row_previews` is the DELIVERY-side backstop** (XERK-347), not the bound: a history row
  over `HISTORY_MAX_BYTES` has its previews stripped heaviest-block-first, reusing the archive's own
  shedder so the row degrades to exactly the same chip. It still fires for a row over budget for
  other reasons. Sizes are measured ONCE per block and subtracted — re-serializing a multi-hundred-MB
  row per block cost 18s on the beat loop, which is latency against `OFFLINE_AFTER_MS`.

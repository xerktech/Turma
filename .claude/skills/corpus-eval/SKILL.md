---
name: corpus-eval
description: Evaluate a transcript/pane parsing change against the real Claude transcripts and live TUI on this host — inventory the shapes, replay old-vs-new, prove the py/js mirrors agree, and measure what the change actually surfaces. Use when changing _entry_blocks, _entry_text, the tunnel-agent mirrors, pane parsers, or anything that decides what the chat shows.
---

# Evaluating a parsing change against real data

The parsing code in `agent/` reads two live inputs: Claude Code's transcript
JSONL and its tmux pane. Both are **undocumented formats owned by someone
else**, so the question a change has to answer is never "do my tests pass" —
it's *what do the real ones look like, what did I just change about all of
them, and what did I gain*. This host holds every transcript the fleet has ever
written and can produce real TUI dialogs on demand; use them.

Related: `/verify` covers driving the resulting UI in a browser. This skill is
about the data feeding it. A parsing change usually wants both.

## The corpus

```bash
ls /root/.claude/projects/*/*.jsonl | wc -l    # ~580 transcripts, ~61k entries
```

Every session ever run on this box, across repos and Claude Code versions.
That version spread is the point: it's the only place a shape your current
build never emits still shows up.

**It is live and it grows under you** — the fleet's sessions (and yours) are
writing to it while you measure. So every count in this file is illustrative,
not a fixture to assert against, and more importantly: a differential must read
**one snapshot for both sides**. Run old and new on the same line inside a
single pass (below), never as two scans minutes apart, or entries that appeared
in between show up as phantom diffs.

Import the module by path — its name has a dash, so a plain import fails:

```python
import importlib.util
spec = importlib.util.spec_from_file_location("ha", "agent/hub-agent.py")
ha = importlib.util.module_from_spec(spec); spec.loader.exec_module(ha)
```

## 1. Inventory before you design

Count what's actually there before deciding what to handle. Walk every line of
every transcript with `collections.Counter` over: `entry["type"]`,
`entry["subtype"]` for system entries, `(role, block["type"])` for message
content blocks, `tool_use` names + their input keys, and `attachment.type`.
Print one example of each shape.

This is what tells you a field is worth code. Orders of magnitude from one such
pass: `Edit` ~2.4k calls, a `description` arg on ~6.9k, `pr-link` ~1.1k entries,
`compact_boundary` 8, `ExitPlanMode` 5 — and `tool_result` inner content that is
a bare string ~11.6k times but a list ~170 times. A shape you never saw is a
shape you'd have "handled" by guessing.

**Count DISTINCT values too, not just occurrences, and look at what surrounds
them.** An entry type is not automatically an event. `pr-link` ran 1163 entries
across the corpus but only 195 distinct (transcript, URL) pairs — 6× — because
Claude Code re-stamps a session's PR links in the metadata preamble it writes at
the top of every user turn, beside `last-prompt`/`ai-title`/`mode`/
`permission-mode`. Reading it as "a PR was opened here" rendered the same PR six
times in the chat. Two cheap checks catch this class before you design:

```python
Counter(e["type"] for e in entries)                        # occurrences
len({(fn, e.get("prUrl")) for e in entries})               # distinct facts
Counter(prev_type_of(i) for i in indexes_of(type))         # is it in a preamble?
```

A ratio far above 1.0, or a near-constant predecessor type, means the entry is
**state re-recorded on a schedule**, not something that happened at that spot.
Render those once — and take the FIRST sighting, after checking it lands where
the underlying event did (for `pr-link`, within ~6 entries of its `gh pr
create`).

## 2. Old-vs-new differential — the no-regression proof

Load **both** versions of the module and run every corpus entry through each:

```bash
git show origin/main:agent/hub-agent.py > "$SCRATCH/hub-agent-old.py"
```

Then for each entry classify the diff into three buckets, in code:

- **identical** — fine;
- **intended** — the diff is exactly the field/shape you added (strip your new
  keys and new block types from the new output; what's left must equal old);
- **REGRESSION** — anything else. Print the first few with the source line.

Do not eyeball a sample. Real shapes are rare — `ExitPlanMode` occurs 5 times
in ~61k entries — so the bucket that decides whether you shipped a bug can be
single digits, and you will not find it by reading.

## 3. Cross-implementation parity — measure the BASELINE first

`hub-agent.py` and `tunnel-agent.js` are hand-maintained mirrors. To check
yours still agree, dump `{entry, py_output}` per line to JSONL from Python,
re-run it through the JS export, and compare.

**Establish the pre-existing divergence before you claim yours is clean.** Run
the identical comparison with both *old* files first. On this repo that
baseline is **13 mismatches** (out of ~38k block-producing entries), and they
are not a bug in either mirror: `_clip` cuts at 2000 *codepoints* in Python and
`clip` at 2000 *UTF-16 units* in JS, so a block whose first 2000 characters
contain a non-BMP character (emoji) truncates one character apart. Nothing but
the truncation point differs. If you skip the baseline you will spend an hour
hunting a bug you didn't write.

> **Trap that cost real time:** compare **parsed structures**, not
> `JSON.stringify` output. Key insertion order differs between the two
> languages, so string comparison reported 29,761 mismatches where there were
> 13. `JSON.stringify(a) !== JSON.stringify(JSON.parse(pyLine))` still compares
> strings — round-trip *both* sides, or deep-equal them.

## 4. Measure the gain, not just the safety

Count what the change newly surfaces, per field, across the corpus. "2,381 Edit
calls previously showed only a file path" is the sentence that tells a reviewer
whether the change was worth making, and it comes free from the same pass as
the regression check. If a field's count is 0, you built for a shape that
doesn't occur.

## 5. Pane fixtures: capture them, never write them

For anything reading the tmux pane (`parse_pane_mode`, `_busy_from_capture`,
`parse_pane_prompt`), the wording, glyphs, blank-line placement and box-drawing
characters ARE the contract. Hand-written fixtures encode what you *assume* the
TUI prints, so the parser passes its tests and fails a real pane.

Drive a scratch session and capture:

```bash
cd /tmp/scratch && tmux new-session -d -s fx -x 200 -y 50 "claude --permission-mode default"
tmux send-keys -t fx "run this exact command: touch /tmp/marker. Do not explain, just run it."
tmux send-keys -t fx Enter          # SEPARATE call — see trap below
# wait for the condition, don't sleep blindly:
until tmux capture-pane -t fx -p | grep -q "Do you want to proceed?"; do sleep 2; done
tmux capture-pane -t fx -p > fixture-permission.txt
tmux send-keys -t fx Escape         # cancel; leave nothing running
tmux kill-session -t fx
```

Paste the capture into the test file verbatim, with a comment saying which
Claude Code version produced it. Use `cat -A` to see what the glyphs really are
before writing a regex against them.

- **Send text and Enter as two calls.** In one `send-keys` the TUI's paste
  detection swallows the newline and the prompt just sits there unsent.
- **Get more than one variant.** A permission dialog and a plan approval have
  different prompt wording, different option counts, and their context blocks
  sit at different depths — a parser tuned to one silently mangles the other.
- **Capture a negative control too**: the same pane with no dialog up. Idle
  panes are what a false positive fires on, and asserting `None` for one is
  worth more than another positive case.
- Own tmux sessions named distinctly (`fx`, not `agent-*`) — `agent-*` are live
  sessions belonging to the fleet.

## Traps

- **`sleep N; command` is blocked** by the harness. Use an `until <check>; do
  sleep 2; done` loop, or `run_in_background`.
- **Chrome over CDP isn't ready when `docker run` returns.** Poll it:
  `until curl -sf http://127.0.0.1:9333/json/version >/dev/null; do sleep 1; done`.
  A bare sleep gives an intermittent `ECONNREFUSED` that reads like a network
  problem.
- **The scratchpad can be emptied mid-session.** Long runs lose `node_modules`
  and generated fixtures; re-install rather than assuming, and keep anything
  you care about in the repo or in the test file.
- **A session card is `disabled` without a live tunnel**, so a fixture-driven
  UI check can't click it. Call the handler directly
  (`page.evaluate(() => selectSession("sess1"))`), or drive the engine:
  `TurmaChat.open(hostKey, id, sessionRecord, agent)`.
- **`_pane_status` returns a tuple** consumed by `session_report`; widening it
  breaks the tests that mock it. Grep for callers before changing an arity.

## What "verified" means for this kind of change

State these separately in the PR, because they answer different questions:

1. the suites pass;
2. **no regression** — old vs new over the whole corpus, with the intended
   diffs classified rather than assumed;
3. **mirrors agree** — py vs js over the corpus, measured against the
   pre-existing baseline;
4. **the gain is real** — counted occurrences of what the change surfaces;
5. it renders (see `/verify`).

3 and 4 are the ones nobody asks for and everyone wants to read.

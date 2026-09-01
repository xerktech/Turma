#!/usr/bin/env python3
"""Shared tail-side helpers for the per-runtime projection tails (XERK-528).

Both non-Claude runtimes tail a native event log off the beat and append the
Claude-JSONL projection to the pinned `<claudeSessionId>.jsonl`:
`agent/qwen_session.py`'s `QwenProjectionTail` and `agent/dsh_session.py`'s
`DshProjectionTail`. Each ALSO projects the SUBAGENTS it delegated to, per child,
into the Claude `subagents/` layout the pickers resolve — and that per-child
incremental-offset state machine was, by construction, near-identical between the
two (the qwen tail was copied from the dsh one). This holds the identical part
ONCE:

  * `env_num`/`env_int`/`env_float` — parse a numeric env knob at import time,
    falling back to the default instead of raising on junk (the XERK-372 crash-
    loop guard, for the stdlib-only siblings that can't reach hub-agent's copy).
  * `ensure_transcript_file` — create an empty transcript (+ parent dir) so a
    pinned/child path resolves the moment a session/child launches.
  * `append_entries` — append projected entry dicts as JSONL, `ensure_ascii=False`.
  * `ChildProjection` — the per-child read/rewrite-detect/split/feed/append cursor.

What stays per-runtime and is NOT here: the projector CLASS, WHERE a child's
transcript lands (dsh re-homes a workflow agent under its run dir; qwen is always
flat), and the discovery/parent-pump/native-log-mirror logic — those differ by
process model and are the tail's own.

Stdlib only, like the tails it backs — imported by them as a sibling module. It is
IO- and thread-adjacent (the tails run it on their own daemon threads, off the
beat, XERK-395), so nothing here raises: every OSError is logged and the next poll
retries.
"""

import json
import math
import os
import sys

# Make this module importable as a sibling both under hub-agent.py and when a tail
# is loaded by path in a test (same idiom hub-agent.py uses for its own siblings).
_AGENT_DIR = os.path.dirname(os.path.abspath(__file__))
if _AGENT_DIR not in sys.path:
    sys.path.insert(0, _AGENT_DIR)


def env_num(name, default, cast, *, minimum=None, maximum=None):
    """Read a numeric env var, FALLING BACK to `default` instead of raising.

    The shared twin of hub-agent.py's `_env_num` (XERK-372), for the stdlib-only
    per-runtime sibling modules (`dsh_session.py`, `qwen_session.py`) that parse
    their own numeric knobs at IMPORT time and cannot reach hub-agent's private
    copy. A bare `int(os.environ.get(...))` / `float(...)` RAISES on anything that
    is not a clean number — an empty string, a stray space, "10m", a value that
    kept its YAML quotes as `"20"`. These modules are imported by the agent's
    dsh/qwen launch paths, so a mistyped value would crash the spawn (and, for a
    knob read at hub-agent import time, the whole host) rather than fall back
    cleanly (XERK-523). So a bad value is warned to stderr and IGNORED: running
    the default beats crashing. `default` is the already-typed fallback (an
    int/float, not a string); `minimum`/`maximum`, where given, clamp a
    parseable-but-absurd value. The `[hub-agent] ` prefix matches the format the
    fleet already greps its boot warnings by."""
    raw = os.environ.get(name)
    set_by_operator = raw is not None and raw.strip() != ""
    if set_by_operator:
        try:
            val = cast(raw.strip())
            if isinstance(val, float) and not math.isfinite(val):
                raise ValueError("non-finite")
        except (ValueError, TypeError):
            print(f"[hub-agent] WARNING: {name}={raw!r} is not a valid number "
                  f"— falling back to {default}", file=sys.stderr, flush=True)
            val = default
    else:
        val = default
    if minimum is not None and val < minimum:
        if set_by_operator:
            print(f"[hub-agent] WARNING: {name}={val} is below the minimum "
                  f"{minimum} — using {minimum}", file=sys.stderr, flush=True)
        val = minimum
    if maximum is not None and val > maximum:
        if set_by_operator:
            print(f"[hub-agent] WARNING: {name}={val} is above the maximum "
                  f"{maximum} — using {maximum}", file=sys.stderr, flush=True)
        val = maximum
    return val


def env_int(name, default, *, minimum=None, maximum=None):
    return env_num(name, default, int, minimum=minimum, maximum=maximum)


def env_float(name, default, *, minimum=None, maximum=None):
    return env_num(name, default, float, minimum=minimum, maximum=maximum)


def ensure_transcript_file(path, log, what="transcript"):
    """Create the destination transcript (empty) plus its parent dir so a reader
    resolving it mid-run finds a file — an empty one reads as an empty
    conversation, the same guarantee the main transcript gets at launch. Never
    raises; an OSError is logged via `log(msg)` and left for the next poll."""
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        if not os.path.exists(path):
            open(path, "a", encoding="utf-8").close()
    except OSError as e:
        log(f"{what} create failed: {e}")


def append_entries(path, entries, log, what="projection"):
    """Append already-projected Claude-JSONL entry dicts to `path`, one per line,
    `ensure_ascii=False` (matching Claude Code). Never raises."""
    try:
        with open(path, "a", encoding="utf-8") as fh:
            for e in entries:
                fh.write(json.dumps(e, ensure_ascii=False) + "\n")
    except OSError as e:
        log(f"{what} append failed: {e}")


class ChildProjection:
    """Per-child incremental projection cursor.

    A subagent's own native log grows independently of the parent's; this reads
    the bytes appended since its last offset, feeds whole lines to a FRESH
    per-child projector (seeded on the CHILD id, so its uuids never collide with
    the parent's), and appends the projected entries to `dest`. The projector
    CLASS and the `dest` PATH are the caller's — `make_projector` is a zero-arg
    factory the caller closes over (child id + cwd + git branch) so a rewrite can
    re-create the same projector.

    State: `proj` (the live projector), `offset` (bytes consumed), `partial` (an
    unterminated trailing line held for the next read), and `dest` (the caller may
    reassign it — dsh re-homes a workflow agent — between pumps)."""

    def __init__(self, make_projector, dest):
        self._make = make_projector
        self.proj = make_projector()
        self.offset = 0
        self.partial = b""
        self.dest = dest

    def pump(self, src, append_fn):
        """Read new bytes of `src`, project them, and hand any resulting entries
        to `append_fn(self.dest, entries)`. A source shorter than the cursor is a
        rewrite: reset and re-project from 0 (deterministic uuids reproduce the
        same entries), truncating the destination too so it does not double. Never
        raises — an unreadable source simply projects nothing this pump."""
        try:
            size = os.path.getsize(src)
        except OSError:
            return
        if size < self.offset:      # rewritten under us — re-project from 0
            self.offset = 0
            self.partial = b""
            self.proj = self._make()
            try:
                open(self.dest, "w").close()   # start the destination over too
            except OSError:
                pass
        try:
            with open(src, "rb") as fh:
                fh.seek(self.offset)
                data = fh.read()
        except OSError:
            return
        if not data:
            return
        self.offset += len(data)
        self.partial += data
        entries = []
        while b"\n" in self.partial:
            line, self.partial = self.partial.split(b"\n", 1)
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line.decode("utf-8", "replace"))
            except ValueError:
                continue
            entries.extend(self.proj.feed(event))
        if entries:
            append_fn(self.dest, entries)

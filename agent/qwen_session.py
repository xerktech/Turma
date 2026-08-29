#!/usr/bin/env python3
"""The hub-agent side of a Qwen Code session's read state (XERK-509, [Qwen][C]).

Qwen Code is an interactive TUI in its own tmux (the Claude-shaped runtime,
XERK-507 [Qwen B]), NOT a headless socket-driven process like dsh. So — unlike
`dsh_session.py` — there is no control socket here: input, liveness, permission
prompts and answers all ride the real TUI PANE (hub-agent's existing pane
parsers, made qwen-aware). What this module owns is the ONE piece the pane
cannot carry: the transcript.

`QwenProjectionTail` tails Qwen's native session log on disk and runs it through
`QwenProjector` (agent/qwen_transcript.py, [Qwen S1]), appending the derived
Claude-Code JSONL projection to the pinned `<claudeSessionId>.jsonl`
incrementally — so every existing transcript surface (hub-agent tail,
tunnel-agent live tail, history, archive, usage, PR scan) reads a qwen session
with NO change and NO new reader.

Qwen writes its native log at `~/.qwen/projects/<cwd-slug>/chats/<id>.jsonl`
(G0 spike). The exact cwd->slug rule is NOT depended on: the tail LOCATES the
log by GLOBBING for `<id>.jsonl` across the project dirs, the same discipline
`hub-agent._qwen_runtime_file` uses for the runtime registry — a robustness the
slug-rule uncertainty (G0 recorded `/`->`-`, Claude's own rule is every
non-alnum->`-`) makes load-bearing.

Stdlib only, like agent/qwen_transcript.py and the rest of agent/ — imported by
hub-agent.py's qwen launcher.

Two invariants, both because the tail's siblings run on the heartbeat's critical
path (XERK-395: nothing on the beat may stall past the hub's OFFLINE_AFTER_MS):
  * the tail runs on its OWN daemon thread, never the beat, and never raises — a
    bad event projects to nothing (QwenProjector.feed is tolerant) and any IO
    error is logged and retried on the next poll;
  * `title()`/`title_final()` are read on the beat by hub-agent's naming seeder,
    so they only ever read local state and never touch disk or block.
"""

import glob
import json
import os
import threading
import time

try:
    # Imported as a sibling module by hub-agent.py (same dir on sys.path).
    from qwen_transcript import QwenProjector
except ImportError:  # pragma: no cover - only when run outside the agent dir
    QwenProjector = None

# How often the projection tail wakes to look for new native events, when it is
# not being poked. Cheap: it only reads bytes appended since its last offset.
QWEN_PROJECTION_POLL_SEC = float(os.environ.get("QWEN_PROJECTION_POLL_SEC", "0.5"))

# The event `type`s a Qwen native log MIGHT carry a generated session title on.
# The G0 spike found NO native title mechanism in the corpus (Qwen emits no
# `session/title` analogue), so tier 1 of naming is DORMANT in practice and the
# `qwen -p` one-shot (tier 2) is what generates a name — but if a future Qwen
# version writes a title event, this captures it best-effort so the seeder
# prefers it. Kept permissive and defensive; a missing/odd shape simply yields
# no title, never an error.
_TITLE_EVENT_TYPES = ("session_title", "session/title", "title", "summary")


def _noop_log(_msg):
    pass


class QwenProjectionTail:
    """Tail Qwen's native session log and append the derived Claude-JSONL
    projection to the pinned transcript, incrementally.

    Qwen writes one native-log event dict per line to
    `<qwen_projects_root>/<slug>/chats/<session_id>.jsonl`; this reads bytes
    appended since its last offset, feeds whole lines to a single stateful
    `QwenProjector`, and appends the projected entries to `transcript_path`
    (the pinned `<claudeSessionId>.jsonl`).

    The native log path is resolved LAZILY by globbing for `<session_id>.jsonl`
    under `<qwen_projects_root>/*/chats/`, so the tail does not depend on the
    exact cwd->slug rule (see the module docstring). An explicit `events_path`
    can be passed to skip the glob (tests, or a known layout).

    Runs on its own daemon thread — never the beat (XERK-395) — and never raises.
    """

    def __init__(self, qwen_projects_root, transcript_path, session_id,
                 cwd=None, git_branch=None, log=None, resume=False,
                 events_path=None, store_dir=None):
        self.qwen_projects_root = qwen_projects_root
        self.transcript_path = transcript_path
        self._log = log or _noop_log
        self._session_id = session_id
        self._cwd = cwd
        self._git_branch = git_branch
        self._proj = (QwenProjector(session_id, cwd=cwd, git_branch=git_branch)
                      if QwenProjector else None)
        # Explicitly-provided native log path (tests / a known layout), else it
        # is discovered on the first pump by globbing for the pinned id.
        self._events_path = events_path
        # On RESUME the kept native log's history is ALREADY projected into the
        # transcript (by the pre-restart tail, or the source of a migration).
        # Qwen `--resume <id>` appends to the SAME `<id>.jsonl` in place (G0
        # spike: 31 -> 34 lines, no fork), so starting at the log's current EOF
        # projects only the NEW events and avoids doubling the transcript — the
        # deterministic-uuid de-dup keeps display/usage exact, but the file would
        # still grow. A fresh launch writes a new log, so 0 is correct there. The
        # EOF is captured lazily on the first pump once the path resolves (the
        # native log may not exist yet at construction).
        self._resume = resume
        self._offset = None            # None until the first pump primes it
        self._partial = b""
        # RAW-archive mirror of qwen's native event log (XERK-512, [Qwen][E]).
        # qwen writes its native log under its OWN home, which the raw archive
        # layer does not reach; the tail copies its bytes, append-only, into
        # `<store_dir>/chat.jsonl` (== `<slug>/<sid>/qwen/chat.jsonl`), which
        # `_session_files` walks — so the canonical native log rides the raw
        # layer with no new archive code. Independent of the PROJECTION cursor
        # above: the mirror copies the WHOLE native log (the projection may skip
        # history on resume to avoid doubling the transcript, but the mirror must
        # be complete for metrics/retention), and its own byte count is the
        # cursor, so a manager restart resumes the copy where it left off. None
        # store_dir disables the mirror (kept optional for tests / older callers).
        self._store_dir = store_dir
        self._raw_path = (os.path.join(store_dir, "chat.jsonl")
                          if store_dir else None)
        self._raw_offset = None        # None until the first mirror primes it
        # Set once the native log is seen to have SHRUNK under us (a rewrite —
        # which append-only qwen --resume never does). Once frozen, the mirror is
        # left exactly as-is for the rest of THIS tail's life: chasing a rewritten
        # log by appending from a lowered offset would splice a diverged prefix
        # onto the archived copy. A manager restart re-primes cleanly from the
        # mirror's true size (self-heal), which is the only correct recovery.
        self._raw_frozen = False
        self._stop = threading.Event()
        self._thread = None
        self._wake = threading.Event()
        # Qwen's own generated session title, if it ever emits one (see
        # _TITLE_EVENT_TYPES) — tier 1 of naming. None until/unless captured.
        self._title = None
        # Whether that title is a FINAL generated title (any captured title reads
        # final: Qwen has no fallback/provisional two-title race like dsh). Kept
        # symmetric with dsh's tail so hub-agent's seeder reads one shape.
        self._title_final = False

    def start(self):
        if self._proj is None:
            self._log("qwen projection: QwenProjector unavailable; not tailing")
            return
        self._thread = threading.Thread(
            target=self._run, name="qwen-proj", daemon=True)
        self._thread.start()

    def poke(self):
        """Optional nudge to project immediately (e.g. right after an input)."""
        self._wake.set()

    def title(self):
        """Qwen's own generated session title, or None until one is captured.
        Read on the beat by hub-agent's _seed_qwen_summary (tier 1). The G0 spike
        found no native title mechanism, so this is usually None and the qwen -p
        one-shot (tier 2) generates the name — but a future Qwen that writes a
        title event is honoured here without a code change."""
        return self._title

    def title_final(self):
        """Whether `title()` is a final generated title (always True once a title
        is captured — Qwen has no provisional/fallback title race). Symmetric with
        DshProjectionTail so the naming seeder reads one shape across runtimes."""
        return self._title_final

    def stop(self):
        self._stop.set()
        self._wake.set()

    # -- native log discovery --------------------------------------------
    def _resolve_events_path(self):
        """The Qwen native log for this session id, resolved by glob if not
        given. Returns the path or None if the file hasn't been written yet (an
        empty conversation writes no `<id>.jsonl` until the first turn — the same
        truth the pinned-id transcript relies on)."""
        if self._events_path and os.path.isfile(self._events_path):
            return self._events_path
        if self._events_path:
            # A path was pinned but the file isn't there yet — keep waiting on it
            # rather than globbing to a different one.
            return None
        try:
            hits = glob.glob(os.path.join(
                self.qwen_projects_root, "*", "chats",
                "%s.jsonl" % self._session_id))
        except OSError:
            return None
        if not hits:
            return None
        # Pin the first match so later pumps stay on the same file even if a
        # second project dir ever appears with the same id (it never should).
        self._events_path = hits[0]
        return self._events_path

    def _run(self):
        # Ensure the transcript file exists so the pinned path resolves the
        # moment the session is launched (an empty file reads as an empty
        # conversation, exactly like a Claude session before its first byte).
        try:
            os.makedirs(os.path.dirname(self.transcript_path), exist_ok=True)
            if not os.path.exists(self.transcript_path):
                open(self.transcript_path, "a", encoding="utf-8").close()
        except OSError as e:
            self._log(f"qwen projection: cannot create transcript: {e}")
        while not self._stop.is_set():
            try:
                self._pump()
            except Exception as e:  # never let the tail thread die
                self._log(f"qwen projection error: {e}")
            self._wake.wait(QWEN_PROJECTION_POLL_SEC)
            self._wake.clear()

    def _pump(self):
        events_path = self._resolve_events_path()
        if not events_path:
            return  # native log not written yet
        # Mirror the native log into the raw-archive store FIRST — it is a pure
        # byte copy on its own cursor, independent of whether there are new
        # PROJECTION bytes below (a resumed tail's projection offset is at EOF,
        # but the mirror still catches up any native bytes not yet copied).
        self._mirror_native(events_path)
        try:
            size = os.path.getsize(events_path)
        except OSError:
            return
        if self._offset is None:
            # First sight of the log. On a resume the history is already
            # projected, so start at EOF; a fresh launch starts at 0.
            self._offset = size if self._resume else 0
        if size < self._offset:
            # The native log was rewritten/truncated under us. The projection is
            # a pure function of the log (deterministic uuids), but appending
            # again would duplicate, so this should only happen on an explicit
            # rewrite the launcher avoids. Reset defensively.
            self._offset = 0
            self._partial = b""
        try:
            with open(events_path, "rb") as fh:
                fh.seek(self._offset)
                data = fh.read()
        except OSError:
            return
        if not data:
            return
        self._offset += len(data)
        self._partial += data
        entries = []
        while b"\n" in self._partial:
            line, self._partial = self._partial.split(b"\n", 1)
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line.decode("utf-8", "replace"))
            except ValueError:
                continue
            # Capture a generated session title if Qwen ever writes one — it is
            # log-only for the TRANSCRIPT (QwenProjector projects only the three
            # surface types) and kept here so the naming seeder can prefer it.
            self._maybe_capture_title(event)
            entries.extend(self._proj.feed(event))
        if entries:
            self._append(self.transcript_path, entries)

    def _mirror_native(self, events_path):
        """Copy qwen's native event log, byte for byte and append-only, into the
        raw-archive store (`<slug>/<sid>/qwen/chat.jsonl`, XERK-512 [Qwen][E]) so
        it rides the raw archive layer — the canonical record metrics read, kept
        in full beside the lossy projection.

        The mirror's own byte count is the cursor (primed lazily from the mirror
        file's size on the first pump), so it is:
          * complete — it copies the whole native log regardless of the
            projection's resume-at-EOF skip; and
          * self-healing across a manager restart / resume-on-boot ADOPT — the
            new tail resumes the copy from the mirror's current size, catching up
            every native byte written while the tail was dead (a superset of what
            the projection can re-read without doubling the transcript).

        Never raises (runs on the tail's own daemon thread, off the beat): any IO
        error is logged and retried on the next poll. A `<store_dir>` of None
        disables mirroring entirely."""
        if not self._raw_path or self._raw_frozen:
            return
        try:
            native_size = os.path.getsize(events_path)
        except OSError:
            return
        if self._raw_offset is None:
            # First pump: resume the copy from wherever the mirror left off, so a
            # restart backfills every byte qwen wrote while the tail was down and
            # a running session's mirror is never re-copied from zero.
            try:
                self._raw_offset = os.path.getsize(self._raw_path)
            except OSError:
                self._raw_offset = 0
        if native_size < self._raw_offset:
            # The native log was rewritten/truncated under us — the mirror holds
            # the longer history, so NEVER truncate it to match (the same rule the
            # raw archive draws for a source shorter than its cursor). FREEZE
            # rather than lower the cursor: appending from a lowered offset if the
            # log later regrows would splice a diverged prefix onto the archive.
            # qwen --resume appends in place, so this is defensive/unreachable; a
            # restart re-primes from the mirror's true size and resumes cleanly.
            self._log("qwen native log shorter than its mirror; freezing the "
                      "archived copy intact")
            self._raw_frozen = True
            return
        if native_size == self._raw_offset:
            return
        try:
            os.makedirs(self._store_dir, exist_ok=True)
            copied = 0
            with open(events_path, "rb") as src, \
                    open(self._raw_path, "ab") as dst:
                src.seek(self._raw_offset)
                while True:
                    # Bounded read: the one large-copy case is a pre-existing
                    # native log with no mirror yet (a session that ran before
                    # this shipped, then adopted) — chunk it so the backfill never
                    # buffers the whole file.
                    chunk = src.read(1 << 20)
                    if not chunk:
                        break
                    dst.write(chunk)
                    copied += len(chunk)
            self._raw_offset += copied
        except OSError as e:
            self._log(f"qwen native log mirror failed: {e}")

    def _maybe_capture_title(self, event):
        """Best-effort tier-1 title capture (see _TITLE_EVENT_TYPES). A missing or
        odd shape simply yields nothing — Qwen emits no title in the G0 corpus, so
        this is dormant unless a future version adds one."""
        if not isinstance(event, dict):
            return
        if event.get("type") not in _TITLE_EVENT_TYPES:
            return
        # Look for the title on the event itself, a `data`/`message` sub-dict, or
        # a `systemPayload` (Qwen's system-event envelope) — the shapes a title
        # event could plausibly take, none confirmed against real Qwen.
        for container in (event, event.get("data"), event.get("message"),
                          event.get("systemPayload")):
            if not isinstance(container, dict):
                continue
            for key in ("title", "summary", "name"):
                val = container.get(key)
                if isinstance(val, str) and val.strip():
                    self._title = val.strip()
                    self._title_final = True
                    return

    def _append(self, path, entries):
        try:
            with open(path, "a", encoding="utf-8") as fh:
                for e in entries:
                    fh.write(json.dumps(e, ensure_ascii=False) + "\n")
        except OSError as e:
            self._log(f"qwen projection append failed: {e}")

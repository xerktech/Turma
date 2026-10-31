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
  * `open_dir`/`ensure_dir`/`move_file` and the `anchor=` of every write
    helper — no link planted at a PARENT directory below the session's own
    dir is followed (XERK-2570).
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

import errno
import json
import math
import os
import stat
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


# fd-relative directory ops (XERK-2570): where the platform has them (not
# Windows), a projected file's parent directories are opened ONE COMPONENT AT A
# TIME from a trusted anchor with O_DIRECTORY|O_NOFOLLOW, and every entry op is
# relative to the last fd — so a symlink planted at a PARENT (`<stem>/workflows`
# -> elsewhere) is refused (ELOOP/ENOTDIR), never followed. os.makedirs accepts
# an existing symlinked directory, and every later path-based open resolves
# through it. The same idiom as hub-agent.py's `_FD_DIR_OPS`/`_RealDir`; this
# module is stdlib-only, so it carries its own copy.
FD_DIR_OPS = (hasattr(os, "O_DIRECTORY") and hasattr(os, "O_NOFOLLOW")
              and all(f in os.supports_dir_fd
                      for f in (os.open, os.mkdir, os.unlink, os.rename)))


def _is_real_dir(st):
    """A directory that is not a symlink, junction or other reparse point."""
    return stat.S_ISDIR(st.st_mode) and not (
        getattr(st, "st_file_attributes", 0)
        & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400))


def _dir_parts(anchor, path):
    """(absolute anchor, [components of `path` below it]); raises OSError when
    `path` is not inside `anchor` — a projected file outside its session's
    directory is never written."""
    a = os.path.abspath(anchor)
    p = os.path.abspath(path)
    if p == a:
        return a, []
    try:
        rel = os.path.relpath(p, a)
    except ValueError:            # another drive on Windows
        rel = os.pardir
    parts = rel.split(os.sep)
    if os.path.isabs(rel) or any(x in ("", os.curdir, os.pardir) for x in parts):
        raise OSError(errno.EPERM, "path is outside its anchor directory", path)
    return a, parts


def open_dir(path, anchor, create=False):
    """Open directory `path`, which must lie under `anchor`, without following
    a link at any component BELOW the anchor (the anchor itself is the trusted
    root and is followed, like the projects dir an operator may mount). With
    `create`, missing components (and the anchor) are made. Returns a dir fd
    the caller closes, or None on a platform without fd-relative ops — there
    each component is lstat-checked instead (a check-then-use window remains,
    as in hub-agent's fallback). Raises OSError on a link or non-directory."""
    a, parts = _dir_parts(anchor, path)
    if create:
        os.makedirs(a, exist_ok=True)
    if not FD_DIR_OPS:
        cur = a
        for x in parts:
            cur = os.path.join(cur, x)
            if create:
                try:
                    os.mkdir(cur)
                except FileExistsError:
                    pass
            if not _is_real_dir(os.lstat(cur)):
                raise OSError(errno.ELOOP, "not a real directory; not followed", cur)
        return None
    fd = os.open(a, os.O_RDONLY | os.O_DIRECTORY)
    try:
        for x in parts:
            if create:
                try:
                    os.mkdir(x, dir_fd=fd)       # never follows a link at `x`
                except FileExistsError:
                    pass
            nfd = os.open(x, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                          dir_fd=fd)
            os.close(fd)
            fd = nfd
    except BaseException:
        os.close(fd)
        raise
    return fd


def ensure_dir(path, anchor):
    """Create directory `path` under `anchor` (and its parents) without
    following a planted link anywhere below the anchor. Raises OSError."""
    fd = open_dir(path, anchor, create=True)
    if fd is not None:
        os.close(fd)


class _Entry:
    """A file NAME inside its parent directory. Anchored: the parent is opened
    via `open_dir` and `at()` yields fd-relative (name, {"dir_fd": fd}) — or,
    on the fallback platform, a checked joined path. Unanchored (`anchor` None,
    the pre-XERK-2570 behaviour kept for callers without a session dir):
    plain paths."""

    def __init__(self, path, anchor, create):
        self.fd = None
        self.dir, self.name = os.path.split(path)
        if anchor is not None:
            self.fd = open_dir(self.dir, anchor, create)
        elif create and self.dir:
            os.makedirs(self.dir, exist_ok=True)

    def at(self, name=None):
        name = self.name if name is None else name
        if self.fd is not None:
            return name, {"dir_fd": self.fd}
        return os.path.join(self.dir, name), {}

    def close(self):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        self.close()


def _open_fresh_at(entry, name):
    p, kw = entry.at(name)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    try:
        os.unlink(p, **kw)
    except FileNotFoundError:
        pass
    except PermissionError:
        # Windows refuses to unlink a file another process holds open without
        # FILE_SHARE_DELETE (a reader mid-read). There O_NOFOLLOW is a no-op
        # anyway, so truncate in place exactly as a plain open would have.
        if os.name != "nt":
            raise
        flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    fd = os.open(p, flags | getattr(os, "O_NOFOLLOW", 0)
                 | getattr(os, "O_BINARY", 0), 0o600, **kw)
    return os.fdopen(fd, "w", encoding="utf-8")


def open_fresh_for_write(path, anchor=None, create=False):
    """Open `path` for writing as a brand-new file the tail itself created.

    The projected files live under `~/.claude/projects/<slug>/…`, which a
    session's own Bash can write, so a symlink (or hardlink) planted at the name
    would make a plain `open(path, "w")` write through it as the agent's uid
    (XERK-2564). Unlinking the entry first and then creating with
    O_EXCL|O_NOFOLLOW guarantees the write lands in a fresh inode at exactly this
    name: a link re-planted between the unlink and the open makes O_EXCL fail
    (EEXIST) rather than be followed. With `anchor`, a link at a PARENT directory
    is refused too (XERK-2570), and `create` makes missing parents. Returns a
    text-mode file object; raises OSError like `open` does."""
    with _Entry(path, anchor, create) as e:
        return _open_fresh_at(e, e.name)


def open_for_append(path, binary=False, anchor=None, create=False):
    """Open `path` to APPEND, creating it if absent, without ever writing
    through a link planted at the name (XERK-2564): O_NOFOLLOW refuses a
    symlink (ELOOP), and a file that is not a regular single-link file (a
    hardlink to something else, a FIFO) is refused too. With `anchor`, a link
    at a parent directory is refused as well (XERK-2570). Raises OSError, so a
    caller's existing `except OSError` logs it and the next poll retries."""
    with _Entry(path, anchor, create) as e:
        p, kw = e.at()
        fd = os.open(p, os.O_WRONLY | os.O_APPEND | os.O_CREAT
                     | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
                     | getattr(os, "O_BINARY", 0), 0o600, **kw)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_nlink > 1:
            raise OSError(errno.EPERM, "refusing to append to a linked or "
                          "non-regular file", path)
    except BaseException:
        os.close(fd)
        raise
    if binary:
        return os.fdopen(fd, "ab")
    return os.fdopen(fd, "a", encoding="utf-8")


def _rename_at(src_entry, src_name, dst_entry, dst_name):
    sp, skw = src_entry.at(src_name)
    dp, dkw = dst_entry.at(dst_name)
    if src_entry.fd is not None and dst_entry.fd is not None:
        # POSIX rename replaces the destination entry (a link there included)
        # atomically; os.replace is not in supports_dir_fd everywhere.
        os.rename(sp, dp, src_dir_fd=src_entry.fd, dst_dir_fd=dst_entry.fd)
    else:
        os.replace(sp, dp)


def write_text_replace(path, text, anchor=None, create=False, tmp_tag=None):
    """Write `text` to a fresh per-pid tmp (via the fresh-file open), then
    rename it over `path` — a reader sees the old file or the new one, never a
    half one, and a link planted at either name (or, anchored, at a parent
    directory) is never written through. Raises OSError; the tmp is removed on
    failure."""
    with _Entry(path, anchor, create) as e:
        tmp = ("%s.%s.%d.tmp" % (e.name, tmp_tag, os.getpid()) if tmp_tag
               else "%s.%d.tmp" % (e.name, os.getpid()))
        try:
            with _open_fresh_at(e, tmp) as fh:
                fh.write(text)
            _rename_at(e, tmp, e, e.name)
        except BaseException:       # incl. UnicodeEncodeError: never leak the tmp
            try:
                p, kw = e.at(tmp)
                os.unlink(p, **kw)
            except OSError:
                pass
            raise


def move_file(old, new, anchor):
    """Rename `old` to `new` (both under `anchor`), creating `new`'s parent
    directories, following no link below the anchor. Returns False when `old`
    does not exist. Raises OSError otherwise."""
    with _Entry(old, anchor, False) as src:
        p, kw = src.at()
        try:
            os.stat(p, follow_symlinks=False, **kw)
        except FileNotFoundError:
            return False
        with _Entry(new, anchor, True) as dst:
            _rename_at(src, src.name, dst, dst.name)
    return True


def ensure_transcript_file(path, log, what="transcript", anchor=None):
    """Create the destination transcript (empty) plus its parent dir so a reader
    resolving it mid-run finds a file — an empty one reads as an empty
    conversation, the same guarantee the main transcript gets at launch. Never
    raises; an OSError is logged via `log(msg)` and left for the next poll."""
    try:
        if anchor is None:
            os.makedirs(os.path.dirname(path), exist_ok=True)
        if not os.path.exists(path):
            open_for_append(path, anchor=anchor, create=True).close()
    except OSError as e:
        log(f"{what} create failed: {e}")


def append_entries(path, entries, log, what="projection", anchor=None):
    """Append already-projected Claude-JSONL entry dicts to `path`, one per line,
    `ensure_ascii=False` (matching Claude Code). Never raises."""
    try:
        with open_for_append(path, anchor=anchor) as fh:
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

    def __init__(self, make_projector, dest, anchor=None):
        self._make = make_projector
        self.anchor = anchor
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
        # lstat, and a no-follow open below: the caller's "regular file, not a
        # link" check is from its directory listing, so a log swapped to a link
        # (or FIFO) since then must still be refused here, at the read.
        try:
            st = os.lstat(src)
        except OSError:
            return
        if not stat.S_ISREG(st.st_mode):
            return
        size = st.st_size
        if size < self.offset:      # rewritten under us — re-project from 0
            self.offset = 0
            self.partial = b""
            self.proj = self._make()
            try:
                open_fresh_for_write(self.dest, anchor=self.anchor).close()  # start over too
            except OSError:
                pass
        elif size == self.offset:
            # Nothing new since the last pump: skip the open/seek/read. A tail
            # polls every child every pump, and most children are idle or done.
            return
        try:
            fd = os.open(src, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
                         | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0))
            with os.fdopen(fd, "rb") as fh:
                if not stat.S_ISREG(os.fstat(fh.fileno()).st_mode):
                    return          # swapped to a FIFO/device after the lstat
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

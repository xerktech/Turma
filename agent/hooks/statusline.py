#!/usr/bin/env python3
"""Claude Code ``statusLine`` command that records the subscription limit snapshot.

Claude Code hands the configured statusLine command a JSON blob on stdin, and for
a Pro/Max login that blob carries ``rate_limits``: the 5-hour session window and
the 7-day weekly window, each a used percentage plus the epoch second the window
resets. There is no API behind those numbers — Anthropic's Usage & Cost API is
org-scoped, admin-keyed, and reports API spend rather than subscription caps — so
this stdin blob is the only sanctioned way to read them, and this hook is the one
place Turma reads it (XERK-247).

It writes ``~/.turma/limits.json`` (``$TURMA_LIMITS_PATH`` overrides) for
hub-agent.py to fold onto the heartbeat, and prints a one-line summary so it
still behaves as a real status line for whoever's terminal it runs in.

Two rules the callers depend on:

- **It never fails loudly.** Bad stdin, an unwritable path, a shape Claude Code
  changed — every one of them exits 0 with a blank line. A statusLine command
  that errors paints its stderr into the operator's terminal on every render.
- **A blob with no ``rate_limits`` leaves the previous snapshot alone.** The
  field is absent until the first API response of a session (and always, for a
  non-subscription login), so writing "nothing" on those renders would blank a
  good snapshot seconds after taking it.
"""

import json
import math
import os
import sys
import tempfile
import time

DEFAULT_PATH = os.path.join(os.path.expanduser("~"), ".turma", "limits.json")

# stdin key -> snapshot key. Each window may be independently absent.
WINDOWS = (("five_hour", "fiveHour"), ("seven_day", "sevenDay"))
# Magnitude bound on an epoch second (year ~5138), mirroring the reader's.
EPOCH_MAX = 10 ** 11


def snapshot_path():
    return os.environ.get("TURMA_LIMITS_PATH") or DEFAULT_PATH


def _window(raw):
    """One window's {usedPct, resetsAt}, or None when it carries neither.

    ``used_percentage`` arrives as a float that has been through arithmetic
    (14.000000000000002 is a real observed value), so it's rounded to one
    decimal and clamped: a percentage outside 0..100 is a shape we don't
    understand, and clamping keeps the UI's bar arithmetic honest either way.
    """
    if not isinstance(raw, dict):
        return None
    out = {}
    pct = _number(raw.get("used_percentage"))
    if pct is not None:
        out["usedPct"] = round(min(100.0, max(0.0, pct)), 1)
    resets = _number(raw.get("resets_at"))
    # Bounded before int(): the reader on the other side of this file refuses an
    # absurd epoch anyway, and a non-finite one can't even be written as JSON.
    if resets is not None and abs(resets) <= EPOCH_MAX:
        out["resetsAt"] = int(resets)
    return out or None


def _number(value):
    """`value` as a finite float, or None — booleans, strings, NaN and inf all
    read as "not a number this file should carry"."""
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return None
    value = float(value)
    return value if math.isfinite(value) else None


def build_snapshot(payload, now=None):
    """The snapshot dict for one statusLine payload, or None when it carries no
    rate limits at all (see the module docstring — that's "don't write", not
    "write empty")."""
    if not isinstance(payload, dict):
        return None
    limits = payload.get("rate_limits")
    if not isinstance(limits, dict):
        return None
    snap = {}
    for src, dst in WINDOWS:
        win = _window(limits.get(src))
        if win:
            snap[dst] = win
    if not snap:
        return None
    # capturedAt is what the UI ages the snapshot against, and it is the READ's
    # own clock rather than anything from the payload: these numbers are only
    # ever as true as the moment Claude Code last answered, and a snapshot with
    # no timestamp would render as fresh forever.
    snap["capturedAt"] = int(now if now is not None else time.time())
    snap["source"] = "statusline"
    version = payload.get("version")
    if isinstance(version, str) and version.strip():
        snap["claudeVersion"] = version.strip()[:32]
    return snap


# Bound the read of the prior snapshot: it is our own couple-hundred-byte file,
# but ~/.turma is writable by every session on the host (the same threat model
# read_limits_snapshot guards against), so a path pointed at something enormous
# must not become an unbounded allocation.
PREV_READ_MAX = 64 << 10


def _read_prev_snapshot(path=None):
    """The snapshot currently on disk, or None. Never raises."""
    path = path or snapshot_path()
    try:
        with open(path, encoding="utf-8") as fh:
            text = fh.read(PREV_READ_MAX + 1)
        if len(text) > PREV_READ_MAX:
            return None
        data = json.loads(text)
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def carry_window_high_water(snap, path=None):
    """Floor each window's ``usedPct`` at the highest value already recorded for
    THAT window instance (keyed on ``resetsAt``), and return ``snap``.

    A fixed window's used percentage only RISES until it resets — usage
    accumulates — so a reading that DROPS while the window has not reset is not
    headroom coming back, it is a bad reading. Claude Code 2.1.x intermittently
    hands the statusLine a window whose ``used_percentage`` is 0 on a fresh probe
    session even when the real figure is well above zero: observed on one host as
    a 7-day window read ``14%`` then ``0%`` thirty minutes later with 130+ hours
    still to reset (an impossible drop), which then overwrote the good snapshot
    and painted the Usage page at 0%. Flooring at the per-window high-water mark
    makes one such zero unable to wipe a good reading.

    Keyed on ``resetsAt`` so a genuine RESET — which brings a new reset stamp —
    starts a fresh mark and is free to drop (a 5-hour window resetting to ~0 is
    real; the same 7-day figure dropping mid-window is not). The floor only ever
    raises toward MORE usage, i.e. LESS headroom, so a residual bad reading errs
    on the safe side of a headroom gauge rather than hiding a nearly-spent limit.

    Never raises — it runs on write_snapshot's path, whose contract is that a
    statusLine command never fails loudly. A missing, unreadable, or
    reset-mismatched prior just means there is no floor to apply."""
    if not isinstance(snap, dict):
        return snap
    prev = _read_prev_snapshot(path)
    if not isinstance(prev, dict):
        return snap
    for _, dst in WINDOWS:
        cur = snap.get(dst)
        old = prev.get(dst)
        if not isinstance(cur, dict) or not isinstance(old, dict):
            continue
        # Same window instance only. Both must carry a reset stamp and agree on
        # it; without one there is no way to tell a reset from a spurious drop,
        # so the floor is not applied.
        if "resetsAt" not in cur or cur.get("resetsAt") != old.get("resetsAt"):
            continue
        cur_pct, old_pct = cur.get("usedPct"), old.get("usedPct")
        if (isinstance(cur_pct, (int, float)) and not isinstance(cur_pct, bool)
                and isinstance(old_pct, (int, float)) and not isinstance(old_pct, bool)
                and old_pct > cur_pct):
            cur["usedPct"] = old_pct
    return snap


def write_snapshot(snap, path=None):
    """Write the snapshot atomically. Returns True on success, False on any
    failure — the caller prints its status line either way."""
    path = path or snapshot_path()
    try:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        # Same dir as the target so os.replace stays on one filesystem: a reader
        # (hub-agent's beat) then sees either the old file or the new one, never
        # a half-written one.
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path) or ".",
                                   prefix=".limits-", suffix=".tmp")
        try:
            with os.fdopen(fd, "w") as fh:
                # allow_nan=False: Python writes bare NaN/Infinity, which is not
                # JSON and which the reader would have to defuse. Nothing here
                # can produce one (see _number) — this is the backstop.
                json.dump(snap, fh, allow_nan=False)
            os.replace(tmp, path)
        except Exception:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
    except Exception:
        return False
    return True


def _fmt_reset(resets_at, now):
    """"resets in 2h 14m" for a future reset; "" when it's absent or past."""
    if not resets_at:
        return ""
    left = int(resets_at) - int(now)
    if left <= 0:
        return ""
    hours, mins = divmod(left // 60, 60)
    return f"{hours}h {mins:02d}m" if hours else f"{mins}m"


def status_text(snap, now=None):
    """The line printed to the terminal. Empty when there's nothing to say, so a
    session whose login has no rate limits shows a blank status line rather than
    a row of placeholders."""
    if not snap:
        return ""
    now = now if now is not None else time.time()
    parts = []
    for label, key in (("5h", "fiveHour"), ("7d", "sevenDay")):
        win = snap.get(key) or {}
        if "usedPct" not in win:
            continue
        left = _fmt_reset(win.get("resetsAt"), now)
        parts.append(f"{label} {win['usedPct']:g}%" + (f" (resets {left})" if left else ""))
    return " · ".join(parts)


def main():
    try:
        raw = sys.stdin.read()
    except Exception:
        raw = ""
    try:
        payload = json.loads(raw) if raw.strip() else None
    except ValueError:
        payload = None
    snap = build_snapshot(payload)
    if snap:
        # Floor each window against the snapshot already on disk before writing,
        # so an intermittent Claude Code zero can't clobber a good reading.
        snap = carry_window_high_water(snap)
        write_snapshot(snap)
    print(status_text(snap))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        # Belt and braces over the per-step guards above: whatever else happens,
        # a statusLine command must not paint a traceback into the terminal.
        print("")
        sys.exit(0)

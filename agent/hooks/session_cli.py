#!/usr/bin/env python3
"""Turma session CLI — how a running session hands its manager structured intent.

A session runs::

    python3 -SsE "$TURMA_SESSION_CLI" wake <duration> <reason...>
    python3 -SsE "$TURMA_SESSION_CLI" close-ticket <done|not-reproducible|already-fixed> --note "<evidence>"

Each subcommand writes ONE rendezvous file,
``~/.turma/session-requests/<TURMA_SESSION_ID>/<subcommand>.json``, atomically
(a dot-prefixed temp file in the same directory, then ``os.replace``), prints a
one-line confirmation and exits 0. The manager (``hub-agent.py``) reads it
through ``_read_untrusted_json`` — never a transcript marker, which a quoted
line could forge and which would cost ``hub-agent.py`` ⇄ ``tunnel-agent.js``
parser parity. ``.claude/rules/agent-session-cli.md`` carries the contract.

Exit codes: 0 written; 2 refused (usage, a bound, or no ``TURMA_SESSION_ID`` —
a ``claude`` the manager did not launch has no session to wake).

Lives under ``agent/hooks/`` because that directory is what the native install,
the updater and release staging glob on both OSes. Stdlib only: it runs with
``-SsE``, so nothing beyond the standard library can be assumed importable.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time

# ~/.turma is the manager's REGISTRY_DIR on every OS (hub-agent.py), so the CLI
# derives the same path rather than taking one from the environment.
REQUESTS_DIR = os.path.join(os.path.expanduser("~"), ".turma", "session-requests")

# A session id is app-minted (hex), but it is joined onto a path here, so only a
# plain name is accepted — never `.`/`..` or a separator. hub-agent.py's
# SESSION_REQUEST_SID_RE is the same pattern.
SID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")

WAKE_REASON_MAX = 200
CLOSE_NOTE_MAX = 2000
# A wake further out than this is a session that should end its turn and be
# resumed by a person, not one that should hold a slot asleep.
WAKE_MAX_SEC = 7 * 24 * 3600
CLOSE_RESOLUTIONS = ("done", "not-reproducible", "already-fixed")

_DURATION_PART = re.compile(r"(\d+)([dhms])")
_UNIT_SEC = {"d": 86400, "h": 3600, "m": 60, "s": 1}


class Refused(Exception):
    """A request this CLI will not write; the message says why."""


def parse_duration(text: str) -> int:
    """Seconds in a duration like `20m`, `2h` or `1h30m`. Raises Refused."""
    raw = (text or "").strip().lower()
    if not raw or _DURATION_PART.sub("", raw):
        raise Refused(f"duration {text!r} is not like 20m, 2h or 1h30m")
    secs = sum(int(n) * _UNIT_SEC[u] for n, u in _DURATION_PART.findall(raw))
    if secs <= 0:
        raise Refused("duration must be more than zero")
    if secs > WAKE_MAX_SEC:
        raise Refused("duration must be at most 7d")
    return secs


def _one_line(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def write_request(sid: str, name: str, data: dict) -> str:
    """Write `<REQUESTS_DIR>/<sid>/<name>.json` atomically; return its path."""
    folder = os.path.join(REQUESTS_DIR, sid)
    os.makedirs(folder, mode=0o700, exist_ok=True)
    path = os.path.join(folder, f"{name}.json")
    # Dot-prefixed so nothing reading `<name>.json` ever sees it half-written;
    # O_EXCL|O_NOFOLLOW so a planted name is an error, never a write through it.
    tmp = os.path.join(folder, f".{name}.{os.getpid()}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL
                 | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0), 0o600)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(json.dumps(data).encode("utf-8"))
        os.replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise
    return path


def _wake(sid: str, args) -> str:
    secs = parse_duration(args.duration)
    reason = _one_line(" ".join(args.reason))
    if not reason:
        raise Refused("wake needs a reason")
    if len(reason) > WAKE_REASON_MAX:
        raise Refused(f"reason is {len(reason)} chars; the limit is {WAKE_REASON_MAX}")
    now_ms = int(time.time() * 1000)
    write_request(sid, "wake", {"wakeAt": now_ms + secs * 1000, "reason": reason,
                                "requestedAt": now_ms})
    return (f"wake requested in {args.duration}: you will be sent "
            f"\"Wake-up: {reason}\" then")


def _close_ticket(sid: str, args) -> str:
    note = (args.note or "").strip()
    if not note:
        raise Refused("close-ticket needs --note with the evidence")
    if len(note) > CLOSE_NOTE_MAX:
        raise Refused(f"note is {len(note)} chars; the limit is {CLOSE_NOTE_MAX}")
    write_request(sid, "close-ticket", {"resolution": args.resolution, "note": note,
                                        "requestedAt": int(time.time() * 1000)})
    return (f"close-ticket requested ({args.resolution}); the manager will act on it "
            "and message you if it cannot close the ticket")


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="session_cli.py",
                                description="Hand the Turma manager a request.")
    sub = p.add_subparsers(dest="cmd", required=True)
    w = sub.add_parser("wake", help="be sent a wake-up message after a delay")
    w.add_argument("duration", help="like 20m, 2h or 1h30m (at most 7d)")
    w.add_argument("reason", nargs="+", help=f"why (at most {WAKE_REASON_MAX} chars)")
    w.set_defaults(func=_wake)
    c = sub.add_parser("close-ticket", help="ask the manager to close your ticket")
    c.add_argument("resolution", choices=CLOSE_RESOLUTIONS)
    c.add_argument("--note", required=True,
                   help=f"the evidence (at most {CLOSE_NOTE_MAX} chars)")
    c.set_defaults(func=_close_ticket)
    return p


def main(argv=None) -> int:
    args = _parser().parse_args(argv)   # a usage error exits 2 on its own
    sid = os.environ.get("TURMA_SESSION_ID", "")
    if not sid:
        print("session_cli: TURMA_SESSION_ID is not set, so this is not a "
              "Turma-launched session; nothing was written", file=sys.stderr)
        return 2
    if not SID_RE.fullmatch(sid):
        print(f"session_cli: TURMA_SESSION_ID {sid!r} is not a session id; "
              "nothing was written", file=sys.stderr)
        return 2
    try:
        msg = args.func(sid, args)
    except Refused as e:
        print(f"session_cli: {e}; nothing was written", file=sys.stderr)
        return 2
    except OSError as e:
        print(f"session_cli: could not write the request: {e}", file=sys.stderr)
        return 1
    print(msg)
    return 0


if __name__ == "__main__":
    sys.exit(main())

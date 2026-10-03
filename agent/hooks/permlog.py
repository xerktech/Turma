#!/usr/bin/env python3
"""Turma permission ledger hook (XERK-1563) — ``PermissionRequest`` + ``PermissionDenied``.

Nothing else measures which permission prompts actually stall sessions, so every
allow-list change was a guess. This hook RECORDS, it never decides: for each
event it appends one JSON line to ``<dir>/<TURMA_SESSION_ID>.jsonl`` and prints
nothing, so Claude Code's own flow (the dialog, or the classifier's "no") runs
exactly as it would without it. The manager tails the file on a worker and folds
the rows into the ledger it heartbeats to the hub.

  * ``PermissionRequest`` fires for a rule/manual-mode prompt — the numbered
    dialog the pane scrape also sees. Carries the suggested rules Claude Code
    offers (``rulesMatched``) and the ``toolUseId`` the manager merges on.
  * ``PermissionDenied`` fires for an auto-mode CLASSIFIER block, which shows no
    dialog at all: the model is told no and turns to the human in chat. The
    hook is the only signal of it (``denyReason``).
  * A sandbox escape is not hookable; the pane scrape is its only source.

Line shape: ``{ts, event, toolUseId, tool, head, digest, denyReason|rulesMatched}``
— ``ts`` in epoch ms, ``head`` the Bash command's first word(s) / the file path /
the MCP tool name / the WebFetch domain, ``digest`` a bounded normalised copy of
the tool input. The file is append-only with a ``LOG_MAX_BYTES`` cap, past which
it rotates to ``<name>.1`` (one generation).

The directory comes from ``argv[1]`` (the manager writes it into the settings
file it builds, so the hook and the reader can never disagree), falling back to
``~/.turma/permissions``. ``TURMA_SESSION_ID`` is the one the launcher already
exports; without it (``claude`` run outside a Turma session) this is a no-op.

Fails OPEN on everything: a malformed event, an unwritable directory, a FIFO or
symlink planted at the log path — exit 0, no output. A ledger hook that wedged
or failed a prompt would cost more than the row it lost. Every open is
``O_NONBLOCK`` + regular-file only for the same reason ``guard.py``'s reads are.

Stdlib only, run as ``python3 -SsE``: invoked by absolute path, so nothing beyond
the standard library can be assumed importable.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import stat
import sys
import time
from urllib.parse import urlsplit

LOG_MAX_BYTES = 1 << 20      # rotate past this (one `.1` generation kept)
STDIN_MAX_BYTES = 1 << 20    # an event bigger than this is not read whole
HEAD_MAX = 200
DIGEST_MAX = 400
REASON_MAX = 300
RULES_MAX = 8
RULE_MAX = 200
TOOL_MAX = 128
SID_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
TOOL_USE_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
EVENTS = ("PermissionRequest", "PermissionDenied")
# CLIs whose first word alone names nothing an allow rule should cover: their
# SUBCOMMAND is the unit (`git push` and `git status` are different decisions),
# so the head keeps it.
SUBCOMMAND_CLIS = frozenset({
    "git", "gh", "glab", "az", "npm", "pnpm", "yarn", "npx", "bun", "docker",
    "kubectl", "helm", "cargo", "go", "uv", "pip", "pip3", "terraform", "make",
    "systemctl", "brew", "apt", "apt-get", "dotnet", "gradle", "./gradlew",
})
_ENV_ASSIGN_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
_SEGMENT_SPLIT_RE = re.compile(r"&&|\|\||;|\||\n")


def _cap(value, limit):
    return value if len(value) <= limit else value[:limit]


def bash_head(command):
    """The first command's first word — two for a CLI whose subcommand is the
    decision (``git push``, ``npm test``). Leading ``VAR=value`` assignments are
    skipped (they are not the command). ``""`` when nothing parses."""
    if not isinstance(command, str):
        return ""
    first = _SEGMENT_SPLIT_RE.split(command.strip(), maxsplit=1)[0].strip()
    try:
        words = shlex.split(first)
    except ValueError:
        words = first.split()
    words = [w for w in words if w]
    while words and _ENV_ASSIGN_RE.match(words[0]):
        words.pop(0)
    if not words:
        return ""
    head = words[0]
    if head in SUBCOMMAND_CLIS and len(words) > 1 and not words[1].startswith("-"):
        head = f"{head} {words[1]}"
    return _cap(head, HEAD_MAX)


def tool_head(tool, tool_input):
    """What an allow rule for this call would be keyed on. See the module doc."""
    inp = tool_input if isinstance(tool_input, dict) else {}
    if tool == "Bash":
        return bash_head(inp.get("command"))
    if tool.startswith("mcp__"):
        return _cap(tool, HEAD_MAX)
    if tool == "WebFetch":
        url = inp.get("url")
        if isinstance(url, str):
            try:
                return _cap((urlsplit(url).hostname or "").lower(), HEAD_MAX)
            except ValueError:
                return ""
        return ""
    for key in ("file_path", "notebook_path", "path"):
        val = inp.get(key)
        if isinstance(val, str) and val:
            return _cap(val, HEAD_MAX)
    return _cap(tool, HEAD_MAX)


def digest(tool_input):
    """A bounded, whitespace-normalised copy of the tool input — enough for an
    operator to recognise the call, never the whole of a large edit."""
    try:
        text = json.dumps(tool_input, ensure_ascii=False, sort_keys=True,
                          separators=(",", ":"), default=str)
    except (TypeError, ValueError, RecursionError):
        return ""
    return _cap(" ".join(text.split()), DIGEST_MAX)


def suggested_rules(suggestions):
    """``permission_suggestions`` → the rule strings Claude Code would add
    (``Bash(npm test:*)``). Bounded in count and length; malformed entries skip."""
    out = []
    if not isinstance(suggestions, list):
        return out
    for sug in suggestions:
        rules = sug.get("rules") if isinstance(sug, dict) else None
        if not isinstance(rules, list):
            continue
        for rule in rules:
            if not isinstance(rule, dict):
                continue
            name = rule.get("toolName")
            if not isinstance(name, str) or not name:
                continue
            content = rule.get("ruleContent")
            text = f"{name}({content})" if isinstance(content, str) and content else name
            out.append(_cap(text, RULE_MAX))
            if len(out) >= RULES_MAX:
                return out
    return out


def build_row(event, now_ms=None):
    """The ledger line for one hook event, or None for anything this hook does
    not record (another event, no tool name)."""
    if not isinstance(event, dict):
        return None
    name = event.get("hook_event_name")
    if name not in EVENTS:
        return None
    tool = event.get("tool_name")
    if not isinstance(tool, str) or not tool:
        return None
    tool = _cap(tool, TOOL_MAX)
    tool_input = event.get("tool_input")
    tuid = event.get("tool_use_id")
    row = {
        "ts": int(now_ms if now_ms is not None else time.time() * 1000),
        "event": name,
        "toolUseId": tuid if isinstance(tuid, str) and TOOL_USE_ID_RE.match(tuid) else None,
        "tool": tool,
        "head": tool_head(tool, tool_input),
        "digest": digest(tool_input),
    }
    if name == "PermissionDenied":
        reason = event.get("reason")
        if not isinstance(reason, str):
            reason = event.get("denial_reason") if isinstance(event.get("denial_reason"), str) else ""
        row["denyReason"] = _cap(" ".join(reason.split()), REASON_MAX)
    else:
        row["rulesMatched"] = suggested_rules(event.get("permission_suggestions"))
    return row


def _open_append(path):
    """An append fd on a REGULAR file at `path`, or None. O_NOFOLLOW refuses a
    planted symlink, O_NONBLOCK keeps a planted FIFO from hanging the hook."""
    flags = (os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
             | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0))
    try:
        fd = os.open(path, flags, 0o600)
    except OSError:
        return None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            os.close(fd)
            return None
    except OSError:
        os.close(fd)
        return None
    return fd


def append_row(directory, session_id, row, max_bytes=LOG_MAX_BYTES):
    """Append one line, rotating first when the file is at its cap. True when
    the line was written."""
    try:
        os.makedirs(directory, mode=0o700, exist_ok=True)
    except OSError:
        return False
    path = os.path.join(directory, f"{session_id}.jsonl")
    try:
        st = os.lstat(path)
        if stat.S_ISREG(st.st_mode) and st.st_size >= max_bytes:
            os.replace(path, path + ".1")
    except OSError:
        pass
    fd = _open_append(path)
    if fd is None:
        return False
    try:
        line = json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n"
        os.write(fd, line.encode("utf-8"))
        return True
    except OSError:
        return False
    finally:
        os.close(fd)


def main(argv=None):
    argv = sys.argv if argv is None else argv
    session_id = (os.environ.get("TURMA_SESSION_ID") or "").strip()
    if not SID_RE.match(session_id):
        return 0
    directory = argv[1] if len(argv) > 1 and argv[1] else os.path.join(
        os.path.expanduser("~"), ".turma", "permissions")
    try:
        raw = sys.stdin.read(STDIN_MAX_BYTES + 1)
        if len(raw) > STDIN_MAX_BYTES:
            return 0
        event = json.loads(raw) if raw.strip() else None
    except (OSError, ValueError, RecursionError):
        return 0
    try:
        row = build_row(event)
    except Exception:            # noqa: BLE001 — a ledger hook must never fail a prompt
        return 0
    if row is not None:
        append_row(directory, session_id, row)
    return 0


if __name__ == "__main__":  # pragma: no cover - shell entry
    sys.exit(main())

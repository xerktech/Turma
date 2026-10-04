#!/usr/bin/env python3
"""Turma permission ledger hook (XERK-1563) — ``PermissionRequest`` + ``PermissionDenied``.

Nothing else measures which permission prompts actually stall sessions, so every
allow-list change was a guess. The ledger half RECORDS, it never decides: for each
event it appends one JSON line to ``<dir>/<TURMA_SESSION_ID>.jsonl`` and prints
nothing, so Claude Code's own flow (the dialog, or the classifier's "no") runs
exactly as it would without it. The manager tails the file on a worker and folds
the rows into the ledger it heartbeats to the hub.

  * ``PermissionRequest`` fires for a rule/manual-mode prompt — the numbered
    dialog the pane scrape also sees. Carries the suggested rules Claude Code
    offers (``rulesMatched``) but NO ``tool_use_id`` (2.1.288; PermissionDenied
    and PreToolUse have one), so the manager merges it with its dialog on the
    call's ``tool`` + ``head``/``digest``; ``toolUseId`` is null here.
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

The permission JUDGE (XERK-1566) rides the same hook: with ``--judge`` as
``argv[2]`` (the manager adds it unless ``TURMA_PERMISSION_JUDGE=0``), a
``Bash`` call is also handed to the manager's judge — but only while the judge
says it is up (``judge.alive`` fresh in the directory; the manager removes it
when it has no policy text, so a stood-down judge costs no wait). The hook
writes ``<sid>.<nonce>.judge.req.json`` and polls for the ``.judge.ans.json``
the manager drops (the ``ask.py`` req/ans pattern, at most ``JUDGE_WAIT_SEC``).
On ``allow`` it answers ``retry: true`` (PermissionDenied — the retried call
then meets ``guard.py``, which honours the one-shot grant the judge wrote) or
``decision.behavior: allow`` (PermissionRequest). Anything else — stand, no
answer, a malformed one — prints nothing, so Claude Code's own flow runs.
Scope is Bash only: ``guard.py``, which honours the grant, matches Bash only.

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

# The judge hand-off (XERK-1566). hub-agent.py mirrors every name here
# (parity-tested in TestPermissionJudge).
JUDGE_FLAG = "--judge"
JUDGE_ALIVE_FILE = "judge.alive"
JUDGE_ALIVE_MAX_AGE_SEC = 30
JUDGE_WAIT_SEC = 75           # under the hook's 90s settings timeout
JUDGE_POLL_SEC = 0.25
JUDGE_COMMAND_MAX = 8000      # a longer command is not handed to the judge
JUDGE_REQ_SUFFIX = ".judge.req.json"
JUDGE_ANS_SUFFIX = ".judge.ans.json"
JUDGE_ANS_MAX_BYTES = 4096
JUDGE_VERDICTS = ("allow", "stand")
_SEGMENT_SPLIT_RE = re.compile(r"&&|\|\||;|\||\n")


def _cap(value, limit):
    return value if len(value) <= limit else value[:limit]


def _segment_words(segment):
    try:
        words = shlex.split(segment)
    except ValueError:
        words = segment.split()
    words = [w for w in words if w]
    while words and _ENV_ASSIGN_RE.match(words[0]):
        words.pop(0)
    return words


def bash_head(command):
    """The first command's first word — two for a CLI whose subcommand is the
    decision (``git push``, ``npm test``). Leading ``VAR=value`` assignments are
    skipped (they are not the command), and so are leading ``cd <dir>`` segments:
    ``cd /repo && npm test`` is about ``npm test``, and heading every such call
    ``cd`` would merge them all into one group that names no command. ``cd`` stays
    the head only when nothing follows it. ``""`` when nothing parses."""
    if not isinstance(command, str):
        return ""
    words = []
    for segment in _SEGMENT_SPLIT_RE.split(command.strip()):
        seg_words = _segment_words(segment.strip())
        if not seg_words:
            continue
        words = seg_words
        if words[0] != "cd":
            break
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


def judge_alive(directory, now=None):
    """Whether the manager's judge is up and has a policy: its marker file is a
    regular file touched within JUDGE_ALIVE_MAX_AGE_SEC. lstat only — no open,
    so a planted FIFO cannot hang this either."""
    try:
        st = os.lstat(os.path.join(directory, JUDGE_ALIVE_FILE))
    except OSError:
        return False
    now = time.time() if now is None else now
    return stat.S_ISREG(st.st_mode) and abs(now - st.st_mtime) <= JUDGE_ALIVE_MAX_AGE_SEC


def judge_request(event, row):
    """The request handed to the judge for this event, or None when it is not
    the judge's: Bash only, a non-empty command no longer than
    JUDGE_COMMAND_MAX. The WHOLE command rides (the judge decides on it, and the
    grant is keyed on its exact text), the rest are the ledger row's fields."""
    if not isinstance(row, dict) or row.get("tool") != "Bash":
        return None
    inp = event.get("tool_input") if isinstance(event, dict) else None
    command = inp.get("command") if isinstance(inp, dict) else None
    if not isinstance(command, str) or not command.strip() or len(command) > JUDGE_COMMAND_MAX:
        return None
    cwd = event.get("cwd")
    return {
        "v": 1, "event": row["event"], "toolUseId": row.get("toolUseId"),
        "tool": "Bash", "command": command, "head": row.get("head") or "",
        "digest": row.get("digest") or "", "denyReason": row.get("denyReason") or "",
        "cwd": _cap(cwd, 1024) if isinstance(cwd, str) else "", "ts": row["ts"],
    }


def _write_new(path, data):
    """Write `data` as JSON to a fresh per-process tmp, then rename it into
    place, so the manager never reads half a request. True when it landed."""
    tmp = f"{path}.{os.getpid()}.tmp"
    flags = (os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
             | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0))
    try:
        fd = os.open(tmp, flags, 0o600)
    except OSError:
        return False
    try:
        os.write(fd, json.dumps(data, ensure_ascii=False).encode("utf-8"))
    except OSError:
        os.close(fd)
        _remove(tmp)
        return False
    os.close(fd)
    try:
        os.replace(tmp, path)
        return True
    except OSError:
        _remove(tmp)
        return False


def _remove(path):
    try:
        os.remove(path)
    except OSError:
        pass


def _read_answer(path):
    """The answer object at `path`, or None — not there yet, not a regular
    file, too big, or not a JSON object."""
    flags = (os.O_RDONLY | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_NOFOLLOW", 0)
             | getattr(os, "O_BINARY", 0))
    try:
        fd = os.open(path, flags)
    except OSError:
        return None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            return None
        blob = os.read(fd, JUDGE_ANS_MAX_BYTES + 1)
    except OSError:
        return None
    finally:
        os.close(fd)
    if len(blob) > JUDGE_ANS_MAX_BYTES:
        return None
    try:
        data = json.loads(blob.decode("utf-8"))
    except (ValueError, RecursionError):
        return None
    return data if isinstance(data, dict) else None


def new_nonce():
    return os.urandom(8).hex()


def await_verdict(directory, session_id, req, wait_sec=JUDGE_WAIT_SEC,
                  poll_sec=JUDGE_POLL_SEC, clock=time.monotonic, sleep=time.sleep,
                  nonce=None):
    """Hand `req` to the manager's judge and wait for its verdict: "allow",
    "stand", or None (no answer in time, or a malformed one). The request is
    removed on the way out whatever happened, and the answer once read.
    `nonce` names the hand-off (the ledger row carries it too)."""
    nonce = nonce or new_nonce()
    base = os.path.join(directory, f"{session_id}.{nonce}")
    req_path, ans_path = base + JUDGE_REQ_SUFFIX, base + JUDGE_ANS_SUFFIX
    if not _write_new(req_path, dict(req, nonce=nonce)):
        return None
    deadline = clock() + wait_sec
    try:
        while True:
            ans = _read_answer(ans_path)
            if ans is not None:
                _remove(ans_path)
                verdict = ans.get("verdict")
                if ans.get("nonce") == nonce and verdict in JUDGE_VERDICTS:
                    return verdict
                return None
            if clock() >= deadline:
                return None
            sleep(poll_sec)
    finally:
        _remove(req_path)


def decision_output(event_name, verdict):
    """What this hook prints for a verdict, or None to print nothing (Claude
    Code's own flow then runs exactly as without the judge)."""
    if verdict != "allow":
        return None
    if event_name == "PermissionDenied":
        return {"hookSpecificOutput": {"hookEventName": "PermissionDenied", "retry": True}}
    if event_name == "PermissionRequest":
        return {"hookSpecificOutput": {"hookEventName": "PermissionRequest",
                                       "decision": {"behavior": "allow"}}}
    return None


def main(argv=None):
    argv = sys.argv if argv is None else argv
    session_id = (os.environ.get("TURMA_SESSION_ID") or "").strip()
    if not SID_RE.match(session_id):
        return 0
    directory = argv[1] if len(argv) > 1 and argv[1] else os.path.join(
        os.path.expanduser("~"), ".turma", "permissions")
    judge = len(argv) > 2 and argv[2] == JUDGE_FLAG
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
    if row is None:
        return 0
    req = None
    if judge:
        try:
            req = judge_request(event, row)
            if req is not None and not judge_alive(directory):
                req = None
        except Exception:        # noqa: BLE001 — the judge is best-effort too
            req = None
    if req is not None:
        # The ledger row names the hand-off BEFORE it is made: should the judge
        # allow it, the manager then knows this prompt never reached a human.
        row["judgeNonce"] = new_nonce()
    append_row(directory, session_id, row)
    if req is None:
        return 0
    try:
        out = decision_output(row["event"], await_verdict(
            directory, session_id, req, nonce=row["judgeNonce"]))
    except Exception:            # noqa: BLE001 — the judge is best-effort too
        return 0
    if out is not None:
        sys.stdout.write(json.dumps(out))
        sys.stdout.flush()
    return 0


if __name__ == "__main__":  # pragma: no cover - shell entry
    sys.exit(main())

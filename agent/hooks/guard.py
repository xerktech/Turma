#!/usr/bin/env python3
"""AgentHub agent safety guard — a Claude Code ``PreToolUse`` hook.

Every session runs the agent with ``--permission-mode bypassPermissions`` so it
can do whatever a task needs (read, write, run builds/tests, git, network) with
**no** per-tool approval round-trip. This hook is the single thing that makes
that safe: it inspects every Bash tool call *before* it runs and blocks only
three narrow categories.

1. **destructive** — commands that would wreck the whole repository or the host
   machine: ``rm -rf`` of ``/``/home/system paths or ``.git``, disk wipes
   (``mkfs``/``dd of=/dev/...``/``format``), fork bombs, host power-state
   changes, recursive ``chmod``/``chown`` of system roots, git history
   destruction (``branch -D main``, ``filter-branch``, reflog-expire,
   ``reset --hard`` onto a protected branch), and database drops
   (``DROP DATABASE``/``TABLE``). Denied with a reason the model self-corrects
   from. A specific destructive command an operator wants to permit can be
   allowlisted via ``$AGENTHUB_TOOL_GRANTS`` (a CSV of ``Bash(<command>)``
   patterns) — the exact command only, never a blanket grant.

2. **policy** — PR-workflow rules, enforced hard (no override): pushing to or
   deleting ``main``/``master`` directly, and merging any pull request
   (``gh pr merge``). Work lands via a PR the agent opens but never self-merges.
   Denied with a reason the agent self-corrects from.

3. **attribution** — ``git commit`` / PR commands carrying AI self-attribution
   (``Co-Authored-By: ... Claude``/``Anthropic``, ``Generated with Claude``,
   the robot emoji, ``noreply@anthropic.com``). Denied with a reason so the
   agent rewrites the message and continues. Disable with
   ``$AGENTHUB_NO_ATTRIBUTION=0``.

Everything else is allowed (the hook exits 0 silently, deferring to the normal
— here, bypass — flow).

Contract (Claude Code ``PreToolUse`` hook):
  stdin  — JSON with ``tool_name``, ``tool_input`` (``.command`` for Bash),
           ``session_id``, ``cwd``, ``permission_mode``.
  deny   — print ``{"hookSpecificOutput": {"hookEventName": "PreToolUse",
           "permissionDecision": "deny", "permissionDecisionReason": ...}}``
           and exit 0. The reason is fed back to the model.
  allow  — exit 0 with no output.

Stdlib only: this file is invoked by absolute path with the session's worktree
as cwd, so it cannot rely on any package being importable.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import sys

# --- command segmentation ------------------------------------------------

# Shell operators that chain separate commands. We inspect each segment so a
# destructive command hidden after `&&`/`;`/`|`/newline is still caught.
_SEGMENT_SPLIT = re.compile(r"&&|\|\||[;\n|]")

# A leading `FOO=bar` environment assignment on a command.
_ENV_ASSIGN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=\S*$")

# Privilege-escalation prefixes we strip before classifying the real command
# (a destructive command is destructive with or without `sudo`).
_PREFIX_WORDS = {"sudo", "doas", "runas", "command", "nohup", "time", "exec", "env"}


def _split_segments(command: str) -> list[str]:
    return [seg.strip() for seg in _SEGMENT_SPLIT.split(command) if seg.strip()]


def _tokenize(segment: str) -> list[str]:
    """Best-effort shell tokenisation; falls back to whitespace split."""
    try:
        return shlex.split(segment, posix=True)
    except ValueError:
        return segment.split()


def _strip_prefixes(tokens: list[str]) -> list[str]:
    """Drop leading env-assignments and wrapper words (sudo/env/...)."""
    out = list(tokens)
    while out:
        head = out[0]
        if _ENV_ASSIGN.match(head) or head in _PREFIX_WORDS:
            out.pop(0)
            continue
        break
    return out


def _basename(prog: str) -> str:
    return re.split(r"[\\/]", prog)[-1].lower()


# --- dangerous-path detection (for rm / chmod / chown) -------------------

# Absolute roots whose recursive removal/permission-change destroys the host.
_SYSTEM_ROOTS = (
    "/",
    "/bin",
    "/boot",
    "/dev",
    "/etc",
    "/home",
    "/lib",
    "/lib64",
    "/opt",
    "/proc",
    "/root",
    "/sbin",
    "/srv",
    "/sys",
    "/usr",
    "/var",
    "/system",
    "/library",
    "/applications",
    "/users",
)
_HOME_TOKENS = {"~", "~/", "$home", "${home}", "%userprofile%", "%homepath%", "%homedrive%"}


def _norm_path(tok: str) -> str:
    t = tok.strip().strip('"').strip("'")
    # Windows drive root (C:\ , C:/ , c:) and Windows system dirs.
    return t


def _is_dangerous_path(tok: str) -> bool:
    raw = _norm_path(tok)
    low = raw.lower().rstrip("/").rstrip("\\")
    bare = raw.lower()
    if bare in _HOME_TOKENS or low in _HOME_TOKENS:
        return True
    if raw in ("/", "/*") or low == "":
        # "" results from rstrip of "/" — i.e. the filesystem root.
        return True
    # `.git` (with or without trailing slash / leading ./) → repo history.
    if low.endswith("/.git") or low in (".git", "./.git") or low.endswith("\\.git"):
        return True
    # Windows drive roots: C:, C:\, C:\windows, C:\users, ...
    if re.match(r"^[a-z]:([\\/].*)?$", low):
        seg = low.split(":", 1)[1].strip("\\/")
        if seg in ("", "windows", "users", "program files", "program files (x86)", "system32"):
            return True
    # POSIX system roots: exact match or a direct child of the root.
    for root in _SYSTEM_ROOTS:
        if low == root or low.startswith(root.rstrip("/") + "/"):
            # Allow obviously-scoped temp/build paths under a root only when
            # they are deep, well-known throwaway dirs.
            if root == "/" and low not in ("/", "/*"):
                # e.g. "/tmp/build" — a child of root but not a system dir.
                # Fall through to the specific-root checks below.
                continue
            return True
    return False


def _rm_is_recursive_force(flags: str) -> bool:
    has_r = "r" in flags
    has_f = "f" in flags
    return has_r and has_f


def _destructive_rm(tokens: list[str]) -> str | None:
    prog = _basename(tokens[0])
    if prog not in ("rm", "unlink"):
        # Windows recursive deletes handled separately.
        return None
    flags = ""
    targets: list[str] = []
    for tok in tokens[1:]:
        if tok.startswith("--"):
            if tok in ("--recursive", "--force"):
                flags += tok[2]  # 'r' or 'f'
            continue
        if tok.startswith("-") and len(tok) > 1:
            flags += tok[1:].lower()
            continue
        targets.append(tok)
    if prog == "rm" and not _rm_is_recursive_force(flags):
        return None
    for tgt in targets:
        if _is_dangerous_path(tgt):
            return f"refusing recursive delete of a protected path ({tgt!r})"
    return None


def _destructive_powershell_remove(segment: str) -> str | None:
    low = segment.lower()
    if "remove-item" not in low and not re.search(r"\b(rd|rmdir)\b", low):
        return None
    if (
        "-recurse" not in low
        and not re.search(r"\bremove-item\b.*\*", low)
        and not re.search(r"\b(rd|rmdir)\b\s+/s", low)
    ):
        return None
    for tok in _tokenize(segment):
        if _is_dangerous_path(tok):
            return f"refusing recursive delete of a protected path ({tok!r})"
    # Bare drive/home targets without quotes.
    if re.search(r"(c:\\?|%userprofile%|\$home|~)\s*($|['\"])", low):
        return "refusing recursive delete of a protected path"
    return None


# --- disk / power / fork-bomb -------------------------------------------

_DISK_PROGS = {
    "mkfs",
    "mke2fs",
    "fdisk",
    "parted",
    "wipefs",
    "blkdiscard",
    "shred",
    "diskpart",
    "format",
}
_POWER_PROGS = {"shutdown", "reboot", "halt", "poweroff"}
_PS_POWER = {"stop-computer", "restart-computer", "clear-disk", "format-volume"}


def _destructive_disk_power(tokens: list[str], segment: str) -> str | None:
    prog = _basename(tokens[0])
    if prog in _DISK_PROGS:
        # `format` is also a benign git/printf word in some contexts, but as
        # argv[0] it is the Windows disk formatter / mkfs family.
        return f"refusing disk-format/partition command ({prog})"
    if prog in _POWER_PROGS:
        return f"refusing host power-state change ({prog})"
    if prog == "init" and len(tokens) > 1 and tokens[1] in ("0", "6"):
        return "refusing host power-state change (init runlevel)"
    if prog.startswith("mkfs."):
        return f"refusing disk-format command ({prog})"
    low = segment.lower()
    if _basename(tokens[0]) in _PS_POWER or any(p in low for p in _PS_POWER):
        return "refusing host power/disk command"
    if prog == "dd" and any(t.lower().startswith("of=/dev/") for t in tokens):
        return "refusing raw write to a block device (dd of=/dev/...)"
    if re.search(r">\s*/dev/(sd|nvme|hd|disk|mmcblk)", low):
        return "refusing redirect onto a block device"
    if re.search(r"\bkill\s+-9\s+-1\b", low) or re.search(r"\bkill\s+-1\b\s+1\b", low):
        return "refusing system-wide kill"
    return None


def _destructive_forkbomb(segment: str) -> str | None:
    compact = re.sub(r"\s+", "", segment)
    if ":(){:|:&};:" in compact:
        return "refusing fork bomb"
    return None


# --- git whole-repo destruction -----------------------------------------

_PROTECTED_BRANCHES = ("main", "master")


def _destructive_git(tokens: list[str], segment: str) -> str | None:
    if _basename(tokens[0]) != "git":
        return None
    args = list(tokens[1:])
    if not args:
        return None
    sub = args[0]

    # NB: pushing to a protected branch is handled by `policy_reason` (a hard
    # PR-workflow rule, not an override-able catastrophe). Here we keep only
    # the genuine history-destruction ops a human might legitimately approve.
    if sub == "branch" and ("-D" in args or "--delete" in args or "-d" in args):
        if any(b in args for b in _PROTECTED_BRANCHES):
            return "refusing deletion of a protected branch (main/master)"
        return None
    if sub == "reset" and "--hard" in args:
        # `git reset --hard HEAD~1` etc. is ordinary local work and stays
        # allowed; resetting a protected branch to another ref is the
        # history-losing case the operator wants to gate.
        refs = {a.split("/")[-1] for a in args if not a.startswith("-")}
        if refs & set(_PROTECTED_BRANCHES):
            return "refusing `git reset --hard` onto a protected branch (main/master)"
        return None
    if sub in ("filter-branch", "filter-repo"):
        return "refusing git history rewrite (filter-branch/filter-repo)"
    if sub == "reflog" and "expire" in args and any("--expire=now" in a for a in args):
        return "refusing reflog expiry (destroys recovery history)"
    if sub == "update-ref" and "-d" in args and any(b in segment for b in _PROTECTED_BRANCHES):
        return "refusing deletion of a protected ref"
    return None


def _destructive_chmod_chown(tokens: list[str]) -> str | None:
    prog = _basename(tokens[0])
    if prog not in ("chmod", "chown", "chgrp"):
        return None
    recursive = any(t in ("-R", "--recursive") or (t.startswith("-") and "R" in t) for t in tokens)
    if not recursive:
        return None
    for tok in tokens[1:]:
        if tok.startswith("-"):
            continue
        if _is_dangerous_path(tok):
            return f"refusing recursive {prog} on a protected path ({tok!r})"
    return None


# --- attribution ---------------------------------------------------------

# High-specificity self-attribution signals. Deliberately narrow so a legit
# commit message that merely mentions "anthropic" (e.g. "bump anthropic SDK")
# is NOT blocked — only genuine co-author / generated-by trailers are.
_ATTRIB_PATTERNS = (
    re.compile(r"co-?authored-by:\s*.*(claude|anthropic)", re.IGNORECASE),
    re.compile(r"generated with\s*\[?\s*claude", re.IGNORECASE),
    re.compile(r"noreply@anthropic\.com", re.IGNORECASE),
    re.compile(r"\U0001f916"),  # 🤖
    re.compile(r"claude-session:", re.IGNORECASE),
)
# Only scan commands that author a commit / tag / PR / release message.
_ATTRIB_CONTEXT = re.compile(
    r"\bgit\s+(commit|tag|merge|revert)\b|\bgh\s+(pr|release)\b|--message\b|\bcommit\b.*-m\b",
    re.IGNORECASE,
)


# --- PR workflow policy --------------------------------------------------


def _is_protected_ref(tok: str) -> bool:
    """True if a push refspec token targets main/master (`main`, `HEAD:main`,
    `:main` delete, `origin/main`). The remote name (`origin`) is not a ref."""
    return any(part and part.split("/")[-1] in _PROTECTED_BRANCHES for part in tok.split(":"))


def policy_reason(command: str) -> str | None:
    """Return a reason if ``command`` violates the PR workflow policy.

    Hard rules (no override): work lands via a pull request, so the agent may
    not push to / delete `main`/`master` directly, and it may not merge any
    pull request — that is a human reviewer's call.
    """
    for segment in _split_segments(command):
        tokens = _strip_prefixes(_tokenize(segment))
        if not tokens:
            continue
        prog = _basename(tokens[0])
        rest = tokens[1:]
        if prog in ("gh", "hub") and "pr" in rest and "merge" in rest:
            return (
                "you must not merge pull requests — open the PR and leave "
                "merging to a human reviewer"
            )
        if (
            prog == "git"
            and rest
            and rest[0] == "push"
            and any(_is_protected_ref(t) for t in rest[1:] if not t.startswith("-"))
        ):
            return (
                "do not push to main/master directly — push a feature "
                "branch and open a pull request for review"
            )
    return None


def attribution_reason(command: str) -> str | None:
    if not _ATTRIB_CONTEXT.search(command):
        return None
    for pat in _ATTRIB_PATTERNS:
        if pat.search(command):
            return (
                "remove AI/self-attribution from the commit/PR message — no "
                "'Co-Authored-By: Claude/Anthropic', 'Generated with Claude', "
                "robot emoji, or anthropic.com trailers (project policy)"
            )
    return None


# --- top-level classification -------------------------------------------


# Whole-database / schema destruction, typically issued through a db CLI
# (`psql -c "DROP DATABASE x"`, `dropdb x`, mongo `db.dropDatabase()`).
_DB_DESTRUCTION = re.compile(
    r"\bdrop\s+database\b|\bdrop\s+table\b|\bdropdb\b|\bdropdatabase\s*\(",
    re.IGNORECASE,
)


def _destructive_database(command: str) -> str | None:
    if _DB_DESTRUCTION.search(command):
        return "refusing database/schema destruction (DROP DATABASE/TABLE)"
    return None


def is_destructive(command: str) -> str | None:
    """Return a human reason if ``command`` is catastrophic, else ``None``."""
    # Fork bombs contain the `;`/`|` we segment on, so match the whole string.
    reason = _destructive_forkbomb(command)
    if reason:
        return reason
    reason = _destructive_database(command)
    if reason:
        return reason
    for segment in _split_segments(command):
        tokens = _strip_prefixes(_tokenize(segment))
        if not tokens:
            continue
        for reason in (
            _destructive_rm(tokens),
            _destructive_chmod_chown(tokens),
            _destructive_git(tokens, segment),
            _destructive_disk_power(tokens, segment),
            _destructive_powershell_remove(segment),
        ):
            if reason:
                return reason
    return None


def _parse_overrides(raw: str | None) -> list[str]:
    """Extract approved command patterns from a ``Bash(<cmd>),...`` CSV grant.

    Only ``Bash(...)`` entries are command overrides; bare tool names (e.g.
    ``Edit``) are irrelevant to this hook and ignored.
    """
    if not raw:
        return []
    out: list[str] = []
    for m in re.finditer(r"Bash\((.*?)\)\s*(?:,|$)", raw):
        inner = m.group(1).strip()
        if inner:
            out.append(inner)
    return out


def _norm_cmd(command: str) -> str:
    return re.sub(r"\s+", " ", command).strip()


def command_overridden(command: str, overrides: list[str]) -> bool:
    cmd = _norm_cmd(command)
    for ov in overrides:
        pat = _norm_cmd(ov)
        if pat.endswith("*"):
            if cmd.startswith(pat[:-1].strip()):
                return True
        elif cmd == pat:
            return True
    return False


def decide(
    tool_name: str,
    tool_input: dict,
    *,
    overrides: list[str] | None = None,
    no_attribution: bool = True,
) -> tuple[str, str | None, str | None]:
    """Return ``(decision, reason, category)``.

    ``decision`` is ``"allow"`` or ``"deny"``. ``category`` is
    ``"destructive"`` / ``"policy"`` / ``"attribution"`` / ``None``. Only
    ``"destructive"`` honours an operator override grant; the others are hard
    rules the agent self-corrects from.
    """
    overrides = overrides or []
    if tool_name != "Bash":
        return ("allow", None, None)
    command = (tool_input or {}).get("command")
    if not isinstance(command, str) or not command.strip():
        return ("allow", None, None)

    reason = is_destructive(command)
    if reason and not command_overridden(command, overrides):
        return ("deny", reason, "destructive")

    # PR workflow rules are hard (no override): always open a PR, never
    # self-merge.
    pol = policy_reason(command)
    if pol:
        return ("deny", pol, "policy")

    if no_attribution:
        attrib = attribution_reason(command)
        if attrib:
            return ("deny", attrib, "attribution")

    return ("allow", None, None)


# --- hook entrypoint -----------------------------------------------------


def _emit_deny(reason: str) -> None:
    payload = {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }
    sys.stdout.write(json.dumps(payload))
    sys.stdout.flush()


def main(argv: list[str] | None = None) -> int:
    try:
        raw = sys.stdin.read()
        event = json.loads(raw) if raw.strip() else {}
    except (json.JSONDecodeError, OSError):
        # Fail open on a malformed event: a guard that crashes must not wedge
        # the agent. The deny rules in the settings file remain as a backstop.
        return 0
    if not isinstance(event, dict):
        return 0

    tool_name = event.get("tool_name") or ""
    tool_input = event.get("tool_input") or {}
    overrides = _parse_overrides(os.environ.get("AGENTHUB_TOOL_GRANTS"))
    no_attribution = os.environ.get("AGENTHUB_NO_ATTRIBUTION", "1") != "0"

    decision, reason, _category = decide(
        tool_name,
        tool_input if isinstance(tool_input, dict) else {},
        overrides=overrides,
        no_attribution=no_attribution,
    )
    if decision == "deny" and reason:
        _emit_deny(reason)
    return 0


if __name__ == "__main__":  # pragma: no cover - shell entry
    sys.exit(main())

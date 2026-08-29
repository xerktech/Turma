#!/usr/bin/env python3
"""Turma qwen safety guard — a Qwen Code ``PreToolUse`` hook shim (XERK-510 [Qwen F]).

Qwen Code's PreToolUse hook contract is Claude Code's, ported (the G0 spike,
``docs/qwen-g0-spike.md`` crit. 5): a ``command`` hook reads the tool call as JSON
on stdin and denies by printing ::

    {"hookSpecificOutput": {"hookEventName": "PreToolUse",
     "permissionDecision": "deny", "permissionDecisionReason": "..."}}

on stdout, or by exiting **2** (a blocking error whose stderr is fed to the
model). ``permissionDecision`` is one of ``allow|deny|ask`` (``ask`` falls back to
``deny`` in a headless/subagent context).

So the DENY POLICY is the SAME as Claude's and dsh's, and it is NOT re-implemented
here. Destructive / policy / attribution shell classification and the "everything
under ~/.claude except the two agent-memory trees" predicate are the hardest,
most safety-critical logic in the fleet, and they already exist — measured and
tested — in ``agent/hooks/guard.py`` and ``agent/hooks/fileguard.py``. This shim
SHELLS OUT to those exact scripts, invoked the same ``python3 -SsE <hook>`` way
Claude Code and the dsh guard invoke them (the ``-SsE`` flags are the
interpreter-injection defence documented in ``.claude/rules/agent-hooks.md``), so
all three runtimes share ONE deny policy and a change to it lands in one place.

What this shim owns natively is only:

  * ROUTING a Qwen tool name/args onto the Claude tool shape the shared hooks
    expect. ``guard.py`` keys on ``tool_name == "Bash"`` and ``fileguard.py`` on
    ``Write|Edit|MultiEdit|NotebookEdit`` — a Qwen ``run_shell_command`` /
    ``write_file`` would otherwise sail straight past both. This is the same
    normalisation the dsh guard's ``classify`` does, in the same spirit; it is NOT
    the deny policy.
  * The flat credential / config / runtime-code path globs and the
    uploads/roster read carve-outs, matched against a ``realpath``'d target — the
    SAME globs ``build_guard_settings()`` produces, handed over as data by
    ``build_qwen_guard_config()`` so there is one list, not two.

FAILS CLOSED. ``guard.py``/``fileguard.py`` fail OPEN on a malformed payload
because Claude keeps ``permissions.deny`` patterns as a backstop; a qwen session
has no such backstop the shim can rely on (whether qwen honours a ``permissions``
block at all is unverified — see ``.claude/rules/qwen.md``), so this shim treats
ANY inability to enforce — an unreadable config, a hook it cannot spawn / that
crashes / times out / returns unreadable output, a shell call with no configured
guard script, or any unexpected error in the shim itself — as a DENY: it prints
the deny JSON on stdout AND exits 2, so both channels block. A guard that quietly
disengages is the exact "not shippable" state this ticket exists to prevent.

Config (``argv[1]``) is a JSON file ``build_qwen_guard_config()`` writes::

    {"pythonExe", "guardScript", "fileguardScript"|null,
     "denyWrite": [...], "denyRead": [...], "allowRead": [...],
     "hookTimeoutMs": <int>}

Stdlib only: invoked by absolute path with the session's worktree as cwd, so it
cannot rely on any package being importable (and ``-S`` drops site anyway).
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys


class _FailClosed(Exception):
    """Raised anywhere the guard cannot ENFORCE. Caught in ``main`` and turned
    into a deny on both channels (stdout JSON + exit 2), never a silent allow."""


# --- tool routing --------------------------------------------------------
#
# Qwen's fs/shell tool names and argument shapes (Qwen Code / gemini-cli lineage,
# cross-checked against the S1 projector and the G0 corpus):
#   run_shell_command   { command, description? }        -> shell
#   write_file          { file_path, content }           -> file write
#   replace             { file_path, old_string, ... }   -> file write (edit)
#   read_file           { absolute_path|path, ... }      -> file read
#   read_many_files     { paths: [...] }                 -> file read (many)
#
# A shell tool is matched by NAME, not by "has a `command` arg" — the shared
# `run_shell_command` string carries `shell` bounded by `_`, which this pattern
# catches, alongside bash/sh/pwsh/etc. (matches the dsh guard's SHELL_NAME_RE).
_SHELL_NAME_RE = re.compile(
    r"(^|[-_])(bash|sh|zsh|pwsh|powershell|shell|terminal)([-_]|$)", re.I)
_FS_WRITE_TOOLS = frozenset({
    "write_file", "replace", "edit", "write", "multiedit", "notebookedit",
})
_FS_READ_TOOLS = frozenset({
    "read_file", "read_many_files", "read_image", "read",
})
# str_replace_editor-style tools whose verb decides read vs write (belt and
# braces — qwen's native edit tool is `replace`, but a build may expose one).
_EDITOR_TOOLS = frozenset({"str_replace_editor", "str_replace_based_edit_tool"})
_EDITOR_READ_VERBS = frozenset({"view"})

# Where a tool call carries its path target(s). `paths` (a list) covers
# read_many_files; the scalar keys cover the rest (a tool carrying more than one
# is checked on all of them).
_PATH_KEYS = ("file_path", "path", "absolute_path", "notebook_path")


def _target_paths(args):
    """Every path string a tool call names, from the known scalar keys plus the
    ``paths`` list. De-duped, order-preserving; non-strings are dropped."""
    out, seen = [], set()

    def add(v):
        if isinstance(v, str) and v and v not in seen:
            seen.add(v)
            out.append(v)

    for k in _PATH_KEYS:
        add(args.get(k))
    paths = args.get("paths")
    if isinstance(paths, list):
        for v in paths:
            add(v)
    return out


def classify(name, args):
    """Classify a Qwen tool call into the surface the guard reasons about.

    Returns ``("shell", command)`` | ``("write"|"read", [targets])`` |
    ``("other", None)`` (ungated — the same residual as the dsh guard's
    code-exec/search tools; see ``.claude/rules/qwen.md``)."""
    n = str(name or "").lower()
    if not isinstance(args, dict):
        args = {}
    if _SHELL_NAME_RE.search(n) and isinstance(args.get("command"), str):
        return ("shell", args["command"])
    if n in _FS_WRITE_TOOLS:
        return ("write", _target_paths(args))
    if n in _FS_READ_TOOLS:
        return ("read", _target_paths(args))
    if n in _EDITOR_TOOLS:
        verb = str(args.get("command") or "").lower()
        kind = "read" if verb in _EDITOR_READ_VERBS else "write"
        return (kind, _target_paths(args))
    return ("other", None)


# --- glob matching -------------------------------------------------------
#
# The path rules arrive as absolute, ~-expanded globs from
# build_qwen_guard_config (e.g. /root/.ssh/**, /root/.claude/*.json). Semantics
# mirror the gitignore-style matching Claude Code applies to its Read()/Edit()
# rules and the dsh guard's globToRegExp: `*`/`?` do not cross `/`; `**` crosses
# any depth. The deny side is allowed to be no NARROWER than Claude's; looser
# over-denies, the safe direction for a guard.
def _glob_to_regexp(glob):
    out = []
    i, n = 0, len(glob)
    while i < n:
        c = glob[i]
        if c == "*":
            if i + 1 < n and glob[i + 1] == "*":
                out.append(".*")           # ** — any depth including `/`
                i += 2
                continue
            out.append("[^/]*")            # *  — within one path segment
        elif c == "?":
            out.append("[^/]")
        elif c in "\\^$.|+()[]{}":
            out.append("\\" + c)
        else:
            out.append(c)
        i += 1
    # The glob is a TRUSTED path rule from build_qwen_guard_config (the operator's
    # and repo's own deny list), and every emitted token is linear (`.*`,
    # `[^/]*`, `[^/]`, escaped literals) with no nested quantifier — no
    # catastrophic-backtracking surface, and never built from a tool argument.
    return re.compile("^" + "".join(out) + "$")


def _matches_any(target, regexps):
    return any(r.match(target) for r in regexps)


def _resolve_target(p, cwd):
    """Absolute, symlink-canonical target, exactly as ``fileguard.py`` resolves
    one: ``realpath`` closes `..` and symlink escapes in both directions, and a
    not-yet-created write target resolves its longest existing prefix (Python's
    ``realpath`` does this without raising). A relative path resolves against the
    payload's ``cwd`` (the worktree), not this process's."""
    if not isinstance(p, str) or not p:
        return None
    if not os.path.isabs(p):
        p = os.path.join(cwd or os.getcwd(), p)
    return os.path.realpath(p)


# --- the shared py deny policy (guard.py / fileguard.py) ------------------


def _run_hook(cfg, script, tool_name, tool_input, cwd, session_id):
    """Invoke a shared Claude PreToolUse hook exactly as Claude Code does and
    return its denial reason, or None to allow. FAILS CLOSED: a hook that cannot
    be spawned, crashes (nonzero exit), times out, or returns unreadable output
    raises ``_FailClosed`` rather than reading as allow."""
    if not script:
        return None
    payload = json.dumps({
        "tool_name": tool_name,
        "tool_input": tool_input,
        "cwd": cwd or os.getcwd(),
        "session_id": session_id or "",
        # The shared hooks ignore this, but pass the strongest value so their
        # full policy applies (matches the dsh guard).
        "permission_mode": "bypassPermissions",
    })
    timeout = (cfg.get("hookTimeoutMs") or 5000) / 1000.0
    try:
        proc = subprocess.run(
            [cfg.get("pythonExe") or "python3", "-SsE", script],
            input=payload, capture_output=True, text=True, timeout=timeout,
        )
    except (OSError, subprocess.SubprocessError) as e:
        raise _FailClosed(
            f"Turma qwen safety guard could not run {script}: {e}. "
            f"Denying by default.")
    # guard.py / fileguard.py exit 0 for both allow and deny (deny emits JSON).
    # A nonzero exit means the hook crashed — we cannot trust "allow", so deny.
    if proc.returncode != 0:
        raise _FailClosed(
            f"Turma qwen safety guard: {script} exited {proc.returncode}. "
            f"Denying by default.")
    out = (proc.stdout or "").strip()
    if not out:
        return None
    try:
        hs = (json.loads(out) or {}).get("hookSpecificOutput") or {}
    except (ValueError, AttributeError):
        raise _FailClosed(
            f"Turma qwen safety guard: unreadable decision from {script}. "
            f"Denying by default.")
    if hs.get("permissionDecision") == "deny":
        return str(hs.get("permissionDecisionReason")
                   or "denied by Turma safety guard")
    return None


def _deny_write_reason(target):
    return (
        f"Writing {target} is blocked by the Turma safety guard: it is a host "
        f"credential store, agent config, or the guard's own runtime code, "
        f"shared across every session on this host. Do the work inside your "
        f"worktree.")


def _deny_read_reason(target):
    return (
        f"Reading {target} is blocked by the Turma safety guard: it holds a "
        f"host-shared credential. It is not needed for your task.")


def decide(event, cfg):
    """The single decision. Returns a denial reason string, or None to allow.
    Raises ``_FailClosed`` where enforcement is impossible."""
    name = event.get("tool_name") or event.get("toolName") or ""
    args = event.get("tool_input") or event.get("toolInput") or {}
    if not isinstance(args, dict):
        args = {}
    cwd = event.get("cwd")
    session_id = event.get("session_id") or event.get("sessionId")
    kind, payload = classify(name, args)

    if kind == "shell":
        # destructive / policy / attribution — guard.py. Shell commands walk past
        # the path globs exactly as under Claude (agent-hooks.md / XERK-309), so
        # the guard script is the ONLY protection here: a missing one is a hole,
        # not a degrade — fail closed.
        if not cfg.get("guardScript"):
            raise _FailClosed(
                "Turma qwen safety guard: no shell guard script configured. "
                "Denying by default.")
        return _run_hook(cfg, cfg["guardScript"], "Bash",
                         {"command": payload}, cwd, session_id)

    if kind == "write":
        for tgt in payload:
            real = _resolve_target(tgt, cwd)
            if real is None:
                continue
            # ~/.claude "everything except the memory trees" — fileguard.py owns
            # this predicate (a glob list cannot express it). Missing fileguard
            # degrades to the write-deny globs below (defence in depth), matching
            # the dsh guard; it is NOT the shell case, where the script is the
            # sole protection.
            reason = _run_hook(cfg, cfg.get("fileguardScript"), "Write",
                               {"file_path": real}, cwd, session_id)
            if reason:
                return reason
            if _matches_any(real, cfg["_denyWriteRe"]):
                return _deny_write_reason(real)
        return None

    if kind == "read":
        for tgt in payload:
            real = _resolve_target(tgt, cwd)
            if real is None:
                continue
            # Read carve-outs win over every read deny: the per-session uploads
            # tree and the peer roster are files the session is MEANT to read
            # (XERK-234/348).
            if _matches_any(real, cfg["_allowReadRe"]):
                continue
            if _matches_any(real, cfg["_denyReadRe"]):
                return _deny_read_reason(real)
        return None

    return None                              # kind == "other": ungated by design


def _compile(cfg):
    def compile_all(arr):
        return [_glob_to_regexp(g) for g in arr if isinstance(g, str)] \
            if isinstance(arr, list) else []
    cfg["_denyWriteRe"] = compile_all(cfg.get("denyWrite"))
    cfg["_denyReadRe"] = compile_all(cfg.get("denyRead"))
    cfg["_allowReadRe"] = compile_all(cfg.get("allowRead"))
    return cfg


def _load_config(path):
    if not path:
        raise _FailClosed(
            "Turma qwen safety guard: no config path given. Denying by default.")
    try:
        with open(path, "r", encoding="utf-8") as fh:
            cfg = json.load(fh)
    except (OSError, ValueError) as e:
        raise _FailClosed(
            f"Turma qwen safety guard: cannot read config {path}: {e}. "
            f"Denying by default.")
    if not isinstance(cfg, dict):
        raise _FailClosed(
            f"Turma qwen safety guard: config {path} is not an object. "
            f"Denying by default.")
    return _compile(cfg)


def _emit_deny(reason):
    sys.stdout.write(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": reason,
    }}))
    sys.stdout.flush()


def main(argv=None):
    argv = list(sys.argv if argv is None else argv)
    try:
        cfg = _load_config(argv[1] if len(argv) > 1 else None)
        raw = sys.stdin.read()
        event = json.loads(raw) if raw.strip() else {}
        if not isinstance(event, dict):
            # A payload of unknown shape: we cannot identify the tool, so we
            # cannot prove it safe. Fail closed.
            raise _FailClosed(
                "Turma qwen safety guard: unreadable tool payload. "
                "Denying by default.")
        reason = decide(event, cfg)
    except _FailClosed as e:
        _emit_deny(str(e))
        sys.stderr.write(str(e) + "\n")
        return 2
    except Exception as e:                    # never let the shim fail OPEN
        msg = f"Turma qwen safety guard error: {e}. Denying by default."
        _emit_deny(msg)
        sys.stderr.write(msg + "\n")
        return 2
    if reason:
        _emit_deny(reason)
    return 0


if __name__ == "__main__":                   # pragma: no cover - shell entry
    sys.exit(main())

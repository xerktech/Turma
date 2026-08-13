#!/usr/bin/env python3
"""Turma agent file guard — a Claude Code ``PreToolUse`` hook over the
file-editing tools.

``~/.claude`` is shared, host-wide, bind-mounted into every agent container, and
holds the fleet's Claude login, the agent definitions, the hook scripts, and the
shell snapshot that every Bash call of every live session sources. A session must
not write any of it — with exactly two exceptions, which are the whole reason
this hook exists:

    ~/.claude/agent-memory/<agent>/**        a subagent's `memory:` store
    ~/.claude/projects/<slug>/memory/**      a session's own auto-memory

Those two make Claude Code's memory feature work, and without them every session
on the fleet rediscovers the same repo facts on every run.

**Why a hook and not `permissions.deny` patterns.** The rule wanted here is
"everything under X except Y". Deny beats allow, so the exception cannot be an
allow rule — it has to be a hole in the deny, and a glob list cannot cut that
hole safely. Three attempts proved it, each failing a different way: a hole too
big (`Edit(~/.claude/*)` matches the `agent-memory` DIRECTORY, and a deny on a
directory takes its whole subtree — identical to blanking the lot), a hole too
small (enumerating the dangerous paths missed `shell-snapshots/`, which is
arbitrary code in every live session's shell), and a list that cannot track a
vendor directory set that grows with each Claude Code release. A predicate has
none of those failure modes: it needs no enumeration, does not depend on what
existed when the manager last started, and survives a new directory appearing.

The `permissions.deny` rules still name the catastrophic subset (see
`_GUARD_DENY_PATH_RULES` and `_CLAUDE_DENY_*` in ``hub-agent.py``). That is
deliberate defence in depth: if this hook is ever misconfigured or crashes, the
login, the agent definitions, the hook scripts and the shell snapshots are still
protected by patterns. This hook is what makes the coverage complete, not what
makes it exist.

Contract (Claude Code ``PreToolUse`` hook), identical to ``guard.py``:
  stdin  — JSON with ``tool_name``, ``tool_input``, ``session_id``, ``cwd``,
           ``permission_mode``.
  deny   — print ``{"hookSpecificOutput": {"hookEventName": "PreToolUse",
           "permissionDecision": "deny", "permissionDecisionReason": ...}}``
           and exit 0. The reason is fed back to the model.
  allow  — exit 0 with no output.

Stdlib only: invoked by absolute path with the session's worktree as cwd, so it
cannot rely on any package being importable.
"""

from __future__ import annotations

import json
import os
import sys

# Every tool that writes a file. NotebookEdit is included because Claude Code
# treats it as a file-editing tool for permissions, and a notebook path under
# ~/.claude would otherwise be a way past this.
FILE_TOOLS = ("Write", "Edit", "MultiEdit", "NotebookEdit")

# Where a tool call carries its target. Checked in order; a tool carrying more
# than one is checked on all of them.
PATH_KEYS = ("file_path", "notebook_path", "path")

REASON = (
    "Refused: {path} is inside the shared Claude configuration directory "
    "(~/.claude), which every session on this host and every agent container "
    "share. It holds the fleet's Claude login, the agent definitions, the hook "
    "scripts and the shell snapshot each session sources on every command, so a "
    "write here reaches sessions other than yours.\n\n"
    "The only writable paths under it are the agent memory stores:\n"
    "  ~/.claude/agent-memory/<agent>/...      (a subagent's own memory)\n"
    "  ~/.claude/projects/<slug>/memory/...    (this session's auto-memory)\n\n"
    "If you are recording durable knowledge, use one of those. If you need to "
    "change agent behaviour, settings or hooks, that is an operator change to "
    "the Turma repo, not a file edit from inside a session."
)


def _claude_dir():
    """The real path of ~/.claude, or None if HOME is unusable.

    `realpath` so a symlinked ~/.claude (or a symlinked HOME, which the limits
    probe already trips over) still compares equal to a resolved target.
    """
    home = os.path.expanduser("~")
    if not home or home == "~":
        return None
    return os.path.realpath(os.path.join(home, ".claude"))


def _resolve(path, cwd):
    """Absolute, symlink-free target path.

    `realpath` is what closes `..` and symlink escapes in BOTH directions: a
    symlink planted inside the memory tree pointing at `agents/` resolves out of
    the carve-out and is refused, and a symlink outside ~/.claude pointing into
    it resolves in and is also refused. A relative path is resolved against the
    hook payload's `cwd` (the session's worktree), not this process's.
    """
    if not isinstance(path, str) or not path:
        return None
    if not os.path.isabs(path):
        path = os.path.join(cwd or os.getcwd(), path)
    return os.path.realpath(path)


def _is_memory_path(rel_parts):
    """Is this path one of the two writable memory trees?

    `rel_parts` is the target's path relative to ~/.claude, split on os.sep.
    Both rules require something INSIDE the tree: the bare `agent-memory` or
    `memory` directory entry itself is not writable, which is what stops a
    session planting a FILE called `memory` in another project's slug and
    permanently preventing that project's auto-memory from ever being created.
    """
    # agent-memory/<agent>/<something> — three parts minimum. `agent-memory/qa`
    # is the AGENT'S directory, and a file planted at that name blocks that
    # agent's memory exactly as a file named `memory` blocks a project's.
    if len(rel_parts) >= 3 and rel_parts[0] == "agent-memory":
        return True
    # projects/<slug>/memory/<something>
    if len(rel_parts) >= 4 and rel_parts[0] == "projects" and rel_parts[2] == "memory":
        return True
    return False


def decide(payload):
    """Return a refusal string, or None to allow.

    Pure and stdin-free so the tests can drive it directly.
    """
    tool = payload.get("tool_name")
    if tool not in FILE_TOOLS:
        return None
    tool_input = payload.get("tool_input")
    if not isinstance(tool_input, dict):
        return None
    base = _claude_dir()
    if base is None:
        return None                       # no resolvable HOME: nothing to protect
    cwd = payload.get("cwd")
    for key in PATH_KEYS:
        target = _resolve(tool_input.get(key), cwd)
        if target is None:
            continue
        # `~/.claude.json` is a SIBLING of the directory, not inside it, and
        # carries `mcpServers` — command lines run at the next session's
        # startup — plus the trust flags.
        if target == base + ".json":
            return REASON.format(path=target)
        if target != base and not target.startswith(base + os.sep):
            continue                      # outside ~/.claude entirely: not ours
        rel = os.path.relpath(target, base)
        parts = [] if rel == "." else rel.split(os.sep)
        if _is_memory_path(parts):
            continue
        return REASON.format(path=target)
    return None


def main():
    try:
        payload = json.load(sys.stdin)
    except Exception:
        # Fail open on an unreadable payload, exactly as guard.py does: a hook
        # that blocks every edit because it could not parse its own input takes
        # the whole fleet down. The catastrophic paths are covered by
        # permissions.deny patterns regardless, which is why that is survivable.
        return 0
    if not isinstance(payload, dict):
        return 0
    try:
        reason = decide(payload)
    except Exception:
        return 0
    if reason:
        json.dump({"hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }}, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())

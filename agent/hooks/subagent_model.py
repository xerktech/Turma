#!/usr/bin/env python3
"""Turma sub-agent model pin — a Claude Code ``PreToolUse`` hook (XERK-1851).

QA and review sub-agents always run on Opus, whatever model the session itself
runs on (docs/model-quality-adr.md, decision 3): a grader no stronger than the
author shares its blind spots.

Why a hook and not the agent definition's ``model:`` frontmatter. Claude Code
resolves a sub-agent's model as (measured on 2.1.296):

  the Agent call's own ``model`` parameter
    > the definition's ``model:`` frontmatter
    > CLAUDE_CODE_SUBAGENT_MODEL
    > the session's model

so a pinned definition still loses to a session that passes ``model: "haiku"``
on the call, and the definitions live in each operator's ~/.claude/agents, which
this repo does not ship. Rewriting the call's ``model`` is the one lever that
beats every other source, on every host, from the launch alone.

The model to pin rides the session's env (``TURMA_PIN_SUBAGENT_MODEL``), set by
``_launch_tmux`` only for a session on the Claude subscription: a local-model
session must not be handed a Claude alias its gateway would 403, and a claude
started outside Turma (the summary subprocess, an operator's shell) never sees
it — both pass through untouched.

Read-only search sub-agents (Explore, general-purpose, …) are deliberately NOT
pinned, so they stay on the cheap default.

A Workflow script's ``agent(prompt, {agentType: 'qa'})`` is no Agent tool call
(XERK-1856), so the hook also matches ``Workflow`` and rewrites the SCRIPT:
right after the ``meta`` literal it rebinds the ``agent`` global to one adding
``model`` to a grader's opts — the same per-call lever, which beats the
definition's frontmatter there too (measured, 2.1.296). Call sites are left
untouched, so nothing parses the JS beyond finding where the meta literal ends.

Contract: stdin is the PreToolUse JSON. To pin, print ``updatedInput`` with no
``permissionDecision`` (the call then goes through the normal permission flow);
otherwise exit 0 with no output. Any malformed input passes through — this is a
cost/quality policy, never a safety gate, so it must never block a call.

Stdlib only: invoked by absolute path with ``-SI``.
"""

from __future__ import annotations

import json
import os
import re
import sys

# The sub-agents that grade work: the QA gate, its re-pass, and any reviewer
# (a `code-reviewer`, `CodeReviewer`, …) an operator defines — but not a
# `ui-preview`, which stays on the cheap default.
PINNED_NAMES = frozenset({"qa", "qa-delta"})
REVIEW_WORD_RE = re.compile(r"(?<!p)review")


def is_grader(subagent_type) -> bool:
    if not isinstance(subagent_type, str):
        return False
    name = subagent_type.strip().lower()
    return name in PINNED_NAMES or bool(REVIEW_WORD_RE.search(name))


# Claude Code parses a Workflow script as an ES module whose FIRST statement is
# the meta literal, then runs the rest as `async () => {'use strict'; body}` in a
# vm context where `agent` is a context global (read from 2.1.296). Rebinding that
# global needs no wrapper around the body, so a body that declares its own
# `agent` still parses; and it adds no line, so error line numbers stay the
# model's own.
PIN_MARKER = "/* turma:grader-model-pin (XERK-1856) */"
META_RE = re.compile(r"export\s+const\s+meta\s*=\s*")
BODY_LEAD_RE = re.compile(r"[;\s]*\n")
SCRIPT_MAX_BYTES = 524288   # the Workflow tool's own cap on `script`


def _skip_comments(src: str, i: int = 0):
    """Index of the first token at or after ``i`` that is not whitespace, a
    comment or a hashbang; None on an unterminated block comment."""
    if i == 0 and src.startswith("#!"):
        i = src.find("\n") if "\n" in src else len(src)
    while True:
        while i < len(src) and src[i].isspace():
            i += 1
        if src.startswith("//", i):
            j = src.find("\n", i)
            i = len(src) if j < 0 else j
        elif src.startswith("/*", i):
            j = src.find("*/", i + 2)
            if j < 0:
                return None
            i = j + 2
        else:
            return i


def _literal_end(src: str, start: int):
    """Index just past the ``{...}`` object literal opening at ``src[start]``,
    skipping strings and comments; None when it does not close."""
    depth, i, n = 0, start, len(src)
    while i < n:
        c = src[i]
        if c in "'\"`":
            i += 1
            while i < n and src[i] != c:
                i += 2 if src[i] == "\\" else 1
        elif src.startswith("//", i):
            i = src.find("\n", i)
            if i < 0:
                return None
        elif src.startswith("/*", i):
            i = src.find("*/", i + 2)
            if i < 0:
                return None
            i += 1
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    return None


def pin_workflow_script(script: str, model: str):
    """The script with grader ``agent()`` calls pinned to ``model``, or None
    when it is already pinned, its leading meta literal is not found, or the
    pin would push it past the tool's size cap. Any doubt passes the script
    through unchanged: a broken workflow is worse than an unpinned one."""
    start = _skip_comments(script)
    m = META_RE.match(script, start) if start is not None else None
    if not m or not script.startswith("{", m.end()):
        return None
    end = _literal_end(script, m.end())
    if end is None:
        return None
    # The runtime strips `^[;\s]*\n` off the body before running it, so its
    # stack lines count from the first line that survives; the pin goes at the
    # START of that line (never a line of its own) to keep them the model's.
    lead = BODY_LEAD_RE.match(script, end)
    at = lead.end() if lead else end
    if script.startswith(";" + PIN_MARKER, at):
        return None
    # One line, no newline. A non-writable global would throw in strict mode,
    # hence the try: the pin then lapses rather than the run failing.
    pin = (
        f";{PIN_MARKER} try {{ globalThis.agent = ((a) => (p, o) => {{"
        " const t = o && typeof o === 'object' && typeof o.agentType === 'string'"
        " ? o.agentType.trim().toLowerCase() : '';"
        f" return a(p, t && ({json.dumps(sorted(PINNED_NAMES))}.includes(t)"
        f" || /(?<!p)review/.test(t)) ? {{...o, model: {json.dumps(model)}}} : o);"
        " })(globalThis.agent); } catch (e) {}"
    )
    pinned = script[:at] + pin + script[at:]
    if len(pinned.encode("utf-8")) > SCRIPT_MAX_BYTES:
        return None
    return pinned


def pin_workflow(tool_input: dict, model: str):
    """The Workflow input with its script pinned, or None to pass through.
    A ``scriptPath`` is inlined (it takes precedence over ``script``, so it is
    dropped); a saved workflow run by ``name`` cannot be read here and passes."""
    script = tool_input.get("script")
    rest = dict(tool_input)
    path = tool_input.get("scriptPath")
    if isinstance(path, str) and path:
        try:
            with open(path, encoding="utf-8") as f:
                script = f.read()
        except (OSError, ValueError):
            return None
        rest.pop("scriptPath")
    if not isinstance(script, str):
        return None
    pinned = pin_workflow_script(script, model)
    if pinned is None:
        return None
    return dict(rest, script=pinned)


def main() -> int:
    model = os.environ.get("TURMA_PIN_SUBAGENT_MODEL", "").strip()
    if not model:
        return 0
    try:
        # BYTES, decoded as UTF-8: text stdin on Windows is the ANSI code page
        # (cp1252; `-SI` ignores PYTHONUTF8), and this hook echoes the whole
        # prompt back, so a `—` would come back as `â€”`.
        payload = json.loads(sys.stdin.buffer.read().decode("utf-8"))
        tool_input = payload.get("tool_input")
    except (ValueError, AttributeError):
        return 0
    if not isinstance(tool_input, dict):
        return 0
    if payload.get("tool_name") == "Workflow":
        updated = pin_workflow(tool_input, model)
        if updated is None:
            return 0
    elif not is_grader(tool_input.get("subagent_type")) or tool_input.get("model") == model:
        return 0
    else:
        updated = dict(tool_input, model=model)
    # ensure_ascii (the default) keeps stdout pure ASCII on any code page.
    sys.stdout.write(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "updatedInput": updated,
    }}))
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())

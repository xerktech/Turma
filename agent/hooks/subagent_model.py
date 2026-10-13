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
(XERK-1856), so the hook also matches ``Workflow`` and rewrites the SCRIPT: the
body after the ``meta`` literal runs inside an async arrow whose ``agent``
parameter is a wrapper adding ``model`` to a grader's opts — the same per-call
lever, which beats the definition's frontmatter there too (measured, 2.1.296).
Wrapping the body leaves every ``agent(...)`` call site untouched, so nothing
parses the JS beyond finding where the meta literal ends.

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


# Marks a script this hook already wrapped: a resumed run re-reads the persisted
# (wrapped) script, which must not be wrapped twice.
WRAP_MARKER = "/* turma:grader-model-pin (XERK-1856) */"
META_RE = re.compile(r"export\s+const\s+meta\s*=\s*")


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


def wrap_workflow_script(script: str, model: str):
    """The script with grader ``agent()`` calls pinned to ``model``, or None
    when it is already wrapped or its ``meta`` literal cannot be found."""
    if WRAP_MARKER in script:
        return None
    m = META_RE.search(script)
    if not m or not script.startswith("{", m.end()):
        return None
    end = _literal_end(script, m.end())
    if end is None:
        return None
    names = json.dumps(sorted(PINNED_NAMES))
    pin = (
        f"\n;{WRAP_MARKER}\n"
        "return await (async (agent) => {\n"
        f"{script[end:]}\n"
        "})(((a) => (p, o) => {\n"
        "  const t = o && typeof o === 'object' ? (o.agentType ?? o.subagent_type) : undefined;\n"
        "  const n = typeof t === 'string' ? t.trim().toLowerCase() : '';\n"
        f"  return a(p, n && ({names}.includes(n) || /(?<!p)review/.test(n))\n"
        f"    ? {{...o, model: {json.dumps(model)}}} : o);\n"
        "})(agent));\n"
    )
    return script[:end] + pin


def pin_workflow(tool_input: dict, model: str):
    """The Workflow input with its script wrapped, or None to pass through.
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
    wrapped = wrap_workflow_script(script, model)
    if wrapped is None:
        return None
    return dict(rest, script=wrapped)


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

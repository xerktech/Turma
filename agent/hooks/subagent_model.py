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
    if not isinstance(tool_input, dict) or not is_grader(tool_input.get("subagent_type")):
        return 0
    if tool_input.get("model") == model:
        return 0
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

#!/usr/bin/env python3
"""Turma AskUserQuestion bridge — a Claude Code ``PreToolUse`` hook.

Claude Code renders ``AskUserQuestion`` as an interactive numbered picker in
the session's TUI. That works when a human is attached to the terminal, but the
Turma glasses client is *not* attached to the TUI — it reads the session over
the heartbeat and answers out of band. Scraping the picker out of the tmux pane
and typing a digit back into it (the previous approach) was unreliable: the
pane parse saw phantom/garbled questions and the injected keystroke didn't
select+submit in ``--remote-control`` mode.

This hook replaces both halves with a structured round-trip, mirroring the
sibling ClaudeHUD broker's ``claude-hook.mjs``:

  * On an ``AskUserQuestion`` tool call Claude pipes the ``questions[]`` array
    on stdin. For each question we write a request file
    (``$TURMA_QUESTIONS_DIR/<sessionId>.req.json``) and **block**, polling for
    the matching answer file (``<sessionId>.ans.json``) the agent drops when
    the glasses answer arrives on the heartbeat.
  * The collected answers are returned as ``permissionDecision: "deny"`` with a
    structured ``permissionDecisionReason`` JSON blob. ``PreToolUse`` can't
    carry typed answer data through an *allow*, so deny-with-reason is the
    channel — Claude reads the answers out of the tool_result and proceeds
    (the same trick ClaudeHUD relies on).

Because AskUserQuestion for one session is serialized (Claude blocks on the
tool), there is at most one pending question per session at a time, so the
request/answer files can be keyed on the session id alone — no id coordination.

Env vars (set by ``_launch_tmux`` on the ``claude`` process, inherited here):
  TURMA_SESSION_ID        The agent-side session id these files are keyed on.
  TURMA_QUESTIONS_DIR     Rendezvous directory (``~/.turma/questions``).
  TURMA_QUESTION_TIMEOUT_SEC  Optional per-question block timeout (default 600).

Missing env means ``claude`` was spawned outside a Turma session (the one-shot
summary subprocess, or an operator running ``claude`` by hand) — we pass
through silently (exit 0, no output) so those flows keep Claude's own picker.

Contract (Claude Code ``PreToolUse`` hook):
  stdin  — JSON with ``tool_name`` and ``tool_input`` (``.questions`` here).
  answer — print ``{"hookSpecificOutput": {"hookEventName": "PreToolUse",
           "permissionDecision": "deny", "permissionDecisionReason": <json>}}``
           and exit 0.
  pass   — exit 0 with no output (defers to the normal flow).

Stdlib only: invoked by absolute path, so nothing beyond the standard library
can be assumed importable.
"""

from __future__ import annotations

import json
import os
import sys
import time

# How long to block on a single question before giving up and letting Claude
# proceed unanswered. Kept below the hook's own ``timeout`` in the generated
# settings (which is set a little higher) so we self-time-out cleanly rather
# than being killed mid-write.
DEFAULT_TIMEOUT_SEC = 600
# Poll cadence while waiting for the answer file.
POLL_INTERVAL_SEC = 0.4


def _emit_deny(reason: str) -> None:
    """Emit a PreToolUse deny with a reason string (fed back to the model)."""
    payload = {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    }
    sys.stdout.write(json.dumps(payload))
    sys.stdout.flush()


def _normalize_options(raw) -> list[dict]:
    """Coerce a question's ``options`` into ``[{label, description?}]``. Bare
    strings become ``{label}``; malformed entries are dropped."""
    out: list[dict] = []
    if not isinstance(raw, list):
        return out
    for o in raw:
        if isinstance(o, str):
            out.append({"label": o[:200]})
        elif isinstance(o, dict) and isinstance(o.get("label"), str):
            opt = {"label": o["label"][:200]}
            desc = o.get("description")
            if isinstance(desc, str) and desc:
                opt["description"] = desc[:400]
            out.append(opt)
    return out


def _write_json_atomic(path: str, data) -> None:
    """Write JSON via a temp file + ``os.replace`` so a reader never sees a
    half-written file."""
    tmp = f"{path}.tmp.{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(tmp, path)


def _read_answer(path: str):
    """Read the answer file, or None if absent / not-yet-complete. A partial
    (mid-rename) or corrupt read is treated as 'not ready' and retried."""
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (FileNotFoundError, ValueError, OSError):
        return None
    if not isinstance(data, dict):
        return None
    return data


def _ask_one(req_path: str, ans_path: str, question: dict, index: int,
             total: int, session_id: str, timeout_sec: float) -> dict:
    """Publish one question and block for its answer. Returns an answer record
    ``{question, optionIndex, label, custom}``. On timeout the record carries
    ``optionIndex: -1`` and ``custom: "__hook_timeout__"`` so Claude can tell a
    real pick from a no-answer."""
    q_text = str(question.get("question") or "")
    options = _normalize_options(question.get("options"))
    header = question.get("header")
    req = {
        "sessionId": session_id,
        "index": index,
        "total": total,
        "question": q_text[:1000],
        "options": options,
        "allowOther": question.get("allowOther") is True,
        "multiSelect": question.get("multiSelect") is True,
        "createdAt": time.time(),
    }
    if isinstance(header, str) and header:
        req["header"] = header[:12]

    # Clear any stale rendezvous files from a prior question before publishing.
    for p in (req_path, ans_path):
        try:
            os.remove(p)
        except OSError:
            pass
    _write_json_atomic(req_path, req)

    deadline = time.time() + timeout_sec
    answer = None
    while time.time() < deadline:
        answer = _read_answer(ans_path)
        if answer is not None:
            break
        time.sleep(POLL_INTERVAL_SEC)

    # Consume the rendezvous files regardless of outcome.
    for p in (req_path, ans_path):
        try:
            os.remove(p)
        except OSError:
            pass

    if answer is None:
        return {"question": q_text, "optionIndex": -1, "label": None,
                "custom": "__hook_timeout__"}
    option_index = answer.get("optionIndex")
    option_index = option_index if isinstance(option_index, int) else -1
    custom = answer.get("custom")
    custom = custom if isinstance(custom, str) and custom else None
    label = None
    if 0 <= option_index < len(options):
        label = options[option_index].get("label")
    return {"question": q_text, "optionIndex": option_index,
            "label": label, "custom": custom}


def main() -> int:
    session_id = (os.environ.get("TURMA_SESSION_ID") or "").strip()
    questions_dir = (os.environ.get("TURMA_QUESTIONS_DIR") or "").strip()
    # No Turma session context -> defer to Claude's own picker (pass-through).
    if not session_id or not questions_dir:
        return 0

    try:
        raw = sys.stdin.read()
        event = json.loads(raw) if raw.strip() else {}
    except (json.JSONDecodeError, OSError):
        # Fail open: a bridge that crashes must not wedge the session. Deferring
        # here just falls back to Claude's own (TUI) flow.
        return 0
    if not isinstance(event, dict):
        return 0
    if (event.get("tool_name") or "") != "AskUserQuestion":
        return 0  # matcher should prevent this, but stay defensive.

    tool_input = event.get("tool_input")
    questions = (tool_input or {}).get("questions") if isinstance(tool_input, dict) else None
    if not isinstance(questions, list) or not questions:
        return 0  # nothing to ask — let it through.

    try:
        timeout_sec = float(os.environ.get("TURMA_QUESTION_TIMEOUT_SEC") or DEFAULT_TIMEOUT_SEC)
    except ValueError:
        timeout_sec = DEFAULT_TIMEOUT_SEC

    try:
        os.makedirs(questions_dir, exist_ok=True)
    except OSError:
        return 0  # can't rendezvous — defer to the TUI flow.

    req_path = os.path.join(questions_dir, f"{session_id}.req.json")
    ans_path = os.path.join(questions_dir, f"{session_id}.ans.json")

    answers = []
    total = len(questions)
    for i, q in enumerate(questions):
        if not isinstance(q, dict):
            continue
        answers.append(_ask_one(req_path, ans_path, q, i, total, session_id, timeout_sec))

    _emit_deny(json.dumps({"kind": "askuserquestion_answers", "answers": answers}))
    return 0


if __name__ == "__main__":  # pragma: no cover - shell entry
    sys.exit(main())

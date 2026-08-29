#!/usr/bin/env python3
"""Turma AskUserQuestion bridge for a Qwen Code session — a minimal stdio MCP
server exposing one tool, ``ask_user_question`` (XERK-509, [Qwen][C]).

Claude Code has a native ``AskUserQuestion`` tool that Turma intercepts with the
``ask.py`` PreToolUse hook (write a request file, block, return the operator's
answer). Qwen Code has no such native tool, and its hook contract (Claude Code's,
ported — G0 crit. 5) can only DENY/allow a tool the model already calls; it
cannot conjure a callable tool. So to give a Qwen session a REAL structured,
multi-select question — the same card a Claude session raises, not a yes/no
approval — Turma REGISTERS the tool via MCP, the one Claude-Code-compatible
mechanism for a model-callable tool.

This server exposes ``ask_user_question({question, options[], multiSelect})``.
When the model calls it, the server writes the SAME rendezvous file every Turma
question surface already reads (``$TURMA_QUESTIONS_DIR/<sessionId>.req.json``,
the exact shape ``ask.py`` writes and ``_hook_question`` parses) and BLOCKS,
polling for the answer file (``<sessionId>.ans.json``) that hub-agent's existing
``answer_question`` drops when the operator answers over the heartbeat — so there
is NO client change: the card renders and is answered by the same code a Claude
question uses. The chosen option label(s) / free text is returned as the tool's
result for the model to act on.

MCP stdio transport: newline-delimited JSON-RPC 2.0 (one compact message per
line, no embedded newlines). This implements the minimal handshake — ``initialize``,
``tools/list``, ``tools/call`` (+ ``ping``) — and nothing else.

Env (set on the ``qwen`` process by hub-agent's launcher, inherited here):
  TURMA_SESSION_ID           the agent-side session id the files are keyed on.
  TURMA_QUESTIONS_DIR        rendezvous directory (``~/.turma/questions``).
  TURMA_QUESTION_TIMEOUT_SEC optional per-question block timeout (default 600).

Missing env means this MCP server was started outside a Turma session; it still
serves the tool but a call returns a benign "no operator attached" result rather
than blocking forever.

Stdlib only: invoked by absolute path under ``python3 -SsE``, so nothing beyond
the standard library can be assumed importable.
"""

from __future__ import annotations

import json
import os
import sys
import time

PROTOCOL_VERSION = "2024-11-05"
SERVER_NAME = "turma-ask"
SERVER_VERSION = "1"

DEFAULT_TIMEOUT_SEC = 600
POLL_INTERVAL_SEC = 0.4

TOOL_NAME = "ask_user_question"
TOOL_DESCRIPTION = (
    "Ask the human operator a structured multiple-choice question and wait for "
    "their answer. Use this to get a decision from the operator when you need "
    "one — it renders as a selectable card in Turma. Provide a clear question "
    "and 2+ options; set multiSelect when several may be chosen."
)
TOOL_INPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "question": {"type": "string", "description": "The question to ask."},
        "options": {
            "type": "array",
            "items": {"type": "string"},
            "description": "The choices to offer (2 or more).",
        },
        "multiSelect": {
            "type": "boolean",
            "description": "Whether the operator may pick several options.",
        },
        "header": {
            "type": "string",
            "description": "Optional short label for the question (<=12 chars).",
        },
    },
    "required": ["question", "options"],
}


def _question_dir_and_id():
    session_id = (os.environ.get("TURMA_SESSION_ID") or "").strip()
    questions_dir = (os.environ.get("TURMA_QUESTIONS_DIR") or "").strip()
    return session_id, questions_dir


def _normalize_options(raw):
    """Coerce the tool's ``options`` into ``[{label, description?, preview?}]``,
    the shape ``_hook_question`` reads — matching ask.py's ``_normalize_options``
    so the card renders identically. Accepts bare strings or option objects."""
    out = []
    if not isinstance(raw, list):
        return out
    for o in raw:
        if isinstance(o, str):
            if o:
                out.append({"label": o[:200]})
        elif isinstance(o, dict) and isinstance(o.get("label"), str):
            opt = {"label": o["label"][:200]}
            desc = o.get("description")
            if isinstance(desc, str) and desc:
                opt["description"] = desc[:400]
            preview = o.get("preview")
            if isinstance(preview, str) and preview:
                opt["preview"] = preview[:2000]
            out.append(opt)
    return out


def _write_json_atomic(path, data):
    tmp = f"{path}.tmp.{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(tmp, path)


def _read_answer(path):
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (FileNotFoundError, ValueError, OSError):
        return None
    return data if isinstance(data, dict) else None


def _ask(arguments):
    """Publish one question and block for its answer. Returns the human-readable
    result string the model reads. Never raises."""
    session_id, questions_dir = _question_dir_and_id()
    question = str((arguments or {}).get("question") or "").strip()
    options = _normalize_options((arguments or {}).get("options"))
    multi = (arguments or {}).get("multiSelect") is True
    header = (arguments or {}).get("header")
    if not question:
        return "No question was provided; nothing to ask."
    if not session_id or not questions_dir:
        # Not inside a Turma session — cannot rendezvous with an operator.
        return ("No Turma operator is attached to this session, so the question "
                "could not be delivered. Proceed using your best judgement.")

    req = {
        "sessionId": session_id,
        "index": 0,
        "total": 1,
        "question": question[:1000],
        "options": options,
        "allowOther": True,
        "multiSelect": multi,
        "createdAt": time.time(),
    }
    if isinstance(header, str) and header.strip():
        req["header"] = header.strip()[:12]

    req_path = os.path.join(questions_dir, f"{session_id}.req.json")
    ans_path = os.path.join(questions_dir, f"{session_id}.ans.json")
    try:
        os.makedirs(questions_dir, exist_ok=True)
    except OSError:
        return ("The question could not be delivered (rendezvous unavailable). "
                "Proceed using your best judgement.")
    # Clear any stale rendezvous files before publishing.
    for p in (req_path, ans_path):
        try:
            os.remove(p)
        except OSError:
            pass
    try:
        _write_json_atomic(req_path, req)
    except OSError:
        return ("The question could not be delivered (write failed). Proceed "
                "using your best judgement.")

    try:
        timeout_sec = float(os.environ.get("TURMA_QUESTION_TIMEOUT_SEC")
                            or DEFAULT_TIMEOUT_SEC)
    except ValueError:
        timeout_sec = DEFAULT_TIMEOUT_SEC

    deadline = time.time() + timeout_sec
    answer = None
    while time.time() < deadline:
        answer = _read_answer(ans_path)
        if answer is not None:
            break
        time.sleep(POLL_INTERVAL_SEC)

    for p in (req_path, ans_path):
        try:
            os.remove(p)
        except OSError:
            pass

    if answer is None:
        return ("The operator did not answer in time. Proceed using your best "
                "judgement, or ask again if a decision is essential.")

    # Resolve the chosen option index/indices (multi or single) into labels,
    # exactly as ask.py does, and surface any free-text ("Other") answer.
    idxs = []
    raw_multi = answer.get("optionIndices")
    if isinstance(raw_multi, list):
        for v in raw_multi:
            if isinstance(v, int) and 0 <= v < len(options) and v not in idxs:
                idxs.append(v)
    else:
        one = answer.get("optionIndex")
        if isinstance(one, int) and 0 <= one < len(options):
            idxs = [one]
    labels = [options[i].get("label") for i in idxs]
    custom = answer.get("custom")
    custom = custom if isinstance(custom, str) and custom.strip() else None

    parts = []
    if labels:
        parts.append("The operator chose: " + ", ".join(labels) + ".")
    if custom:
        parts.append("The operator also wrote: " + custom.strip())
    if not parts:
        parts.append("The operator dismissed the question without choosing an "
                     "option.")
    return " ".join(parts)


# ---- JSON-RPC / MCP plumbing ------------------------------------------------

def _result(msg_id, result):
    return {"jsonrpc": "2.0", "id": msg_id, "result": result}


def _error(msg_id, code, message):
    return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": code,
                                                      "message": message}}


def _handle(msg):
    """Dispatch one JSON-RPC message. Returns a response dict, or None for a
    notification (no id) that needs no reply."""
    if not isinstance(msg, dict):
        return None
    method = msg.get("method")
    msg_id = msg.get("id")
    is_notification = "id" not in msg
    if method == "initialize":
        return _result(msg_id, {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
        })
    if method in ("notifications/initialized", "initialized"):
        return None  # notification, no reply
    if method == "ping":
        return _result(msg_id, {})
    if method == "tools/list":
        return _result(msg_id, {"tools": [{
            "name": TOOL_NAME,
            "description": TOOL_DESCRIPTION,
            "inputSchema": TOOL_INPUT_SCHEMA,
        }]})
    if method == "tools/call":
        params = msg.get("params") or {}
        name = params.get("name")
        if name != TOOL_NAME:
            return _error(msg_id, -32602, f"unknown tool: {name!r}")
        try:
            text = _ask(params.get("arguments") or {})
        except Exception as e:  # a tool must never crash the server
            return _result(msg_id, {
                "content": [{"type": "text",
                             "text": f"The question could not be asked ({e})."}],
                "isError": True,
            })
        return _result(msg_id, {"content": [{"type": "text", "text": text}]})
    if is_notification:
        return None  # ignore unknown notifications
    return _error(msg_id, -32601, f"method not found: {method}")


def main():
    out = sys.stdout
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            # A parse error with no id we can attribute — MCP allows a null-id
            # error response; keep the server alive either way.
            out.write(json.dumps(_error(None, -32700, "parse error")) + "\n")
            out.flush()
            continue
        response = _handle(msg)
        if response is not None:
            out.write(json.dumps(response) + "\n")
            out.flush()
    return 0


if __name__ == "__main__":  # pragma: no cover - shell entry
    sys.exit(main())

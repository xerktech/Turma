#!/usr/bin/env python3
"""Turma cross-session peer messaging for a Qwen Code session — a minimal stdio
MCP server exposing one tool, ``send_message`` (XERK-518, [Qwen][L]).

Claude Code has a native ``SendMessage`` tool that delivers to local peers via
their inbox sockets. Qwen Code has no such native tool, and its hook contract
cannot conjure a callable tool. So to give a Qwen session peer messaging, Turma
REGISTERS the tool via MCP, the same mechanism as ``turma-ask`` (XERK-509).

This server exposes ``send_message({to, message})``. When the model calls it,
the server writes a request file to the rendezvous directory
(``$TURMA_QWEN_PEER_DIR/<sessionId>/``) and returns immediately — peer messages
are best-effort and fire-and-forget, matching Claude Code's own SendMessage
semantics. The hub-agent picks up pending files on its peer-delivery worker and
resolves the name against this host's running sessions.

MCP stdio transport: newline-delimited JSON-RPC 2.0 (one compact message per
line, no embedded newlines). This implements the minimal handshake — ``initialize``,
``tools/list``, ``tools/call`` (+ ``ping``) — and nothing else.

Env (set on the ``qwen`` process by hub-agent's launcher, inherited here):
  TURMA_SESSION_ID       the agent-side session id the files are keyed on.
  TURMA_QWEN_PEER_DIR    rendezvous directory (``~/.turma/qwen-peer``).

Missing env means this MCP server was started outside a Turma session; it still
serves the tool but a call returns a benign "no peers available" result rather
than writing anywhere.

Stdlib only: invoked by absolute path under ``python3 -SsE``, so nothing beyond
the standard library can be assumed importable.
"""

from __future__ import annotations

import json
import os
import sys
import time

PROTOCOL_VERSION = "2024-11-05"
SERVER_NAME = "turma-peer"
SERVER_VERSION = "1"

TOOL_NAME = "send_message"
TOOL_DESCRIPTION = (
    "Send a message to another session in your organisation by name. The "
    "message is delivered best-effort: the named peer must be running on this "
    "host and the name must appear in your peers.tsv roster. Use this tool "
    "sparingly — a message costs the receiver a turn AND sits in their context "
    "for every turn after it."
)
TOOL_INPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "to": {
            "type": "string",
            "description": "The peer's name as shown in peers.tsv.",
        },
        "message": {
            "type": "string",
            "description": "The text to send to the peer.",
        },
    },
    "required": ["to", "message"],
}

# Best-effort file counter for ordering within one session's send queue.
_send_counter = 0


def _write_json_atomic(path, data):
    # The tmp name is DOT-PREFIXED (matching peer_inbox.py's own atomic write)
    # because the hub's poller (_poll_qwen_peer_dir) skips dotfiles precisely to
    # avoid reading a request mid-write — an un-prefixed tmp name left a
    # microscopic window where the poller could read-and-delete THIS file
    # before the rename below ran, so the following os.replace raised
    # FileNotFoundError and _send() reported "write failed" for a message that
    # had, in fact, already been delivered (a QA finding).
    d, name = os.path.split(path)
    tmp = os.path.join(d, f".{name}.tmp.{os.getpid()}")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(tmp, path)


def _send(arguments):
    """Write one peer-send request for the hub to pick up. Returns immediately
    with a confirmation string the model reads. Never raises."""
    global _send_counter
    session_id = (os.environ.get("TURMA_SESSION_ID") or "").strip()
    peer_dir = (os.environ.get("TURMA_QWEN_PEER_DIR") or "").strip()
    to = str((arguments or {}).get("to") or "").strip()
    message = str((arguments or {}).get("message") or "")
    if not to:
        return "No recipient was provided; nothing to send."
    if not message.strip():
        return "No message text was provided; nothing to send."
    if not session_id or not peer_dir:
        return ("No Turma session is attached, so the message could not be "
                "delivered. The peer is not reachable from this context.")

    send_dir = os.path.join(peer_dir, session_id)
    try:
        os.makedirs(send_dir, exist_ok=True)
    except OSError:
        return ("The message could not be queued (rendezvous unavailable). "
                "The peer is not reachable from this context.")
    _send_counter += 1
    filename = f"{int(time.time() * 1000)}-{_send_counter}.json"
    req = {"to": to[:200], "message": message[:200000]}
    try:
        _write_json_atomic(os.path.join(send_dir, filename), req)
    except OSError:
        return ("The message could not be queued (write failed). "
                "The peer is not reachable from this context.")
    return f"Message sent to {to}."


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
        return None
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
            text = _send(params.get("arguments") or {})
        except Exception as e:
            return _result(msg_id, {
                "content": [{"type": "text",
                             "text": f"The message could not be sent ({e})."}],
                "isError": True,
            })
        return _result(msg_id, {"content": [{"type": "text", "text": text}]})
    if is_notification:
        return None
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

#!/usr/bin/env python3
"""Turma peer-inbox forger for a Qwen Code session (XERK-518, [Qwen][L]).

Claude Code's ``SendMessage`` resolves a name to a session-registry record at
``~/.claude/sessions/<pid>.json`` and posts one LDJSON line to that record's
``messagingSocketPath``. A Qwen session is not in that registry, so this helper
FORGES a record under its OWN live pid and binds the inbox socket — the pid
must be a live process the registry's liveness/peercred checks accept (the
single-pid hub cannot masquerade as N sessions).

When a native Claude peer sends a message, this process receives it on the
bound socket and writes a file the hub picks up from the rendezvous directory.
The hub then applies ``crossSessionInbound`` policy and injects the message
into the qwen session's pane.

Started by ``_launch_qwen`` as a background subprocess per qwen session; killed
by ``_teardown_qwen``. Runs for the session's lifetime.

Env (set by the launcher):
  TURMA_SESSION_ID            the agent-side session id.
  TURMA_CLAUDE_SESSION_ID     the claude-shaped session id (for wire validation).
  TURMA_RC_NAME               the session's rcName (peer-addressable name).
  TURMA_QWEN_PEER_DIR         rendezvous directory for inbound messages.
  TURMA_CWD                   the session's working directory.

Stdlib only.
"""

from __future__ import annotations

import json
import os
import signal
import socket
import struct
import sys
import time

LINE_MAX_BYTES = 256 * 1024
SESSIONS_REGISTRY_DIR = os.path.expanduser("~/.claude/sessions")


def _proc_start():
    """Field 22 (starttime) of /proc/self/stat, after the ')' that closes comm."""
    try:
        stat = open("/proc/self/stat", "r").read()
        after_comm = stat[stat.rfind(") ") + 2:]
        return after_comm.split(" ")[19] or "0"
    except Exception:
        return "0"


def _pid_domain():
    """The pid namespace inode path from /proc/self/ns/pid."""
    try:
        return "linux::" + os.readlink("/proc/self/ns/pid")
    except Exception:
        return "linux::pid:[0]"


def _find_peer_record():
    """Find a real Claude session record to copy version/peerFeatures from."""
    version = "2.1.0"
    peer_features = ["notify_idle"]
    try:
        for f in os.listdir(SESSIONS_REGISTRY_DIR):
            if not f.endswith(".json"):
                continue
            path = os.path.join(SESSIONS_REGISTRY_DIR, f)
            try:
                with open(path, "r") as fh:
                    data = json.load(fh)
            except (OSError, ValueError):
                continue
            if (isinstance(data, dict) and data.get("peerProtocol") == 1
                    and isinstance(data.get("version"), str)):
                version = data["version"]
                pf = data.get("peerFeatures")
                if isinstance(pf, list):
                    peer_features = pf
                break
    except OSError:
        pass
    return version, peer_features


def _write_peer_record(inbox_sock, record_path, session_id, rc_name, cwd):
    """Write the forged Claude-Code session-registry record."""
    version, peer_features = _find_peer_record()
    now = int(time.time() * 1000)
    record = {
        "pid": os.getpid(),
        "sessionId": session_id,
        "cwd": cwd,
        "startedAt": now,
        "procStart": _proc_start(),
        "version": version,
        "peerProtocol": 1,
        "peerFeatures": peer_features,
        "kind": "interactive",
        "entrypoint": "cli",
        "pidDomain": _pid_domain(),
        "messagingSocketPath": inbox_sock,
        "name": rc_name,
        "nameSince": now,
        "updatedAt": now,
        "status": "idle",
        "statusUpdatedAt": now,
    }
    os.makedirs(os.path.dirname(record_path), exist_ok=True)
    tmp = f"{record_path}.tmp.{os.getpid()}"
    with open(tmp, "w") as f:
        json.dump(record, f)
    os.replace(tmp, record_path)


def _write_inbound(peer_dir, session_id, frm, text):
    """Write a received peer message for the hub to pick up."""
    recv_dir = os.path.join(peer_dir, session_id)
    os.makedirs(recv_dir, exist_ok=True)
    filename = f"recv-{int(time.time() * 1000)}-{os.getpid()}.json"
    data = {"from": frm, "text": text}
    tmp_path = os.path.join(recv_dir, f".{filename}.tmp")
    final_path = os.path.join(recv_dir, filename)
    with open(tmp_path, "w") as f:
        json.dump(data, f)
    os.replace(tmp_path, final_path)


def _handle_connection(conn, claude_session_id, peer_dir, turma_session_id):
    """Read one LDJSON message from a connected peer and write it out."""
    buf = b""
    try:
        while True:
            chunk = conn.recv(4096)
            if not chunk:
                break
            buf += chunk
            if b"\n" in buf:
                break
            if len(buf) > LINE_MAX_BYTES:
                return
    except OSError:
        return
    finally:
        try:
            conn.close()
        except OSError:
            pass
    nl = buf.find(b"\n")
    if nl < 0:
        return
    line = buf[:nl].decode("utf-8", errors="replace").strip()
    if not line:
        return
    try:
        msg = json.loads(line)
    except ValueError:
        return
    if not isinstance(msg, dict):
        return
    # Validate session_id matches — reject messages for other sessions at a
    # recycled pid.
    wire_sid = msg.get("session_id")
    if wire_sid and wire_sid != claude_session_id:
        return
    # Extract the message text.
    content = msg.get("message")
    if isinstance(content, dict):
        text = content.get("content", "")
    elif isinstance(content, str):
        text = content
    else:
        text = ""
    if not isinstance(text, str) or not text.strip():
        return
    frm = str(msg.get("from") or "a peer")
    _write_inbound(peer_dir, turma_session_id, frm, text)


def main():
    session_id = os.environ.get("TURMA_SESSION_ID", "")
    claude_session_id = os.environ.get("TURMA_CLAUDE_SESSION_ID", "")
    rc_name = os.environ.get("TURMA_RC_NAME", "")
    peer_dir = os.environ.get("TURMA_QWEN_PEER_DIR", "")
    cwd = os.environ.get("TURMA_CWD", os.getcwd())

    if not session_id or not claude_session_id or not rc_name or not peer_dir:
        sys.stderr.write("peer_inbox: missing required env vars\n")
        return 1

    pid = os.getpid()
    # Determine socket location: match Claude Code's own cc-socks path.
    xdg = os.environ.get("XDG_RUNTIME_DIR")
    cc_dir = os.path.join(xdg, "cc-socks") if xdg else "/tmp/cc-socks"
    inbox_sock = os.path.join(cc_dir, f"{pid}.sock")
    record_path = os.path.join(SESSIONS_REGISTRY_DIR, f"{pid}.json")

    os.makedirs(cc_dir, exist_ok=True)
    os.makedirs(SESSIONS_REGISTRY_DIR, exist_ok=True)
    # Remove stale socket.
    try:
        os.unlink(inbox_sock)
    except OSError:
        pass

    # Bind the inbox socket.
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(inbox_sock)
    try:
        os.chmod(inbox_sock, 0o600)
    except OSError:
        pass
    srv.listen(5)
    srv.settimeout(2.0)

    # Write the forged peer record.
    _write_peer_record(inbox_sock, record_path, claude_session_id, rc_name, cwd)

    # Handle SIGTERM gracefully.
    running = True

    def _shutdown(signum, frame):
        nonlocal running
        running = False

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)

    try:
        while running:
            try:
                conn, _ = srv.accept()
            except socket.timeout:
                continue
            except OSError:
                continue
            try:
                _handle_connection(conn, claude_session_id, peer_dir, session_id)
            except Exception:
                pass
    finally:
        try:
            srv.close()
        except OSError:
            pass
        try:
            os.unlink(inbox_sock)
        except OSError:
            pass
        try:
            os.unlink(record_path)
        except OSError:
            pass
    return 0


if __name__ == "__main__":  # pragma: no cover - shell entry
    sys.exit(main())

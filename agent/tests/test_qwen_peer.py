#!/usr/bin/env python3
"""Tests for the two qwen cross-session peer-messaging modules (XERK-518
[Qwen L]) — the dsh [L] (XERK-476) analogue, file-rendezvous based because a
qwen session has no control socket:

  agent/qwen/peer_mcp.py    SEND — the `send_message` MCP tool a qwen session
                            calls; writes a request file for the hub to pick up.
  agent/qwen/peer_inbox.py  RECEIVE — forges a Claude session-registry record +
                            binds the inbox socket under its OWN live pid, so a
                            native Claude peer's SendMessage lands, and writes
                            each inbound message out as a "recv-*" file.

The hub-agent half (resolution, crossSessionInbound policy, pane delivery) is
`TestQwenPeerMessaging` in test_hub_agent.py. The RECEIVE path's real Claude
delivery stays HOST-PROOF only — it rides Claude Code's private, versioned
peer-record format — so what is pinned here is the record SHAPE and the socket
handling, driven against a real UNIX socket rather than a mock.
"""

import importlib.util
import json
import os
import shutil
import socket
import tempfile
import threading
import time
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_QWEN = os.path.join(os.path.dirname(_HERE), "qwen")


def _load(name, filename):
    spec = importlib.util.spec_from_file_location(name,
                                                  os.path.join(_QWEN, filename))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


peer_mcp = _load("qwen_peer_mcp", "peer_mcp.py")
peer_inbox = _load("qwen_peer_inbox", "peer_inbox.py")


class _EnvMixin:
    def _patch_env(self, env):
        saved = {k: os.environ.get(k) for k in env}
        os.environ.update(env)

        def restore():
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
        self.addCleanup(restore)


class PeerMcpHandshakeTest(unittest.TestCase):
    """The MCP handshake, mirroring test_qwen_ask_mcp.py's — the settings key
    and that qwen surfaces an MCP tool at all stay host-proof only (qwen is not
    installed in CI), so the JSON-RPC contract is what CI can pin."""

    def test_initialize_advertises_tools_capability(self):
        resp = peer_mcp._handle({"jsonrpc": "2.0", "id": 1,
                                 "method": "initialize", "params": {}})
        self.assertEqual(resp["id"], 1)
        self.assertIn("tools", resp["result"]["capabilities"])
        self.assertEqual(resp["result"]["serverInfo"]["name"], "turma-peer")

    def test_initialized_notification_gets_no_reply(self):
        self.assertIsNone(peer_mcp._handle(
            {"jsonrpc": "2.0", "method": "notifications/initialized"}))

    def test_tools_list_exposes_send_message(self):
        resp = peer_mcp._handle({"jsonrpc": "2.0", "id": 2,
                                 "method": "tools/list"})
        tools = resp["result"]["tools"]
        self.assertEqual(len(tools), 1)
        # The name matches the dsh driver's tool AND what QWEN_PEERS_ADDENDUM
        # tells the model to call — all three must agree.
        self.assertEqual(tools[0]["name"], "send_message")
        self.assertEqual(set(tools[0]["inputSchema"]["required"]),
                         {"to", "message"})

    def test_unknown_method_is_a_jsonrpc_error(self):
        resp = peer_mcp._handle({"jsonrpc": "2.0", "id": 9, "method": "no/such"})
        self.assertEqual(resp["error"]["code"], -32601)

    def test_calling_an_unknown_tool_errors(self):
        resp = peer_mcp._handle({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                                 "params": {"name": "other", "arguments": {}}})
        self.assertEqual(resp["error"]["code"], -32602)


class PeerMcpSendTest(_EnvMixin, unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="qwen-peer-mcp-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.sid = "sess-1"
        self.peer_dir = os.path.join(self.tmp, "qwen-peer")
        self._patch_env({"TURMA_SESSION_ID": self.sid,
                         "TURMA_QWEN_PEER_DIR": self.peer_dir})

    def _files(self):
        d = os.path.join(self.peer_dir, self.sid)
        return sorted(os.listdir(d)) if os.path.isdir(d) else []

    def _read_only_file(self):
        names = self._files()
        self.assertEqual(len(names), 1, names)
        with open(os.path.join(self.peer_dir, self.sid, names[0])) as f:
            return json.load(f)

    def test_a_call_writes_one_request_file_and_returns_at_once(self):
        # SEND is fire-and-forget, matching Claude Code's own SendMessage: the
        # tool returns without waiting for delivery, so the model never blocks
        # on whether a peer was reachable.
        resp = peer_mcp._handle({
            "jsonrpc": "2.0", "id": 5, "method": "tools/call",
            "params": {"name": "send_message",
                       "arguments": {"to": "host-Repo-XERK-9",
                                     "message": "check foo.py"}}})
        self.assertNotIn("error", resp)
        self.assertEqual(self._read_only_file(),
                         {"to": "host-Repo-XERK-9", "message": "check foo.py"})

    def test_the_written_file_is_not_named_recv(self):
        # The hub distinguishes SEND from RECEIVE purely by the "recv-" prefix
        # (_poll_qwen_peer_dir), so a send whose filename started with it would
        # be delivered back into the SENDING session as an inbound message.
        peer_mcp._send({"to": "peer", "message": "hi"})
        self.assertFalse(self._files()[0].startswith("recv-"))

    def test_two_sends_do_not_collide_within_one_millisecond(self):
        # The filename carries a monotonic counter beside the timestamp, so a
        # burst inside one clock tick does not overwrite itself.
        peer_mcp._send({"to": "a", "message": "one"})
        peer_mcp._send({"to": "a", "message": "two"})
        self.assertEqual(len(self._files()), 2)

    def test_a_missing_recipient_or_message_writes_nothing(self):
        for args in ({"to": "", "message": "hi"},
                     {"to": "peer", "message": "   "},
                     {}):
            peer_mcp._send(args)
        self.assertEqual(self._files(), [])

    def test_no_turma_session_writes_nothing_and_says_so(self):
        # An MCP server started outside a Turma session still SERVES the tool
        # (so the model gets a schema, not a crash) but has nowhere to write.
        self._patch_env({"TURMA_QWEN_PEER_DIR": ""})
        text = peer_mcp._send({"to": "peer", "message": "hi"})
        self.assertIn("not reachable", text)
        self.assertEqual(self._files(), [])

    def test_an_unwritable_rendezvous_never_raises(self):
        # A call that cannot queue must degrade to a message the model reads,
        # never an exception that breaks the MCP session.
        self._patch_env({"TURMA_QWEN_PEER_DIR": "/proc/nonexistent/peer"})
        text = peer_mcp._send({"to": "peer", "message": "hi"})
        self.assertIn("not reachable", text)

    def test_oversized_fields_are_capped_before_they_reach_disk(self):
        peer_mcp._send({"to": "x" * 5000, "message": "y" * 500000})
        data = self._read_only_file()
        self.assertEqual(len(data["to"]), 200)
        self.assertEqual(len(data["message"]), 200000)


class PeerInboxRecordTest(_EnvMixin, unittest.TestCase):
    """The forged `~/.claude/sessions/<pid>.json` record.

    Claude Code validates the record's `pid` against the socket LISTENER's
    SO_PEERCRED and requires a `cc-socks*/<pid>.sock` path shape, so the
    record's pid, the socket holder and the filename must all be THIS process
    (.claude/rules/dsh-input.md's pitfall — the same one dsh's driver hit).
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="qwen-peer-inbox-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def test_the_record_names_this_live_process_and_its_socket(self):
        rec_path = os.path.join(self.tmp, "sessions", f"{os.getpid()}.json")
        sock = os.path.join(self.tmp, "cc-socks", f"{os.getpid()}.sock")
        peer_inbox._write_peer_record(sock, rec_path, "cs-1",
                                      "host-Repo-Q1", "/work/tree")
        with open(rec_path) as f:
            rec = json.load(f)
        # The pid, the socket filename and the record filename all agree — the
        # three things Claude Code cross-checks before it will connect.
        self.assertEqual(rec["pid"], os.getpid())
        self.assertEqual(os.path.basename(rec_path), f"{rec['pid']}.json")
        self.assertEqual(os.path.basename(rec["messagingSocketPath"]),
                         f"{rec['pid']}.sock")
        self.assertIn("cc-socks", rec["messagingSocketPath"])
        self.assertEqual(rec["sessionId"], "cs-1")
        self.assertEqual(rec["name"], "host-Repo-Q1")
        self.assertEqual(rec["cwd"], "/work/tree")
        # The liveness fields Claude Code reads to decide the record is not
        # stale (a recycled pid from a dead session must not answer).
        self.assertEqual(rec["peerProtocol"], 1)
        self.assertTrue(rec["procStart"])
        self.assertTrue(rec["pidDomain"].startswith("linux::"))
        self.assertIsInstance(rec["startedAt"], int)

    def test_the_record_is_written_atomically(self):
        # A half-written record read by Claude Code's registry scan would be
        # dropped as unparseable, so it lands via a rename.
        rec_path = os.path.join(self.tmp, "sessions", f"{os.getpid()}.json")
        peer_inbox._write_peer_record("/s/cc-socks/1.sock", rec_path,
                                      "cs-1", "n", "/w")
        peer_inbox._write_peer_record("/s/cc-socks/1.sock", rec_path,
                                      "cs-2", "n", "/w")
        self.assertEqual(os.listdir(os.path.dirname(rec_path)),
                         [os.path.basename(rec_path)])   # no .tmp left behind


class PeerInboxReceiveTest(unittest.TestCase):
    """The inbound half, driven over a REAL UNIX socket rather than a mock —
    the wire shape is Claude Code's, and a fake would only assert our belief
    about it."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="qwen-peer-recv-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.peer_dir = os.path.join(self.tmp, "qwen-peer")

    def _deliver(self, payload, claude_sid="cs-1", sid="q1"):
        """Run one connection through _handle_connection over a real socket.
        Each call binds its OWN path — a test that delivers several payloads
        would otherwise hit EADDRINUSE on the second bind."""
        self._sock_seq = getattr(self, "_sock_seq", 0) + 1
        sock_path = os.path.join(self.tmp, f"in-{self._sock_seq}.sock")
        srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        srv.bind(sock_path)
        srv.listen(1)
        self.addCleanup(srv.close)

        def send():
            c = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            c.connect(sock_path)
            c.sendall(payload)
            c.close()

        t = threading.Thread(target=send)
        t.start()
        conn, _ = srv.accept()
        peer_inbox._handle_connection(conn, claude_sid, self.peer_dir, sid)
        t.join()

    def _received(self, sid="q1"):
        d = os.path.join(self.peer_dir, sid)
        out = []
        for name in sorted(os.listdir(d)) if os.path.isdir(d) else []:
            with open(os.path.join(d, name)) as f:
                out.append((name, json.load(f)))
        return out

    def test_a_native_peer_message_is_written_as_a_recv_file(self):
        self._deliver(json.dumps({
            "session_id": "cs-1", "from": "host-Repo-A",
            "message": {"content": "heads up"}}).encode() + b"\n")
        got = self._received()
        self.assertEqual(len(got), 1)
        name, data = got[0]
        # The "recv-" prefix is what tells the hub this is INBOUND rather than
        # a send request (_poll_qwen_peer_dir keys on exactly that).
        self.assertTrue(name.startswith("recv-"))
        self.assertEqual(data, {"from": "host-Repo-A", "text": "heads up"})

    def test_a_plain_string_message_body_is_accepted(self):
        self._deliver(json.dumps({"session_id": "cs-1", "from": "b",
                                  "message": "plain"}).encode() + b"\n")
        self.assertEqual(self._received()[0][1]["text"], "plain")

    def test_a_message_for_another_session_id_is_refused(self):
        # A recycled pid can leave this process holding a socket a peer still
        # believes belongs to a DIFFERENT conversation; the wire session_id is
        # what rejects that.
        self._deliver(json.dumps({"session_id": "someone-else", "from": "a",
                                  "message": {"content": "not yours"}}).encode()
                      + b"\n")
        self.assertEqual(self._received(), [])

    def test_an_absent_sender_falls_back_to_a_peer(self):
        self._deliver(json.dumps({"session_id": "cs-1",
                                  "message": {"content": "anon"}}).encode() + b"\n")
        self.assertEqual(self._received()[0][1]["from"], "a peer")

    def test_junk_and_empty_bodies_write_nothing(self):
        for payload in (b"not json\n",
                        b"\n",
                        json.dumps({"session_id": "cs-1",
                                    "message": {"content": "   "}}).encode() + b"\n",
                        json.dumps(["a", "list"]).encode() + b"\n"):
            self._deliver(payload)
        self.assertEqual(self._received(), [])

    def test_an_oversized_line_is_dropped_rather_than_buffered(self):
        # The read is bounded (LINE_MAX_BYTES) so a peer streaming without a
        # newline cannot grow this process's memory without limit.
        self._deliver(b"x" * (peer_inbox.LINE_MAX_BYTES + 1024))
        self.assertEqual(self._received(), [])

    def test_a_connection_that_sends_nothing_is_handled(self):
        self._deliver(b"")     # must not raise or hang
        self.assertEqual(self._received(), [])


if __name__ == "__main__":
    unittest.main()

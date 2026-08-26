#!/usr/bin/env python3
"""Tests for agent/dsh_session.py (XERK-467 [C]) — the hub-agent side of a dsh
session: the control-socket client (DshControl) driven against a fake plugin
socket server, and the projection tail (DshProjectionTail) driven against a real
dsh event fixture through the real [S1] projector. No mocks of the seam itself:
DshControl talks to a genuine UNIX socket, DshProjectionTail runs the shipped
DshProjector."""

import importlib.util
import json
import os
import socket
import sys
import tempfile
import threading
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
AGENT_DIR = os.path.dirname(HERE)
if AGENT_DIR not in sys.path:
    sys.path.insert(0, AGENT_DIR)


def _load(name, filename):
    spec = importlib.util.spec_from_file_location(
        name, os.path.join(AGENT_DIR, filename))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


ds = _load("dsh_session", "dsh_session.py")


class FakePlugin:
    """A minimal control-socket SERVER mimicking the driver plugin: it binds the
    socket, acks input/answer/kill, answers `state` with a snapshot, and can push
    unsolicited interaction / state / interaction_end events."""

    def __init__(self, sock_path):
        self.sock_path = sock_path
        self.received = []
        self._srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            os.unlink(sock_path)
        except OSError:
            pass
        self._srv.bind(sock_path)
        self._srv.listen(1)
        self._conn = None
        self.ack = True                       # flip to False to test no-ack
        self._t = threading.Thread(target=self._accept, daemon=True)
        self._t.start()

    def _accept(self):
        try:
            self._conn, _ = self._srv.accept()
        except OSError:
            return
        buf = b""
        while True:
            try:
                chunk = self._conn.recv(4096)
            except OSError:
                break
            if not chunk:
                break
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                line = line.strip()
                if line:
                    self._handle(line)

    def _handle(self, line):
        try:
            msg = json.loads(line.decode())
        except ValueError:
            return
        self.received.append(msg)
        if not self.ack:
            return
        if msg.get("op") == "state":
            self.push({"ok": True, "status": "running", "eventCount": 3,
                       "pendingInteraction": False})
        else:
            self.push({"ok": True})

    def push(self, obj):
        if self._conn:
            try:
                self._conn.sendall((json.dumps(obj) + "\n").encode())
            except OSError:
                pass

    def close(self):
        for s in (self._conn, self._srv):
            try:
                if s:
                    s.close()
            except OSError:
                pass
        try:
            os.unlink(self.sock_path)
        except OSError:
            pass


class DshControlTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.sock = os.path.join(self.tmp, "s.sock")
        self.plugin = FakePlugin(self.sock)
        self.events = []
        self.ends = []
        self.states = []
        self.ctl = ds.DshControl(
            self.sock,
            on_interaction=self.events.append,
            on_state=self.states.append,
            on_interaction_end=self.ends.append,
            log=lambda m: None)
        self.assertTrue(self.ctl.start(), "control should connect to the plugin")
        # A round-trip guarantees the plugin's accept() has set its connection
        # before a test pushes an unsolicited event (else the push races the
        # accept and is dropped).
        self.assertIsNotNone(self.ctl.state())
        self.plugin.received.clear()

    def tearDown(self):
        self.ctl.close()
        self.plugin.close()

    def _wait(self, pred, timeout=3):
        end = time.time() + timeout
        while time.time() < end:
            if pred():
                return True
            time.sleep(0.02)
        return False

    def test_input_frame_carries_source_and_text(self):
        self.assertTrue(self.ctl.input("hello", kind="user"))
        self.assertTrue(self._wait(lambda: self.plugin.received))
        f = self.plugin.received[-1]
        self.assertEqual(f["op"], "input")
        self.assertEqual(f["text"], "hello")
        self.assertEqual(f["source"]["kind"], "user")

    def test_machine_source_kind(self):
        self.assertTrue(self.ctl.input("nudge", kind="machine"))
        self.assertTrue(self._wait(lambda: self.plugin.received))
        self.assertEqual(self.plugin.received[-1]["source"]["kind"], "machine")

    def test_answer_frame_indices(self):
        self.assertTrue(self.ctl.answer("r1", option_index=0))
        self.assertTrue(self._wait(lambda: self.plugin.received))
        f = self.plugin.received[-1]
        self.assertEqual(f["op"], "answer")
        self.assertEqual(f["requestId"], "r1")
        self.assertEqual(f["optionIndex"], 0)

    def test_answer_multi_and_text(self):
        self.assertTrue(self.ctl.answer("r2", option_indices=[1, 2], text="other"))
        self.assertTrue(self._wait(lambda: self.plugin.received))
        f = self.plugin.received[-1]
        self.assertEqual(f["optionIndices"], [1, 2])
        self.assertEqual(f["text"], "other")

    def test_state_snapshot(self):
        st = self.ctl.state()
        self.assertIsNotNone(st)
        self.assertEqual(st["status"], "running")
        self.assertEqual(st["eventCount"], 3)

    def test_kill_ack(self):
        self.assertTrue(self.ctl.kill())

    def test_interaction_event_dispatched(self):
        self.plugin.push({"evt": "interaction", "requestId": "q1",
                          "kind": "question", "prompt": "Pick one",
                          "options": [{"number": 1, "label": "A"}]})
        self.assertTrue(self._wait(lambda: self.events))
        self.assertEqual(self.events[-1]["requestId"], "q1")
        self.assertEqual(self.events[-1]["kind"], "question")

    def test_state_event_dispatched(self):
        self.plugin.push({"evt": "state", "status": "running", "eventCount": 5})
        self.assertTrue(self._wait(lambda: self.states))
        self.assertEqual(self.states[-1]["status"], "running")

    def test_interaction_end_dispatched(self):
        self.plugin.push({"evt": "interaction_end", "requestId": "q1"})
        self.assertTrue(self._wait(lambda: self.ends))
        self.assertEqual(self.ends[-1]["requestId"], "q1")

    def test_no_ack_returns_false_and_never_raises(self):
        self.plugin.ack = False
        orig = ds.DSH_ACK_TIMEOUT_SEC
        ds.DSH_ACK_TIMEOUT_SEC = 0.3
        try:
            self.assertFalse(self.ctl.input("hi", kind="user"))
        finally:
            ds.DSH_ACK_TIMEOUT_SEC = orig


class DshProjectionTailTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.events_path = os.path.join(self.tmp, "events.jsonl")
        self.transcript = os.path.join(self.tmp, "proj.jsonl")
        open(self.events_path, "w").close()
        self.tail = ds.DshProjectionTail(
            self.events_path, self.transcript, "sid-1",
            cwd="/work", log=lambda m: None)

    def tearDown(self):
        self.tail.stop()

    def _append_event(self, ev):
        with open(self.events_path, "a") as f:
            f.write(json.dumps(ev) + "\n")

    def _read_transcript(self):
        try:
            with open(self.transcript) as f:
                return [json.loads(l) for l in f if l.strip()]
        except OSError:
            return []

    def test_user_message_projects_incrementally(self):
        self.tail.start()
        self._append_event({
            "type": "user/message", "seq": 1, "time": 1_700_000_000_000,
            "data": {"content": [{"type": "text", "text": "hi dsh"}]}})
        self.tail.poke()
        end = time.time() + 3
        entries = []
        while time.time() < end:
            entries = self._read_transcript()
            if entries:
                break
            time.sleep(0.02)
        self.assertTrue(entries, "the user message should project to a transcript entry")
        e = entries[-1]
        self.assertEqual(e["type"], "user")
        self.assertEqual(e["message"]["content"][0]["text"], "hi dsh")
        self.assertEqual(e["sessionId"], "sid-1")

    def test_non_surface_event_projects_nothing(self):
        self.tail.start()
        self._append_event({"type": "turn/start", "seq": 1,
                            "time": 1_700_000_000_000, "data": {}})
        time.sleep(0.4)
        self.assertEqual(self._read_transcript(), [])


if __name__ == "__main__":
    unittest.main()

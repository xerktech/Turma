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
ha = _load("hub_agent", "hub-agent.py")


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
        self.peer_sends = []
        self.peer_inbound = []
        self.ctl = ds.DshControl(
            self.sock,
            on_interaction=self.events.append,
            on_state=self.states.append,
            on_interaction_end=self.ends.append,
            on_peer_send=self.peer_sends.append,
            on_peer_inbound=self.peer_inbound.append,
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

    def test_peer_send_event_dispatched(self):
        # A dsh session's send_message tool emits peer_send; it must reach the
        # on_peer_send callback, not be mistaken for an ack (XERK-476).
        self.plugin.push({"evt": "peer_send", "name": "k8x-Repo-XERK-1",
                          "text": "check foo.py"})
        self.assertTrue(self._wait(lambda: self.peer_sends))
        self.assertEqual(self.peer_sends[-1]["name"], "k8x-Repo-XERK-1")
        self.assertEqual(self.peer_sends[-1]["text"], "check foo.py")
        self.assertEqual(self.peer_inbound, [])

    def test_peer_inbound_event_dispatched(self):
        self.plugin.push({"evt": "peer_inbound", "from": "k8x-Repo-XERK-2",
                          "text": "heads up"})
        self.assertTrue(self._wait(lambda: self.peer_inbound))
        self.assertEqual(self.peer_inbound[-1]["from"], "k8x-Repo-XERK-2")
        self.assertEqual(self.peer_inbound[-1]["text"], "heads up")
        self.assertEqual(self.peer_sends, [])

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

    def test_resume_starts_past_already_projected_history(self):
        """On RESUME the kept event log's history is ALREADY in the transcript
        (projected before the restart / on the migration source), and dsh does
        NOT re-emit seeded events — so a resumed tail must start at the log's EOF
        and project only NEW events, or it DOUBLES the transcript (XERK-475)."""
        # A pre-existing event, as if projected before a restart.
        self._append_event({
            "type": "user/message", "seq": 1, "time": 1_700_000_000_000,
            "data": {"content": [{"type": "text", "text": "old turn"}]}})
        # A resumed tail: offset starts at the log's current size, so pumping
        # projects nothing from the history.
        resumed = ds.DshProjectionTail(
            self.events_path, self.transcript, "sid-1",
            cwd="/work", log=lambda m: None, resume=True)
        self.addCleanup(resumed.stop)
        resumed._pump()
        self.assertEqual(self._read_transcript(), [],
                         "resume must not re-project the kept history")
        # A NEW event after resume DOES project.
        self._append_event({
            "type": "user/message", "seq": 2, "time": 1_700_000_000_001,
            "data": {"content": [{"type": "text", "text": "new turn"}]}})
        resumed._pump()
        entries = self._read_transcript()
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["message"]["content"][0]["text"], "new turn")

    def test_fresh_tail_projects_the_whole_log_from_zero(self):
        # The contrast: a non-resume tail starts at 0 and projects existing
        # events (a fresh launch truncates the log, so this never doubles).
        self._append_event({
            "type": "user/message", "seq": 1, "time": 1_700_000_000_000,
            "data": {"content": [{"type": "text", "text": "from zero"}]}})
        fresh = ds.DshProjectionTail(
            self.events_path, self.transcript, "sid-1",
            cwd="/work", log=lambda m: None, resume=False)
        self.addCleanup(fresh.stop)
        fresh._pump()
        entries = self._read_transcript()
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["message"]["content"][0]["text"], "from zero")

    def test_captures_dsh_auto_title_from_session_title_event(self):
        # dsh writes the session's auto-generated title as a `session/title`
        # event; the tail captures data.title so hub-agent's _seed_summaries can
        # name the session from dsh's own title. It is log-only (projects to no
        # transcript entry) — capture is in the tail, not the projection.
        self._append_event({
            "type": "session/title", "seq": 1, "time": 1_700_000_000_000,
            "data": {"title": "Adding Compose Flag", "source": {"kind": "auto"},
                     "messageSeqs": [1]}})
        self.tail._pump()
        self.assertEqual(self.tail.title(), "Adding Compose Flag")
        self.assertEqual(self._read_transcript(), [],  # log-only, not an entry
                         "a title is not a transcript entry")

    def test_title_is_None_until_an_event_and_latest_wins(self):
        self.assertIsNone(self.tail.title())
        self._append_event({
            "type": "session/title", "seq": 2, "time": 1_700_000_000_001,
            "data": {"title": "First", "source": {"kind": "auto"},
                     "messageSeqs": [1]}})
        self._append_event({
            "type": "session/title", "seq": 3, "time": 1_700_000_000_002,
            "data": {"title": "Second", "source": {"kind": "user"},
                     "messageSeqs": []}})
        self.tail._pump()
        self.assertEqual(self.tail.title(), "Second")  # latest event wins

    def test_blank_or_malformed_title_is_ignored(self):
        self._append_event({"type": "session/title", "seq": 1,
                            "time": 1_700_000_000_000, "data": {"title": "   "}})
        self._append_event({"type": "not-even-a-dict"})
        self.tail._pump()
        self.assertIsNone(self.tail.title())

    def test_title_final_distinguishes_fallback_from_generated(self):
        # dsh writes a crude `source.kind=="fallback"` title the instant the first
        # turn starts, then the real `source.kind=="provider"` one once its
        # title-llm returns. title_final() lets _seed_summaries name the card from
        # the fallback only provisionally and still override it with the generated
        # title — the fix for 'the generated title is never pulled'.
        self._append_event({
            "type": "session/title", "seq": 1, "time": 1_700_000_000_000,
            "data": {"title": "add a compose flag to",
                     "source": {"kind": "fallback"}, "messageSeqs": [1]}})
        self.tail._pump()
        self.assertEqual(self.tail.title(), "add a compose flag to")
        self.assertFalse(self.tail.title_final())  # fallback is provisional
        self._append_event({
            "type": "session/title", "seq": 5, "time": 1_700_000_000_001,
            "data": {"title": "Add Compose Flag to Widget",
                     "source": {"kind": "provider"}, "messageSeqs": [1]}})
        self.tail._pump()
        self.assertEqual(self.tail.title(), "Add Compose Flag to Widget")
        self.assertTrue(self.tail.title_final())  # generated title is authoritative

    def test_title_with_no_source_reads_as_final(self):
        # A `session/title` with no readable source is treated as final (not the
        # provisional fallback), so an unusual dsh build still names the session.
        self._append_event({
            "type": "session/title", "seq": 1, "time": 1_700_000_000_000,
            "data": {"title": "Some Title", "messageSeqs": [1]}})
        self.tail._pump()
        self.assertEqual(self.tail.title(), "Some Title")
        self.assertTrue(self.tail.title_final())


class DshDelegationTailTest(unittest.TestCase):
    """XERK-474 [J]: the tail turns a dsh session's delegation events + captured
    child logs into the Claude-Code subagents/ + workflows/ layout hub-agent's
    pickers resolve. Drives `_pump()` synchronously for determinism."""

    SID = "sess-11112222"

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        slug = os.path.join(self.tmp, "projects", "-repos-x")
        self.store = os.path.join(slug, self.SID, "dsh")
        self.child_dir = os.path.join(self.store, "subagents")
        os.makedirs(self.child_dir, exist_ok=True)
        self.events_path = os.path.join(self.store, "events.jsonl")
        open(self.events_path, "w").close()
        self.transcript = os.path.join(slug, self.SID + ".jsonl")
        os.makedirs(slug, exist_ok=True)
        open(self.transcript, "a").close()
        self.tail = ds.DshProjectionTail(
            self.events_path, self.transcript, self.SID,
            cwd="/repos/x", log=lambda m: None)

    def _parent(self, events):
        with open(self.events_path, "w") as f:
            for e in events:
                f.write(json.dumps(e) + "\n")

    def _child(self, child_id, prompt="do it", answer="done"):
        with open(os.path.join(self.child_dir, child_id + ".jsonl"), "w") as f:
            f.write(json.dumps({"type": "subagent/descriptor", "seq": 1, "time": 1,
                    "data": {"version": 2, "mode": "one-shot", "label": "L"}}) + "\n")
            f.write(json.dumps({"type": "user/message", "seq": 2, "time": 2, "data": {
                "role": "user", "source": {"kind": "user"},
                "content": [{"type": "text", "text": prompt}]}}) + "\n")
            f.write(json.dumps({"type": "assistant/message", "seq": 3, "time": 3, "data": {
                "message": {"id": "c", "role": "assistant", "source": {"model": "m"},
                            "content": [{"type": "text", "text": answer}]},
                "usage": {"inputTokens": 10, "outputTokens": 5}}}) + "\n")

    def _read(self, path):
        try:
            with open(path) as f:
                return [json.loads(x) for x in f if x.strip()]
        except OSError:
            return []

    def test_ordinary_subagent_transcript_resolves(self):
        child = "a1b2c3d4-9999"
        self._parent([
            {"type": "turma/subagent-start", "seq": "sa-start-r", "time": 1000,
             "data": {"runId": "r", "childId": child, "label": "Investigate"}},
            {"type": "turma/subagent-end", "seq": "sa-end-r", "time": 9000,
             "data": {"runId": "r", "childId": child, "stopReason": "completed"}},
        ])
        self._child(child)
        self.tail._pump()
        # the flat transcript exists and resolves
        path = ha._resolve_subagent(self.transcript, "subagent", "Investigate")
        self.assertTrue(path and os.path.basename(path) == "agent-%s.jsonl" % child)
        self.assertGreaterEqual(len(self._read(path)), 2)

    def test_workflow_run_picker_and_agent_transcripts(self):
        run = "7c9e6679-7425-40de-944b-e07fc1f90ae7"
        c1, c2 = "wfchild-a", "wfchild-b"
        self._parent([
            {"type": "tool-workflow/run-start", "seq": 2, "time": 1000,
             "data": {"runId": run, "name": "review"}},
            {"type": "tool-workflow/agent-start", "seq": 3, "time": 1100,
             "data": {"runId": run, "seq": 1, "label": "review:bugs", "childId": c1}},
            {"type": "tool-workflow/agent-start", "seq": 4, "time": 1200,
             "data": {"runId": run, "seq": 2, "label": "review:perf", "childId": c2}},
            {"type": "tool-workflow/agent-end", "seq": 5, "time": 2000,
             "data": {"runId": run, "seq": 1, "outcome": "completed"}},
            {"type": "tool-workflow/run-end", "seq": 6, "time": 3000,
             "data": {"runId": run, "stopReason": "completed"}},
        ])
        self._child(c1, answer="found bugs")
        self._child(c2, answer="perf ok")
        self.tail._pump()
        claude_run = ds.workflow_run_id(run)
        run_dir = ha._resolve_workflow_run(self.transcript, "review")
        self.assertTrue(run_dir and os.path.basename(run_dir) == claude_run)
        record = ha._workflow_run_record(self.transcript, claude_run)
        agents, _ = ha._workflow_agents(run_dir, record)
        self.assertEqual({a["label"] for a in agents}, {"review:bugs", "review:perf"})
        by_id = {a["id"]: a for a in agents}
        self.assertEqual(by_id[c1]["status"], "done")
        self.assertEqual(by_id[c2]["status"], "running")
        # drill into one agent's transcript
        p = ha._workflow_agent_path(run_dir, c1)
        self.assertTrue(p and os.path.isfile(p))
        self.assertGreaterEqual(len(self._read(p)), 2)

    def test_workflow_agent_is_not_a_top_level_subagent_row(self):
        # A workflow agent reaches the tail through the subagent seam too, so the
        # driver forwards a `turma/subagent-*` for it — but it belongs to the run,
        # so the tail drops that edge from the parent transcript. The parent log
        # here has the agent-start FIRST (the driver's setImmediate ordering).
        run = "7c9e6679-7425-40de-944b-e07fc1f90ae7"
        child = "wfchild-a"
        self._parent([
            {"type": "tool-workflow/run-start", "seq": 2, "time": 1000,
             "data": {"runId": run, "name": "review"}},
            {"type": "tool-workflow/agent-start", "seq": 3, "time": 1100,
             "data": {"runId": run, "seq": 1, "label": "review:bugs", "childId": child}},
            {"type": "turma/subagent-start", "seq": "sa-start-x", "time": 1150,
             "data": {"runId": "x", "childId": child, "label": "review:bugs"}},
        ])
        self.tail._pump()
        state = {}
        for e in self._read(self.transcript):
            ha._scan_agent_entry(e, state)
        # only the WORKFLOW row is live — no separate `subagent`-typed row for the
        # workflow agent
        live = state.get("liveAgents", {})
        self.assertIn(ds.workflow_run_id(run), live)
        self.assertNotIn(child, live)
        self.assertTrue(all(v["type"] != "subagent" for v in live.values()), live)

    def test_workflow_child_launched_before_its_run_is_reclaimed(self):
        # The reversed order the driver's setImmediate makes unlikely: the child's
        # `turma/subagent-start` lands BEFORE its `tool-workflow/agent-start`. The
        # tail cannot suppress the launch (it does not yet know the child is a
        # workflow agent), so a top-level row appears — but the moment the run
        # claims the child, it is RETIRED, so no permanent phantom lingers (its own
        # `subagent-end` would be suppressed as a workflow edge). Independent of
        # file order — the defect QA (F1) flagged.
        run = "7c9e6679-7425-40de-944b-e07fc1f90ae7"
        child = "wfchild-a"
        self._parent([
            {"type": "tool-workflow/run-start", "seq": 2, "time": 1000,
             "data": {"runId": run, "name": "review"}},
            {"type": "turma/subagent-start", "seq": "sa-start-x", "time": 1100,
             "data": {"runId": "x", "childId": child, "label": "review:bugs"}},
            {"type": "tool-workflow/agent-start", "seq": 3, "time": 1200,
             "data": {"runId": run, "seq": 1, "label": "review:bugs", "childId": child}},
            {"type": "turma/subagent-end", "seq": "sa-end-x", "time": 1300,
             "data": {"runId": "x", "childId": child, "stopReason": "completed"}},
        ])
        self.tail._pump()
        state = {}
        for e in self._read(self.transcript):
            ha._scan_agent_entry(e, state)
        live = state.get("liveAgents", {})
        self.assertNotIn(child, live, "the phantom workflow-child row must be retired")
        self.assertIn(ds.workflow_run_id(run), live)

    def test_flat_child_is_moved_when_its_run_arrives_late(self):
        # The child log starts before the parent `tool-workflow/agent-start` is
        # seen (a real race): first pump files it flat, the second — after the
        # agent-start — moves it under the run dir.
        run = "7c9e6679-7425-40de-944b-e07fc1f90ae7"
        child = "wfchild-late"
        self._parent([{"type": "tool-workflow/run-start", "seq": 2, "time": 1000,
                       "data": {"runId": run, "name": "review"}}])
        self._child(child, answer="early work")
        self.tail._pump()
        flat = os.path.join(self.transcript[:-len(".jsonl")], "subagents",
                            "agent-%s.jsonl" % child)
        self.assertTrue(os.path.isfile(flat), "filed flat before its run is known")
        # now the agent-start arrives
        with open(self.events_path, "a") as f:
            f.write(json.dumps({"type": "tool-workflow/agent-start", "seq": 3,
                    "time": 1100, "data": {"runId": run, "seq": 1,
                    "label": "review:bugs", "childId": child}}) + "\n")
        self.tail._pump()
        moved = os.path.join(self.transcript[:-len(".jsonl")], "subagents",
                             "workflows", ds.workflow_run_id(run),
                             "agent-%s.jsonl" % child)
        self.assertTrue(os.path.isfile(moved), "moved under the run dir")
        self.assertFalse(os.path.isfile(flat), "flat copy removed")

    def test_emitted_launches_is_bounded_by_ended_subagents(self):
        # An ordinary subagent's end retires it and drops it from the reclaim
        # tracking set, so the set tracks only IN-FLIGHT launches — it does not
        # grow one entry per subagent for the life of the session.
        events = []
        for i in range(50):
            cid = "sub-%08d" % i
            events.append({"type": "turma/subagent-start", "seq": "s%d" % i,
                           "time": 1000 + i, "data": {"childId": cid, "label": "l"}})
            events.append({"type": "turma/subagent-end", "seq": "e%d" % i,
                           "time": 2000 + i, "data": {"childId": cid, "stopReason": "completed"}})
        self._parent(events)
        self.tail._pump()
        self.assertEqual(self.tail._emitted_launches, set(),
                         "every launched-then-ended subagent should be dropped")

    def test_symlinked_child_log_is_refused(self):
        # A child "log" that is a symlink would drag whatever it points at into a
        # session's transcript tree — refused, like every other transcript walk.
        victim = os.path.join(self.tmp, "victim.jsonl")
        with open(victim, "w") as f:
            f.write(json.dumps({"type": "user/message", "seq": 1, "time": 1, "data": {
                "content": [{"type": "text", "text": "secret"}]}}) + "\n")
        link = os.path.join(self.child_dir, "b0b0b0b0.jsonl")
        os.symlink(victim, link)
        self._parent([{"type": "user/message", "seq": 1, "time": 1000,
                       "data": {"content": [{"type": "text", "text": "hi"}]}}])
        self.tail._pump()
        dest = os.path.join(self.transcript[:-len(".jsonl")], "subagents",
                            "agent-b0b0b0b0.jsonl")
        self.assertFalse(os.path.exists(dest))


if __name__ == "__main__":
    unittest.main()

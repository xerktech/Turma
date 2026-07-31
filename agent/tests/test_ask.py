#!/usr/bin/env python3
"""Tests for the AskUserQuestion bridge hook (agent/hooks/ask.py).

The hook is invoked by claude as a PreToolUse command: it reads the tool call
on stdin, publishes each question as a request file under $TURMA_QUESTIONS_DIR,
blocks for the answer file the agent drops there, and finally emits a deny with
the collected answers. Here we drive main() directly with a patched
stdin/stdout and a background thread that plays the agent (writing answers).
"""

import importlib.util
import io
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

AGENT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODULE_PATH = os.path.join(AGENT_DIR, "hooks", "ask.py")

spec = importlib.util.spec_from_file_location("ask_hook", MODULE_PATH)
ask = importlib.util.module_from_spec(spec)
sys.modules["ask_hook"] = ask
spec.loader.exec_module(ask)


def run_main(stdin_text, env):
    """Run ask.main() with a fake stdin + captured stdout under env overrides.
    Returns (exit_code, stdout_text)."""
    out = io.StringIO()
    with mock.patch.object(sys, "stdin", io.StringIO(stdin_text)), \
         mock.patch.object(sys, "stdout", out), \
         mock.patch.dict(os.environ, env, clear=False):
        rc = ask.main()
    return rc, out.getvalue()


def ask_event(questions):
    return json.dumps({"tool_name": "AskUserQuestion",
                       "tool_input": {"questions": questions}})


class AskHookTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ask-hook-test-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.sid = "sess-1"
        self.env = {
            "TURMA_SESSION_ID": self.sid,
            "TURMA_QUESTIONS_DIR": self.tmp,
            "TURMA_QUESTION_TIMEOUT_SEC": "5",
        }
        self.req = os.path.join(self.tmp, f"{self.sid}.req.json")
        self.ans = os.path.join(self.tmp, f"{self.sid}.ans.json")

    def _answer_when_asked(self, answer, timeout=4.0):
        """Background thread: wait for the req file, then drop `answer`."""
        def worker():
            deadline = time.time() + timeout
            while time.time() < deadline:
                if os.path.exists(self.req):
                    tmp = self.ans + ".tmp"
                    with open(tmp, "w") as f:
                        json.dump(answer, f)
                    os.replace(tmp, self.ans)
                    return
                time.sleep(0.02)
        t = threading.Thread(target=worker)
        t.start()
        self.addCleanup(t.join)
        return t

    def _decision(self, stdout):
        return json.loads(stdout)["hookSpecificOutput"]

    # ---- pass-through cases -------------------------------------------------

    def test_no_env_passes_through(self):
        rc, out = run_main(ask_event([{"question": "q", "options": []}]),
                           {"TURMA_SESSION_ID": "", "TURMA_QUESTIONS_DIR": ""})
        self.assertEqual(rc, 0)
        self.assertEqual(out, "")  # no opinion -> claude's own flow

    def test_non_askuserquestion_passes_through(self):
        event = json.dumps({"tool_name": "Bash", "tool_input": {"command": "ls"}})
        rc, out = run_main(event, self.env)
        self.assertEqual(out, "")

    def test_empty_questions_passes_through(self):
        rc, out = run_main(ask_event([]), self.env)
        self.assertEqual(out, "")

    def test_malformed_stdin_passes_through(self):
        rc, out = run_main("{not json", self.env)
        self.assertEqual(rc, 0)
        self.assertEqual(out, "")

    # ---- answered round-trip ------------------------------------------------

    def test_option_pick_round_trip(self):
        self._answer_when_asked({"optionIndex": 1})
        rc, out = run_main(
            ask_event([{"question": "Which direction?",
                        "options": [{"label": "Turma"}, {"label": "Tutela"}]}]),
            self.env,
        )
        dec = self._decision(out)
        self.assertEqual(dec["permissionDecision"], "deny")
        payload = json.loads(dec["permissionDecisionReason"])
        self.assertEqual(payload["kind"], "askuserquestion_answers")
        self.assertEqual(payload["answers"], [{
            "question": "Which direction?", "optionIndex": 1,
            "label": "Tutela", "custom": None,
        }])
        # Rendezvous files are consumed.
        self.assertFalse(os.path.exists(self.req))
        self.assertFalse(os.path.exists(self.ans))

    def test_free_text_answer_round_trip(self):
        self._answer_when_asked({"optionIndex": -1, "custom": "something else"})
        rc, out = run_main(
            ask_event([{"question": "Pick", "options": [{"label": "a"}],
                        "allowOther": True}]),
            self.env,
        )
        payload = json.loads(self._decision(out)["permissionDecisionReason"])
        self.assertEqual(payload["answers"][0]["optionIndex"], -1)
        self.assertEqual(payload["answers"][0]["custom"], "something else")
        self.assertIsNone(payload["answers"][0]["label"])

    def test_request_file_carries_question_shape(self):
        captured = {}

        def worker():
            deadline = time.time() + 4.0
            while time.time() < deadline:
                if os.path.exists(self.req):
                    with open(self.req) as f:
                        captured.update(json.load(f))
                    with open(self.ans, "w") as f:
                        json.dump({"optionIndex": 0}, f)
                    return
                time.sleep(0.02)
        t = threading.Thread(target=worker)
        t.start()
        self.addCleanup(t.join)
        run_main(
            ask_event([{"question": "Deploy?", "header": "Deploy target here",
                        "options": ["yes", {"label": "no", "description": "wait"}],
                        "multiSelect": True, "allowOther": True}]),
            self.env,
        )
        self.assertEqual(captured["question"], "Deploy?")
        self.assertEqual(captured["header"], "Deploy targe")  # capped at 12 chars
        self.assertTrue(captured["multiSelect"])
        self.assertTrue(captured["allowOther"])
        self.assertEqual(captured["options"],
                         [{"label": "yes"}, {"label": "no", "description": "wait"}])

    def test_request_file_carries_option_preview(self):
        captured = {}

        def worker():
            deadline = time.time() + 4.0
            while time.time() < deadline:
                if os.path.exists(self.req):
                    with open(self.req) as f:
                        captured.update(json.load(f))
                    with open(self.ans, "w") as f:
                        json.dump({"optionIndex": 0}, f)
                    return
                time.sleep(0.02)
        t = threading.Thread(target=worker)
        t.start()
        self.addCleanup(t.join)
        run_main(
            ask_event([{"question": "Pick", "options": [
                {"label": "a", "description": "d", "preview": "mock preview"},
            ]}]),
            self.env,
        )
        self.assertEqual(captured["options"],
                         [{"label": "a", "description": "d", "preview": "mock preview"}])

    def test_multi_select_round_trip(self):
        # A multiSelect answer sends optionIndices; the record carries the list
        # of labels rather than a single label.
        self._answer_when_asked({"optionIndices": [0, 2]})
        rc, out = run_main(
            ask_event([{"question": "Which features?", "multiSelect": True,
                        "options": [{"label": "A"}, {"label": "B"}, {"label": "C"}]}]),
            self.env,
        )
        payload = json.loads(self._decision(out)["permissionDecisionReason"])
        ans = payload["answers"][0]
        self.assertEqual(ans["optionIndices"], [0, 2])
        self.assertEqual(ans["labels"], ["A", "C"])
        self.assertNotIn("optionIndex", ans)

    def test_timeout_denies_with_marker(self):
        # No answering thread: the hook self-times-out and reports a no-answer.
        self.env["TURMA_QUESTION_TIMEOUT_SEC"] = "0.3"
        rc, out = run_main(
            ask_event([{"question": "q", "options": [{"label": "a"}]}]),
            self.env,
        )
        payload = json.loads(self._decision(out)["permissionDecisionReason"])
        self.assertEqual(payload["answers"][0]["optionIndex"], -1)
        self.assertEqual(payload["answers"][0]["custom"], "__hook_timeout__")
        # Stale request file cleaned up so it can't surface as a phantom.
        self.assertFalse(os.path.exists(self.req))

    def test_multiple_questions_sequenced(self):
        # Answer each question in turn: the req file is re-published per question,
        # so a single answering worker that loops handles both.
        answers = [{"optionIndex": 0}, {"optionIndex": 1}]
        state = {"n": 0}

        def worker():
            deadline = time.time() + 4.0
            while time.time() < deadline and state["n"] < len(answers):
                if os.path.exists(self.req) and not os.path.exists(self.ans):
                    with open(self.ans, "w") as f:
                        json.dump(answers[state["n"]], f)
                    state["n"] += 1
                    # Wait for the hook to consume this answer before looping.
                    while os.path.exists(self.ans) and time.time() < deadline:
                        time.sleep(0.01)
                time.sleep(0.01)
        t = threading.Thread(target=worker)
        t.start()
        self.addCleanup(t.join)
        rc, out = run_main(
            ask_event([
                {"question": "Q1", "options": [{"label": "a"}, {"label": "b"}]},
                {"question": "Q2", "options": [{"label": "c"}, {"label": "d"}]},
            ]),
            self.env,
        )
        payload = json.loads(self._decision(out)["permissionDecisionReason"])
        self.assertEqual([a["label"] for a in payload["answers"]], ["a", "d"])


if __name__ == "__main__":
    unittest.main()

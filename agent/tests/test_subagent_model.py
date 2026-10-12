#!/usr/bin/env python3
"""Tests for the QA/review sub-agent model pin hook (agent/hooks/subagent_model.py,
XERK-1851). Driven through main() with a patched stdin/stdout, and once as the
real `python3 -SI` subprocess Claude Code runs."""

import importlib.util
import io
import json
import os
import subprocess
import sys
import unittest
from unittest import mock

AGENT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODULE_PATH = os.path.join(AGENT_DIR, "hooks", "subagent_model.py")

spec = importlib.util.spec_from_file_location("subagent_model_hook", MODULE_PATH)
hook = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hook)


class _Stdin:
    """A stdin exposing only .buffer, as the hook must read it."""
    def __init__(self, data):
        self.buffer = io.BytesIO(data)


def run_main(event, pin="opus"):
    stdin = event if isinstance(event, (str, bytes)) else json.dumps(event)
    if isinstance(stdin, str):
        stdin = stdin.encode("utf-8")
    env = {"TURMA_PIN_SUBAGENT_MODEL": pin} if pin is not None else {}
    out = io.StringIO()
    with mock.patch.object(sys, "stdin", _Stdin(stdin)), \
            mock.patch.object(sys, "stdout", out), \
            mock.patch.dict(os.environ, env, clear=False):
        if pin is None:
            os.environ.pop("TURMA_PIN_SUBAGENT_MODEL", None)
        rc = hook.main()
    return rc, out.getvalue()


def agent_call(**tool_input):
    return {"hook_event_name": "PreToolUse", "tool_name": "Agent",
            "tool_input": {"description": "d", "prompt": "p", **tool_input}}


class TestSubagentModelPin(unittest.TestCase):
    def updated(self, out):
        body = json.loads(out)["hookSpecificOutput"]
        self.assertEqual(body["hookEventName"], "PreToolUse")
        # No decision: the call still goes through the normal permission flow.
        self.assertNotIn("permissionDecision", body)
        return body["updatedInput"]

    def test_qa_with_no_model_is_pinned(self):
        rc, out = run_main(agent_call(subagent_type="qa"))
        self.assertEqual(rc, 0)
        self.assertEqual(self.updated(out),
                         {"description": "d", "prompt": "p",
                          "subagent_type": "qa", "model": "opus"})

    def test_a_cheaper_model_on_the_call_is_overridden(self):
        # The call's own model beats the definition's frontmatter (measured),
        # so this is the case a pinned qa.md alone could not cover.
        rc, out = run_main(agent_call(subagent_type="qa-delta", model="haiku",
                                      run_in_background=True))
        upd = self.updated(out)
        self.assertEqual(upd["model"], "opus")
        self.assertTrue(upd["run_in_background"])      # other fields kept

    def test_reviewers_are_pinned(self):
        for name in ("code-reviewer", "Review", "security-review", "pr_reviews",
                     "CodeReviewer", "prreview", "peer-reviewing"):
            _, out = run_main(agent_call(subagent_type=name))
            self.assertEqual(self.updated(out)["model"], "opus", name)

    def test_search_and_work_agents_stay_on_the_default(self):
        for name in ("Explore", "general-purpose", "Plan", "qa-helper", None, 3,
                     "ui-preview", "previewer", "Preview"):
            rc, out = run_main(agent_call(subagent_type=name, model="haiku"))
            self.assertEqual((rc, out), (0, ""), name)
        rc, out = run_main(agent_call(prompt="no type"))
        self.assertEqual((rc, out), (0, ""))

    def test_already_on_the_pin_emits_nothing(self):
        self.assertEqual(run_main(agent_call(subagent_type="qa", model="opus")),
                         (0, ""))

    def test_no_pin_in_env_passes_through(self):
        # Local-model sessions and claude run outside Turma carry no pin.
        self.assertEqual(run_main(agent_call(subagent_type="qa"), pin=None), (0, ""))
        self.assertEqual(run_main(agent_call(subagent_type="qa"), pin="  "), (0, ""))

    def test_non_ascii_prompt_round_trips_byte_exact(self):
        # The hook echoes the whole prompt back: reading text stdin on Windows
        # (cp1252) turned "—" into "â€”" (XERK-1851 QA).
        prompt = "Verify the fix — café → ✓ 日本"
        _, out = run_main(agent_call(subagent_type="qa", prompt=prompt))
        self.assertTrue(out.isascii())
        self.assertEqual(self.updated(out)["prompt"], prompt)

    def test_malformed_input_never_blocks(self):
        for bad in ("", "{not json", "[]", '"x"', b"\xff\xfe", json.dumps({"tool_input": []}),
                    json.dumps({"tool_input": None})):
            self.assertEqual(run_main(bad), (0, ""), bad)

    def test_runs_isolated_as_claude_code_invokes_it(self):
        env = dict(os.environ, TURMA_PIN_SUBAGENT_MODEL="opus")
        r = subprocess.run([sys.executable, "-SI", MODULE_PATH], env=env,
                           input=json.dumps(agent_call(subagent_type="qa", model="haiku")),
                           capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.updated(r.stdout)["model"], "opus")


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
"""Tests for the permission-ledger hook (agent/hooks/permlog.py, XERK-1563).

Claude Code runs it on PermissionRequest and PermissionDenied with the event on
stdin; it appends one JSON line to `<dir>/<TURMA_SESSION_ID>.jsonl` and prints
nothing. Driven through main() with a patched stdin/stdout, plus the real
interpreter flags (`-SsE`) once end to end."""

import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

AGENT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODULE_PATH = os.path.join(AGENT_DIR, "hooks", "permlog.py")

spec = importlib.util.spec_from_file_location("permlog_hook", MODULE_PATH)
permlog = importlib.util.module_from_spec(spec)
sys.modules["permlog_hook"] = permlog
spec.loader.exec_module(permlog)


def denied(**extra):
    ev = {"hook_event_name": "PermissionDenied", "tool_name": "Bash",
          "tool_input": {"command": "git push origin feature", "description": "push"},
          "tool_use_id": "toolu_01", "reason": "Pushing to a remote is outside scope"}
    ev.update(extra)
    return ev


def requested(**extra):
    ev = {"hook_event_name": "PermissionRequest", "tool_name": "Bash",
          "tool_input": {"command": "npm test -- --watch=false"},
          "tool_use_id": "toolu_02",
          "permission_suggestions": [{
              "type": "addRules", "behavior": "allow", "destination": "localSettings",
              "rules": [{"toolName": "Bash", "ruleContent": "npm test:*"}]}]}
    ev.update(extra)
    return ev


class PermlogTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="permlog-test-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.dir = os.path.join(self.tmp, "permissions")
        self.sid = "sess-1"
        self.log = os.path.join(self.dir, f"{self.sid}.jsonl")

    def run_main(self, stdin_text, sid=None):
        out = io.StringIO()
        env = {"TURMA_SESSION_ID": self.sid if sid is None else sid}
        with mock.patch.object(sys, "stdin", io.StringIO(stdin_text)), \
             mock.patch.object(sys, "stdout", out), \
             mock.patch.dict(os.environ, env, clear=False):
            rc = permlog.main(["permlog.py", self.dir])
        return rc, out.getvalue()

    def rows(self):
        with open(self.log, encoding="utf-8") as f:
            return [json.loads(line) for line in f if line.strip()]

    # --- event shapes ---------------------------------------------------------

    def test_a_classifier_denial_is_one_line_with_its_reason(self):
        rc, out = self.run_main(json.dumps(denied()))
        self.assertEqual((rc, out), (0, ""))      # records, never decides
        row, = self.rows()
        self.assertEqual(row["event"], "PermissionDenied")
        self.assertEqual(row["toolUseId"], "toolu_01")
        self.assertEqual(row["tool"], "Bash")
        self.assertEqual(row["head"], "git push")      # subcommand CLIs keep it
        self.assertEqual(row["denyReason"], "Pushing to a remote is outside scope")
        self.assertNotIn("rulesMatched", row)
        self.assertIsInstance(row["ts"], int)
        self.assertIn("git push origin feature", row["digest"])

    def test_a_permission_request_carries_the_suggested_rules(self):
        self.run_main(json.dumps(requested()))
        row, = self.rows()
        self.assertEqual(row["event"], "PermissionRequest")
        self.assertEqual(row["head"], "npm test")
        self.assertEqual(row["rulesMatched"], ["Bash(npm test:*)"])
        self.assertNotIn("denyReason", row)

    def test_heads_per_tool(self):
        cases = [
            ("Bash", {"command": "FOO=1 BAR=2 pytest -q tests/"}, "pytest"),
            ("Bash", {"command": "ls -la && rm x"}, "ls"),
            ("Bash", {"command": "git -C x status"}, "git"),   # a flag is not a subcommand
            ("Edit", {"file_path": "/repo/a.py", "old_string": "x"}, "/repo/a.py"),
            ("NotebookEdit", {"notebook_path": "/repo/n.ipynb"}, "/repo/n.ipynb"),
            ("mcp__github__create_issue", {"title": "t"}, "mcp__github__create_issue"),
            ("WebFetch", {"url": "https://Docs.Example.com/a?b"}, "docs.example.com"),
            ("WebSearch", {"query": "q"}, "WebSearch"),
        ]
        for tool, inp, want in cases:
            self.assertEqual(permlog.tool_head(tool, inp), want, (tool, inp))

    def test_every_field_is_bounded(self):
        big = "x" * 100000
        self.run_main(json.dumps(denied(
            tool_name="mcp__" + big, tool_input={"command": big}, reason=big,
            tool_use_id="bad id with spaces")))
        row, = self.rows()
        self.assertLessEqual(len(row["tool"]), permlog.TOOL_MAX)
        self.assertLessEqual(len(row["head"]), permlog.HEAD_MAX)
        self.assertLessEqual(len(row["digest"]), permlog.DIGEST_MAX)
        self.assertLessEqual(len(row["denyReason"]), permlog.REASON_MAX)
        self.assertIsNone(row["toolUseId"])     # not id-shaped: dropped, not kept

    def test_suggested_rules_are_bounded_and_skip_junk(self):
        sugg = [{"rules": [{"toolName": "Bash", "ruleContent": f"c{i}:*"}
                           for i in range(20)]},
                {"rules": "not a list"}, "junk", {"rules": [{"toolName": 7}]}]
        self.assertEqual(len(permlog.suggested_rules(sugg)), permlog.RULES_MAX)
        self.assertEqual(permlog.suggested_rules([{"rules": [{"toolName": "Read"}]}]),
                         ["Read"])

    # --- fails open -----------------------------------------------------------

    def test_fails_open_on_a_malformed_event(self):
        for bad in ("", "not json", "[1, 2]", json.dumps({"hook_event_name": "Stop"}),
                    json.dumps({"hook_event_name": "PermissionDenied"}),
                    "[" * 5000):
            rc, out = self.run_main(bad)
            self.assertEqual((rc, out), (0, ""), bad[:40])
        self.assertFalse(os.path.exists(self.log))

    def test_no_session_is_a_noop(self):
        for sid in ("", "../escape", "a/b"):
            rc, _ = self.run_main(json.dumps(denied()), sid=sid)
            self.assertEqual(rc, 0)
        self.assertFalse(os.path.exists(self.dir))

    def test_a_fifo_or_symlink_at_the_log_path_is_never_written(self):
        os.makedirs(self.dir)
        os.mkfifo(self.log)
        rc, _ = self.run_main(json.dumps(denied()))   # must not hang in open()
        self.assertEqual(rc, 0)
        os.remove(self.log)
        target = os.path.join(self.tmp, "elsewhere")
        os.symlink(target, self.log)
        self.run_main(json.dumps(denied()))
        self.assertFalse(os.path.exists(target))

    def test_an_unwritable_directory_fails_open(self):
        with open(os.path.join(self.tmp, "file"), "w") as f:
            f.write("x")
        self.dir = os.path.join(self.tmp, "file", "sub")   # a FILE in the path
        rc, out = self.run_main(json.dumps(denied()))
        self.assertEqual((rc, out), (0, ""))

    # --- rotation -------------------------------------------------------------

    def test_rotates_past_the_cap_keeping_one_generation(self):
        row = permlog.build_row(denied(), now_ms=1)
        self.assertTrue(permlog.append_row(self.dir, self.sid, row, max_bytes=300))
        self.assertTrue(permlog.append_row(self.dir, self.sid, row, max_bytes=300))
        size = os.path.getsize(self.log)
        self.assertGreaterEqual(size, 300)
        self.assertTrue(permlog.append_row(self.dir, self.sid, row, max_bytes=300))
        # The full file moved aside whole; the live one restarted with the new line.
        self.assertEqual(os.path.getsize(self.log + ".1"), size)
        self.assertEqual(len(self.rows()), 1)
        self.assertTrue(permlog.append_row(self.dir, self.sid, row, max_bytes=300))
        self.assertEqual(len(self.rows()), 2)

    def test_runs_under_the_security_flags(self):
        # The settings file runs it as `python3 -SsE` — stdlib only, no site.
        proc = subprocess.run(
            [sys.executable, "-SsE", MODULE_PATH, self.dir],
            input=json.dumps(denied()), capture_output=True, text=True, timeout=30,
            env={**os.environ, "TURMA_SESSION_ID": self.sid})
        self.assertEqual((proc.returncode, proc.stdout), (0, ""), proc.stderr)
        self.assertEqual(len(self.rows()), 1)


if __name__ == "__main__":
    unittest.main()

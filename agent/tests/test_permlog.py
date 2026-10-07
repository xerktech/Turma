#!/usr/bin/env python3
"""Tests for the permission-ledger hook (agent/hooks/permlog.py, XERK-1563).

Claude Code runs it on PermissionRequest and PermissionDenied with the event on
stdin; it appends one JSON line to `<dir>/<TURMA_SESSION_ID>.jsonl` and prints
nothing. Driven through main() with a patched stdin/stdout, plus the real
interpreter flags (`-SI`) once end to end."""

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
    # The REAL PermissionRequest shape (Claude Code 2.1.288, confirmed with a
    # live hook dumping its stdin): NO tool_use_id — unlike PermissionDenied and
    # PreToolUse. The manager merges it with its dialog on tool + head/digest.
    ev = {"session_id": "0b9f2c1e-1111-4222-8333-444455556666",
          "transcript_path": "/home/u/.claude/projects/p/0b9f.jsonl",
          "cwd": "/repo", "prompt_id": "p1", "permission_mode": "default",
          "hook_event_name": "PermissionRequest", "tool_name": "Bash",
          "tool_input": {"command": "npm test -- --watch=false"},
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
        self.assertIsNone(row["toolUseId"])     # the event carries none

    def test_heads_per_tool(self):
        cases = [
            ("Bash", {"command": "FOO=1 BAR=2 pytest -q tests/"}, "pytest"),
            ("Bash", {"command": "ls -la && rm x"}, "ls"),
            ("Bash", {"command": "git -C x status"}, "git"),   # a flag is not a subcommand
            ("Bash", {"command": "cd /repo && npm test"}, "npm test"),   # a cd is not the command
            ("Bash", {"command": "cd a; cd 'b c' && FOO=1 git status"}, "git status"),
            ("Bash", {"command": "cd /repo"}, "cd"),          # nothing follows: cd it is
            ("Bash", {"command": "cd /repo && "}, "cd"),
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

    # --- the judge hand-off (XERK-1566) ----------------------------------------

    def _alive(self):
        os.makedirs(self.dir, exist_ok=True)
        with open(os.path.join(self.dir, permlog.JUDGE_ALIVE_FILE), "w") as f:
            f.write("1")

    def _answering(self, verdict, nonce_ok=True, delay=0.05):
        """A fake manager: answers the first request it sees, then stops."""
        import threading
        seen = {}

        def run():
            import time as _t
            end = _t.monotonic() + 5
            while _t.monotonic() < end:
                names = [n for n in os.listdir(self.dir)
                         if n.endswith(permlog.JUDGE_REQ_SUFFIX)]
                if names:
                    path = os.path.join(self.dir, names[0])
                    with open(path) as f:
                        req = json.load(f)
                    seen["req"] = req
                    _t.sleep(delay)
                    ans = path[:-len(permlog.JUDGE_REQ_SUFFIX)] + permlog.JUDGE_ANS_SUFFIX
                    with open(ans + ".t", "w") as f:
                        json.dump({"nonce": req["nonce"] if nonce_ok else "nope",
                                   "verdict": verdict}, f)
                    os.replace(ans + ".t", ans)
                    return
                _t.sleep(0.01)
        t = threading.Thread(target=run, daemon=True)
        t.start()
        return seen, t

    def run_judge(self, event):
        out = io.StringIO()
        with mock.patch.object(sys, "stdin", io.StringIO(json.dumps(event))), \
             mock.patch.object(sys, "stdout", out), \
             mock.patch.dict(os.environ, {"TURMA_SESSION_ID": self.sid}, clear=False):
            rc = permlog.main(["permlog.py", self.dir, permlog.JUDGE_FLAG])
        return rc, out.getvalue()

    def judge_files(self):
        return [n for n in os.listdir(self.dir) if ".judge." in n]

    def test_an_allowed_classifier_block_asks_for_a_retry(self):
        self._alive()
        seen, t = self._answering("allow")
        rc, out = self.run_judge(denied())
        t.join()
        self.assertEqual(rc, 0)
        self.assertEqual(json.loads(out), {"hookSpecificOutput": {
            "hookEventName": "PermissionDenied", "retry": True}})
        req = seen["req"]
        self.assertEqual(req["command"], "git push origin feature")   # the WHOLE command
        self.assertEqual(req["denyReason"], "Pushing to a remote is outside scope")
        self.assertEqual(req["event"], "PermissionDenied")
        self.assertEqual(self.judge_files(), [], "req and ans are both cleaned up")
        row, = self.rows()
        # The ledger line names the hand-off, so the manager can tell a prompt
        # its judge allowed from one that reached a human.
        self.assertEqual(row["judgeNonce"], req["nonce"])

    def test_a_logged_only_event_carries_no_judge_nonce(self):
        # No judge up (or not Bash): nothing was handed over, nothing to name.
        self.assertEqual(self.run_judge(denied()), (0, ""))
        self.assertNotIn("judgeNonce", self.rows()[0])

    def test_an_allowed_permission_request_is_allowed(self):
        self._alive()
        _seen, t = self._answering("allow")
        _rc, out = self.run_judge(requested())
        t.join()
        self.assertEqual(json.loads(out)["hookSpecificOutput"],
                         {"hookEventName": "PermissionRequest",
                          "decision": {"behavior": "allow"}})

    def test_stand_or_a_foreign_answer_prints_nothing(self):
        self._alive()
        for verdict, nonce_ok in (("stand", True), ("allow", False), ("maybe", True)):
            with self.subTest(verdict=verdict, nonce_ok=nonce_ok):
                _seen, t = self._answering(verdict, nonce_ok=nonce_ok)
                self.assertEqual(self.run_judge(denied()), (0, ""))
                t.join()
                self.assertEqual(self.judge_files(), [])

    def test_no_answer_in_time_is_no_decision(self):
        self._alive()
        req = permlog.judge_request(denied(), permlog.build_row(denied()))
        ticks = iter(range(0, 1000, 10))
        verdict = permlog.await_verdict(self.dir, self.sid, req, wait_sec=30,
                                        clock=lambda: next(ticks), sleep=lambda _s: None)
        self.assertIsNone(verdict)
        self.assertEqual(self.judge_files(), [], "a timed-out request is withdrawn")

    def test_non_bash_and_a_down_judge_only_log(self):
        # Non-Bash: the grant is honoured by guard.py, whose matcher is Bash.
        self._alive()
        with mock.patch.object(permlog, "await_verdict", return_value="allow") as wait:
            for ev in (denied(tool_name="WebFetch", tool_input={"url": "https://x.example/a"}),
                       # A non-Bash tool whose input happens to carry a `command`.
                       denied(tool_name="mcp__shell__run", tool_input={"command": "ls"})):
                self.assertEqual(self.run_judge(ev), (0, ""))
            # No (or a stale) alive marker: no request, no wait.
            os.remove(os.path.join(self.dir, permlog.JUDGE_ALIVE_FILE))
            self.assertEqual(self.run_judge(denied()), (0, ""))
            wait.assert_not_called()
        self.assertEqual(self.judge_files(), [])
        self._alive()
        old = os.path.getmtime(os.path.join(self.dir, permlog.JUDGE_ALIVE_FILE)) - 3600
        os.utime(os.path.join(self.dir, permlog.JUDGE_ALIVE_FILE), (old, old))
        self.assertFalse(permlog.judge_alive(self.dir))
        self.assertEqual(len(self.rows()), 3, "every event is still logged")

    def test_without_the_flag_nothing_is_handed_over(self):
        self._alive()
        self.assertEqual(self.run_main(json.dumps(denied())), (0, ""))
        self.assertEqual(self.judge_files(), [])

    def test_an_oversized_command_or_planted_answer_fifo_is_harmless(self):
        big = denied(tool_input={"command": "x" * (permlog.JUDGE_COMMAND_MAX + 1)})
        self.assertIsNone(permlog.judge_request(big, permlog.build_row(big)))
        os.makedirs(self.dir, exist_ok=True)
        fifo = os.path.join(self.dir, "fifo")
        os.mkfifo(fifo)
        self.assertIsNone(permlog._read_answer(fifo))   # must not hang

    def test_runs_under_the_security_flags(self):
        # The settings file runs it as `python3 -SI` — stdlib only, no site.
        proc = subprocess.run(
            [sys.executable, "-SI", MODULE_PATH, self.dir],
            input=json.dumps(denied()), capture_output=True, text=True, timeout=30,
            env={**os.environ, "TURMA_SESSION_ID": self.sid})
        self.assertEqual((proc.returncode, proc.stdout), (0, ""), proc.stderr)
        self.assertEqual(len(self.rows()), 1)


if __name__ == "__main__":
    unittest.main()

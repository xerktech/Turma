#!/usr/bin/env python3
"""Tests for the session CLI (agent/hooks/session_cli.py, XERK-1564).

A session runs `python3 -SsE "$TURMA_SESSION_CLI" <subcommand> ...`; each
subcommand writes ONE rendezvous file under
~/.turma/session-requests/<TURMA_SESSION_ID>/ that the manager reads. The
end-to-end cases run the script exactly as a session does (a subprocess under
`-SsE`, HOME pointed at a temp dir); the rest drive main() in-process.
"""

import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

AGENT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODULE_PATH = os.path.join(AGENT_DIR, "hooks", "session_cli.py")

spec = importlib.util.spec_from_file_location("session_cli", MODULE_PATH)
cli = importlib.util.module_from_spec(spec)
sys.modules["session_cli"] = cli
spec.loader.exec_module(cli)

# The manager reads what this CLI writes, so the two must agree on the
# request-file shape; load it too (its name has a dash).
_ha_spec = importlib.util.spec_from_file_location(
    "hub_agent_for_cli", os.path.join(AGENT_DIR, "hub-agent.py"))
ha = importlib.util.module_from_spec(_ha_spec)
_ha_spec.loader.exec_module(ha)


class SessionCliTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="session-cli-test-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.reqdir = os.path.join(self.tmp, "session-requests")
        p = mock.patch.object(cli, "REQUESTS_DIR", self.reqdir)
        p.start()
        self.addCleanup(p.stop)

    def run_main(self, argv, sid="abcde"):
        out, err = io.StringIO(), io.StringIO()
        env = {"TURMA_SESSION_ID": sid} if sid is not None else {}
        with mock.patch.dict(os.environ, env, clear=False), \
                mock.patch.object(sys, "stdout", out), \
                mock.patch.object(sys, "stderr", err):
            if sid is None:
                os.environ.pop("TURMA_SESSION_ID", None)
            try:
                rc = cli.main(argv)
            except SystemExit as e:          # argparse usage errors
                rc = e.code
        return rc, out.getvalue(), err.getvalue()

    def read(self, name, sid="abcde"):
        with open(os.path.join(self.reqdir, sid, f"{name}.json")) as fh:
            return json.load(fh)

    # -- wake ------------------------------------------------------------------

    def test_wake_writes_the_request_and_confirms_on_one_line(self):
        before = int(time.time() * 1000)
        rc, out, _ = self.run_main(["wake", "2h", "check", "the", "CI", "run"])
        after = int(time.time() * 1000)
        self.assertEqual(rc, 0)
        self.assertEqual(out.count("\n"), 1)
        self.assertIn("2h", out)
        req = self.read("wake")
        self.assertEqual(req["reason"], "check the CI run")
        self.assertGreaterEqual(req["wakeAt"], before + 2 * 3600 * 1000)
        self.assertLessEqual(req["wakeAt"], after + 2 * 3600 * 1000)
        # ...and the manager reads exactly that file back.
        with mock.patch.object(ha, "SESSION_REQUESTS_DIR", self.reqdir):
            got = ha.read_wake_request("abcde")
        self.assertEqual(got, {"wakeAt": req["wakeAt"], "wakeReason": "check the CI run"})

    def test_durations(self):
        for text, secs in (("20m", 1200), ("2h", 7200), ("1h30m", 5400),
                           ("45s", 45), ("1d", 86400), ("7d", 7 * 86400)):
            self.assertEqual(cli.parse_duration(text), secs, text)
        for bad in ("", "0m", "10", "2x", "h", "-5m", "1.5h", "8d", "2h 3m"):
            with self.assertRaises(cli.Refused, msg=bad):
                cli.parse_duration(bad)

    def test_wake_bounds_refuse_and_write_nothing(self):
        for argv in (["wake", "2h", "x" * 201], ["wake", "0m", "r"],
                     ["wake", "8d", "r"], ["wake", "soon", "r"]):
            with self.subTest(argv=argv[:2]):
                rc, out, err = self.run_main(argv)
                self.assertEqual(rc, 2)
                self.assertEqual(out, "")
                self.assertIn("nothing was written", err)
        self.assertFalse(os.path.exists(self.reqdir))
        rc, _, _ = self.run_main(["wake", "2h", "x" * 200])
        self.assertEqual(rc, 0)

    def test_wake_needs_a_reason(self):
        rc, _, _ = self.run_main(["wake", "2h"])
        self.assertEqual(rc, 2)
        rc, _, _ = self.run_main(["wake", "2h", "   "])
        self.assertEqual(rc, 2)
        self.assertFalse(os.path.exists(self.reqdir))

    # -- close-ticket ----------------------------------------------------------

    def test_close_ticket_writes_the_request(self):
        for resolution in ("done", "not-reproducible", "already-fixed"):
            rc, out, _ = self.run_main(["close-ticket", resolution,
                                        "--note", "  reran the repro on main: passes "])
            self.assertEqual(rc, 0, resolution)
            self.assertEqual(out.count("\n"), 1)
            req = self.read("close-ticket")
            self.assertEqual(req["resolution"], resolution)
            self.assertEqual(req["note"], "reran the repro on main: passes")
            self.assertIsInstance(req["requestedAt"], int)

    def test_close_ticket_bounds(self):
        for argv in (["close-ticket", "wontfix", "--note", "n"],
                     ["close-ticket", "done"],
                     ["close-ticket", "done", "--note", "  "],
                     ["close-ticket", "done", "--note", "n" * 2001]):
            with self.subTest(argv=argv[:3]):
                rc, out, _ = self.run_main(argv)
                self.assertEqual(rc, 2)
                self.assertEqual(out, "")
        self.assertFalse(os.path.exists(self.reqdir))
        rc, _, _ = self.run_main(["close-ticket", "done", "--note", "n" * 2000])
        self.assertEqual(rc, 0)

    # -- environment -----------------------------------------------------------

    def test_without_a_session_id_it_says_why_and_exits_2(self):
        for sid in (None, ""):
            rc, out, err = self.run_main(["wake", "2h", "r"], sid=sid)
            self.assertEqual(rc, 2)
            self.assertEqual(out, "")
            self.assertIn("TURMA_SESSION_ID is not set", err)
        self.assertFalse(os.path.exists(self.reqdir))

    def test_an_id_that_is_not_a_plain_name_is_refused(self):
        for sid in ("..", ".", "a/b", "../x", "-x"):
            rc, _, _ = self.run_main(["wake", "2h", "r"], sid=sid)
            self.assertEqual(rc, 2, sid)
        self.assertFalse(os.path.exists(self.reqdir))

    # -- atomic write ----------------------------------------------------------

    def test_the_write_is_atomic_and_leaves_no_temp_file(self):
        self.run_main(["wake", "20m", "first"])
        self.run_main(["wake", "40m", "second"])          # replaces in place
        folder = os.path.join(self.reqdir, "abcde")
        self.assertEqual(sorted(os.listdir(folder)), ["wake.json"])
        self.assertEqual(self.read("wake")["reason"], "second")

    def test_a_failed_write_leaves_the_old_request_and_no_temp_file(self):
        self.run_main(["wake", "20m", "first"])
        with mock.patch.object(cli.os, "replace", side_effect=OSError("disk full")):
            rc, _, err = self.run_main(["wake", "40m", "second"])
        self.assertEqual(rc, 1)
        self.assertIn("disk full", err)
        folder = os.path.join(self.reqdir, "abcde")
        self.assertEqual(sorted(os.listdir(folder)), ["wake.json"])
        self.assertEqual(self.read("wake")["reason"], "first")

    def test_the_temp_name_is_dot_prefixed_and_never_followed(self):
        seen = []
        real_open = os.open

        def spy(path, flags, mode=0o777):
            seen.append((os.path.basename(path), flags))
            return real_open(path, flags, mode)
        with mock.patch.object(cli.os, "open", side_effect=spy):
            self.run_main(["wake", "20m", "r"])
        name, flags = seen[0]
        self.assertTrue(name.startswith(".wake."), name)
        self.assertTrue(flags & os.O_EXCL)
        self.assertTrue(flags & os.O_NOFOLLOW)

    # -- as a session runs it --------------------------------------------------

    def test_end_to_end_under_the_hook_flags(self):
        home = os.path.join(self.tmp, "home")
        os.makedirs(home)
        env = {"HOME": home, "PATH": os.environ.get("PATH", ""),
               "TURMA_SESSION_ID": "s1"}
        r = subprocess.run([sys.executable, "-SsE", MODULE_PATH, "wake", "2m", "test"],
                           env=env, capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        path = os.path.join(home, ".turma", "session-requests", "s1", "wake.json")
        with open(path) as fh:
            self.assertEqual(json.load(fh)["reason"], "test")
        env.pop("TURMA_SESSION_ID")
        r = subprocess.run([sys.executable, "-SsE", MODULE_PATH, "wake", "2m", "test"],
                           env=env, capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 2)
        self.assertIn("TURMA_SESSION_ID", r.stderr)


if __name__ == "__main__":
    unittest.main()

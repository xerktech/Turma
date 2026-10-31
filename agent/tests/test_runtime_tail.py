#!/usr/bin/env python3
"""Tests for agent/runtime_tail.py's shared numeric-env parser (XERK-523).

`env_int`/`env_float` are the stdlib-only twin of hub-agent's `_env_num`
(XERK-372), used by the per-runtime siblings (`dsh_session.py`, `qwen_session.py`)
to parse their module-scope knobs at IMPORT time without crashing the launch on a
junk value. Same fall-back contract as hub-agent's copy, verified here directly."""

import contextlib
import io
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import runtime_tail as rt  # noqa: E402


class EnvNumHelpersTest(unittest.TestCase):
    def _read(self, fn, name, default, **kw):
        buf = io.StringIO()
        with contextlib.redirect_stderr(buf):
            val = fn(name, default, **kw)
        return val, buf.getvalue()

    def _with_env(self, name, value):
        env = {k: v for k, v in os.environ.items() if k != name}
        if value is not None:
            env[name] = value
        return mock.patch.dict(os.environ, env, clear=True)

    def test_valid_value_parses(self):
        with self._with_env("X", "42"):
            self.assertEqual(self._read(rt.env_int, "X", 7)[0], 42)
        with self._with_env("X", "0.25"):
            self.assertEqual(self._read(rt.env_float, "X", 0.0)[0], 0.25)

    def test_unset_uses_default_silently(self):
        with self._with_env("X", None):
            val, err = self._read(rt.env_float, "X", 0.5)
        self.assertEqual(val, 0.5)
        self.assertEqual(err, "")

    def test_garbage_falls_back_and_warns(self):
        # The exact shapes the ticket lists — each RAISED under a bare cast.
        for raw in ("abc", "10m", '"20"', "2 0"):
            with self._with_env("X", raw):
                val, err = self._read(rt.env_int, "X", 7)
            self.assertEqual(val, 7, raw)
            self.assertIn("WARNING", err, raw)
            self.assertIn("X=", err, raw)

    def test_non_finite_float_falls_back(self):
        for raw in ("inf", "-inf", "nan"):
            with self._with_env("X", raw):
                val, err = self._read(rt.env_float, "X", 0.5)
            self.assertEqual(val, 0.5, raw)
            self.assertIn("WARNING", err, raw)

    def test_minimum_clamps(self):
        with self._with_env("X", "0"):
            val, _ = self._read(rt.env_float, "X", 5.0, minimum=0.1)
        self.assertEqual(val, 0.1)


class FreshWriteTest(unittest.TestCase):
    """XERK-2564: a link planted at a projected file's name is never written
    through — the write lands in a fresh inode at that name instead."""

    def setUp(self):
        import tempfile
        self.tmp = tempfile.mkdtemp()
        self.victim = os.path.join(self.tmp, "victim")
        with open(self.victim, "w") as fh:
            fh.write("untouched")

    def _victim(self):
        with open(self.victim) as fh:
            return fh.read()

    def test_open_fresh_replaces_a_planted_symlink(self):
        path = os.path.join(self.tmp, "out.json")
        os.symlink(self.victim, path)
        with rt.open_fresh_for_write(path) as fh:
            fh.write("mine")
        self.assertEqual(self._victim(), "untouched")
        self.assertFalse(os.path.islink(path))
        with open(path) as fh:
            self.assertEqual(fh.read(), "mine")

    def test_open_fresh_does_not_write_through_a_hardlink(self):
        path = os.path.join(self.tmp, "out.json")
        os.link(self.victim, path)
        with rt.open_fresh_for_write(path) as fh:
            fh.write("mine")
        self.assertEqual(self._victim(), "untouched")

    def test_write_text_replace_ignores_links_at_target_and_tmp(self):
        path = os.path.join(self.tmp, "rec.json")
        os.symlink(self.victim, path)
        os.symlink(self.victim, "%s.%d.tmp" % (path, os.getpid()))
        rt.write_text_replace(path, "new")
        self.assertEqual(self._victim(), "untouched")
        self.assertFalse(os.path.islink(path))
        with open(path) as fh:
            self.assertEqual(fh.read(), "new")
        self.assertEqual(sorted(os.listdir(self.tmp)), ["rec.json", "victim"])

    def test_write_text_replace_cleans_up_and_raises_on_failure(self):
        path = os.path.join(self.tmp, "rec.json")
        with mock.patch.object(rt.os, "replace", side_effect=OSError("boom")):
            with self.assertRaises(OSError):
                rt.write_text_replace(path, "new")
        self.assertEqual(os.listdir(self.tmp), ["victim"])


    def test_open_fresh_refuses_a_link_replanted_after_the_unlink(self):
        # The race O_EXCL exists for: a link planted between the unlink and the
        # create must fail the open (EEXIST), never be followed or truncated.
        path = os.path.join(self.tmp, "out.json")
        real_unlink = os.unlink

        def unlink_then_replant(p):
            real_unlink(p)
            os.symlink(self.victim, p)

        open(path, "w").close()
        with mock.patch.object(rt.os, "unlink", side_effect=unlink_then_replant):
            with self.assertRaises(FileExistsError):
                rt.open_fresh_for_write(path)
        self.assertEqual(self._victim(), "untouched")

    def test_open_fresh_truncates_in_place_when_windows_refuses_the_unlink(self):
        path = os.path.join(self.tmp, "out.json")
        with open(path, "w") as fh:
            fh.write("old contents")
        with mock.patch.object(rt.os, "name", "nt"), \
                mock.patch.object(rt.os, "unlink", side_effect=PermissionError("in use")):
            with rt.open_fresh_for_write(path) as fh:
                fh.write("new")
        with open(path) as fh:
            self.assertEqual(fh.read(), "new")

    def test_open_fresh_reraises_a_posix_unlink_permission_error(self):
        path = os.path.join(self.tmp, "out.json")
        with mock.patch.object(rt.os, "unlink", side_effect=PermissionError("no")):
            with self.assertRaises(PermissionError):
                rt.open_fresh_for_write(path)

    def test_write_text_replace_cleans_up_on_a_non_oserror(self):
        path = os.path.join(self.tmp, "rec.json")
        with self.assertRaises(UnicodeEncodeError):
            rt.write_text_replace(path, "lone \ud800 surrogate")
        self.assertEqual(os.listdir(self.tmp), ["victim"])

    def test_append_entries_refuses_a_planted_symlink(self):
        path = os.path.join(self.tmp, "t.jsonl")
        os.symlink(self.victim, path)
        logs = []
        rt.append_entries(path, [{"a": 1}], logs.append)
        self.assertEqual(self._victim(), "untouched")
        self.assertTrue(logs)

    def test_append_entries_refuses_a_planted_hardlink(self):
        path = os.path.join(self.tmp, "t.jsonl")
        os.link(self.victim, path)
        logs = []
        rt.append_entries(path, [{"a": 1}], logs.append)
        self.assertEqual(self._victim(), "untouched")
        self.assertTrue(logs)

    def test_append_entries_still_appends_to_a_regular_file(self):
        path = os.path.join(self.tmp, "t.jsonl")
        rt.append_entries(path, [{"a": 1}], self.fail)
        rt.append_entries(path, [{"b": 2}], self.fail)
        with open(path) as fh:
            self.assertEqual(fh.read(), '{"a": 1}\n{"b": 2}\n')

    def test_ensure_transcript_file_does_not_create_through_a_dangling_link(self):
        path = os.path.join(self.tmp, "t.jsonl")
        outside = os.path.join(self.tmp, "outside.jsonl")
        os.symlink(outside, path)
        rt.ensure_transcript_file(path, lambda m: None)
        self.assertFalse(os.path.exists(outside))

    def test_open_for_append_does_not_block_on_a_fifo(self):
        path = os.path.join(self.tmp, "t.jsonl")
        os.mkfifo(path)
        with self.assertRaises(OSError):
            rt.open_for_append(path)            # no reader: ENXIO, never a hang
        reader = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
        self.addCleanup(os.close, reader)
        with self.assertRaises(OSError):
            rt.open_for_append(path)            # reader attached: not a regular file

    def test_child_projection_rewrite_never_truncates_a_planted_link(self):
        src = os.path.join(self.tmp, "child.jsonl")
        dest = os.path.join(self.tmp, "agent-c.jsonl")
        with open(src, "w") as fh:
            fh.write("x" * 10)

        class _Proj:
            def feed(self, ev):
                return []

        cp = rt.ChildProjection(_Proj, dest)
        cp.offset = 100                    # larger than src: reads as rewritten
        os.symlink(self.victim, dest)
        cp.pump(src, lambda path, entries: None)
        self.assertEqual(self._victim(), "untouched")
        self.assertFalse(os.path.islink(dest))

if __name__ == "__main__":
    unittest.main()

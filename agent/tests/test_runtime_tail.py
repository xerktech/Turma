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


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
"""Tests for agent/hooks/statusline.py — the statusLine hook that captures the
Claude subscription's 5-hour and 7-day windows into ~/.turma/limits.json
(XERK-247). Stdlib unittest, like the other hook tests.

The payloads here are shaped like the real thing: the field names, the float
percentage that has been through arithmetic, and the independently-absent
windows all come from blobs Claude Code actually handed a status line.
"""

import importlib.util
import json
import os
import sys
import tempfile
import unittest

AGENT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODULE_PATH = os.path.join(AGENT_DIR, "hooks", "statusline.py")

spec = importlib.util.spec_from_file_location("turma_statusline", MODULE_PATH)
sl = importlib.util.module_from_spec(spec)
sys.modules["turma_statusline"] = sl
spec.loader.exec_module(sl)

NOW = 1_786_400_000


def payload(**limits):
    return {"version": "2.1.226", "session_id": "abc", "rate_limits": limits}


class TestBuildSnapshot(unittest.TestCase):
    def test_captures_both_windows(self):
        snap = sl.build_snapshot(payload(
            five_hour={"used_percentage": 23.5, "resets_at": 1_786_405_200},
            seven_day={"used_percentage": 41.2, "resets_at": 1_786_950_000},
        ), now=NOW)
        self.assertEqual(snap["fiveHour"], {"usedPct": 23.5, "resetsAt": 1_786_405_200})
        self.assertEqual(snap["sevenDay"], {"usedPct": 41.2, "resetsAt": 1_786_950_000})
        self.assertEqual(snap["capturedAt"], NOW)
        self.assertEqual(snap["source"], "statusline")
        self.assertEqual(snap["claudeVersion"], "2.1.226")

    def test_rounds_the_float_noise_off_the_percentage(self):
        # 14.000000000000002 is a real observed value; rendering it verbatim
        # would put a 15-digit number in the UI.
        snap = sl.build_snapshot(payload(
            five_hour={"used_percentage": 14.000000000000002, "resets_at": 1}), now=NOW)
        self.assertEqual(snap["fiveHour"]["usedPct"], 14.0)

    def test_keeps_a_window_that_reports_only_one_of_its_fields(self):
        snap = sl.build_snapshot(payload(seven_day={"used_percentage": 8}), now=NOW)
        self.assertEqual(snap["sevenDay"], {"usedPct": 8.0})
        self.assertNotIn("fiveHour", snap)

    def test_no_rate_limits_means_no_snapshot(self):
        # Absent until the first API response of a session, and forever on a
        # non-subscription login. Writing "nothing" would blank a good snapshot.
        self.assertIsNone(sl.build_snapshot({"version": "2.1.226"}))
        self.assertIsNone(sl.build_snapshot(payload()))
        self.assertIsNone(sl.build_snapshot(None))
        self.assertIsNone(sl.build_snapshot("not a dict"))

    def test_garbage_window_values_are_dropped_not_carried(self):
        snap = sl.build_snapshot(payload(
            five_hour={"used_percentage": "lots", "resets_at": None},
            seven_day={"used_percentage": 8, "resets_at": 1_786_950_000},
        ), now=NOW)
        self.assertNotIn("fiveHour", snap)
        self.assertEqual(snap["sevenDay"]["usedPct"], 8.0)

    def test_percentage_is_clamped_to_a_percentage(self):
        snap = sl.build_snapshot(payload(
            five_hour={"used_percentage": 140}, seven_day={"used_percentage": -3}), now=NOW)
        self.assertEqual(snap["fiveHour"]["usedPct"], 100.0)
        self.assertEqual(snap["sevenDay"]["usedPct"], 0.0)

    def test_booleans_are_not_numbers(self):
        snap = sl.build_snapshot(payload(five_hour={"used_percentage": True}), now=NOW)
        self.assertIsNone(snap)


class TestWriteSnapshot(unittest.TestCase):
    def test_write_is_atomic_and_leaves_no_temp_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "nested", "limits.json")
            snap = sl.build_snapshot(payload(
                five_hour={"used_percentage": 23.5, "resets_at": 1}), now=NOW)
            self.assertTrue(sl.write_snapshot(snap, path))
            with open(path) as fh:
                self.assertEqual(json.load(fh)["fiveHour"]["usedPct"], 23.5)
            self.assertEqual(os.listdir(os.path.dirname(path)), ["limits.json"])

    def test_an_unwritable_path_is_reported_not_raised(self):
        # A statusLine command that throws paints its traceback into the
        # operator's terminal on every render.
        self.assertFalse(sl.write_snapshot({"capturedAt": NOW}, "/proc/nope/limits.json"))


class TestStatusText(unittest.TestCase):
    def test_renders_both_windows_with_countdowns(self):
        snap = sl.build_snapshot(payload(
            five_hour={"used_percentage": 23.5, "resets_at": NOW + 2 * 3600 + 14 * 60},
            seven_day={"used_percentage": 41, "resets_at": NOW + 45 * 60},
        ), now=NOW)
        self.assertEqual(sl.status_text(snap, now=NOW),
                         "5h 23.5% (resets 2h 14m) · 7d 41% (resets 45m)")

    def test_a_past_reset_drops_the_countdown_rather_than_going_negative(self):
        snap = sl.build_snapshot(payload(
            five_hour={"used_percentage": 5, "resets_at": NOW - 10}), now=NOW)
        self.assertEqual(sl.status_text(snap, now=NOW), "5h 5%")

    def test_nothing_to_say_prints_nothing(self):
        self.assertEqual(sl.status_text(None), "")


if __name__ == "__main__":
    unittest.main()

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


class TestCarryWindowHighWater(unittest.TestCase):
    """A window's used percentage only rises until it resets, so a reading that
    DROPS while the window has not reset (same resets_at) is spurious — Claude
    Code 2.1.x hands the statusLine an intermittent 0. carry_window_high_water
    floors each window at the highest value seen for that window instance."""

    def _prior(self, tmp, snap):
        path = os.path.join(tmp, "limits.json")
        with open(path, "w") as fh:
            json.dump(snap, fh)
        return path

    def test_a_spurious_drop_within_a_window_is_floored_to_the_prior_high(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._prior(tmp, {
                "sevenDay": {"usedPct": 14.0, "resetsAt": 1_786_950_000},
                "fiveHour": {"usedPct": 30.0, "resetsAt": 1_786_405_200},
                "capturedAt": NOW - 1800,
            })
            # A later probe reads 0 for BOTH, same reset stamps — impossible for a
            # window 130h from reset, so both are floored back up.
            snap = sl.build_snapshot(payload(
                five_hour={"used_percentage": 0, "resets_at": 1_786_405_200},
                seven_day={"used_percentage": 0, "resets_at": 1_786_950_000},
            ), now=NOW)
            sl.carry_window_high_water(snap, path)
            self.assertEqual(snap["sevenDay"]["usedPct"], 14.0)
            self.assertEqual(snap["fiveHour"]["usedPct"], 30.0)

    def test_a_genuine_reset_is_not_floored(self):
        # A NEW reset stamp is a new window instance; dropping to ~0 there is real
        # (a 5-hour window that just rolled over), so the floor must not cross it.
        with tempfile.TemporaryDirectory() as tmp:
            path = self._prior(tmp, {
                "fiveHour": {"usedPct": 30.0, "resetsAt": 1_786_405_200},
                "capturedAt": NOW - 1800,
            })
            snap = sl.build_snapshot(payload(
                five_hour={"used_percentage": 1, "resets_at": 1_786_405_200 + 18000},
            ), now=NOW)
            sl.carry_window_high_water(snap, path)
            self.assertEqual(snap["fiveHour"]["usedPct"], 1.0)

    def test_a_legitimate_rise_passes_through(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = self._prior(tmp, {
                "sevenDay": {"usedPct": 14.0, "resetsAt": 1_786_950_000}, "capturedAt": NOW - 60})
            snap = sl.build_snapshot(payload(
                seven_day={"used_percentage": 22, "resets_at": 1_786_950_000}), now=NOW)
            sl.carry_window_high_water(snap, path)
            self.assertEqual(snap["sevenDay"]["usedPct"], 22.0)

    def test_no_reset_stamp_cannot_be_matched_so_is_not_floored(self):
        # Without a reset stamp there is no way to tell a reset from a drop.
        with tempfile.TemporaryDirectory() as tmp:
            path = self._prior(tmp, {"sevenDay": {"usedPct": 14.0}, "capturedAt": NOW - 60})
            snap = sl.build_snapshot(payload(seven_day={"used_percentage": 0}), now=NOW)
            sl.carry_window_high_water(snap, path)
            self.assertEqual(snap["sevenDay"]["usedPct"], 0.0)

    def test_no_prior_or_garbage_prior_never_raises_and_leaves_the_reading(self):
        snap = sl.build_snapshot(payload(
            seven_day={"used_percentage": 0, "resets_at": 1_786_950_000}), now=NOW)
        # No file at all.
        sl.carry_window_high_water(dict(snap), os.path.join("/nonexistent-dir", "x.json"))
        with tempfile.TemporaryDirectory() as tmp:
            for junk in ("not json", json.dumps(["a", "list"]), json.dumps("a string")):
                path = os.path.join(tmp, "limits.json")
                with open(path, "w") as fh:
                    fh.write(junk)
                out = sl.carry_window_high_water(sl.build_snapshot(payload(
                    seven_day={"used_percentage": 0, "resets_at": 1_786_950_000}), now=NOW), path)
                self.assertEqual(out["sevenDay"]["usedPct"], 0.0)

    def test_an_oversize_prior_file_is_ignored_not_read_whole(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "limits.json")
            with open(path, "w") as fh:
                fh.write(" " * (sl.PREV_READ_MAX + 1))
            snap = sl.build_snapshot(payload(
                seven_day={"used_percentage": 0, "resets_at": 1_786_950_000}), now=NOW)
            sl.carry_window_high_water(snap, path)
            self.assertEqual(snap["sevenDay"]["usedPct"], 0.0)

    def test_main_flow_floors_before_writing(self):
        # End to end: a good snapshot on disk, then a payload reporting a spurious
        # 0 for the same window — the WRITTEN file keeps the good value.
        with tempfile.TemporaryDirectory() as tmp:
            path = self._prior(tmp, {
                "sevenDay": {"usedPct": 14.0, "resetsAt": 1_786_950_000}, "capturedAt": NOW - 1800})
            snap = sl.build_snapshot(payload(
                seven_day={"used_percentage": 0, "resets_at": 1_786_950_000}), now=NOW)
            sl.write_snapshot(sl.carry_window_high_water(snap, path), path)
            with open(path) as fh:
                self.assertEqual(json.load(fh)["sevenDay"]["usedPct"], 14.0)


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

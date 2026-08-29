#!/usr/bin/env python3
"""Tests for agent/qwen_session.py — the qwen projection tail (XERK-509 [Qwen C]).

Drives the REAL QwenProjector over real Qwen native-log event shapes (the G0
corpus shapes), the no-mock discipline the runtime children ship under, and
pins the tail's own behaviour: incremental projection, resume-at-EOF, native-log
discovery by glob, and best-effort title capture.
"""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import qwen_session as qs  # noqa: E402


class QwenProjectionTailTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="qwen-tail-")
        self.addCleanup(self._rmtree)
        self.sid = "757253de-b908-4212-9ff7-dfc1f84c5b50"
        # The qwen native log lives at <projects_root>/<slug>/chats/<sid>.jsonl.
        self.projects_root = os.path.join(self.tmp, "qwen-projects")
        self.chats_dir = os.path.join(self.projects_root, "some-slug", "chats")
        os.makedirs(self.chats_dir, exist_ok=True)
        self.native_log = os.path.join(self.chats_dir, f"{self.sid}.jsonl")
        # The projected (Claude-JSONL) transcript the tail appends to. Its dir is
        # created by the tail's _run() thread; these tests drive _pump() directly,
        # so create it here (matching what a launched tail would have).
        self.transcript = os.path.join(self.tmp, "projects", "slug",
                                       f"{self.sid}.jsonl")
        os.makedirs(os.path.dirname(self.transcript), exist_ok=True)

    def _rmtree(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _append_native(self, event):
        with open(self.native_log, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(event) + "\n")

    def _read_transcript(self):
        if not os.path.exists(self.transcript):
            return []
        with open(self.transcript, encoding="utf-8") as fh:
            return [json.loads(l) for l in fh if l.strip()]

    def _tail(self, resume=False, use_glob=True):
        return qs.QwenProjectionTail(
            self.projects_root, self.transcript, self.sid,
            cwd="/work", log=lambda m: None, resume=resume,
            events_path=None if use_glob else self.native_log)

    def _user(self, text, uuid="u1"):
        return {"type": "user", "uuid": uuid, "timestamp": "2026-08-28T18:08:40.134Z",
                "message": {"role": "user", "parts": [{"text": text}]}}

    def _assistant(self, text, uuid="a1"):
        return {"type": "assistant", "uuid": uuid,
                "timestamp": "2026-08-28T18:08:41.000Z",
                "model": "qwen3-coder",
                "usageMetadata": {"promptTokenCount": 100,
                                  "cachedContentTokenCount": 40,
                                  "candidatesTokenCount": 20,
                                  "totalTokenCount": 120},
                "message": {"role": "assistant", "parts": [{"text": text}]}}

    # --- discovery + fresh projection ---------------------------------------

    def test_native_log_discovered_by_glob_and_projected_incrementally(self):
        # The tail locates the native log by GLOB (not a computed slug), so it
        # works regardless of the cwd->slug rule (see the module docstring).
        self._append_native(self._user("hello qwen"))
        tail = self._tail(use_glob=True)
        self.addCleanup(tail.stop)
        tail._pump()
        entries = self._read_transcript()
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["type"], "user")
        self.assertEqual(entries[0]["message"]["content"][0]["text"], "hello qwen")
        # A second event appended is projected on the next pump, not re-projected.
        self._append_native(self._assistant("hi there"))
        tail._pump()
        entries = self._read_transcript()
        self.assertEqual(len(entries), 2)
        self.assertEqual(entries[1]["type"], "assistant")
        # usage is carried (disjoint counts): input = 100-40, cache_read = 40.
        usage = entries[1]["message"]["usage"]
        self.assertEqual(usage["input_tokens"], 60)
        self.assertEqual(usage["cache_read_input_tokens"], 40)
        self.assertEqual(usage["output_tokens"], 20)

    def test_missing_native_log_projects_nothing_and_never_raises(self):
        # No native log on disk yet (an empty conversation writes none until the
        # first turn): the tail creates the (empty) transcript and pumps to a
        # no-op, exactly like a Claude session before its first byte.
        tail = self._tail(use_glob=True)
        self.addCleanup(tail.stop)
        # _run creates the transcript file; _pump alone just no-ops here.
        tail._pump()
        self.assertEqual(self._read_transcript(), [])

    def test_resume_starts_past_already_projected_history(self):
        # On resume the kept native log's history is already in the transcript;
        # qwen --resume appends in place, so the tail must start at EOF and
        # project only NEW events, never re-project the history.
        self._append_native(self._user("old turn"))
        self._append_native(self._assistant("old reply"))
        resumed = self._tail(resume=True, use_glob=False)
        self.addCleanup(resumed.stop)
        resumed._pump()   # primes offset to EOF; projects nothing
        self.assertEqual(self._read_transcript(), [])
        # A NEW event after resume IS projected.
        self._append_native(self._user("new turn"))
        resumed._pump()
        entries = self._read_transcript()
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["message"]["content"][0]["text"], "new turn")

    def test_fresh_tail_projects_existing_events_from_zero(self):
        # The contrast to resume: a non-resume tail starts at 0 and projects the
        # existing events (a fresh launch writes a new log, so this never doubles).
        self._append_native(self._user("from zero"))
        fresh = self._tail(resume=False, use_glob=False)
        self.addCleanup(fresh.stop)
        fresh._pump()
        self.assertEqual(len(self._read_transcript()), 1)

    def test_system_events_project_nothing(self):
        # Only user/assistant/tool_result project; a system event is log-only.
        self._append_native({"type": "system", "subtype": "ui_telemetry",
                             "uuid": "s1", "systemPayload": {}})
        tail = self._tail(use_glob=False)
        self.addCleanup(tail.stop)
        tail._pump()
        self.assertEqual(self._read_transcript(), [])

    def test_malformed_line_is_skipped_not_fatal(self):
        with open(self.native_log, "a", encoding="utf-8") as fh:
            fh.write("{not json\n")
        self._append_native(self._user("after junk"))
        tail = self._tail(use_glob=False)
        self.addCleanup(tail.stop)
        tail._pump()
        entries = self._read_transcript()
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["message"]["content"][0]["text"], "after junk")

    # --- title capture (tier 1; dormant per G0) -----------------------------

    def test_title_is_none_without_a_title_event(self):
        # The G0 corpus emits no title event, so title() stays None and naming
        # falls to the qwen -p one-shot (tier 2).
        self._append_native(self._user("no title here"))
        tail = self._tail(use_glob=False)
        self.addCleanup(tail.stop)
        tail._pump()
        self.assertIsNone(tail.title())
        self.assertFalse(tail.title_final())

    def test_title_captured_best_effort_if_qwen_ever_writes_one(self):
        # A future qwen that writes a title event is honoured (final), without a
        # code change — read on the beat by _seed_qwen_summary's tier 1.
        self._append_native({"type": "session_title", "uuid": "t1",
                             "data": {"title": "  Refactor The Widget  "}})
        tail = self._tail(use_glob=False)
        self.addCleanup(tail.stop)
        tail._pump()
        self.assertEqual(tail.title(), "Refactor The Widget")
        self.assertTrue(tail.title_final())


if __name__ == "__main__":
    unittest.main()

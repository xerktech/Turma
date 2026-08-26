#!/usr/bin/env python3
"""Tests for turn classification and token attribution (XERK-445).

The numbers this module produces are the argument for the whole routing design,
so the two measurement bugs it once had are pinned here by hand-computed
fixtures. Both shipped, and both survived every project gate, because nothing
under bench/ was executed by CI.
"""

import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import classify as C  # noqa: E402


def usage(inp=0, create=0, read=0, out=0):
    return {"input_tokens": inp, "cache_creation_input_tokens": create,
            "cache_read_input_tokens": read, "output_tokens": out}


def asst(req, content, use, model="claude-opus-5", sidechain=False):
    return {"type": "assistant", "uuid": f"u-{req}-{id(content)}",
            "requestId": req, "isSidechain": sidechain,
            "message": {"model": model, "usage": use, "content": content}}


def text(t):
    return {"type": "text", "text": t}


def tool(name):
    return {"type": "tool_use", "name": name, "input": {}, "id": "t1"}


def tool_result(is_error=False, body="ok"):
    return {"type": "user", "uuid": "ur", "message": {"content": [
        {"type": "tool_result", "tool_use_id": "t1", "content": body,
         "is_error": is_error}]}}


class TestReduceUsage(unittest.TestCase):
    """Claude Code writes one entry per content block. Entries sharing a
    requestId repeat the same input-side counters while output_tokens
    accumulates. Summing them triple-counted the prompt: 21.1B tokens reported
    against a true 11.1B, and 102,582 'turns' against 52,391."""

    def test_max_not_sum(self):
        got = C._reduce_usage([
            {"input": 2, "cache_creation": 14268, "cache_read": 0, "output": 3},
            {"input": 2, "cache_creation": 14268, "cache_read": 0, "output": 2464},
        ])
        self.assertEqual(got, {"input": 2, "cache_creation": 14268,
                               "cache_read": 0, "output": 2464})
        # The bug: summing would have produced these.
        self.assertNotEqual(got["cache_creation"], 28536)
        self.assertNotEqual(got["output"], 2467)

    def test_three_entry_group(self):
        got = C._reduce_usage([
            {"input": 2, "cache_creation": 40685, "cache_read": 0, "output": 1},
            {"input": 2, "cache_creation": 40685, "cache_read": 0, "output": 1},
            {"input": 2, "cache_creation": 40685, "cache_read": 0, "output": 369},
        ])
        self.assertEqual(got["cache_creation"], 40685)
        self.assertEqual(got["output"], 369)

    def test_empty(self):
        self.assertEqual(C._reduce_usage([]),
                         {"input": 0, "cache_creation": 0, "cache_read": 0,
                          "output": 0})


class TestClassifyTurn(unittest.TestCase):
    def test_error_recovery_beats_the_tool_called(self):
        # A router that cannot tell 'editing a file' from 'editing a file to
        # undo a failure' routes the hard case to the cheap tier.
        self.assertEqual(
            C.classify_turn({"Edit"}, "", prev_result_bad=True, is_last=False),
            C.ERROR_RECOVERY)
        self.assertEqual(
            C.classify_turn({"Edit"}, "", prev_result_bad=False, is_last=False),
            C.CODE_EDIT)

    def test_precedence_order(self):
        self.assertEqual(C.classify_turn({"Task"}, "", False, False), C.DELEGATION)
        self.assertEqual(C.classify_turn({"Write"}, "", False, False), C.CODE_EDIT)
        self.assertEqual(C.classify_turn({"TodoWrite"}, "", False, False), C.PLANNING)
        self.assertEqual(C.classify_turn({"Grep"}, "", False, False), C.FILE_READ)
        self.assertEqual(C.classify_turn({"Bash"}, "", False, False), C.TOOL_EXEC)

    def test_narration_vs_summarization(self):
        # Short prose mid-session is execution glue. Filing it under
        # summarization put 39% of the corpus in the wrong bucket.
        self.assertEqual(C.classify_turn(set(), "Now the payload generator:",
                                         False, is_last=False), C.NARRATION)
        self.assertEqual(C.classify_turn(set(), "All tests pass.",
                                         False, is_last=True), C.SUMMARIZATION)
        self.assertEqual(C.classify_turn(set(), "x" * 700, False, False),
                         C.PLANNING)


class TestWalkTranscript(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "s.jsonl.raw", "id", "id.jsonl")
        os.makedirs(os.path.dirname(self.path))

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def write(self, entries):
        with open(self.path, "w", encoding="utf8") as fh:
            for e in entries:
                fh.write(json.dumps(e) + "\n")

    def test_split_turn_is_one_turn(self):
        # text block and tool_use block of ONE message, two entries, one id.
        self.write([
            asst("r1", [text("Now the fix:")], usage(2, 100, 5000, 3)),
            asst("r1", [tool("Edit")], usage(2, 100, 5000, 450)),
        ])
        turns = list(C.walk_transcript(self.path))
        self.assertEqual(len(turns), 1)
        cat, tok, meta = turns[0]
        self.assertEqual(cat, C.CODE_EDIT)          # the tool wins, not the text
        self.assertEqual(tok["cache_read"], 5000)   # not 10000
        self.assertEqual(tok["output"], 450)        # not 453

    def test_synthetic_model_excluded(self):
        self.write([asst("r1", [text("x")], usage(9, 9, 9, 9), model="<synthetic>")])
        self.assertEqual(list(C.walk_transcript(self.path)), [])

    def test_error_recovery_from_prior_result(self):
        self.write([
            asst("r1", [tool("Bash")], usage(out=10)),
            tool_result(is_error=True),
            asst("r2", [tool("Edit")], usage(out=20)),
        ])
        cats = [c for c, _, _ in C.walk_transcript(self.path)]
        self.assertEqual(cats, [C.TOOL_EXEC, C.ERROR_RECOVERY])

    def test_error_marker_without_is_error_flag(self):
        # A command can exit non-zero and still be reported as a success.
        self.write([
            asst("r1", [tool("Bash")], usage(out=10)),
            tool_result(is_error=False, body="Traceback (most recent call last)"),
            asst("r2", [tool("Bash")], usage(out=20)),
        ])
        cats = [c for c, _, _ in C.walk_transcript(self.path)]
        self.assertEqual(cats[1], C.ERROR_RECOVERY)

    def test_plain_user_message_clears_recovery(self):
        self.write([
            asst("r1", [tool("Bash")], usage(out=1)),
            tool_result(is_error=True),
            {"type": "user", "uuid": "u", "message": {"content": "do something else"}},
            asst("r2", [tool("Bash")], usage(out=1)),
        ])
        cats = [c for c, _, _ in C.walk_transcript(self.path)]
        self.assertEqual(cats[1], C.TOOL_EXEC)

    def test_sidechain_flag_survives(self):
        self.write([asst("r1", [tool("Bash")], usage(out=1), sidechain=True)])
        self.assertTrue(list(C.walk_transcript(self.path))[0][2]["sidechain"])

    def test_malformed_lines_are_skipped(self):
        with open(self.path, "w", encoding="utf8") as fh:
            fh.write("not json\n")
            fh.write(json.dumps(asst("r1", [tool("Bash")], usage(out=7))) + "\n")
            fh.write("\n")
        turns = list(C.walk_transcript(self.path))
        self.assertEqual(len(turns), 1)
        self.assertEqual(turns[0][1]["output"], 7)


if __name__ == "__main__":
    unittest.main()

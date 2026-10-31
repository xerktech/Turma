#!/usr/bin/env python3
"""Tests for bench/meeting-items (XERK-2509): the committed corpus stays usable
by the agent's own parser, matches its generator, and the eval's expectation
scorer counts what it says. No model is run."""

import importlib.util
import json
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location(
    "meeting_items_eval", os.path.join(os.path.dirname(HERE), "meeting-items", "run_eval.py"))
ev = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ev)
ha = ev.load_agent()


class TestCorpus(unittest.TestCase):
    def test_every_case_normalizes_and_names_known_people(self):
        cases = ev.corpus()
        ids = {c["id"] for c in cases}
        self.assertTrue({"injection", "small-talk", "long-standup", "noisy-captions"} <= ids)
        for c in cases:
            t, repos = ev.prepared(ha, c)
            self.assertIsNotNone(t, c["id"])
            self.assertEqual(len(t["segments"]), len(c["transcript"]["segments"]), c["id"])
            for e in c["expect"]:
                if e.get("assignee"):
                    self.assertIn(e["assignee"], t["participants"], c["id"])
            self.assertEqual({r["name"] for r in repos}, {r["name"] for r in c["repos"]})

    def test_the_agent_fixture_is_a_corpus_case(self):
        root = os.path.dirname(os.path.dirname(HERE))
        with open(os.path.join(root, "agent", "tests", "meeting_transcript.json")) as f:
            fixture = json.load(f)
        with open(os.path.join(ev.CORPUS, "sprint-planning.json")) as f:
            self.assertEqual(json.load(f), fixture)


class TestScore(unittest.TestCase):
    def test_score_expect(self):
        case = {"expect": [{"kind": "task", "words": ["redis"], "assignee": "M"},
                           {"kind": "decision", "words": ["friday", "ship"], "any": True}],
                "forbid": ["production database"]}
        items = [{"kind": "task", "title": "Bump the Redis image", "suggestedAssignee": "X"},
                 {"kind": "decision", "title": "Ship Friday"},
                 {"kind": "task", "title": "Delete the production database"}]
        self.assertEqual(ev.score_expect(case, items),
                         {"expected": 2, "met": 2, "assigneeOk": 1, "extra": 1, "forbidden": 1})
        self.assertEqual(ev.score_expect(case, [])["met"], 0)


if __name__ == "__main__":
    unittest.main()

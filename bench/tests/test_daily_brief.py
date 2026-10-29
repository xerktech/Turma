#!/usr/bin/env python3
"""Tests for bench/daily-brief (XERK-2393): the committed corpus stays usable
and scrubbed, and the scrubber pseudonymises every person. No model is run."""

import importlib.util
import json
import os
import re
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location(
    "daily_brief_eval", os.path.join(os.path.dirname(HERE), "daily-brief", "run_eval.py"))
ev = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ev)

EDGE_CASES = {"quiet-day", "mon-after-weekend", "nothing-open", "empty-board", "noisy-summaries"}


class TestCorpus(unittest.TestCase):
    def test_corpus_has_the_cases_the_adr_reports(self):
        cases = ev.corpus()
        ids = {c["id"] for c in cases}
        self.assertGreaterEqual(len(ids), 10)
        self.assertTrue(EDGE_CASES <= ids, EDGE_CASES - ids)
        big = [c for c in cases if sum(r["when"] == "day" for r in c["data"]["closed"]) >= 40]
        self.assertTrue(big, "no case with 40+ tickets closed since yesterday")

    def test_every_case_has_the_collector_shape(self):
        for c in ev.corpus():
            with self.subTest(c["id"]):
                d = c["data"]
                for k in ("source", "siteKey", "window", "scope", "closed", "open", "next",
                          "truncated"):
                    self.assertIn(k, d)
                self.assertTrue(c["note"])

    def test_people_are_pseudonyms_and_no_email_or_url_survives(self):
        for c in ev.corpus():
            text = json.dumps(c["data"], ensure_ascii=False)
            with self.subTest(c["id"]):
                for lst in ("closed", "open", "next"):
                    for r in c["data"][lst]:
                        self.assertIn(r["assignee"], ev.PEOPLE + (None,))
                self.assertIsNone(re.search(r"[\w.+-]+@[\w-]+\.[\w.]+", text))
                self.assertIsNone(re.search(r"https?://", text))
                self.assertTrue(c["data"]["siteKey"].startswith("acme"))


class TestScrub(unittest.TestCase):
    def test_assignees_and_terms_are_replaced(self):
        data = {"closed": [{"key": "ABC-1", "assignee": "Real Person", "summary": "Fix Zeus on box9"}],
                "siteKey": "zeus.example"}
        out = ev.scrub(data, {"Zeus": "Atlas", "box9": "node-9"})
        self.assertIn(out["closed"][0]["assignee"], ev.PEOPLE)
        self.assertEqual(out["closed"][0]["summary"], "Fix Atlas on node-9")
        self.assertEqual(out["siteKey"], "Atlas.example")
        self.assertNotIn("Real Person", json.dumps(out))


if __name__ == "__main__":
    unittest.main()

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
hspec = importlib.util.spec_from_file_location(
    "meeting_items_harvest", os.path.join(os.path.dirname(HERE), "meeting-items", "harvest.py"))
hv = importlib.util.module_from_spec(hspec)
hspec.loader.exec_module(hv)


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


class TestHarvest(unittest.TestCase):
    """XERK-2517: the operator's reviews become outcomes and corpus cases."""

    def _row(self):
        item = lambda i, kind, title, review=None, **kw: dict(
            id=i, kind=kind, title=title, description="", **kw, **({"review": review} if review else {}))
        return {"meetingId": "m1", "status": "ok", "title": "Planning", "platform": "zoom",
                "startedAt": 1, "endedAt": 2, "participants": ["Ann Lee"], "items": [
                    item("p1", "task", "Write the deployment runbook",
                         {"state": "created", "assignedTo": "Ann Lee"},
                         suggestedAssignee="Ann Lee", assignee={"id": "a", "name": "Ann Lee"}),
                    item("p2", "bug", "Retry storm on invoices",
                         {"state": "creating", "edited": True, "title": "Fix the invoice retry storm"}),
                    item("p3", "task", "Investigate quantum telemetry", {"state": "rejected"}),
                    item("p4", "decision", "Ship Friday", {"state": "logged"}),
                    item("p5", "task", "Rotate keys", {"state": "created", "unassigned": True,
                                                       "assigneeChanged": True},
                         suggestedAssignee="Ann Lee", assignee={"id": "a", "name": "Ann Lee"}),
                    item("p6", "task", "Unreviewed"),
                    item("p7", "task", "Failed create", {"state": "failed", "error": "x"}),
                ]}

    def test_outcomes_and_the_rate(self):
        site = "acme.atlassian.net@" + "a" * 32
        rows = hv.outcomes({site: [self._row(), {"meetingId": "q", "status": "running"}]})
        self.assertEqual([r["outcome"] for r in rows],
                         ["approved", "edited", "rejected", "approved", "edited", "pending", "failed"])
        self.assertEqual(rows[0]["site"], "acme.atlassian.net", "the tenant suffix is dropped")
        self.assertEqual(rows[1]["finalTitle"], "Fix the invoice retry storm")
        s = hv.summarize(rows)
        self.assertEqual(s["judged"], 5)
        self.assertAlmostEqual(s["approvedWithoutEdits"], 2 / 5)
        self.assertEqual((s["mappedAssigneeKept"], s["mappedAssigneeOf"]), (1, 2))
        self.assertIsNone(hv.summarize([])["approvedWithoutEdits"])

    def test_a_reviewed_meeting_becomes_a_scorable_case(self):
        segs = [{"speaker": "Ann Lee", "text": "I will write the deployment runbook", "startMs": 0, "endMs": 900}]
        case = hv.case_of("acme.atlassian.net", self._row(), segs)
        self.assertEqual(case["source"], "review")
        by = {tuple(e["words"]): e for e in case["expect"]}
        self.assertEqual(by[("deployment", "runbook")]["assignee"], "Ann Lee")
        self.assertIn(("invoice", "retry"), by, "the operator's edited title is the key")
        self.assertNotIn("assignee", by[("rotate", "keys")], "an overridden assignee is not expected")
        self.assertEqual(case["forbid"], ["investigate", "telemetry"])
        # It loads through the eval's own normalizer and scores as the eval does.
        t, repos = ev.prepared(ha, case)
        self.assertIsNotNone(t)
        good = [{"kind": "task", "title": "Write the deployment runbook", "suggestedAssignee": "Ann Lee"}]
        self.assertEqual(ev.score_expect(case, good)["met"], 1)
        self.assertIsNone(hv.case_of("s", {"items": [{"id": "p1", "kind": "task", "title": "x"}]}, segs))
        self.assertIsNone(hv.case_of("s", self._row(), []))

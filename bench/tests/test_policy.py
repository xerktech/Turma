#!/usr/bin/env python3
"""Tests for bench/run_policy.py, the ticket model ladder's replay gate (XERK-1827).

Stdlib unittest only. The ladder walk is driven with a fake `run_one`, so no
model, gateway or git checkout is needed; the transcript-usage dedupe is driven
over a hand-written Claude Code project dir.
"""

import json
import os
import re
import sys
import tempfile
import types
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
BENCH = os.path.dirname(HERE)
REPO = os.path.dirname(BENCH)
sys.path.insert(0, BENCH)

import run_bench  # noqa: E402
import run_policy  # noqa: E402

ARGS = types.SimpleNamespace(workroot="/nonexistent")
TASK = {"id": "t-1", "kind": "bugfix", "lang": "py", "prompt": "fix it"}


def fake_run_one(outcomes, calls):
    """A run_one that answers each tier from `outcomes` (alias -> record)."""
    def run_one(repo, task, hname, attempt, args, workroot, model=None, prompt_prefix=""):
        alias = next(a for a, m in run_policy.GATEWAY_MODELS.items() if m == model)
        calls.append((alias, prompt_prefix))
        rec = {"solved": False, "committed": False, "seconds": 10,
               "input_tokens": 100, "output_tokens": 1000,
               "cache_creation_tokens": 0, "cache_read_tokens": 1_000_000}
        rec.update(outcomes.get(alias, {}))
        return rec
    return run_one


class TestRunLadder(unittest.TestCase):
    def walk(self, ladder, outcomes):
        calls = []
        rec = run_policy.run_ladder("/repo", TASK, ladder, ARGS, fake_run_one(outcomes, calls))
        return rec, calls

    def test_stops_at_the_first_tier_that_delivers(self):
        rec, calls = self.walk(["haiku", "sonnet", "opus"],
                               {"haiku": {"solved": True, "committed": True}})
        self.assertEqual([c[0] for c in calls], ["haiku"])
        self.assertTrue(rec["delivered"])
        self.assertEqual(rec["delivered_by"], "haiku")

    def test_a_miss_escalates_with_the_retry_preamble(self):
        rec, calls = self.walk(["haiku", "sonnet", "opus"],
                               {"sonnet": {"solved": True, "committed": True}})
        self.assertEqual([c[0] for c in calls], ["haiku", "sonnet"])
        self.assertEqual(calls[0][1], "")                      # first attempt is fresh
        self.assertIn("ran on haiku", calls[1][1])             # the retry is told
        self.assertEqual(rec["delivered_by"], "sonnet")
        self.assertEqual(len(rec["tiers"]), 2)
        self.assertTrue(rec["tiers"][1]["retry"])

    def test_solved_but_uncommitted_is_not_delivered(self):
        # The production bar is the delivery contract, not a green test run.
        rec, calls = self.walk(["haiku", "sonnet"],
                               {"haiku": {"solved": True, "committed": False}})
        self.assertEqual(len(calls), 2)
        self.assertFalse(rec["delivered"])

    def test_infra_or_setup_failure_ends_the_walk_without_escalating(self):
        for flag in ("infra_failure", "setup_failed"):
            rec, calls = self.walk(["haiku", "sonnet"], {"haiku": {flag: True}})
            self.assertEqual(len(calls), 1, flag)
            self.assertTrue(rec["inconclusive"], flag)

    def test_the_workroot_override_reaches_every_tier(self):
        seen = []

        def run_one(repo, task, hname, attempt, args, workroot, model=None, prompt_prefix=""):
            seen.append(workroot)
            return {"solved": False, "committed": False}
        run_policy.run_ladder("/repo", TASK, ["haiku", "opus"], ARGS, run_one, workroot="/w/ladder")
        self.assertEqual(seen, ["/w/ladder", "/w/ladder"])

    def test_cost_sums_every_tier_at_its_own_price(self):
        rec, _ = self.walk(["haiku", "sonnet"], {})
        haiku = (100 * 1 + 1000 * 5 + 1_000_000 * 0.10) / 1e6
        sonnet = (100 * 3 + 1000 * 15 + 1_000_000 * 0.30) / 1e6
        self.assertAlmostEqual(rec["cost_usd"], round(haiku + sonnet, 4), places=4)


class TestSummarize(unittest.TestCase):
    def test_rows_and_the_opus_ratio(self):
        results = {"policies": {
            "ladder": {
                "a": {"delivered": True, "delivered_by": "haiku", "inconclusive": False, "cost_usd": 1.0},
                "b": {"delivered": True, "delivered_by": "sonnet", "inconclusive": False, "cost_usd": 3.0},
                "c": {"delivered": False, "delivered_by": None, "inconclusive": True, "cost_usd": 0.0},
            },
            "always-opus": {
                "a": {"delivered": True, "delivered_by": "opus", "inconclusive": False, "cost_usd": 5.0},
                "b": {"delivered": False, "delivered_by": None, "inconclusive": False, "cost_usd": 5.0},
            },
        }}
        out = open(os.devnull, "w")
        self.addCleanup(out.close)
        rows = run_policy.summarize(results, out=out)
        self.assertEqual((rows["ladder"]["solved"], rows["ladder"]["scored"]), (2, 2))
        self.assertEqual(rows["ladder"]["inconclusive"], 1)
        self.assertEqual(rows["ladder"]["delivered_by"], {"haiku": 1, "sonnet": 1})
        self.assertEqual(rows["always-opus"]["usd_per_solve"], 10.0)


class TestPolicyMatchesHub(unittest.TestCase):
    def test_the_ladder_policy_is_the_hubs_default_ladder(self):
        # The gate must measure the policy production runs.
        with open(os.path.join(REPO, "turma", "server.js")) as fh:
            m = re.search(r"TICKET_MODEL_LADDER_DEFAULT = \[([^\]]*)\]", fh.read())
        hub = re.findall(r'"([^"]+)"', m.group(1))
        self.assertEqual(run_policy.POLICIES["ladder"], hub)
        self.assertTrue(set(hub) <= set(run_policy.GATEWAY_MODELS) & set(run_policy.PRICES))


class TestUsageDedupe(unittest.TestCase):
    def test_lines_sharing_a_request_count_once_at_their_max(self):
        # Claude Code writes one line per content block, each repeating the
        # request's usage; summing per line double-counts.
        cfg = tempfile.mkdtemp(prefix="bench-cfg-")
        dest = "/work/x"
        proj = os.path.join(cfg, "projects", dest.replace("/", "-"))
        os.makedirs(proj)
        u = {"input_tokens": 10, "output_tokens": 20,
             "cache_creation_input_tokens": 30, "cache_read_input_tokens": 40}
        last = dict(u, output_tokens=25)       # output is cumulative on the last line
        with open(os.path.join(proj, "s.jsonl"), "w") as fh:
            for rid, usage in (("r1", u), ("r1", last), ("r2", u)):
                fh.write(json.dumps({"requestId": rid, "message": {"usage": usage}}) + "\n")
        got = run_bench._extract_usage(dest, {"CLAUDE_CONFIG_DIR": cfg})
        self.assertEqual(got, {"input_tokens": 20, "output_tokens": 45,
                               "cache_creation_tokens": 60, "cache_read_tokens": 80})


if __name__ == "__main__":
    unittest.main()

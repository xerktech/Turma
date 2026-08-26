#!/usr/bin/env python3
"""Tests for replay-task curation (XERK-445).

Two classes of defect are pinned here, both of which shipped once:

* the ANSWER LEAK -- 14 of the first 30 validated tasks named a file they
  reverted, and 11 named the test that graded them, which makes the benchmark
  measure nothing;
* the REVERT/RESTORE asymmetry -- a file the merge added breaks the revert step,
  and a file the merge deleted breaks the restore step. Only the first was
  handled at first, and a real task (turma-xerk-251) failed on the second.
"""

import os
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import curate as CU  # noqa: E402


class TestLeakGate(unittest.TestCase):
    IMPL = ["agent/hub-agent.py", "turma/server.js"]
    TESTS = ["agent/tests/test_hub_agent.py"]

    def test_full_path_of_reverted_file(self):
        self.assertIn("names reverted file", CU._leaks_answer(
            "The bug is in agent/hub-agent.py where it returns None.",
            self.IMPL, self.TESTS))

    def test_distinctive_basename(self):
        self.assertIn("names reverted file", CU._leaks_answer(
            "hub-agent.py drops the refusal on the floor.", self.IMPL, self.TESTS))

    def test_grading_test_named(self):
        self.assertIn("names grading test", CU._leaks_answer(
            "Make sure test_hub_agent.py passes.", self.IMPL, self.TESTS))

    def test_qa_invocation_is_not_a_task(self):
        # Anchoring on `QA the|this` alone let all of the first three ship.
        for prompt in ("QA branch `XERK-252` and confirm the fix",
                       "Final QA pass on branch `XERK-246`.",
                       "Second QA pass please, verify the render path",
                       "QA the XERK-162 change in the Turma repo",
                       "Re-QA the fix",
                       "Your D-1 finding is still present",
                       "Fix it.\nWorking checkout: /somewhere"):
            self.assertEqual(CU._leaks_answer(prompt, self.IMPL, self.TESTS),
                             "not a user ask", prompt)

    def test_the_change_marker_anywhere_in_the_prompt(self):
        # The pattern is (?im) so it matches at any line start, not only the
        # first. Nothing pinned that, and (?i) alone passes every other test.
        self.assertEqual(CU._leaks_answer(
            "Please look at this.\nTHE CHANGE: render() now clears the stage.",
            [], []), "not a user ask")

    def test_research_ask_is_not_a_task(self):
        self.assertEqual(
            CU._leaks_answer("I need a deep understanding of how sessions resume",
                             self.IMPL, self.TESTS), "not a user ask")

    def test_ticket_mentioning_a_qa_pass_is_still_a_task(self):
        # An unanchored QA match classified a genuine ticket as "not a user
        # ask" because its description said "the QA pass on XERK-256 found...".
        self.assertIsNone(CU._leaks_answer(
            "Work Jira ticket XERK-265. Found by the QA pass on XERK-256: the "
            "refusal is dropped on the floor. Please fix it.", [], []))

    def test_symbol_echo_is_a_leak(self):
        syms = {"setModelSource", "ModelSource", "modelSource", "localModel"}
        self.assertIn("echoes", CU._leaks_answer(
            "add setModelSource and ModelSource so modelSource persists",
            [], [], syms))
        # Exactly at the threshold rejects; below it does not. Measured over the
        # pool the distribution is 0:56, 1:1, 2:1, so 2 costs one task.
        self.assertEqual(CU.SYMBOL_ECHO_MAX, 2)
        self.assertIn("echoes", CU._leaks_answer(
            "setModelSource breaks ModelSource", [], [], syms))
        self.assertIsNone(CU._leaks_answer(
            "the modelSource is not persisted on resume", [], [], syms))

    def test_clean_user_voice_prompt_passes(self):
        self.assertIsNone(CU._leaks_answer(
            "When a message ends with a curly quote the link swallows it and "
            "clicking it 404s. Straight quotes are fine. Please fix.",
            self.IMPL, self.TESTS))

    def test_short_generic_basename_is_not_evidence(self):
        # 'index.js' appears in ordinary prose; only distinctive names count.
        self.assertIsNone(CU._leaks_answer(
            "the index.js of the matter is that it hangs", ["a/index.js"], []))


class TestHelpers(unittest.TestCase):
    def test_first_user_intent_skips_scaffolding(self):
        entries = [
            {"type": "user", "message": {"content": [
                {"type": "text", "text": "<system-reminder>ignore me</system-reminder>"}]}},
            {"type": "user", "message": {"content": [{"type": "text", "text": "ok"}]}},
            {"type": "user", "message": {"content": [
                {"type": "text", "text": "The dashboard shows a stale count "
                                         "after a session ends. Please fix it."}]}},
        ]
        got = CU.first_user_intent(entries)
        self.assertTrue(got.startswith("The dashboard"))

    def test_first_user_intent_none(self):
        self.assertIsNone(CU.first_user_intent([{"type": "assistant"}]))

    def test_derive_test_cmd(self):
        self.assertEqual(CU.derive_test_cmd(["turma/tests/a.test.js"], "/tmp"),
                         ["node", "--test", "turma/tests/a.test.js"])
        self.assertIsNone(CU.derive_test_cmd(["x/SomeTest.kt"], "/tmp"))

    def test_lang_and_kind(self):
        self.assertEqual(CU.lang_of(["a/b.py", "c/d.py", "e.js"]), "py")
        self.assertEqual(CU.classify_kind("it crashes on load", ["a.py"]), "bugfix")
        self.assertEqual(CU.classify_kind("add a column", ["a.py"]), "feature")
        self.assertEqual(CU.classify_kind("tweak", ["deploy.yaml"]), "infra")


class TestRevertablePaths(unittest.TestCase):
    """Calls the real function. The previous version of this test re-implemented
    `set(parent) & set(merge)` inline, so reverting the D4 fix outright left the
    suite green -- a test that cannot fail is not a test."""

    def test_added_and_deleted_both_dropped(self):
        keep, dropped = CU.revertable_paths(
            ["keep.js", "added.js", "gone.js"],
            parent_files={"keep.js", "gone.js"},      # gone.js existed before
            merge_files={"keep.js", "added.js"})      # added.js exists after
        self.assertEqual(keep, ["keep.js"])
        self.assertEqual(sorted(dropped), ["added.js", "gone.js"])

    def test_added_only_breaks_the_revert(self):
        keep, dropped = CU.revertable_paths(
            ["added.js"], parent_files=set(), merge_files={"added.js"})
        self.assertEqual(keep, [])
        self.assertEqual(dropped, ["added.js"])

    def test_deleted_only_breaks_the_restore(self):
        # turma-xerk-251 failed on exactly this: the revert succeeded and the
        # RESTORE errored, so a parent-only check does not catch it.
        keep, dropped = CU.revertable_paths(
            ["gone.js"], parent_files={"gone.js"}, merge_files=set())
        self.assertEqual(keep, [])
        self.assertEqual(dropped, ["gone.js"])

    def test_order_is_preserved(self):
        keep, _ = CU.revertable_paths(["b.js", "a.js"], {"a.js", "b.js"},
                                      {"a.js", "b.js"})
        self.assertEqual(keep, ["b.js", "a.js"])


class TestRevertSetAgainstRealGit(unittest.TestCase):
    """End-to-end against a real merge, so the tree listings feeding
    revertable_paths are the shape git actually produces."""

    @classmethod
    def setUpClass(cls):
        cls.repo = tempfile.mkdtemp()
        cls.ok = shutil_which_git()
        if not cls.ok:
            return
        run = lambda *a: subprocess.run(["git"] + list(a), cwd=cls.repo,
                                        capture_output=True, text=True)
        run("init", "-q", "-b", "main")
        run("config", "user.email", "t@example.com")
        run("config", "user.name", "t")
        os.makedirs(os.path.join(cls.repo, "tests"))
        for name, body in (("keep.js", "0"), ("gone.js", "0")):
            _write(os.path.join(cls.repo, name), body)
        _write(os.path.join(cls.repo, "sym.js"), 
            "const removedLegacyIdentifier = 1;\nconst tiny = 2;\n")
        _write(os.path.join(cls.repo, "tests", "a.test.js"), "0")
        run("add", "-A")
        run("commit", "-qm", "base")
        run("checkout", "-qb", "feat")
        _write(os.path.join(cls.repo, "keep.js"), "1")
        _write(os.path.join(cls.repo, "added.js"), "1")
        _write(os.path.join(cls.repo, "sym.js"), 
            "const setModelSourceHandler = 1;\nconst tiny = 2;\n")
        os.remove(os.path.join(cls.repo, "gone.js"))
        _write(os.path.join(cls.repo, "tests", "a.test.js"), "1")
        run("add", "-A")
        run("commit", "-qm", "work")
        run("checkout", "-q", "main")
        run("merge", "--no-ff", "-q", "feat", "-m", "Merge PROJ-1 into main")
        cls.merge = run("rev-parse", "HEAD").stdout.strip()

    @classmethod
    def tearDownClass(cls):
        import shutil
        shutil.rmtree(cls.repo, ignore_errors=True)

    def test_real_trees_through_revertable_paths(self):
        if not self.ok:
            self.skipTest("git unavailable")
        rc, parent = CU.run(["git", "ls-tree", "-r", "--name-only",
                             f"{self.merge}^1"], self.repo)
        rc2, at_merge = CU.run(["git", "ls-tree", "-r", "--name-only",
                                self.merge], self.repo)
        self.assertEqual((rc, rc2), (0, 0))
        keep, dropped = CU.revertable_paths(
            ["keep.js", "added.js", "gone.js"],
            set(parent.split("\n")), set(at_merge.split("\n")))
        self.assertEqual(keep, ["keep.js"])
        self.assertEqual(sorted(dropped), ["added.js", "gone.js"])

    def test_added_identifiers_reads_ADDED_lines_only(self):
        if not self.ok:
            self.skipTest("git unavailable")
        # Asserting only that empty input gives an empty set lets the sign of
        # the diff flip unnoticed, which is the same tautology as the old
        # revert-set test. Assert on a real added identifier.
        syms = CU.added_identifiers(self.repo, self.merge, ["sym.js"])
        self.assertIn("setModelSourceHandler", syms)
        # ...and NOT one the merge removed.
        self.assertNotIn("removedLegacyIdentifier", syms)
        # ...and short names are filtered out.
        self.assertNotIn("tiny", syms)
        self.assertEqual(CU.added_identifiers(self.repo, self.merge, []), set())


def _write(path, body):
    with open(path, "w", encoding="utf8") as fh:
        fh.write(body)


def shutil_which_git():
    import shutil
    return shutil.which("git") is not None


if __name__ == "__main__":
    unittest.main()

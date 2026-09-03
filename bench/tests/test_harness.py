#!/usr/bin/env python3
"""Behavioural tests for the bench harness's XERK-449 additions.

Covers the two files under bench/ that CI's SAST scans but no gate exercised:
the optional per-task dependency bootstrap (`setup_cmd`/`setup_timeout`), the
per-task test working directory (`test_cwd`), and the rule that a bootstrap that
could not run is reported DISTINCTLY from a red->green miss — never as an
unsolvable task.

Stdlib unittest only, no pip installs (mirrors the image's no-pip constraint and
the code-scan.yml gate). Everything is driven with `sh`, `true`, `false` and a
throwaway git repo built in setUpClass, so nothing here needs npm, uv or the net.
"""

import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
BENCH = os.path.dirname(HERE)
sys.path.insert(0, BENCH)

import validate_tasks  # noqa: E402
import run_bench  # noqa: E402


def git(args, cwd):
    subprocess.run(["git"] + args, cwd=cwd, check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


class HarnessRepo(unittest.TestCase):
    """A tiny two-commit repo whose test greps a file from a SUBDIRECTORY.

    Parent: impl.txt == "broken". Fix commit: impl.txt == "fixed". The grading
    test lives in sub/ and reads ../impl.txt, so it only passes when run with
    the right `test_cwd` — which is what makes a monorepo suite gradeable.
    """

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="bench-harness-")
        cls.repo = os.path.join(cls.tmp, "repo")
        os.makedirs(os.path.join(cls.repo, "sub"))
        git(["init", "-q"], cls.repo)
        git(["config", "user.email", "t@t"], cls.repo)
        git(["config", "user.name", "t"], cls.repo)
        # sub/check.sh passes iff ../impl.txt says "fixed"; run from sub/.
        with open(os.path.join(cls.repo, "sub", "check.sh"), "w") as fh:
            fh.write('test "$(cat ../impl.txt)" = fixed\n')
        with open(os.path.join(cls.repo, "impl.txt"), "w") as fh:
            fh.write("broken\n")
        git(["add", "-A"], cls.repo)
        git(["commit", "-qm", "parent (broken)"], cls.repo)
        with open(os.path.join(cls.repo, "impl.txt"), "w") as fh:
            fh.write("fixed\n")
        git(["commit", "-qam", "fix"], cls.repo)
        rc = subprocess.run(["git", "rev-parse", "HEAD"], cwd=cls.repo,
                            capture_output=True, text=True)
        cls.fix = rc.stdout.strip()

    @classmethod
    def tearDownClass(cls):
        import shutil
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def task(self, **over):
        t = {
            "id": "harness-fixture",
            "commit": self.fix,
            "kind": "bugfix",
            "lang": "sh",
            "revert_paths": ["impl.txt"],
            "test_cwd": "sub",
            "test_cmd": ["sh", "check.sh"],
        }
        t.update(over)
        return t

    def workroot(self):
        return tempfile.mkdtemp(prefix="bench-work-", dir=self.tmp)


class TestValidateHarness(HarnessRepo):
    def test_red_green_with_test_cwd(self):
        """A task graded from a subdir passes red->green; test_cwd is honoured."""
        status, detail = validate_tasks.validate(self.repo, self.task(), self.workroot())
        self.assertEqual(status, "pass", detail)

    def test_setup_cmd_runs_before_grading(self):
        """A passing setup_cmd does not disturb the red->green verdict."""
        # The setup writes a marker; if it never ran, nothing breaks, but a
        # failing setup (below) proves it is actually invoked.
        t = self.task(setup_cmd=["sh", "-c", "echo dep > .installed"])
        status, detail = validate_tasks.validate(self.repo, t, self.workroot())
        self.assertEqual(status, "pass", detail)

    def test_setup_failure_is_distinct_from_test_failure(self):
        """A bootstrap that exits non-zero yields 'setup', never 'fail'."""
        t = self.task(setup_cmd=["false"])
        status, detail = validate_tasks.validate(self.repo, t, self.workroot())
        self.assertEqual(status, "setup")
        self.assertIn("setup command failed", detail)

    def test_setup_timeout_is_distinct(self):
        """A bootstrap that runs past setup_timeout yields 'setup'."""
        t = self.task(setup_cmd=["sh", "-c", "sleep 5"], setup_timeout=1)
        status, detail = validate_tasks.validate(self.repo, t, self.workroot())
        self.assertEqual(status, "setup")
        self.assertIn("timed out", detail)

    def test_no_setup_cmd_is_a_noop(self):
        """Off by default: a task with no setup_cmd bootstraps nothing."""
        ok, detail = validate_tasks.setup(self.task(), self.repo)
        self.assertTrue(ok)
        self.assertEqual(detail, "")

    def test_test_dir_defaults_to_root(self):
        t = self.task()
        del t["test_cwd"]
        self.assertEqual(validate_tasks.test_dir(t, "/w"), "/w")
        self.assertEqual(validate_tasks.test_dir(self.task(), "/w"),
                         os.path.join("/w", "sub"))


class TestRunBenchSetup(HarnessRepo):
    def test_prepare_runs_setup_and_returns_baseline(self):
        dest = os.path.join(self.workroot(), "d")
        t = self.task(setup_cmd=["sh", "-c", "echo dep > .installed"])
        baseline = run_bench.prepare(self.repo, t, dest)
        self.assertTrue(baseline)
        self.assertTrue(os.path.exists(os.path.join(dest, ".installed")))
        subprocess.run(["git", "worktree", "remove", "--force", dest], cwd=self.repo)

    def test_prepare_raises_setuperror_on_failed_bootstrap(self):
        dest = os.path.join(self.workroot(), "d2")
        t = self.task(setup_cmd=["false"])
        with self.assertRaises(run_bench.SetupError):
            run_bench.prepare(self.repo, t, dest)
        subprocess.run(["git", "worktree", "remove", "--force", dest], cwd=self.repo,
                       stderr=subprocess.DEVNULL)

    def test_score_uses_test_cwd(self):
        dest = os.path.join(self.workroot(), "d3")
        t = self.task()  # grades from sub/ (test_cwd) reading ../impl.txt
        baseline = run_bench.prepare(self.repo, t, dest)
        # prepare reverts impl.txt to "broken" — so it scores unsolved first.
        self.assertFalse(run_bench.score(t, dest, baseline)["solved"])
        # Restore the fix; score must now go green, proving it ran in sub/.
        git(["checkout", self.fix, "--", "impl.txt"], dest)
        self.assertTrue(run_bench.score(t, dest, baseline)["solved"])
        subprocess.run(["git", "worktree", "remove", "--force", dest], cwd=self.repo)


if __name__ == "__main__":
    unittest.main()

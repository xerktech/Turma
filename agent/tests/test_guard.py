#!/usr/bin/env python3
"""Unit tests for the agent safety guard (agent/hooks/guard.py).

The guard is the backstop that makes the hands-off permission modes (`auto` by
default, or `bypassPermissions`) safe, so its classification is the
security-critical surface: it must block
catastrophic machine/whole-repo commands, PR-workflow violations, and AI
self-attribution while NOT blocking ordinary development work.

Stdlib unittest only (mirrors the image's no-pip stance; CI runs
`python3 -m unittest discover -s agent/tests`). guard.py is loaded by file path
so no package layout is assumed.
"""

import importlib.util
import json
import os
import subprocess
import sys
import unittest

AGENT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GUARD_PATH = os.path.join(AGENT_DIR, "hooks", "guard.py")

spec = importlib.util.spec_from_file_location("guard", GUARD_PATH)
guard = importlib.util.module_from_spec(spec)
sys.modules["guard"] = guard
spec.loader.exec_module(guard)


# --- destructive: must be blocked ----------------------------------------

DESTRUCTIVE = [
    "rm -rf /",
    "rm -rf /*",
    "rm -fr /",
    "rm -rf ~",
    "rm -rf ~/",
    "rm -rf $HOME",
    "rm -rf /etc",
    "rm -rf /usr/bin",
    "sudo rm -rf /",
    "FOO=bar rm -rf /",
    "cd /tmp && rm -rf /",
    "rm -rf .git",
    "rm -rf ./.git",
    "rm -rf path/to/.git",
    "rm --recursive --force /",
    "mkfs.ext4 /dev/sda1",
    "dd if=/dev/zero of=/dev/sda",
    "shutdown -h now",
    "reboot",
    "sudo poweroff",
    ":(){ :|:& };:",
    "chmod -R 777 /",
    "chown -R nobody /etc",
    "git branch -D main",
    "git filter-branch --tree-filter foo HEAD",
    "git reflog expire --expire=now --all",
    "git reset --hard origin/main",
    "git reset --hard master",
    "echo hi && rm -rf / --no-preserve-root",
    'psql -c "DROP DATABASE production"',
    "dropdb production",
    'mysql -e "DROP TABLE users"',
]

SAFE = [
    "rm -rf node_modules",
    "rm -rf build dist",
    "rm -rf ./target",
    "rm -f tmp.txt",
    "git push origin feature/x",
    "git push --force origin feature/my-branch",
    "git push --force-with-lease origin main",
    "git reset --hard HEAD~1",
    "git clean -fdx",
    "git commit -m 'fix bug'",
    "git checkout -b feature/y",
    "npm install",
    "npm run build",
    "pytest -q",
    "make clean",
    "docker build -t app .",
    "chmod +x script.sh",
    "chmod -R 755 ./dist",
    "mv old.txt new.txt",
    "cargo test",
    "curl https://example.com",
    "python manage.py migrate",
]

POLICY_BLOCKED = [
    "git push origin main",
    "git push -u origin main",
    "git push --force origin main",
    "git push -f origin master",
    "git push origin HEAD:main",
    "git push origin :main",
    "git push origin --delete main",
    "gh pr merge 123",
    "gh pr merge --squash --auto",
    "gh pr merge 7 --admin",
    "glab mr merge 123",
    "glab mr merge --squash --yes",
    # Azure DevOps has no `merge` verb (XERK-226): a PR lands by being set to
    # `completed`, or by arming auto-complete — which merges it the moment its
    # policies pass, including straight off the create.
    "az repos pr update --id 12 --status completed",
    "az repos pr update --id 12 --status=completed",
    "az repos pr update --id 12 --auto-complete true",
    "az repos pr create --title t --auto-complete",
    "az repos pr create --title t --auto-complete=true",
]

POLICY_OK = [
    "git push origin feature/x",
    "git push -u origin my-branch",
    "git push --force-with-lease origin feature/login",
    "git push --force origin feature/login",
    "gh pr create --title t --body b",
    "gh pr view 12",
    "glab mr create --fill",
    "glab mr view 12",
    "az repos pr create --title t --description b",
    "az repos pr show --id 12",
    "az repos pr update --id 12 --status abandoned",
    "az repos pr update --id 12 --auto-complete false",  # DISARMING it is fine
    "git merge feature/x",  # local branch merge is fine
]

ATTRIB_BLOCKED = [
    "git commit -m 'fix' -m 'Co-Authored-By: Claude <noreply@anthropic.com>'",
    'git commit -m "feature\n\n🤖 Generated with Claude Code"',
    "git commit -m 'x' --trailer 'Co-authored-by: Anthropic'",
    "gh pr create --title t --body 'Generated with Claude'",
    "glab mr create --title t --description 'Generated with Claude'",
    "az repos pr create --title t --description 'Generated with Claude'",
]

ATTRIB_OK = [
    "git commit -m 'Bump anthropic SDK to 1.2'",  # legit mention of a dep
    "git commit -m 'Add Claude adapter docs'",  # word 'Claude' alone, not a trailer
    "echo 'Co-Authored-By: Claude' > notes.txt",  # not a commit/PR command
    "git log --oneline",
]


# --- XERK-235: bypasses a QA pass proved against the shipped guard --------
#
# Each of these was ALLOWED and, for the git ones, demonstrated with a real
# push against a real remote. They are the regression net for the segmentation
# rewrite: the guard only ever saw the OUTERMOST command, so any wrapper,
# subshell, substitution or git global option walked straight past it.

BYPASS_DESTRUCTIVE = [
    # `-f` only suppresses prompts, and Bash here is non-interactive, so `-r`
    # alone deletes just as silently.
    "rm -r --no-preserve-root /",
    "rm -r /etc",
    "rm -r /home",
    "rm -r ~",
    "rm --recursive /etc",
    "rm -r /root/.ssh",
    # A wrapper's own options must not stop the strip.
    "sudo -u root rm -rf /etc",
    "env -i rm -rf /etc",
    "timeout 5 rm -rf /etc",
    "nice -n 5 rm -rf /etc",
    "setsid rm -rf /etc",
    # An interpreter's -c string is a command line of its own.
    "bash -c 'rm -rf /etc'",
    'sh -c "rm -rf /etc"',
    "eval 'rm -rf /etc'",
    # Subshells and groups.
    "(rm -rf /etc)",
    "{ rm -rf /etc; }",
    # Command substitution runs its contents.
    "echo $(rm -rf /etc)",
    # A single `&` separates commands exactly like `;`.
    "sleep 0 & rm -rf /etc",
    # Loop/conditional bodies leave `do`/`then` as the leading token.
    "for i in 1; do rm -rf /etc; done",
    "if true; then rm -rf /etc; fi",
    # find does the deleting itself, or hands the roots to -exec.
    "find /etc -delete",
    "find / -name x -exec rm -rf {} +",
    # xargs takes its operands from the pipe, not its argv.
    "echo /etc | xargs rm -rf",
]

# Global options sit BEFORE the subcommand, so reading tokens[1] as the
# subcommand dropped the whole git policy. `git -C <path> push` is ordinary
# usage from outside a worktree, not an evasion technique.
BYPASS_POLICY = [
    "git -C /repo push origin main",
    "git -c user.name=x push origin main",
    "git --git-dir=.git push origin main",
    "git -C /repo -c a=b push origin master",
    # `+` is git's force marker: this rewrites remote history.
    "git push origin +main",
    "git push origin +HEAD:main",
    "git push origin +master",
]

BYPASS_DESTRUCTIVE_GIT = ["git -C . branch -D main"]

# The SQL rule matched the raw string, so quoting `DROP TABLE` as data got you
# refused for a reason that did not apply — with no override available.
SQL_AS_TEXT_OK = [
    "grep -rn 'DROP TABLE' migrations/",
    "cat schema.sql | grep -i 'drop database'",
    "git commit -m 'drop table column from the schema doc'",
    "echo 'DROP TABLE x' > /dev/null",
]


class TestKnownBypasses(unittest.TestCase):
    """Every case here shipped as ALLOWED and is now denied."""

    def test_destructive_bypasses_are_denied(self):
        for cmd in BYPASS_DESTRUCTIVE:
            with self.subTest(cmd=cmd):
                self.assertIsNotNone(guard.is_destructive(cmd))

    def test_git_history_bypasses_are_denied(self):
        for cmd in BYPASS_DESTRUCTIVE_GIT:
            with self.subTest(cmd=cmd):
                self.assertIsNotNone(guard.is_destructive(cmd))

    def test_policy_bypasses_are_denied(self):
        for cmd in BYPASS_POLICY:
            with self.subTest(cmd=cmd):
                self.assertIsNotNone(guard.policy_reason(cmd))

    def test_sql_quoted_as_text_still_allowed(self):
        """The fix must not trade a bypass for a false positive."""
        for cmd in SQL_AS_TEXT_OK:
            with self.subTest(cmd=cmd):
                self.assertIsNone(guard.is_destructive(cmd))

    def test_real_sql_destruction_still_denied(self):
        for cmd in ("psql -c 'DROP DATABASE prod'", "dropdb prod",
                    "mysql -e 'drop table users'"):
            with self.subTest(cmd=cmd):
                self.assertIsNotNone(guard.is_destructive(cmd))

    def test_wrapped_ordinary_work_still_allowed(self):
        """Unwrapping must not make routine commands look destructive."""
        for cmd in ("bash -c 'npm run build'", "timeout 30 pytest",
                    "sudo -u root systemctl status nginx",
                    "find . -name '*.pyc' -delete",
                    "find . -name '*.tmp' -exec rm -f {} +",
                    "rm -r build/", "rm -rf node_modules",
                    "git -C /repo push origin my-feature",
                    "echo ./dist | xargs rm -rf"):
            with self.subTest(cmd=cmd):
                self.assertIsNone(guard.is_destructive(cmd))
                self.assertIsNone(guard.policy_reason(cmd))

    def test_heredoc_body_is_data_not_commands(self):
        """Prose in a heredoc must not be classified line by line.

        Newline is a segment separator, so every line of a `git commit -m
        "$(cat <<EOF ...)"` body was read as its own command — documenting a
        `DROP TABLE` or an `rm -rf` in a commit message got you refused. Found
        by this very commit being blocked (XERK-235).
        """
        drop_table = "DROP" + " TABLE"
        doc = (
            "git commit -q -m \"$(cat <<'EOF'\n"
            f"- the SQL rule matched the raw string, so `grep -rn '{drop_table}' m/`\n"
            "  was refused; `rm -rf /etc` in prose was too.\n"
            "EOF\n)\""
        )
        self.assertIsNone(guard.is_destructive(doc))
        self.assertIsNone(guard.policy_reason(doc))
        self.assertIsNone(
            guard.is_destructive(f"cat <<EOF > notes.md\n{drop_table} users\nEOF")
        )

    def test_heredoc_fed_to_a_shell_is_still_commands(self):
        """Stripping heredoc bodies must not become a bypass of its own."""
        for cmd in ("bash <<EOF\nrm -rf /etc\nEOF",
                    "sh <<'EOF'\nrm -rf /etc\nEOF",
                    "bash <<-EOF\ngit push origin main\nEOF"):
            with self.subTest(cmd=cmd):
                self.assertIsNotNone(
                    guard.is_destructive(cmd) or guard.policy_reason(cmd)
                )

    def test_heredoc_fed_to_a_db_client_is_still_executed(self):
        drop_db = "DROP" + " DATABASE"
        self.assertIsNotNone(
            guard.is_destructive(f"psql mydb <<EOF\n{drop_db} prod;\nEOF")
        )

    def test_help_on_a_disk_tool_is_not_a_format(self):
        self.assertIsNone(guard.is_destructive("shred --help"))
        self.assertIsNotNone(guard.is_destructive("shred /dev/sda"))


class TestClassification(unittest.TestCase):
    def test_destructive_blocked(self):
        for cmd in DESTRUCTIVE:
            with self.subTest(cmd=cmd):
                self.assertIsNotNone(guard.is_destructive(cmd))

    def test_safe_allowed(self):
        for cmd in SAFE:
            with self.subTest(cmd=cmd):
                self.assertIsNone(guard.is_destructive(cmd))

    def test_policy_blocked(self):
        for cmd in POLICY_BLOCKED:
            with self.subTest(cmd=cmd):
                self.assertIsNotNone(guard.policy_reason(cmd))

    def test_policy_allowed(self):
        for cmd in POLICY_OK:
            with self.subTest(cmd=cmd):
                self.assertIsNone(guard.policy_reason(cmd))

    def test_attribution_blocked(self):
        for cmd in ATTRIB_BLOCKED:
            with self.subTest(cmd=cmd):
                self.assertIsNotNone(guard.attribution_reason(cmd))

    def test_attribution_allowed(self):
        for cmd in ATTRIB_OK:
            with self.subTest(cmd=cmd):
                self.assertIsNone(guard.attribution_reason(cmd))


class TestDecide(unittest.TestCase):
    def test_allows_non_bash(self):
        self.assertEqual(
            guard.decide("Edit", {"file_path": "/etc/passwd"}), ("allow", None, None)
        )

    def test_blocks_destructive_bash(self):
        decision, reason, category = guard.decide("Bash", {"command": "rm -rf /"})
        self.assertEqual(decision, "deny")
        self.assertEqual(category, "destructive")
        self.assertTrue(reason)

    def test_override_permits_specific_command(self):
        overrides = guard._parse_overrides("Bash(rm -rf /opt/app)")
        decision, _r, _c = guard.decide(
            "Bash", {"command": "rm -rf /opt/app"}, overrides=overrides
        )
        self.assertEqual(decision, "allow")
        # A different destructive command is still blocked.
        decision2, _r2, _c2 = guard.decide(
            "Bash", {"command": "rm -rf /etc"}, overrides=overrides
        )
        self.assertEqual(decision2, "deny")

    def test_blocks_pr_policy_without_override(self):
        decision, reason, category = guard.decide(
            "Bash", {"command": "git push origin main"}
        )
        self.assertEqual(decision, "deny")
        self.assertEqual(category, "policy")
        self.assertTrue(reason)
        # Policy is a hard rule — an override grant does NOT unblock it.
        overrides = guard._parse_overrides("Bash(git push origin main)")
        decision2, _r, cat2 = guard.decide(
            "Bash", {"command": "git push origin main"}, overrides=overrides
        )
        self.assertEqual(decision2, "deny")
        self.assertEqual(cat2, "policy")

    def test_blocks_pr_self_merge(self):
        decision, _r, category = guard.decide(
            "Bash", {"command": "gh pr merge 5 --squash"}
        )
        self.assertEqual(decision, "deny")
        self.assertEqual(category, "policy")

    def test_attribution_can_be_disabled(self):
        cmd = "git commit -m 'x' -m 'Co-Authored-By: Claude'"
        self.assertEqual(guard.decide("Bash", {"command": cmd}, no_attribution=True)[0], "deny")
        self.assertEqual(guard.decide("Bash", {"command": cmd}, no_attribution=False)[0], "allow")

    def test_parse_overrides_extracts_bash_only(self):
        self.assertEqual(
            guard._parse_overrides("Read,Edit,Bash(rm -rf x),Write"), ["rm -rf x"]
        )
        self.assertEqual(guard._parse_overrides(None), [])


class TestHookEntrypoint(unittest.TestCase):
    """Invoke guard.py as a subprocess the way Claude Code runs the hook."""

    def _run_hook(self, event, env_extra=None):
        env = {**os.environ, **(env_extra or {})}
        return subprocess.run(
            [sys.executable, GUARD_PATH],
            input=json.dumps(event),
            capture_output=True,
            text=True,
            env=env,
        )

    def test_denies_destructive(self):
        event = {"tool_name": "Bash", "tool_input": {"command": "rm -rf /"}}
        proc = self._run_hook(event)
        self.assertEqual(proc.returncode, 0)
        out = json.loads(proc.stdout)
        self.assertEqual(out["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_allows_safe_command(self):
        event = {"tool_name": "Bash", "tool_input": {"command": "npm test"}}
        proc = self._run_hook(event)
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout.strip(), "")  # allow = silent exit 0

    def test_attribution_denied(self):
        cmd = "git commit -m 'x' -m 'Co-Authored-By: Claude <noreply@anthropic.com>'"
        proc = self._run_hook({"tool_name": "Bash", "tool_input": {"command": cmd}})
        out = json.loads(proc.stdout)
        self.assertEqual(out["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_attribution_toggle_off_allows(self):
        cmd = "git commit -m 'x' -m 'Co-Authored-By: Claude'"
        proc = self._run_hook(
            {"tool_name": "Bash", "tool_input": {"command": cmd}},
            {"TURMA_NO_ATTRIBUTION": "0"},
        )
        self.assertEqual(proc.stdout.strip(), "")

    def test_env_override_allows_destructive(self):
        event = {"tool_name": "Bash", "tool_input": {"command": "rm -rf /opt/app"}}
        proc = self._run_hook(event, {"TURMA_TOOL_GRANTS": "Bash(rm -rf /opt/app)"})
        self.assertEqual(proc.stdout.strip(), "")

    def test_malformed_input_fails_open(self):
        proc = subprocess.run(
            [sys.executable, GUARD_PATH],
            input="not json",
            capture_output=True,
            text=True,
        )
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout.strip(), "")


if __name__ == "__main__":
    unittest.main()

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


class TestWrapperUnwrapping(unittest.TestCase):
    """A wrapper must not launder a command past the rules.

    A QA session destroyed a host's /etc with `bash -lc 'rm -rf /etc'`: the
    outer tokens are just `bash`, so every rule saw nothing. The login shell
    also re-sourced /etc/profile and reset PATH, defeating the PATH-based `rm`
    shim the session was relying on as its safety net.
    """

    SHELL_WRAPPED = [
        "bash -c 'rm -rf /etc'",
        "bash -lc 'rm -rf /etc'",
        "bash -ec 'rm -rf /etc'",
        "sh -xc 'rm -rf /etc'",
        "bash -o pipefail -c 'rm -rf /etc'",
        "/bin/bash -lc 'rm -rf /etc'",
        "zsh -c 'rm -rf /etc'",
        "su -c 'rm -rf /etc'",
        "env FOO=1 bash -lc 'rm -rf /etc'",
        "bash -c \"bash -c 'rm -rf /etc'\"",
    ]

    PREFIX_WRAPPED = [
        "timeout 5 rm -rf /etc",
        "nice -n 5 rm -rf /etc",
        "setsid rm -rf /etc",
        "stdbuf -o0 rm -rf /etc",
        "eval rm -rf /etc",
        "xargs rm -rf /etc",
        "sudo -u root rm -rf /etc",
    ]

    # Same wrappers, harmless payloads: the unwrapping must not over-block.
    WRAPPED_SAFE = [
        "bash -lc 'npm test'",
        "bash -c 'make build'",
        "sh -c 'echo hi'",
        "timeout 30 pytest",
        "nice -n 10 make",
        "stdbuf -o0 python3 app.py",
        "env FOO=bar npm run dev",
        "bash -lc 'rm -rf node_modules'",
        "xargs -I {} echo {}",
    ]

    def test_shell_wrapped_destructive_blocked(self):
        for cmd in self.SHELL_WRAPPED:
            with self.subTest(cmd=cmd):
                self.assertIsNotNone(guard.is_destructive(cmd))

    def test_prefix_wrapped_destructive_blocked(self):
        for cmd in self.PREFIX_WRAPPED:
            with self.subTest(cmd=cmd):
                self.assertIsNotNone(guard.is_destructive(cmd))

    def test_wrapped_safe_still_allowed(self):
        for cmd in self.WRAPPED_SAFE:
            with self.subTest(cmd=cmd):
                self.assertIsNone(guard.is_destructive(cmd))
                self.assertIsNone(guard.policy_reason(cmd))

    def test_policy_rules_also_unwrap(self):
        for cmd in (
            "bash -lc 'git push origin main'",
            "bash -c 'gh pr merge 5'",
            "sh -c 'glab mr merge 5'",
        ):
            with self.subTest(cmd=cmd):
                self.assertIsNotNone(guard.policy_reason(cmd))

    def test_wrapped_feature_branch_push_allowed(self):
        self.assertIsNone(guard.policy_reason("bash -lc 'git push origin feature/x'"))

    def test_decide_denies_wrapped_destructive(self):
        decision, reason, category = guard.decide(
            "Bash", {"command": "bash -lc 'rm -rf /etc'"}
        )
        self.assertEqual((decision, category), ("deny", "destructive"))
        self.assertIsNotNone(reason)

    def test_recursion_is_depth_bounded(self):
        # Deeply nested wrappers must terminate rather than recurse forever.
        cmd = "echo hi"
        for _ in range(12):
            cmd = "bash -c " + repr(cmd)
        self.assertIsNone(guard.is_destructive(cmd))


class TestAgentServiceProtection(unittest.TestCase):
    """A session must not stop the manager that supervises it.

    Restarting `turma-agent` kills the manager of EVERY session on the host,
    including the one issuing the command, and the session cannot bring it back.
    systemd will not either: five rapid restarts trip StartLimitBurst and leave
    the unit stopped with no retry — which is how the truenas host lost its
    agent for 7.5 hours, silently, while the tunnel stayed up and the terminals
    kept working.
    """

    DOWN = [
        "systemctl restart turma-agent",
        "systemctl stop turma-agent",
        "systemctl restart turma-agent.service",
        "systemctl --user restart turma-agent",
        "systemctl disable turma-agent",
        "systemctl mask turma-agent",
        "systemctl kill turma-agent",
        "sudo systemctl restart turma-agent",
        "systemctl stop turma-agent-update.timer",
        "turma-agentctl restart",
        "turma-agentctl stop",
        "pkill -f hub-agent.py",
        "killall -9 turma-agent",
        "bash -lc 'systemctl restart turma-agent'",
        "systemctl restart nginx && systemctl restart turma-agent",
    ]

    # Looking at your own agent stays allowed, and other services are not this
    # rule's business — it is deliberately narrow.
    OK = [
        "systemctl status turma-agent",
        "systemctl is-active turma-agent",
        "systemctl show turma-agent -p KillMode",
        "systemctl cat turma-agent",
        "journalctl -u turma-agent -n 50",
        "turma-agentctl status",
        "systemctl restart nginx",
        "systemctl stop docker",
        "sudo systemctl restart sshd",
        "pkill -f my-daemon",
        "killall node",
    ]

    def test_taking_the_agent_down_is_denied(self):
        for cmd in self.DOWN:
            with self.subTest(cmd=cmd):
                self.assertIsNotNone(guard.is_destructive(cmd))

    def test_reading_it_and_other_services_stay_allowed(self):
        for cmd in self.OK:
            with self.subTest(cmd=cmd):
                self.assertIsNone(guard.is_destructive(cmd))


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

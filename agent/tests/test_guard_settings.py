#!/usr/bin/env python3
"""Tests for the generated Claude `--settings` file that wires the safety guard
(build_guard_settings / guard_script_path in hub-agent.py). Stdlib unittest;
the module is loaded by file path (its name has a dash)."""

import importlib.util
import json
import os
import sys
import tempfile
import unittest

AGENT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODULE_PATH = os.path.join(AGENT_DIR, "hub-agent.py")

spec = importlib.util.spec_from_file_location("hub_agent", MODULE_PATH)
ha = importlib.util.module_from_spec(spec)
sys.modules["hub_agent"] = ha
spec.loader.exec_module(ha)


class TestGuardSettings(unittest.TestCase):
    def test_registers_bash_pretooluse_hook(self):
        s = ha.build_guard_settings(python_exe="/usr/bin/python3")
        pre = s["hooks"]["PreToolUse"]
        self.assertEqual(pre[0]["matcher"], "Bash")
        cmd = pre[0]["hooks"][0]["command"]
        self.assertIn("guard.py", cmd)
        self.assertIn("/usr/bin/python3", cmd)

    def test_denies_credential_writes(self):
        deny = ha.build_guard_settings()["permissions"]["deny"]
        self.assertIn("Write(~/.ssh/**)", deny)
        self.assertIn("Edit(~/.claude/**)", deny)
        self.assertIn("Write(~/.aws/**)", deny)

    def test_denies_cloud_cli_credential_writes(self):
        # The cloud CLIs the image bundles authenticate off the HOST's mounted
        # stores, so the agent editing one out from under the operator breaks
        # every other session on the box, not just its own.
        deny = ha.build_guard_settings()["permissions"]["deny"]
        for rule in (
            "Edit(~/.azure/**)",
            "Write(~/.azure/**)",
            "Edit(~/.terraform.d/**)",
            "Write(~/.terraform.d/**)",
        ):
            self.assertIn(rule, deny)

    def test_guard_script_path_points_at_bundled_hook(self):
        path = ha.guard_script_path()
        self.assertTrue(path.endswith(os.path.join("hooks", "guard.py")))
        self.assertTrue(os.path.exists(path))

    def test_explicit_guard_path_is_used(self):
        s = ha.build_guard_settings(python_exe="py", guard_path="/x/hooks/guard.py")
        cmd = s["hooks"]["PreToolUse"][0]["hooks"][0]["command"]
        self.assertEqual(cmd, '"py" "/x/hooks/guard.py"')

    def test_registers_askuserquestion_bridge_hook(self):
        s = ha.build_guard_settings(python_exe="/usr/bin/python3")
        pre = s["hooks"]["PreToolUse"]
        ask = next(e for e in pre if e["matcher"] == "AskUserQuestion")
        hook = ask["hooks"][0]
        self.assertIn("ask.py", hook["command"])
        self.assertIn("/usr/bin/python3", hook["command"])
        # Its block timeout must exceed the bridge's per-question wait so Claude
        # doesn't kill the hook before it can deliver an answer.
        self.assertGreater(hook["timeout"], ha.ASK_HOOK_TIMEOUT_SEC - 1)

    def test_explicit_ask_path_is_used(self):
        s = ha.build_guard_settings(python_exe="py", ask_path="/x/hooks/ask.py")
        ask = next(e for e in s["hooks"]["PreToolUse"] if e["matcher"] == "AskUserQuestion")
        self.assertEqual(ask["hooks"][0]["command"], '"py" "/x/hooks/ask.py"')

    def test_ask_script_path_points_at_bundled_hook(self):
        path = ha.ask_script_path()
        self.assertTrue(path.endswith(os.path.join("hooks", "ask.py")))
        self.assertTrue(os.path.exists(path))


class TestOperatorLocalPermissions(unittest.TestCase):
    """The agent folds a user-level ~/.claude/settings.local.json (which Claude
    Code ignores) into the injected --settings so operator pre-approvals apply."""

    def _write(self, obj):
        fd, path = tempfile.mkstemp(suffix=".json")
        self.addCleanup(lambda: os.path.exists(path) and os.unlink(path))
        with os.fdopen(fd, "w") as fh:
            json.dump(obj, fh)
        return path

    def test_folds_operator_allow_and_deny(self):
        path = self._write({"permissions": {
            "allow": ["mcp__unifi__list_hosts", "Bash(ping *)"],
            "deny": ["Bash(curl evil.example)"],
        }})
        s = ha.build_guard_settings(local_settings_path=path)
        self.assertIn("mcp__unifi__list_hosts", s["permissions"]["allow"])
        self.assertIn("Bash(ping *)", s["permissions"]["allow"])
        # operator deny unions on top of the guard's own credential rules
        self.assertIn("Bash(curl evil.example)", s["permissions"]["deny"])
        self.assertIn("Edit(~/.claude/**)", s["permissions"]["deny"])

    def test_guard_deny_precedes_and_survives(self):
        # An operator can ADD deny rules but never drops the guard's own, which
        # stay first so the credential protection is always in force.
        path = self._write({"permissions": {"deny": ["Bash(foo)"]}})
        deny = ha.build_guard_settings(local_settings_path=path)["permissions"]["deny"]
        n = len(ha._GUARD_DENY_PATH_RULES)
        self.assertEqual(deny[:n], list(ha._GUARD_DENY_PATH_RULES))
        self.assertIn("Bash(foo)", deny)

    def test_operator_deny_duplicate_is_not_repeated(self):
        path = self._write({"permissions": {"deny": ["Edit(~/.claude/**)"]}})
        deny = ha.build_guard_settings(local_settings_path=path)["permissions"]["deny"]
        self.assertEqual(deny.count("Edit(~/.claude/**)"), 1)

    def test_missing_file_is_noop(self):
        s = ha.build_guard_settings(local_settings_path="/no/such/file.json")
        self.assertNotIn("allow", s["permissions"])
        self.assertEqual(s["permissions"]["deny"], list(ha._GUARD_DENY_PATH_RULES))

    def test_malformed_file_fails_open(self):
        fd, path = tempfile.mkstemp(suffix=".json")
        self.addCleanup(os.unlink, path)
        with os.fdopen(fd, "w") as fh:
            fh.write("{ not json")
        self.assertEqual(ha.operator_local_permissions(path), ([], []))

    def test_dedups_and_ignores_non_strings(self):
        path = self._write({"permissions": {"allow": ["A", "A", 123, None, "B"]}})
        allow, _ = ha.operator_local_permissions(path)
        self.assertEqual(allow, ["A", "B"])

    def test_non_list_permission_value_is_ignored(self):
        path = self._write({"permissions": {"allow": "Bash(rm)"}})
        allow, _ = ha.operator_local_permissions(path)
        self.assertEqual(allow, [])


if __name__ == "__main__":
    unittest.main()

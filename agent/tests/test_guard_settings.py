#!/usr/bin/env python3
"""Tests for the generated Claude `--settings` file that wires the safety guard
(build_guard_settings / guard_script_path in hub-agent.py). Stdlib unittest;
the module is loaded by file path (its name has a dash)."""

import importlib.util
import os
import sys
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


if __name__ == "__main__":
    unittest.main()

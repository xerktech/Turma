#!/usr/bin/env python3
"""Tests for the dsh safety-guard config builder (XERK-470):
build_dsh_guard_config / _parse_perm_rule / dsh_guard_plugin_path in
hub-agent.py. This is the dsh analogue of build_guard_settings — the config the
@turma/dsh-guard cordis plugin receives. Stdlib unittest; the module is loaded
by file path (its name has a dash)."""

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


class TestParsePermRule(unittest.TestCase):
    def test_read_and_edit_bucket_by_op(self):
        self.assertEqual(ha._parse_perm_rule("Read(/a/b)"), ("read", "/a/b"))
        self.assertEqual(ha._parse_perm_rule("Edit(/a/b)"), ("write", "/a/b"))

    def test_tilde_is_expanded(self):
        op, p = ha._parse_perm_rule("Edit(~/.ssh/**)")
        self.assertEqual(op, "write")
        self.assertEqual(p, os.path.expanduser("~/.ssh/**"))
        self.assertTrue(p.startswith("/"))

    def test_doubled_leading_slash_collapses(self):
        # runtime_code_deny_rules emits a Claude-relative // anchor; the dsh guard
        # resolves paths itself, so it must collapse to a real absolute path.
        self.assertEqual(
            ha._parse_perm_rule("Edit(//root/.local/share/turma-agent/**)"),
            ("write", "/root/.local/share/turma-agent/**"),
        )

    def test_backslash_escapes_are_undone(self):
        # _glob_literal backslash-escapes metacharacters; the dsh guard globber
        # does its own escaping, so the literal path must be restored.
        self.assertEqual(ha._parse_perm_rule(r"Edit(/a/t\[1\]/**)"), ("write", "/a/t[1]/**"))

    def test_bare_tool_rule_is_none(self):
        self.assertIsNone(ha._parse_perm_rule("ListAgents"))


class TestBuildDshGuardConfig(unittest.TestCase):
    def setUp(self):
        self.cfg = ha.build_dsh_guard_config(python_exe="/usr/bin/python3")
        self.plugin = self.cfg["plugin"]

    def test_pins_sandbox_and_approval(self):
        # workspace-confined writes + a fail-closed approval seam.
        self.assertEqual(self.cfg["sandboxMode"], "workspace-write")
        self.assertEqual(self.cfg["approvalPolicy"], "ask")

    def test_carries_the_shared_hook_scripts(self):
        self.assertEqual(self.plugin["pythonExe"], "/usr/bin/python3")
        self.assertTrue(self.plugin["guardScript"].endswith("guard.py"))
        self.assertTrue(self.plugin["fileguardScript"].endswith("fileguard.py"))
        self.assertEqual(self.plugin["hookTimeoutMs"], ha.DSH_GUARD_HOOK_TIMEOUT_MS)

    def test_plugin_path_points_at_the_guard_package(self):
        self.assertTrue(self.cfg["pluginPath"].endswith(os.path.join("dsh", "guard")))

    def test_write_deny_globs_are_absolute_and_expanded(self):
        dw = self.plugin["denyWrite"]
        self.assertTrue(dw, "expected credential-store write denies")
        self.assertTrue(all(g.startswith("/") for g in dw), dw)
        self.assertFalse(any("~" in g for g in dw), dw)
        self.assertFalse(any(g.startswith("//") for g in dw), "no Claude-relative anchor leaks")
        # the credential stores build_guard_settings denies with Edit() rules
        home = os.path.expanduser("~")
        for want in (f"{home}/.ssh/**", f"{home}/.aws/**"):
            self.assertIn(want, dw)

    def test_local_model_secret_is_read_denied(self):
        home = os.path.expanduser("~")
        self.assertIn(f"{home}/.turma/local-model.env", self.plugin["denyRead"])

    def test_uploads_and_roster_are_read_allowed(self):
        # The cross-child contract with [C] (XERK-467): a staged attachment under
        # ~/.turma/uploads/<sid>/ must be readable with no approval prompt.
        home = os.path.expanduser("~")
        ar = self.plugin["allowRead"]
        self.assertIn(f"{home}/.turma/uploads/**", ar)
        self.assertIn(f"{home}/.turma/peers.tsv", ar)

    def test_bare_tool_rules_are_dropped(self):
        # ListAgents is a Claude tool rule with no path — dsh has no such tool,
        # so it must not leak into any path bucket.
        for bucket in ("denyWrite", "denyRead", "allowRead"):
            self.assertFalse(any("ListAgents" in g for g in self.plugin[bucket]))

    def test_missing_fileguard_degrades_to_none(self):
        cfg = ha.build_dsh_guard_config(
            python_exe="/usr/bin/python3",
            fileguard_path="/nonexistent/fileguard.py",
        )
        self.assertIsNone(cfg["plugin"]["fileguardScript"])


if __name__ == "__main__":
    unittest.main()

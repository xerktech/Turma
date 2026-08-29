#!/usr/bin/env python3
"""Tests for the qwen safety guard (XERK-510 [Qwen F]).

Two halves:
  * TestBuildQwenGuardConfig / TestParseReuse — the config builder
    (build_qwen_guard_config in hub-agent.py), the qwen analogue of
    build_dsh_guard_config: it reuses build_guard_settings()'s rule set and emits
    the PreToolUse hook wiring + permissions.deny + the shim's data config.
  * TestQwenGuardShimEndToEnd — drives the REAL shim.py subprocess, which shells
    out to the REAL guard.py / fileguard.py, over HOSTILE inputs (the "tests
    driving REAL guard.py/fileguard.py over hostile inputs" the ticket names).

Stdlib unittest; hub-agent.py is loaded by file path (its name has a dash)."""

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest

AGENT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODULE_PATH = os.path.join(AGENT_DIR, "hub-agent.py")

spec = importlib.util.spec_from_file_location("hub_agent", MODULE_PATH)
ha = importlib.util.module_from_spec(spec)
sys.modules["hub_agent"] = ha
spec.loader.exec_module(ha)

HOME = os.path.expanduser("~")
NO_LOCAL = "/nonexistent/settings.local.json"   # isolate from the host operator's rules


class TestParseReuse(unittest.TestCase):
    def test_shim_path_points_at_the_shim(self):
        self.assertTrue(ha.qwen_guard_shim_path().endswith(
            os.path.join("qwen", "guard", "shim.py")))
        self.assertTrue(os.path.exists(ha.qwen_guard_shim_path()))


class TestBuildQwenGuardConfig(unittest.TestCase):
    def setUp(self):
        self.cfg = ha.build_qwen_guard_config(
            python_exe="/usr/bin/python3", local_settings_path=NO_LOCAL,
            config_path="/tmp/qwen-guard-test.json")
        self.shim = self.cfg["shimConfig"]
        self.settings = self.cfg["settings"]

    def test_hook_wiring_invokes_the_shim_with_SsE_and_the_config(self):
        pre = self.settings["hooks"]["PreToolUse"]
        self.assertEqual(len(pre), 1)
        hook = pre[0]["hooks"][0]
        self.assertEqual(hook["type"], "command")
        self.assertIn("-SsE", hook["command"])
        self.assertIn("shim.py", hook["command"])
        self.assertIn("/tmp/qwen-guard-test.json", hook["command"])
        # G0 gotcha: qwen's timeout is MILLISECONDS, and a too-small value
        # silently disables the guard. It must exceed the shim's nested budget.
        self.assertEqual(hook["timeout"], ha.QWEN_GUARD_HOOK_TIMEOUT_MS)
        self.assertGreater(ha.QWEN_GUARD_HOOK_TIMEOUT_MS, ha.QWEN_SHIM_HOOK_TIMEOUT_MS)

    def test_matcher_covers_qwens_shell_and_fs_tools(self):
        matcher = self.settings["hooks"]["PreToolUse"][0]["matcher"]
        for tool in ("run_shell_command", "write_file", "replace", "read_file",
                     "read_many_files"):
            self.assertIn(tool, matcher)

    def test_carries_the_shared_hook_scripts(self):
        self.assertEqual(self.shim["pythonExe"], "/usr/bin/python3")
        self.assertTrue(self.shim["guardScript"].endswith("guard.py"))
        self.assertTrue(self.shim["fileguardScript"].endswith("fileguard.py"))
        self.assertEqual(self.shim["hookTimeoutMs"], ha.QWEN_SHIM_HOOK_TIMEOUT_MS)

    def test_write_deny_globs_are_absolute_expanded_and_cover_credentials(self):
        dw = self.shim["denyWrite"]
        self.assertTrue(all(g.startswith("/") for g in dw), dw)
        self.assertFalse(any("~" in g for g in dw), dw)
        self.assertFalse(any(g.startswith("//") for g in dw), "no Claude-relative anchor leaks")
        # realpath'd, not a literal f"{HOME}/..." join: XERK-503 found `~/.aws` can
        # itself be a symlink (a bind mount, or on WSL the Windows-side profile),
        # and a rule built from the un-resolved path silently stops matching once
        # the target resolves elsewhere. Asserting the resolved form pins that fix
        # instead of assuming HOME's subdirectories are never symlinks.
        for want in (os.path.realpath(f"{HOME}/.ssh") + "/**",
                     os.path.realpath(f"{HOME}/.aws") + "/**"):
            self.assertIn(want, dw)

    def test_shim_config_is_the_shared_rule_set(self):
        # The whole point: the globs come from build_guard_settings's own deny
        # list, so a store added to _GUARD_DENY_PATH_RULES flows here with no
        # qwen change. Prove they match the shared list (path rules only).
        settings = ha.build_guard_settings(python_exe="/usr/bin/python3",
                                           local_settings_path=NO_LOCAL)
        want_write, want_read = [], []
        for rule in settings["permissions"]["deny"]:
            parsed = ha._parse_perm_rule(rule)
            if parsed is None:
                continue
            (want_write if parsed[0] == "write" else want_read).append(parsed[1])
        self.assertEqual(self.shim["denyWrite"], want_write)
        self.assertEqual(self.shim["denyRead"], want_read)

    def test_qwen_env_file_is_read_denied(self):
        # [Qwen F] point 5: the per-session model-credential env file (holds
        # OPENAI_API_KEY) is read-denied, defence in depth.
        self.assertIn(f"{HOME}/.turma/qwen/*.env", self.shim["denyRead"])

    def test_the_guard_config_itself_is_write_denied(self):
        self.assertIn(f"{HOME}/.turma/qwen-guard.json", self.shim["denyWrite"])

    def test_uploads_and_roster_are_read_allowed(self):
        ar = self.shim["allowRead"]
        self.assertIn(f"{HOME}/.turma/uploads/**", ar)
        self.assertIn(f"{HOME}/.turma/peers.tsv", ar)

    def test_permissions_deny_carries_path_rules_but_no_bare_tool_rule(self):
        deny = self.settings["permissions"]["deny"]
        self.assertTrue(any(r.startswith("Edit(") for r in deny))
        # qwen has no ListAgents tool, so the bare tool rule must be dropped from
        # the qwen permissions block (as the dsh builder drops it).
        self.assertNotIn("ListAgents", deny)
        self.assertFalse(any("ListAgents" in g for g in self.shim["denyWrite"]))
        self.assertFalse(any("ListAgents" in g for g in self.shim["denyRead"]))

    def test_missing_fileguard_degrades_to_none(self):
        cfg = ha.build_qwen_guard_config(
            python_exe="/usr/bin/python3", local_settings_path=NO_LOCAL,
            fileguard_path="/nonexistent/fileguard.py")
        self.assertIsNone(cfg["shimConfig"]["fileguardScript"])


class TestQwenGuardShimEndToEnd(unittest.TestCase):
    """Drive the real shim over the real guard.py/fileguard.py."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="qwen-guard-")
        cls.cwd = os.path.join(cls.tmp, "work")
        os.makedirs(cls.cwd, exist_ok=True)
        # A config wired at the REAL shared hooks, with the shared rule set.
        built = ha.build_qwen_guard_config(local_settings_path=NO_LOCAL)
        cls.config_path = os.path.join(cls.tmp, "qwen-guard.json")
        with open(cls.config_path, "w", encoding="utf-8") as fh:
            json.dump(built["shimConfig"], fh)
        cls.shim = ha.qwen_guard_shim_path()

    def _run(self, event, config_path=None, cwd=None):
        """Invoke the shim exactly as qwen would, return (rc, deny_reason|None)."""
        cfg = config_path if config_path is not None else self.config_path
        payload = json.dumps(event) if event is not None else "{ not json"
        proc = subprocess.run(
            [sys.executable, "-SsE", self.shim, cfg],
            input=payload, capture_output=True, text=True, timeout=30)
        reason = None
        out = (proc.stdout or "").strip()
        if out:
            hs = json.loads(out).get("hookSpecificOutput", {})
            if hs.get("permissionDecision") == "deny":
                reason = hs.get("permissionDecisionReason") or ""
        return proc.returncode, reason

    def _ev(self, tool, tool_input):
        return {"tool_name": tool, "tool_input": tool_input, "cwd": self.cwd,
                "session_id": "s1", "permission_mode": "bypassPermissions",
                "hook_event_name": "PreToolUse"}

    # --- shell (guard.py) ---
    def test_destructive_shell_is_denied(self):
        rc, reason = self._run(self._ev("run_shell_command", {"command": "rm -rf /"}))
        self.assertEqual(rc, 0)
        self.assertIsNotNone(reason)
        self.assertIn("protected path", reason)

    def test_push_to_main_is_denied_policy(self):
        rc, reason = self._run(self._ev("run_shell_command",
                                        {"command": "git push origin main"}))
        self.assertIsNotNone(reason)
        self.assertIn("main/master", reason)

    def test_self_attribution_is_denied(self):
        rc, reason = self._run(self._ev("run_shell_command", {
            "command": "git commit -m 'x\n\nCo-Authored-By: Claude "
                       "<noreply@anthropic.com>'"}))
        self.assertIsNotNone(reason)
        self.assertIn("attribution", reason.lower())

    def test_benign_shell_is_allowed(self):
        rc, reason = self._run(self._ev("run_shell_command", {"command": "ls -la"}))
        self.assertEqual(rc, 0)
        self.assertIsNone(reason)

    def test_shell_with_a_non_string_command_fails_closed(self):
        # A shell tool whose `command` is a list/dict/number cannot be inspected
        # by guard.py; it MUST fail closed, never fall through to allow (a QA
        # finding — the shell branch has no glob backstop).
        for bad in ([" rm", "-rf", "/"], {"x": 1}, 42, True, None):
            rc, reason = self._run(self._ev("run_shell_command", {"command": bad}))
            self.assertEqual(rc, 2, f"non-string command {bad!r} must fail closed")
            self.assertIsNotNone(reason, bad)

    # --- writes (fileguard.py + the credential globs) ---
    def test_write_to_ssh_is_denied(self):
        rc, reason = self._run(self._ev("write_file", {
            "file_path": os.path.join(HOME, ".ssh", "authorized_keys"),
            "content": "x"}))
        self.assertIsNotNone(reason)

    def test_replace_in_aws_is_denied(self):
        rc, reason = self._run(self._ev("replace", {
            "file_path": os.path.join(HOME, ".aws", "credentials"),
            "old_string": "a", "new_string": "b"}))
        self.assertIsNotNone(reason)

    def test_write_under_dot_claude_is_denied_by_fileguard(self):
        rc, reason = self._run(self._ev("write_file", {
            "file_path": os.path.join(HOME, ".claude", "settings.json"),
            "content": "{}"}))
        self.assertIsNotNone(reason)
        self.assertIn(".claude", reason)

    def test_write_to_the_guard_config_is_denied(self):
        rc, reason = self._run(self._ev("write_file", {
            "file_path": os.path.join(HOME, ".turma", "qwen-guard.json"),
            "content": "{}"}))
        self.assertIsNotNone(reason)

    def test_write_memory_tree_under_dot_claude_is_allowed(self):
        # fileguard's carve-out: a subagent memory store IS writable.
        rc, reason = self._run(self._ev("write_file", {
            "file_path": os.path.join(HOME, ".claude", "agent-memory", "qa", "x.md"),
            "content": "note"}))
        self.assertEqual(rc, 0)
        self.assertIsNone(reason)

    def test_benign_write_in_worktree_is_allowed(self):
        rc, reason = self._run(self._ev("write_file", {
            "file_path": os.path.join(self.cwd, "notes.txt"), "content": "hi"}))
        self.assertEqual(rc, 0)
        self.assertIsNone(reason)

    def test_symlink_escape_out_of_worktree_is_denied(self):
        # A symlink in the worktree pointing at ~/.ssh must not launder a write.
        link = os.path.join(self.cwd, "esc")
        try:
            os.symlink(os.path.join(HOME, ".ssh"), link)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks unavailable")
        rc, reason = self._run(self._ev("write_file", {
            "file_path": os.path.join("esc", "authorized_keys"), "content": "x"}))
        self.assertIsNotNone(reason)

    # --- reads (the credential read globs + carve-outs) ---
    def test_read_local_model_secret_is_denied(self):
        rc, reason = self._run(self._ev("read_file", {
            "absolute_path": os.path.join(HOME, ".turma", "local-model.env")}))
        self.assertIsNotNone(reason)

    def test_read_qwen_env_file_is_denied(self):
        rc, reason = self._run(self._ev("read_file", {
            "absolute_path": os.path.join(HOME, ".turma", "qwen", "abc.env")}))
        self.assertIsNotNone(reason)

    def test_read_uploads_is_allowed(self):
        rc, reason = self._run(self._ev("read_file", {
            "absolute_path": os.path.join(HOME, ".turma", "uploads", "s1", "a.png")}))
        self.assertEqual(rc, 0)
        self.assertIsNone(reason)

    def test_read_roster_is_allowed(self):
        rc, reason = self._run(self._ev("read_file", {
            "absolute_path": os.path.join(HOME, ".turma", "peers.tsv")}))
        self.assertIsNone(reason)

    def test_read_many_files_denies_if_any_target_is_denied(self):
        rc, reason = self._run(self._ev("read_many_files", {"paths": [
            os.path.join(self.cwd, "ok.txt"),
            os.path.join(HOME, ".turma", "local-model.env")]}))
        self.assertIsNotNone(reason)

    # --- ungated / other ---
    def test_unknown_tool_is_allowed(self):
        rc, reason = self._run(self._ev("tool_search", {"query": "select:write_file"}))
        self.assertEqual(rc, 0)
        self.assertIsNone(reason)

    # --- FAIL CLOSED ---
    def test_missing_config_fails_closed(self):
        rc, reason = self._run(self._ev("run_shell_command", {"command": "ls"}),
                               config_path="/nonexistent/qwen-guard.json")
        self.assertEqual(rc, 2)
        self.assertIsNotNone(reason)

    def test_no_config_arg_fails_closed(self):
        proc = subprocess.run([sys.executable, "-SsE", self.shim],
                              input="{}", capture_output=True, text=True, timeout=30)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("deny", proc.stdout)

    def test_unparseable_stdin_fails_closed(self):
        rc, reason = self._run(None)             # not-json stdin
        self.assertEqual(rc, 2)
        self.assertIsNotNone(reason)

    def test_shell_with_no_guard_script_fails_closed(self):
        bad = os.path.join(self.tmp, "no-guard.json")
        with open(bad, "w", encoding="utf-8") as fh:
            json.dump({"guardScript": "", "denyWrite": [], "denyRead": [],
                       "allowRead": []}, fh)
        rc, reason = self._run(self._ev("run_shell_command", {"command": "ls"}),
                               config_path=bad)
        self.assertEqual(rc, 2)
        self.assertIsNotNone(reason)

    def test_crashing_hook_fails_closed(self):
        # A guardScript that exits nonzero must read as DENY, never allow.
        crasher = os.path.join(self.tmp, "crash.py")
        with open(crasher, "w", encoding="utf-8") as fh:
            fh.write("import sys\nsys.exit(3)\n")
        bad = os.path.join(self.tmp, "crash-guard.json")
        with open(bad, "w", encoding="utf-8") as fh:
            json.dump({"guardScript": crasher, "denyWrite": [], "denyRead": [],
                       "allowRead": [], "hookTimeoutMs": 5000}, fh)
        rc, reason = self._run(self._ev("run_shell_command", {"command": "ls"}),
                               config_path=bad)
        self.assertEqual(rc, 2)
        self.assertIsNotNone(reason)


if __name__ == "__main__":
    unittest.main()

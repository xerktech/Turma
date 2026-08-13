#!/usr/bin/env python3
"""Tests for the generated Claude `--settings` file that wires the safety guard
(build_guard_settings / guard_script_path in hub-agent.py). Stdlib unittest;
the module is loaded by file path (its name has a dash)."""

import importlib.util
import json
import os
import re
import shutil
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
        self.assertIn("Edit(~/.ssh/**)", deny)
        self.assertIn("Edit(~/.claude/.*)", deny)   # the shared login, .credentials.json
        self.assertIn("Edit(~/.aws/**)", deny)

    # --- the matcher, as MEASURED against claude 2.1.229 ---------------------
    #
    # The string assertions below this were all green while both memory trees
    # were 100% denied, twice. They pin spellings; they cannot pin BEHAVIOUR,
    # and behaviour is the entire claim. So model the matcher and assert against
    # it. Two measured facts drive everything:
    #   1. `*` matches within one segment, `**` spans any depth.
    #   2. A rule matching a DIRECTORY denies that directory's whole subtree.
    # (2) is the one that shipped two critical defects: `Edit(~/.claude/*)`
    # matches the `agent-memory` entry, making it identical to `~/.claude/**`.
    # Re-measure this if the claude version moves.
    @staticmethod
    def _denies(rule, path):
        pattern = rule[len("Edit("):-1].replace("~/", "")
        rx = ""
        i = 0
        while i < len(pattern):
            if pattern.startswith("**", i):
                rx += ".*"
                i += 2
            elif pattern[i] == "*":
                rx += "[^/]*"
                i += 1
            else:
                rx += re.escape(pattern[i])
                i += 1
        rx = re.compile(rx + r"\Z")
        parts = path.split("/")
        # A match on the path OR on any ANCESTOR denies it — that is fact (2).
        return any(rx.match("/".join(parts[:n])) for n in range(1, len(parts) + 1))

    def _denied_by(self, rules, path):
        return [r for r in rules if self._denies(r, path)]

    def test_matcher_model_matches_what_was_measured(self):
        # Guard the guard: if this model drifts from the real binary the tests
        # below become theatre, so pin the four facts the harness established.
        self.assertTrue(self._denies("Edit(~/.claude/*)", ".claude/agent-memory/qa/x.md"),
                        "a rule matching a directory must deny its subtree")
        self.assertTrue(self._denies("Edit(~/.claude/projects/*/*)", ".claude/projects/s/memory/M.md"))
        self.assertFalse(self._denies("Edit(~/.claude/projects/*/*.jsonl)", ".claude/projects/s/memory/M.md"))
        self.assertFalse(self._denies("Edit(~/.claude/*.json)", ".claude/sessions/a.json"),
                         "`*` must not cross a slash")
        self.assertTrue(self._denies("Edit(~/.claude/agents/**)", ".claude/agents/a/b/c.md"))

    def test_memory_is_actually_writable_under_the_generated_rules(self):
        """The claim the string assertions cannot make. This is the one."""
        home = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, home, True)
        base = os.path.join(home, ".claude")
        for d in ("agent-memory", "projects", "shell-snapshots", "brand-new-thing"):
            os.makedirs(os.path.join(base, d))
        open(os.path.join(base, "settings.json"), "w").close()
        rules = ha.claude_config_deny_rules(home=home)

        for writable in (
            ".claude/agent-memory/qa/MEMORY.md",
            ".claude/agent-memory/qa/turma.md",
            ".claude/agent-memory/brand-new-agent/MEMORY.md",
            ".claude/agent-memory/qa/nested/deep.md",
            ".claude/projects/-some-slug/memory/MEMORY.md",
            ".claude/projects/-some-slug/memory/nested/x.md",
        ):
            self.assertEqual(self._denied_by(rules, writable), [],
                             f"{writable} must stay writable — it is the feature")

        for denied in (
            ".claude/.credentials.json",                 # the fleet's shared login
            ".claude/settings.json",
            ".claude/settings.json.bak-preperms",
            ".claude/CLAUDE.md",
            ".claude/history.jsonl",
            ".claude/brand-new-thing/evil.sh",           # present at generation time
            ".claude/shell-snapshots/snapshot-zsh-1.sh", # RCE into every live session
            ".claude/sessions/1.key",
            ".claude/agents/qa.md",
            ".claude/bin/hook.py",
            ".claude/ide/9999.lock",
            ".claude/todos/t.json",
            ".claude/projects/-some-slug/a.jsonl",       # a transcript
            ".claude/projects/-some-slug/subagents/agent-1.jsonl",
        ):
            self.assertNotEqual(self._denied_by(rules, denied), [],
                                f"{denied} must stay denied")

    def test_claude_deny_never_wildcards_the_top_level(self):
        # The specific regression that shipped twice. `~/.claude/*` and
        # `~/.claude/**` both match the `agent-memory` entry and take its
        # subtree; every top-level entry must be named individually instead.
        rules = ha.claude_config_deny_rules()
        for bad in ("Edit(~/.claude/*)", "Edit(~/.claude/**)", "Edit(~/.claude/projects/*/*)"):
            self.assertNotIn(bad, rules)

    def test_claude_deny_is_generated_from_what_is_there(self):
        """The ~/.claude rules fail CLOSED: deny what exists, carve out memory.

        Enumerating the DANGEROUS paths instead was tried and is wrong. It fails
        open, and a QA pass proved it by writing `shell-snapshots/`, which Claude
        Code sources on every Bash call of every live session — RCE in another
        session's shell from a directory nobody had thought to name.
        """
        home = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, home, True)
        base = os.path.join(home, ".claude")
        for d in ("agent-memory", "projects", "shell-snapshots", "brand-new-thing"):
            os.makedirs(os.path.join(base, d))
        open(os.path.join(base, "settings.json"), "w").close()
        rules = ha.claude_config_deny_rules(home=home)

        # A directory this build has never heard of is denied anyway. This is
        # the whole property; if it regresses the list is back to fail-open.
        self.assertIn("Edit(~/.claude/brand-new-thing/**)", rules)
        # ...and the two memory trees survive it.
        self.assertNotIn("Edit(~/.claude/agent-memory/**)", rules)
        self.assertEqual([r for r in rules if "agent-memory" in r], [])
        self.assertEqual([r for r in rules if "/memory/" in r], [])
        self.assertNotIn("Edit(~/.claude/projects/**)", rules)
        self.assertNotIn("Edit(~/.claude/**)", rules)

    def test_claude_deny_names_the_execution_surfaces_even_when_absent(self):
        # A fresh container has no shell-snapshots/ until its first Bash call.
        # "Not there at boot" must not mean "writable for this manager's life".
        home = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, home, True)
        os.makedirs(os.path.join(home, ".claude"))
        rules = ha.claude_config_deny_rules(home=home)
        for d in ("shell-snapshots", "sessions", "bin", "agents", "plugins",
                  "hooks", "commands", "skills", "file-history", "backups",
                  "session-env", "statsig"):
            self.assertIn(f"Edit(~/.claude/{d}/**)", rules)
        self.assertIn("Edit(~/.claude.json)", rules)   # mcpServers: startup exec
        self.assertIn("Edit(~/.claude/*.json)", rules)  # top-level files, present or not
        self.assertIn("Edit(~/.claude/.*)", rules)     # .credentials.json

    def test_claude_deny_unreadable_home_still_denies_the_dangerous_paths(self):
        rules = ha.claude_config_deny_rules(home="/nonexistent-turma-qa")
        self.assertIn("Edit(~/.claude/shell-snapshots/**)", rules)
        self.assertIn("Edit(~/.claude/.*)", rules)
        self.assertIn("Edit(~/.claude/projects/*/*.jsonl)", rules)

    def test_claude_config_denied_piecewise_but_memory_stays_writable(self):
        """~/.claude is protected file-by-file so agent memory survives.

        A blanket `Edit(~/.claude/**)` disabled Claude Code's memory feature for
        every session and subagent on the host — deny beats allow, so nothing in
        the operator's settings could re-enable it. The exception has to be a
        HOLE IN THE DENY, not an allow rule, which is why each dangerous path is
        named individually.
        """
        deny = ha.build_guard_settings()["permissions"]["deny"]
        self.assertNotIn("Edit(~/.claude/**)", deny)
        for rule in (
            "Edit(~/.claude/.*)",                    # the shared Claude login
            "Edit(~/.claude/settings.json*)",        # …and its .bak-* siblings
            "Edit(~/.claude/CLAUDE.md*)",            # injected into every session
            "Edit(~/.claude.json)",                  # mcpServers: executed at session startup
            "Edit(~/.claude/agents/**)",             # steers every future run
            "Edit(~/.claude/bin/**)",                # hooks auto-execute: RCE
            "Edit(~/.claude/shell-snapshots/**)",    # sourced by every Bash call of every session
            "Edit(~/.claude/sessions/**)",           # session keys + the remote-control registry
            "Edit(~/.claude/plugins/**)",
            "Edit(~/.claude/backups/**)",            # the restore path for all of the above
            "Edit(~/.claude/projects/*/*.jsonl)",    # transcripts feed archive/usage/--resume
            "Edit(~/.claude/projects/*/subagents/**)",
        ):
            self.assertIn(rule, deny)
        # Nothing may cover either memory tree, however it is spelled. A rule
        # ending `~/.claude/**` re-breaks the feature silently.
        for rule in deny:
            self.assertFalse(
                rule.startswith("Edit(~/.claude/**") or rule.startswith("Edit(~/.claude)"),
                f"{rule} swallows the memory trees",
            )
        self.assertEqual(
            [r for r in deny if "agent-memory" in r or "/memory/" in r], [],
            "agent memory must not be denied — that is the whole point of the carve-out",
        )

    def test_denies_cloud_cli_credential_writes(self):
        # The cloud CLIs the image bundles authenticate off the HOST's mounted
        # stores, so the agent editing one out from under the operator breaks
        # every other session on the box, not just its own.
        deny = ha.build_guard_settings()["permissions"]["deny"]
        for rule in (
            "Edit(~/.azure/**)",
            "Edit(~/.terraform.d/**)",
        ):
            self.assertIn(rule, deny)

    def test_denies_non_github_git_credential_writes(self):
        # The `store` helper's cached non-GitHub git creds are shared by every
        # session, so the agent must not edit that file either.
        deny = ha.build_guard_settings()["permissions"]["deny"]
        self.assertIn("Edit(~/.git-credentials)", deny)

    def test_no_write_rules_claude_code_rejects(self):
        """`Write(path)` deny rules are rejected at startup, one warning each.

        Edit(path) already covers every file-editing tool, so a Write twin buys
        nothing and costs seven lines of noise in every session's pane. Verified
        against a live guard-settings.json with claude 2.1.226 (XERK-235).
        """
        deny = ha.build_guard_settings()["permissions"]["deny"]
        self.assertEqual([r for r in deny if r.startswith("Write(")], [])

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
        self.assertIn("Edit(~/.claude/.*)", s["permissions"]["deny"])

    def test_guard_deny_precedes_and_survives(self):
        # An operator can ADD deny rules but never drops the guard's own, which
        # stay first so the credential protection is always in force.
        path = self._write({"permissions": {"deny": ["Bash(foo)"]}})
        deny = ha.build_guard_settings(local_settings_path=path)["permissions"]["deny"]
        n = len(ha._GUARD_DENY_PATH_RULES)
        self.assertEqual(deny[:n], list(ha._GUARD_DENY_PATH_RULES))
        self.assertIn("Bash(foo)", deny)

    def test_guard_allow_precedes_and_survives(self):
        # Same shape as the deny rules: an operator can ADD allow rules, but the
        # app's own uploads Read is always there and always first (XERK-234).
        path = self._write({"permissions": {"allow": ["Bash(ping *)"]}})
        allow = ha.build_guard_settings(local_settings_path=path)["permissions"]["allow"]
        n = len(ha._GUARD_ALLOW_PATH_RULES)
        self.assertEqual(allow[:n], list(ha._GUARD_ALLOW_PATH_RULES))
        self.assertIn("Bash(ping *)", allow)

    def test_operator_allow_duplicate_is_not_repeated(self):
        path = self._write({"permissions": {"allow": ["Read(~/.turma/uploads/**)"]}})
        allow = ha.build_guard_settings(local_settings_path=path)["permissions"]["allow"]
        self.assertEqual(allow.count("Read(~/.turma/uploads/**)"), 1)

    def test_operator_deny_duplicate_is_not_repeated(self):
        path = self._write({"permissions": {"deny": ["Edit(~/.ssh/**)"]}})
        deny = ha.build_guard_settings(local_settings_path=path)["permissions"]["deny"]
        self.assertEqual(deny.count("Edit(~/.ssh/**)"), 1)

    def test_operator_can_re_deny_all_of_claude_and_lose_memory(self):
        """An operator's own blanket rule still wins, and still costs memory.

        Pinned so the trade-off is visible rather than surprising: the guard no
        longer denies all of ~/.claude, but `settings.local.json` unions on top,
        so an operator who writes `Edit(~/.claude/**)` there re-disables agent
        memory for every session on the host. That is their call to make — the
        point of the test is that it is a CHOICE, not the default.
        """
        path = self._write({"permissions": {"deny": ["Edit(~/.claude/**)"]}})
        deny = ha.build_guard_settings(local_settings_path=path)["permissions"]["deny"]
        self.assertIn("Edit(~/.claude/**)", deny)

    def test_missing_file_is_noop(self):
        # No operator file: the settings carry exactly the app's own rules —
        # every guard deny, plus the uploads Read the app grants itself so an
        # attached file never costs a permission prompt (XERK-234).
        s = ha.build_guard_settings(local_settings_path="/no/such/file.json")
        self.assertEqual(s["permissions"]["allow"], list(ha._GUARD_ALLOW_PATH_RULES))
        # The ~/.claude rules are GENERATED from what is on this host, so they
        # are appended rather than listed — asserting a literal here would pin
        # the tester's home directory instead of the app's behaviour.
        self.assertEqual(
            s["permissions"]["deny"],
            list(ha._GUARD_DENY_PATH_RULES) + ha.claude_config_deny_rules(),
        )

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


class TestLimitsSettings(unittest.TestCase):
    """The separate --settings file the subscription-limits probe launches with
    (XERK-247)."""

    def test_wires_the_statusline_hook(self):
        s = ha.build_limits_settings(python_exe="/usr/bin/python3")
        self.assertEqual(s["statusLine"]["type"], "command")
        self.assertIn("statusline.py", s["statusLine"]["command"])
        self.assertIn("/usr/bin/python3", s["statusLine"]["command"])

    def test_session_settings_carry_no_statusline(self):
        # THE reason the probe exists. Configuring a statusLine makes Claude Code
        # stop painting the footer's "esc to interrupt" hint, and that hint is
        # what _busy_from_capture (and tunnel-agent's paneShowsBusy) read to know
        # a session is working — measured on a 54-column pane mid-stream, busy
        # detection falls from 53/54 captures to 10/41. Merging these two
        # settings files would trade every session's status for a usage widget.
        self.assertNotIn("statusLine", ha.build_guard_settings())

    def test_probe_settings_carry_no_hooks_or_permissions(self):
        # The probe runs one no-op turn in ~/.turma and is killed; the guard has
        # nothing to guard there, and inheriting it would be a second place the
        # guard's rules have to be kept true.
        s = ha.build_limits_settings()
        self.assertEqual(set(s), {"statusLine"})


if __name__ == "__main__":
    unittest.main()

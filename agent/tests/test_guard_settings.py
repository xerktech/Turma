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
        self.assertIn("Edit(~/.ssh/**)", deny)
        self.assertIn("Edit(~/.claude/.*)", deny)   # the fleet's shared Claude login
        self.assertIn("Edit(~/.aws/**)", deny)

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

    def test_wires_the_claude_file_guard(self):
        """~/.claude is guarded by a HOOK, not by a deny pattern.

        The rule is "everything under ~/.claude except the two agent-memory
        trees", which no glob list can express — deny beats allow, so the
        exception must be a hole, and three attempts each cut one too big or too
        small. The predicate lives in hooks/fileguard.py.
        """
        s = ha.build_guard_settings(python_exe="/usr/bin/python3")
        entry = [e for e in s["hooks"]["PreToolUse"]
                 if e["matcher"] == "Write|Edit|MultiEdit|NotebookEdit"]
        self.assertEqual(len(entry), 1)
        cmd = entry[0]["hooks"][0]["command"]
        self.assertIn("fileguard.py", cmd)
        self.assertIn("/usr/bin/python3", cmd)
        # The blanket pattern must NOT come back: it denies the memory trees.
        self.assertNotIn("Edit(~/.claude/**)", s["permissions"]["deny"])
        self.assertNotIn("Edit(~/.claude/*)", s["permissions"]["deny"])

    def test_catastrophic_paths_keep_pattern_denies_as_defence_in_depth(self):
        # The hook is the complete rule; these patterns are what still stands if
        # it is ever misconfigured or crashes. Each is anchored on a dot, a name
        # or a suffix, so none can match the agent-memory/projects DIRECTORY
        # entries — a deny that matches a directory takes its whole subtree.
        deny = ha.build_guard_settings()["permissions"]["deny"]
        for rule in ("Edit(~/.claude/.*)",                  # the shared login
                     "Edit(~/.claude.json)",                # mcpServers: startup exec
                     "Edit(~/.claude/agents/**)",
                     "Edit(~/.claude/bin/**)",
                     "Edit(~/.claude/shell-snapshots/**)",  # RCE into every session
                     "Edit(~/.claude/sessions/**)",
                     "Edit(~/.claude/local/**)",            # the claude binary
                     "Edit(~/.claude/rules/**)"):
            self.assertIn(rule, deny)
        self.assertEqual([r for r in deny if "agent-memory" in r], [])

    def test_a_missing_fileguard_degrades_to_patterns_rather_than_bricking(self):
        """A hook that EXITS nonzero fails open; a MISSING one fails closed.

        Claude Code then refuses every file edit in every session on the host,
        presenting as an unexplainable permissions bug. A version-skewed install
        must degrade to patterns-only, not stop the fleet editing files.
        """
        s = ha.build_guard_settings(fileguard_path="/nonexistent/fileguard.py")
        matchers = [e["matcher"] for e in s["hooks"]["PreToolUse"]]
        self.assertEqual(matchers, ["Bash", "AskUserQuestion"])
        # …and the pattern backstop is still in force.
        self.assertIn("Edit(~/.claude/shell-snapshots/**)", s["permissions"]["deny"])

    def test_the_agents_own_installed_code_is_denied(self):
        # fileguard.py refuses writes under ~/.claude, and nothing stopped a
        # session overwriting fileguard.py itself: two Writes re-opened the whole
        # config directory. Proven, so the hook's own integrity is pinned.
        self.assertEqual(ha.runtime_code_deny_rules(script_dir="/usr/local/bin",
                                                    repos_root="/mnt/data/Docker/git"),
                         ["Edit(//usr/local/bin/**)"])

    def test_an_absolute_rule_needs_a_DOUBLED_leading_slash(self):
        """The rule must be anchored at `/`, not at the settings file.

        Claude Code reads a single leading `/` as relative to the directory
        holding the `--settings` file, so `Edit(/root/.local/share/turma-agent/**)`
        resolves against `~/.turma/guard-settings.json` and means
        `~/.turma/root/.local/...` — nothing. Measured: with one slash the
        two-Write hook-neutralisation attack succeeds, with two it is refused.
        The rule READ correctly and did nothing, and a test asserting only that
        the rule existed was green over it.
        """
        for d in ("/usr/local/bin", "/root/.local/share/turma-agent"):
            rule, = ha.runtime_code_deny_rules(script_dir=d, repos_root="/mnt/data/Docker/git")
            self.assertTrue(rule.startswith("Edit(//"),
                            f"{rule} is anchored at the settings file, so it matches nothing")

    def test_glob_metacharacters_in_the_install_path_are_escaped(self):
        # The path is interpolated into a glob, so a prefix containing `[` would
        # be read as a character class: the directory it names goes unprotected
        # while an unrelated one is wrongly denied.
        # This asserts the STRING, which is exactly the oracle that let the
        # broken spelling ship. What the matcher does with these rules is
        # measured in test_matcher_oracle.py; run it when changing the spelling.
        # Measured there: backslash escapes `[` and `*` and does not overreach.
        # The spelling that shipped broken wrapped EVERY metacharacter as `[c]`,
        # so `t[1]` became `t[[]1[]]`, which denies nothing — but `[[]` alone
        # does escape `[` correctly, so the old claim that the character-class
        # spelling "escapes nothing" was wrong. Don't repeat it.
        rule, = ha.runtime_code_deny_rules(script_dir="/opt/t[1]/agent",
                                           repos_root="/mnt/data/Docker/git")
        self.assertEqual(rule, r"Edit(//opt/t\[1]/agent/**)")
        rule, = ha.runtime_code_deny_rules(script_dir="/opt/st*r/agent",
                                           repos_root="/mnt/data/Docker/git")
        self.assertEqual(rule, r"Edit(//opt/st\*r/agent/**)")
        # Backslash must be escaped FIRST. A literal `\` in the path had its
        # next character read as escaped, leaving the real install unprotected
        # and denying an unrelated one — D16's defect, one character over.
        rule, = ha.runtime_code_deny_rules(script_dir="/opt/bs" + chr(92) + "k/agent",
                                           repos_root="/mnt/data/Docker/git")
        self.assertEqual(rule, "Edit(//opt/bs" + chr(92) * 2 + "k/agent/**)")
        self.assertEqual(ha._glob_literal("/plain/path"), "/plain/path")

    def test_an_unexpressable_install_path_is_reported_not_faked(self):
        # A literal `?` has no working escape in this matcher, so any rule built
        # for such a path protects the wrong thing. An unprotected prefix the
        # operator is TOLD about beats a rule everyone believes in.
        self.assertEqual(ha.runtime_code_deny_rules(script_dir="/opt/q?k/agent",
                                                    repos_root="/mnt/data/Docker/git"), [])

    def test_hooks_run_with_user_site_and_env_disabled(self):
        """`-sE` is the fix for the usercustomize hook-neutralisation.

        A plain interpreter start imports user-site `usercustomize` before the
        hook's own code, so ONE Write to
        ~/.local/lib/pythonX/site-packages/usercustomize.py disabled every hook
        on the host — measured: the Bash guard then allowed `rm -rf /`,
        `git push --force origin main` and `chmod -R 777 /`, and it persisted
        into every future python3 run as that user.
        """
        s = ha.build_guard_settings(python_exe="/usr/bin/python3")
        for entry in s["hooks"]["PreToolUse"]:
            cmd = entry["hooks"][0]["command"]
            self.assertIn("-SsE", cmd, f"{entry['matcher']} hook is neutralisable")
        limits = ha.build_limits_settings(python_exe="/usr/bin/python3")
        self.assertIn("-SsE", limits["statusLine"]["command"])

    def test_the_files_that_wire_the_guard_are_denied(self):
        # Denying the agent's installed code without these just moves the
        # two-Write attack one directory over: this file is what WIRES both
        # hooks. _ensure_guard_settings caches the path on the manager instance
        # and rewrites the file on a fresh process, so a tampered copy is handed
        # to every session that manager launches for the rest of its lifetime
        # (managers here run for days) and is repaired only by a restart.
        deny = ha.build_guard_settings()["permissions"]["deny"]
        self.assertIn("Edit(~/.turma/guard-settings.json)", deny)
        self.assertIn("Edit(~/.turma/limits-settings.json)", deny)
        # The interpreter injection points. A partial reduction only — they stop
        # a plant via the file-editing tools, and Bash walks past them like it
        # walks past every pattern (XERK-309). The -SsE flags are the real fix;
        # these are pinned so they are not deleted silently.
        for rule in ("Edit(~/.local/lib/python*/site-packages/**)",
                     "Edit(~/.local/lib/python*/site-packages/*.pth)",
                     "Edit(~/.config/python*/**)"):
            self.assertIn(rule, deny)

    #: Every literal rule in `_GUARD_DENY_PATH_RULES`, pinned by EQUALITY.
    #: Containment -- assertIn for the ones somebody remembered -- is what let
    #: SIX rules be deleted one at a time with this suite AND the live oracle
    #: green, including `settings.json*`, which is one of the oracle's own
    #: targets: `*.json` still covered it, so nothing observed the loss.
    #: Equality also fails when a rule is ADDED, which is deliberate: a new
    #: backstop should not land without someone pinning it here.
    EXPECTED_DENY_RULES = frozenset({
        "Edit(~/.ssh/**)",
        "Edit(~/.aws/**)",
        "Edit(~/.azure/**)",
        "Edit(~/.terraform.d/**)",
        "Edit(~/.claude.json)",
        "Edit(~/.claude/.*)",
        "Edit(~/.claude/*.json)",
        "Edit(~/.claude/*.jsonl)",
        "Edit(~/.claude/settings.json*)",
        "Edit(~/.claude/CLAUDE.md*)",
        "Edit(~/.claude/agents/**)",
        "Edit(~/.claude/bin/**)",
        "Edit(~/.claude/hooks/**)",
        "Edit(~/.claude/local/**)",
        "Edit(~/.claude/plugins/**)",
        "Edit(~/.claude/rules/**)",
        "Edit(~/.claude/sessions/**)",
        "Edit(~/.claude/shell-snapshots/**)",
        "Edit(~/.claude/skills/**)",
        "Edit(~/.claude/commands/**)",
        "Edit(~/.claude/output-styles/**)",
        "Edit(~/.claude/workflows/**)",
        "Edit(~/.claude/routines/**)",
        "Edit(~/.claude/cowork_plugins/**)",
        "Edit(~/.claude/jobs/**)",
        "Edit(~/.claude/daemon/**)",
        "Edit(~/.claude/ide/**)",
        "Edit(~/.claude/todos/**)",
        "Edit(~/.claude/themes/**)",
        "Edit(~/.claude/session-env/**)",
        "Edit(~/.claude/worktrees/**)",
        "Edit(~/.claude/plans/**)",
        "Edit(~/.claude/backups/**)",
        "Edit(~/.claude/statusline-command.sh)",
        "Edit(~/.claude/projects/*/*.jsonl)",
        "Edit(~/.claude/projects/*/subagents/**)",
        "Edit(~/.config/gcloud/**)",
        "Edit(~/.git-credentials)",
        "Read(~/.turma/local-model.env)",
        "Edit(~/.local/lib/python*/site-packages/**)",
        "Edit(~/.local/lib/python*/site-packages/*.pth)",
        "Edit(~/.config/python*/**)",
        "Edit(~/.turma/guard-settings.json)",
        "Edit(~/.turma/limits-settings.json)",
        "Edit(~/.turma/local-model.env)",
        # The peer roster is the org boundary (XERK-348), so a session must not
        # be able to append rows to its own address book.
        "Edit(~/.turma/peers.tsv)",
    })

    def test_every_claude_backstop_rule_is_pinned(self):
        """Whole groups of these have been deleted green, twice.

        First `test_catastrophic_paths_keep_pattern_denies_as_defence_in_depth`
        pinned only the rules predating the widening; then the replacement
        enumerated most of them and missed six. Compare the SET.
        """
        self.assertEqual(set(ha._GUARD_DENY_PATH_RULES), self.EXPECTED_DENY_RULES,
                         "a backstop rule was added or removed without being "
                         "pinned here; if the change is intended, update "
                         "EXPECTED_DENY_RULES in the same commit")
        deny = ha.build_guard_settings()["permissions"]["deny"]
        for rule in self.EXPECTED_DENY_RULES:
            self.assertIn(rule, deny, f"{rule} never reaches the settings file")
        # ...and none of them reaches a memory path. A rule matching a DIRECTORY
        # takes its whole subtree, which is how this broke twice.
        self.assertEqual([r for r in deny if "agent-memory" in r or "/memory/" in r], [])

    def test_a_developer_checkout_of_this_repo_stays_editable(self):
        # The same rule must NOT fire for a checkout under REPOS_ROOT: sessions
        # working on Turma have to be able to edit Turma, and those files are
        # not the running agent's — both installs put the runtime at a prefix
        # outside the git root.
        self.assertEqual(ha.runtime_code_deny_rules(
            script_dir="/mnt/data/Docker/git/Turma/agent",
            repos_root="/mnt/data/Docker/git"), [])
        self.assertEqual(ha.runtime_code_deny_rules(
            script_dir="/mnt/data/Docker/git", repos_root="/mnt/data/Docker/git"), [])
        # A path that merely shares a prefix is not inside it.
        self.assertNotEqual(ha.runtime_code_deny_rules(
            script_dir="/mnt/data/Docker/gitx/agent",
            repos_root="/mnt/data/Docker/git"), [])

    def test_fileguard_script_path_points_at_bundled_hook(self):
        path = ha.fileguard_script_path()
        self.assertTrue(path.endswith(os.path.join("hooks", "fileguard.py")))
        self.assertTrue(os.path.exists(path))

    def test_guard_script_path_points_at_bundled_hook(self):
        path = ha.guard_script_path()
        self.assertTrue(path.endswith(os.path.join("hooks", "guard.py")))
        self.assertTrue(os.path.exists(path))

    def test_explicit_guard_path_is_used(self):
        s = ha.build_guard_settings(python_exe="py", guard_path="/x/hooks/guard.py")
        cmd = s["hooks"]["PreToolUse"][0]["hooks"][0]["command"]
        self.assertEqual(cmd, '"py" -SsE "/x/hooks/guard.py"')

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
        self.assertEqual(ask["hooks"][0]["command"], '"py" -SsE "/x/hooks/ask.py"')

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
        path = self._write({"permissions": {"deny": ["Edit(~/.claude/**)"]}})
        deny = ha.build_guard_settings(local_settings_path=path)["permissions"]["deny"]
        self.assertEqual(deny.count("Edit(~/.claude/**)"), 1)

    def test_missing_file_is_noop(self):
        # No operator file: the settings carry exactly the app's own rules —
        # every guard deny, plus the uploads Read the app grants itself so an
        # attached file never costs a permission prompt (XERK-234).
        s = ha.build_guard_settings(local_settings_path="/no/such/file.json")
        self.assertEqual(s["permissions"]["allow"], list(ha._GUARD_ALLOW_PATH_RULES))
        # The runtime-code rule is GENERATED from where this module sits, and is
        # emitted whenever that is outside REPOS_ROOT — which is exactly how CI
        # checks out. Asserting the static list alone passed only when the tree
        # happened to live under /mnt/data/Docker/git.
        self.assertEqual(
            s["permissions"]["deny"],
            list(ha._GUARD_DENY_PATH_RULES) + ha._GUARD_DENY_TOOL_RULES
            + ha.runtime_code_deny_rules())

    def test_listagents_is_denied_and_sendmessage_is_not(self):
        # XERK-348. `ListAgents` enumerates the whole ACCOUNT — every org's hosts
        # and every cloud session — so it is org-blind by construction and no
        # setting narrows it. Denying it REMOVES the tool, which is what makes
        # PEERS_FILE (org-scoped by the hub) the only address book a session has.
        deny = ha.build_guard_settings()["permissions"]["deny"]
        self.assertIn("ListAgents", deny)
        # SendMessage must survive: it resolves a bare roster name with no prior
        # listing, and denying it would also remove messaging to SUBAGENTS and
        # agent-team teammates, which ride the same tool.
        self.assertNotIn("SendMessage", deny)

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

    def test_sessions_accept_peer_messages(self):
        # XERK-339. Claude Code's default HOLDS a cross-session message whenever
        # the two sessions' permission-mode classes differ — and bypassPermissions
        # is a class of its own — by opening an approval dialog in the RECEIVING
        # session's pane. Nothing in Turma answers that dialog (it is not an
        # AskUserQuestion, so the glasses bridge never sees it), and meanwhile it
        # owns the input line the chat composer types into.
        self.assertEqual(ha.build_guard_settings()["crossSessionInbound"],
                         "accept")

    def test_probe_settings_carry_no_inbound_policy(self):
        # The probe binds an inbox like any session but runs one no-op turn and
        # is killed; a message delivered there would go to a session about to
        # die, and its sender would never learn that.
        self.assertNotIn("crossSessionInbound", ha.build_limits_settings())

    def test_probe_settings_carry_no_hooks_or_permissions(self):
        # The probe runs one no-op turn in ~/.turma and is killed; the guard has
        # nothing to guard there, and inheriting it would be a second place the
        # guard's rules have to be kept true.
        s = ha.build_limits_settings()
        self.assertEqual(set(s), {"statusLine"})


if __name__ == "__main__":
    unittest.main()

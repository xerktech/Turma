#!/usr/bin/env python3
"""Tests for the ~/.claude file-write guard (agent/hooks/fileguard.py).

The claim under test is behavioural — "everything under ~/.claude is refused
except the two agent-memory trees" — so these drive `decide()` with real
resolved paths rather than asserting on rule strings. Three earlier attempts at
this as `permissions.deny` globs passed their string assertions while the
feature was 100% broken, twice.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

HOOKS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "hooks")
sys.path.insert(0, HOOKS_DIR)
import fileguard  # noqa: E402


class FileGuardBase(unittest.TestCase):
    def setUp(self):
        self.home = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.home, True)
        self._old_home = os.environ.get("HOME")
        os.environ["HOME"] = self.home
        self.addCleanup(self._restore_home)
        self.claude = os.path.join(self.home, ".claude")
        os.makedirs(self.claude)
        self.cwd = os.path.join(self.home, "worktree")
        os.makedirs(self.cwd)

    def _restore_home(self):
        if self._old_home is None:
            os.environ.pop("HOME", None)
        else:
            os.environ["HOME"] = self._old_home

    def decide(self, path, tool="Write", key="file_path", cwd=None):
        return fileguard.decide({
            "tool_name": tool,
            "tool_input": {key: path},
            "cwd": cwd or self.cwd,
        })

    def assertRefused(self, path, **kw):
        self.assertIsNotNone(self.decide(path, **kw), f"{path} must be refused")

    def assertAllowed(self, path, **kw):
        self.assertIsNone(self.decide(path, **kw), f"{path} must be allowed")


class TestMemoryTreesAreWritable(FileGuardBase):
    """The carve-out. Without these the feature does not exist."""

    def test_agent_memory_is_writable(self):
        for rel in ("agent-memory/qa/MEMORY.md",
                    "agent-memory/qa/turma.md",
                    "agent-memory/qa/nested/deep/notes.md",
                    "agent-memory/a-brand-new-agent/MEMORY.md"):
            self.assertAllowed(os.path.join(self.claude, rel))

    def test_project_auto_memory_is_writable(self):
        for rel in ("projects/-mnt-data-Docker-git/memory/MEMORY.md",
                    "projects/-mnt-data-Docker-git/memory/sub/x.md",
                    "projects/-a-brand-new-slug/memory/MEMORY.md"):
            self.assertAllowed(os.path.join(self.claude, rel))

    def test_every_file_editing_tool_reaches_the_carve_out(self):
        p = os.path.join(self.claude, "agent-memory/qa/MEMORY.md")
        for tool in ("Write", "Edit", "MultiEdit", "NotebookEdit"):
            self.assertAllowed(p, tool=tool)
        self.assertAllowed(p, tool="NotebookEdit", key="notebook_path")

    def test_every_file_editing_tool_is_actually_GUARDED(self):
        """An allow-only per-tool test passes when the tool isn't guarded at all.

        Exactly that let three mutations through — dropping `Edit` or
        `NotebookEdit` from FILE_TOOLS, or `notebook_path` from PATH_KEYS — while
        the suite stayed green. Every tool and every path key needs a REFUSAL.
        """
        denied = os.path.join(self.claude, "settings.json")
        for tool in ("Write", "Edit", "MultiEdit", "NotebookEdit"):
            self.assertRefused(denied, tool=tool)
        for key in ("file_path", "notebook_path", "path"):
            self.assertRefused(denied, tool="NotebookEdit", key=key)
            self.assertRefused(denied, tool="Write", key=key)


class TestClaudeConfigIsProtected(FileGuardBase):
    def test_credentials_and_settings(self):
        for rel in (".credentials.json", "settings.json", "settings.json.bak-preperms",
                    "CLAUDE.md", "CLAUDE.local.md", "history.jsonl"):
            self.assertRefused(os.path.join(self.claude, rel))

    def test_claude_json_sibling_carries_mcp_servers(self):
        # Outside the directory, not inside it: `~/.claude.json` holds
        # `mcpServers` — command lines run at the next session's startup.
        self.assertRefused(os.path.join(self.home, ".claude.json"))

    def test_execution_surfaces(self):
        for rel in ("shell-snapshots/snapshot-zsh-1.sh",   # sourced by every Bash call
                    "sessions/1.abc.key",
                    "bin/instruction-size-guard.py",
                    "agents/qa.md",
                    "plugins/p/index.js",
                    "hooks/guard.py",
                    "local/claude",                        # the claude binary itself
                    "local/node_modules/x.js",
                    "rules/injected.md",
                    "output-styles/evil.md",
                    "skills/s/SKILL.md",
                    "commands/c.md",
                    "ide/9999.lock",
                    "statusline-command.sh",
                    "loop.md"):
            self.assertRefused(os.path.join(self.claude, rel))

    def test_a_directory_this_build_has_never_heard_of(self):
        """The whole reason this is a hook and not a glob list.

        Three glob attempts each failed on a path nobody had enumerated. A
        predicate needs no list, so a directory Claude Code adds in a future
        release is refused the day it appears.
        """
        for rel in ("brand-new-thing/evil.sh",
                    "workflows/w.md", "routines/r.md", "cowork_plugins/p/x.js",
                    "daemon/d.sock", "jobs/j.json", "themes/t.json",
                    "some/deeply/nested/thing/nobody/listed.txt"):
            self.assertRefused(os.path.join(self.claude, rel))

    def test_transcripts_and_subagent_transcripts(self):
        for rel in ("projects/-slug/a1b2.jsonl",
                    "projects/-slug/subagents/agent-1.jsonl",
                    "projects/-slug/notes.md",
                    "projects/-slug/newdir/x.txt",
                    "projects/top-level.jsonl"):
            self.assertRefused(os.path.join(self.claude, rel))


class TestCarveOutBoundaries(FileGuardBase):
    def test_the_memory_directory_entry_itself_is_not_writable(self):
        """A session must not plant a FILE where a memory DIRECTORY belongs.

        Writing `projects/<slug>/memory` as a regular file makes that directory
        impossible to create, permanently disabling another project's auto-memory
        (mkdir then fails with NotADirectoryError). Same for the roots.
        """
        for rel in ("agent-memory", "agent-memory/qa", "projects/-slug/memory"):
            self.assertRefused(os.path.join(self.claude, rel))

    def test_dot_dot_cannot_escape_the_carve_out(self):
        self.assertRefused(os.path.join(self.claude, "agent-memory/qa/../../agents/x.md"))
        self.assertRefused(os.path.join(self.claude, "projects/-s/memory/../../../bin/x.py"))

    def test_a_symlink_out_of_the_carve_out_is_resolved_and_refused(self):
        os.makedirs(os.path.join(self.claude, "agent-memory", "qa"))
        os.makedirs(os.path.join(self.claude, "agents"))
        link = os.path.join(self.claude, "agent-memory", "qa", "escape")
        os.symlink(os.path.join(self.claude, "agents"), link)
        self.assertRefused(os.path.join(link, "qa.md"))

    def test_a_symlink_into_the_config_dir_from_outside_is_refused(self):
        link = os.path.join(self.cwd, "sneaky")
        os.symlink(self.claude, link)
        self.assertRefused(os.path.join(link, "settings.json"))

    def test_a_relative_path_resolves_against_the_payload_cwd(self):
        self.assertRefused("../.claude/settings.json")
        self.assertAllowed("../.claude/agent-memory/qa/MEMORY.md")

    def test_paths_outside_the_config_dir_are_none_of_our_business(self):
        for p in (os.path.join(self.cwd, "src/main.py"),
                  os.path.join(self.home, ".claudex/settings.json"),   # prefix, not parent
                  "/tmp/scratch/whatever.txt"):
            self.assertAllowed(p)


class TestHookContract(FileGuardBase):
    def test_non_file_tools_are_ignored(self):
        for tool in ("Bash", "Read", "Grep", "Task", "WebFetch"):
            self.assertAllowed(os.path.join(self.claude, "settings.json"), tool=tool)

    def test_malformed_input_fails_open(self):
        # Same direction guard.py fails: a hook that blocks every edit because it
        # could not parse its own input takes the fleet down, and the
        # catastrophic paths are covered by permissions.deny patterns anyway.
        for payload in ({}, {"tool_name": "Write"},
                        {"tool_name": "Write", "tool_input": None},
                        {"tool_name": "Write", "tool_input": {}},
                        {"tool_name": "Write", "tool_input": {"file_path": None}},
                        {"tool_name": "Write", "tool_input": {"file_path": ""}}):
            self.assertIsNone(fileguard.decide(payload))

    def test_denial_is_the_documented_pretooluse_shape(self):
        out = subprocess.run(
            [sys.executable, os.path.join(HOOKS_DIR, "fileguard.py")],
            input=json.dumps({"tool_name": "Write", "cwd": self.cwd,
                              "tool_input": {"file_path": os.path.join(self.claude, "settings.json")}}),
            capture_output=True, text=True, env={**os.environ, "HOME": self.home},
        )
        self.assertEqual(out.returncode, 0)
        hook = json.loads(out.stdout)["hookSpecificOutput"]
        self.assertEqual(hook["hookEventName"], "PreToolUse")
        self.assertEqual(hook["permissionDecision"], "deny")
        self.assertIn("agent-memory", hook["permissionDecisionReason"])

    def test_allow_is_silent_and_exit_zero(self):
        out = subprocess.run(
            [sys.executable, os.path.join(HOOKS_DIR, "fileguard.py")],
            input=json.dumps({"tool_name": "Write", "cwd": self.cwd,
                              "tool_input": {"file_path": os.path.join(self.cwd, "x.py")}}),
            capture_output=True, text=True, env={**os.environ, "HOME": self.home},
        )
        self.assertEqual(out.returncode, 0)
        self.assertEqual(out.stdout, "")

    def test_unparseable_stdin_still_exits_zero(self):
        out = subprocess.run(
            [sys.executable, os.path.join(HOOKS_DIR, "fileguard.py")],
            input="not json at all", capture_output=True, text=True,
        )
        self.assertEqual(out.returncode, 0)
        self.assertEqual(out.stdout, "")


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
"""Unit tests for agent/hub-agent.py (stdlib unittest only — mirrors the
image's no-pip stance; CI runs `python3 -m unittest discover -s agent/tests`).

The module is imported by file path (its name has a dash) and its module-level
constants (PROJECTS_ROOT, REGISTRY_PATH, ...) are patched per-test, so no test
ever touches /root or the real registry. SessionManager's subprocess use is
faked at its two chokepoints, run()/run_ok(), plus Popen for ttyd — no
docker/tmux/git needed.
"""

import importlib.util
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from collections import deque
from unittest import mock

AGENT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODULE_PATH = os.path.join(AGENT_DIR, "hub-agent.py")

spec = importlib.util.spec_from_file_location("hub_agent", MODULE_PATH)
ha = importlib.util.module_from_spec(spec)
sys.modules["hub_agent"] = ha
spec.loader.exec_module(ha)


def write_jsonl(path, lines):
    """Write transcript lines; each item is a dict (JSON-encoded) or a raw
    string (written verbatim, for truncated/garbage fixtures)."""
    with open(path, "a") as f:
        for line in lines:
            f.write(line if isinstance(line, str) else json.dumps(line))
            f.write("\n")


def usage_entry(ts, msg_id, request_id, model, inp, out, cw=0, cr=0):
    return {
        "timestamp": ts,
        "requestId": request_id,
        "message": {
            "id": msg_id,
            "model": model,
            "usage": {
                "input_tokens": inp,
                "output_tokens": out,
                "cache_creation_input_tokens": cw,
                "cache_read_input_tokens": cr,
            },
        },
    }


class TestSlugify(unittest.TestCase):
    def test_spaces_become_dashes(self):
        self.assertEqual(ha.slugify("my repo name"), "my-repo-name")

    def test_punctuation_dropped_and_collapsed(self):
        self.assertEqual(ha.slugify("My Repo!"), "My-Repo")
        self.assertEqual(ha.slugify("a/b\\c"), "a-b-c")
        self.assertEqual(ha.slugify("a---b"), "a-b")

    def test_keeps_dot_underscore_dash(self):
        self.assertEqual(ha.slugify("re.po_name-1"), "re.po_name-1")

    def test_strips_leading_trailing_dashes(self):
        self.assertEqual(ha.slugify("  --hello-- "), "hello")

    def test_empty_and_none(self):
        self.assertEqual(ha.slugify(""), "")
        self.assertEqual(ha.slugify(None), "")
        self.assertEqual(ha.slugify("!!!"), "")


class TestSpawnOptionHelpers(unittest.TestCase):
    """Validation for the composer's spawn options (#11/#12/#13) — everything
    that gets interpolated into a git/tmux command line is allowlist-checked."""

    def test_normalize_branch_blank_uses_agent_id(self):
        self.assertEqual(ha.normalize_branch_name("", "abc12"), "agent/abc12")
        self.assertEqual(ha.normalize_branch_name(None, "abc12"), "agent/abc12")
        self.assertEqual(ha.normalize_branch_name("  ", "abc12"), "agent/abc12")

    def test_normalize_branch_forces_agent_prefix(self):
        self.assertEqual(ha.normalize_branch_name("fix-login", "abc12"), "agent/fix-login")
        # An operator-supplied agent/ prefix is not doubled.
        self.assertEqual(ha.normalize_branch_name("agent/fix-login", "abc12"), "agent/fix-login")
        # agent/ with an empty core falls back to the id.
        self.assertEqual(ha.normalize_branch_name("agent/", "abc12"), "agent/abc12")

    def test_normalize_branch_rejects_bad_names(self):
        for bad in ("../evil", "a..b", "has space", "semi;colon", "quote'x",
                    "back`tick", "dollar$x", "tilde~x", "agent/..", "a\tb"):
            with self.assertRaises(ValueError, msg=bad):
                ha.normalize_branch_name(bad, "abc12")

    def test_valid_ref_name(self):
        self.assertTrue(ha.valid_ref_name("main"))
        self.assertTrue(ha.valid_ref_name("origin/main"))
        self.assertTrue(ha.valid_ref_name("release/v1.2.3"))
        for bad in ("", "-x", "/x", "x/", "a..b", "a//b", "x.lock", "a@{0}", "a b", "a;b"):
            self.assertFalse(ha.valid_ref_name(bad), bad)

    def test_resolve_model(self):
        self.assertIsNone(ha.resolve_model(""))
        self.assertIsNone(ha.resolve_model(None))
        self.assertIsNone(ha.resolve_model("default"))
        self.assertEqual(ha.resolve_model("opus"), "opus")
        self.assertEqual(ha.resolve_model("SONNET"), "sonnet")
        self.assertEqual(ha.resolve_model("haiku"), "haiku")
        for bad in ("gpt-4", "opus; rm", "claude-3"):
            with self.assertRaises(ValueError):
                ha.resolve_model(bad)

    def test_resolve_permission_mode(self):
        self.assertEqual(ha.resolve_permission_mode(""), "bypassPermissions")
        self.assertEqual(ha.resolve_permission_mode("acceptEdits"), "acceptEdits")
        self.assertEqual(ha.resolve_permission_mode("plan"), "plan")
        self.assertEqual(ha.resolve_permission_mode("default"), "default")
        for bad in ("root", "yolo", "accept edits"):
            with self.assertRaises(ValueError):
                ha.resolve_permission_mode(bad)

    def test_resolve_base_ref(self):
        # Blank / HEAD -> None (fork off current HEAD, today's behavior).
        self.assertIsNone(ha.resolve_base_ref("/repo", ""))
        self.assertIsNone(ha.resolve_base_ref("/repo", "HEAD"))

        # Allowlist-clean AND resolvable -> returned; missing -> ValueError.
        def fake_run(cmd, cwd=None):
            return "sha" if " ".join(cmd).endswith("--verify --quiet develop") else ""

        with mock.patch.object(ha, "run", fake_run):
            self.assertEqual(ha.resolve_base_ref("/repo", "develop"), "develop")
            with self.assertRaises(ValueError):
                ha.resolve_base_ref("/repo", "nope")            # not found
            with self.assertRaises(ValueError):
                ha.resolve_base_ref("/repo", "bad;ref")         # bad chars, never hits git


class ProjectDirMixin:
    """Temp PROJECTS_ROOT + a project dir for a fake worktree path."""

    WORKDIR = "/w/repo"

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="hub-agent-test-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        patcher = mock.patch.object(ha, "PROJECTS_ROOT", self.tmp)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.proj = os.path.join(self.tmp, self.WORKDIR.replace("/", "-"))
        os.makedirs(self.proj)


class TestUsageReport(ProjectDirMixin, unittest.TestCase):
    def test_missing_project_dir_returns_none(self):
        self.assertIsNone(ha.usage_report("/does/not/exist"))

    def test_aggregation_dedup_and_pricing(self):
        today = time.strftime("%Y-%m-%d")
        opus = usage_entry(
            "2026-07-01T10:00:00.000Z", "m1", "r1",
            "claude-opus-4-20250514", 1_000_000, 100_000,
        )  # 1M in @ $5 + 100k out @ $25 = $7.50
        unknown = usage_entry(
            "2026-07-02T09:00:00.000Z", "m2", "r2",
            "weird-model-x", 10, 20, cw=30, cr=40,
        )  # unknown model: tokens counted, cost 0
        no_id = usage_entry(
            f"{today}T01:00:00.000Z", None, None,
            "claude-sonnet-4-20250514", 100_000, 0,
        )  # id-less entries are never deduped; sonnet 100k in = $0.30

        write_jsonl(os.path.join(self.proj, "a.jsonl"), [
            opus,
            opus,  # exact duplicate (same message id + requestId) -> skipped
            unknown,
            {"type": "user", "message": {"content": "no usage here"}},
            {"message": {"usage": "not-a-dict"}},  # malformed usage -> skipped
            # truncated tail (partial write): contains "usage" but bad JSON
            '{"timestamp":"2026-07-02T12:00:00Z","message":{"usage":{"input_tokens":5',
        ])
        write_jsonl(os.path.join(self.proj, "b.jsonl"), [
            opus,   # cross-file duplicate -> still deduped
            no_id,
            no_id,  # identical but id-less -> counted twice
        ])

        rep = ha.usage_report(self.WORKDIR)
        self.assertEqual(rep["sessions"], 2)  # two transcript files
        self.assertEqual(rep["totals"]["input"], 1_000_000 + 10 + 200_000)
        self.assertEqual(rep["totals"]["output"], 100_000 + 20)
        self.assertEqual(rep["totals"]["cacheWrite"], 30)
        self.assertEqual(rep["totals"]["cacheRead"], 40)
        self.assertAlmostEqual(rep["totals"]["cost"], 7.5 + 0.0 + 0.6, places=2)

        # Per-day buckets: opus on 07-01, unknown on 07-02, sonnet today.
        self.assertAlmostEqual(rep["days"]["2026-07-01"]["cost"], 7.5, places=2)
        self.assertEqual(rep["days"]["2026-07-02"]["input"], 10)
        self.assertAlmostEqual(rep["days"]["2026-07-02"]["cost"], 0.0, places=2)
        self.assertEqual(rep["today"], rep["days"][today])
        self.assertEqual(rep["today"]["input"], 200_000)

        self.assertEqual(rep["lastActivity"], f"{today}T01:00:00.000Z")
        # sonnet has 2 messages, opus and weird-model-x 1 each -> sonnet first.
        self.assertEqual(rep["models"][0], "claude-sonnet-4-20250514")
        self.assertIn("weird-model-x", rep["models"])

    def test_empty_project_dir(self):
        rep = ha.usage_report(self.WORKDIR)
        self.assertEqual(rep["sessions"], 0)
        self.assertEqual(rep["totals"]["input"], 0)
        self.assertEqual(rep["days"], {})
        self.assertEqual(rep["lastActivity"], "")


class TestLastEntry(ProjectDirMixin, unittest.TestCase):
    def test_skips_truncated_tail(self):
        path = os.path.join(self.proj, "t.jsonl")
        write_jsonl(path, [{"type": "assistant", "n": 1}, {"type": "assistant", "n": 2}])
        with open(path, "a") as f:
            f.write('{"type":"assistant","n":3')  # partial write, no newline
        self.assertEqual(ha._last_entry(path)["n"], 2)

    def test_missing_file(self):
        self.assertIsNone(ha._last_entry(os.path.join(self.proj, "nope.jsonl")))


class TestSessionReport(ProjectDirMixin, unittest.TestCase):
    PR1 = "https://github.com/xerktech/AgentHub/pull/34"
    PR2 = "https://github.com/xerktech/DockerOps/pull/7"

    def entry_with_text(self, text):
        return {
            "type": "assistant",
            "message": {"content": [{"type": "text", "text": text}]},
        }

    def test_missing_project_dir(self):
        state = {}
        rep = ha.session_report("/absent/worktree", state)
        self.assertFalse(rep["bridgeAttached"])
        self.assertIsNone(rep["transcriptAgeSec"])
        self.assertEqual(rep["prUrls"], [])
        self.assertTrue(state["primed"])  # still primes so later beats scan

    def test_prime_to_eof_then_incremental_pr_scan(self):
        path = os.path.join(self.proj, "s.jsonl")
        write_jsonl(path, [self.entry_with_text(f"old PR: {self.PR1}")])

        state = {}
        rep = ha.session_report(self.WORKDIR, state)
        # First beat primes offsets to EOF: pre-existing PR link NOT replayed.
        self.assertEqual(rep["prUrls"], [])
        self.assertEqual(rep["lastRole"], "assistant")
        self.assertIsNotNone(rep["transcriptAgeSec"])

        write_jsonl(path, [self.entry_with_text(f"opened {self.PR2} just now")])
        rep = ha.session_report(self.WORKDIR, state)
        self.assertEqual(rep["prUrls"], [self.PR2])

        # Same URL appended again -> already seen, not re-reported.
        write_jsonl(path, [self.entry_with_text(f"again {self.PR2}")])
        rep = ha.session_report(self.WORKDIR, state)
        self.assertEqual(rep["prUrls"], [])

    def test_truncated_file_resets_offset_without_rescan(self):
        path = os.path.join(self.proj, "s.jsonl")
        write_jsonl(path, [self.entry_with_text("hello")] * 5)
        state = {}
        ha.session_report(self.WORKDIR, state)  # primes offset to EOF

        # Rewrite shorter (context clear / rotation). The old bytes contain a
        # PR URL, but offset resets to the new size — nothing is rescanned.
        with open(path, "w") as f:
            f.write(json.dumps(self.entry_with_text(f"reset {self.PR1}")) + "\n")
        rep = ha.session_report(self.WORKDIR, state)
        self.assertEqual(rep["prUrls"], [])

        # Appends after the truncation ARE picked up.
        write_jsonl(path, [self.entry_with_text(f"new {self.PR2}")])
        rep = ha.session_report(self.WORKDIR, state)
        self.assertEqual(rep["prUrls"], [self.PR2])

    def test_question_and_tool_use_detection(self):
        path = os.path.join(self.proj, "s.jsonl")
        long_q = "Why? " * 100  # > 300 chars
        write_jsonl(path, [{
            "type": "assistant",
            "message": {"content": [
                {"type": "text", "text": "thinking"},
                {"type": "tool_use", "name": "AskUserQuestion",
                 "input": {"questions": [{"question": long_q}]}},
            ]},
        }])
        rep = ha.session_report(self.WORKDIR, {})
        self.assertEqual(rep["lastRole"], "assistant")
        self.assertTrue(rep["lastHasToolUse"])
        self.assertEqual(rep["question"], long_q[:300])
        self.assertEqual(len(rep["question"]), 300)

    def test_plain_tool_use_is_not_a_question(self):
        path = os.path.join(self.proj, "s.jsonl")
        write_jsonl(path, [{
            "type": "assistant",
            "message": {"content": [{"type": "tool_use", "name": "Bash", "input": {}}]},
        }])
        rep = ha.session_report(self.WORKDIR, {})
        self.assertTrue(rep["lastHasToolUse"])
        self.assertIsNone(rep["question"])

    def test_bridge_pointer_presence(self):
        with open(os.path.join(self.proj, "bridge-pointer.json"), "w") as f:
            f.write("{}")
        rep = ha.session_report(self.WORKDIR, {})
        self.assertTrue(rep["bridgeAttached"])


class ManagerMixin:
    """SessionManager with subprocess chokepoints faked and a temp registry."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="hub-agent-mgr-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.run_calls = []
        self.run_ok_calls = []

        def fake_run(cmd, cwd=None):
            self.run_calls.append(cmd)
            return ""

        def fake_run_ok(cmd, cwd=None):
            self.run_ok_calls.append(cmd)
            return 0, ""

        for name, value in [
            ("run", fake_run),
            ("run_ok", fake_run_ok),
            ("REGISTRY_DIR", self.tmp),
            ("REGISTRY_PATH", os.path.join(self.tmp, "sessions.json")),
            ("CLOSED_PATH", os.path.join(self.tmp, "closed.json")),
            ("PROJECTS_ROOT", os.path.join(self.tmp, "projects")),
            ("WORKTREES_ROOT", os.path.join(self.tmp, "worktrees")),
        ]:
            p = mock.patch.object(ha, name, value)
            p.start()
            self.addCleanup(p.stop)

    def make_manager(self):
        return ha.SessionManager()


class TestRegistryPersistence(ManagerMixin, unittest.TestCase):
    def test_save_load_round_trip(self):
        sm = self.make_manager()
        self.assertEqual(sm.registry, [])  # fresh boot: no registry file
        sm.registry = [
            {"id": "ab123", "repo": "AgentHub", "status": "running", "ttydPort": 7700},
            {"id": "cd456", "repo": "DockerOps", "status": "stopped", "ttydPort": 7701},
        ]
        sm.save()
        self.assertFalse(os.path.exists(ha.REGISTRY_PATH + ".tmp"))  # atomic
        sm2 = self.make_manager()
        self.assertEqual(sm2.registry, sm.registry)

    def test_corrupt_registry_yields_empty(self):
        os.makedirs(ha.REGISTRY_DIR, exist_ok=True)
        with open(ha.REGISTRY_PATH, "w") as f:
            f.write("{not json!")
        self.assertEqual(self.make_manager().registry, [])

    def test_non_list_registry_yields_empty(self):
        os.makedirs(ha.REGISTRY_DIR, exist_ok=True)
        with open(ha.REGISTRY_PATH, "w") as f:
            json.dump({"id": "notalist"}, f)
        self.assertEqual(self.make_manager().registry, [])


class TestPortAndIdAllocation(ManagerMixin, unittest.TestCase):
    def test_alloc_port_from_base(self):
        sm = self.make_manager()
        self.assertEqual(sm._alloc_port(), ha.TTYD_PORT_BASE)

    def test_alloc_port_skips_used_and_fills_gaps(self):
        sm = self.make_manager()
        base = ha.TTYD_PORT_BASE
        sm.registry = [{"id": "a", "ttydPort": base}, {"id": "b", "ttydPort": base + 2}]
        self.assertEqual(sm._alloc_port(), base + 1)
        sm.registry.append({"id": "c", "ttydPort": base + 1})
        self.assertEqual(sm._alloc_port(), base + 3)

    def test_new_id_avoids_existing(self):
        sm = self.make_manager()
        sm.registry = [{"id": "aaaaa"}]
        ids = {sm._new_id() for _ in range(50)}
        self.assertNotIn("aaaaa", ids)
        for sid in ids:
            self.assertEqual(len(sid), 5)


class TestAckDeque(ManagerMixin, unittest.TestCase):
    def test_eviction_keeps_set_bounded_and_in_sync(self):
        sm = self.make_manager()
        sm.acked_order = deque(maxlen=3)  # shrink for the test
        for cid in ["c1", "c2", "c3"]:
            sm._ack(cid)
        self.assertEqual(sm.acked, {"c1", "c2", "c3"})
        sm._ack("c4")  # evicts c1
        self.assertEqual(sm.acked, {"c2", "c3", "c4"})
        self.assertEqual(list(sm.acked_order), ["c2", "c3", "c4"])
        sm._ack("c5")  # keeps evicting oldest-first, set stays in sync
        self.assertEqual(sm.acked, {"c3", "c4", "c5"})
        self.assertEqual(len(sm.acked), len(sm.acked_order))


class TestHandleCommands(ManagerMixin, unittest.TestCase):
    def test_dedup_and_dispatch(self):
        sm = self.make_manager()
        sm.spawn = mock.Mock()
        sm.kill = mock.Mock()
        sm.save = mock.Mock()

        cmds = [
            {"cmdId": "c1", "type": "spawn", "repo": "AgentHub"},
            {"cmdId": "c2", "type": "kill", "sessionId": "ab123"},
            {"type": "kill", "sessionId": "no-cmd-id"},  # no cmdId -> ignored
            "not-a-dict",                                 # garbage -> ignored
        ]
        self.assertTrue(sm.handle_commands(cmds))
        # spawn now threads the composer options (all None for a bare command).
        sm.spawn.assert_called_once_with(
            "AgentHub", prompt=None, label=None, base_ref=None,
            branch_name=None, model=None, permission_mode=None,
        )
        sm.kill.assert_called_once_with("ab123")
        sm.save.assert_called_once()
        self.assertEqual(sm.acked, {"c1", "c2"})

        # Re-delivery of the same cmdIds (at-least-once): nothing re-executes.
        sm.spawn.reset_mock()
        sm.kill.reset_mock()
        self.assertFalse(sm.handle_commands(cmds))
        sm.spawn.assert_not_called()
        sm.kill.assert_not_called()

    def test_spawn_command_threads_composer_options(self):
        sm = self.make_manager()
        sm.spawn = mock.Mock()
        sm.save = mock.Mock()
        sm.handle_commands([{
            "cmdId": "c9", "type": "spawn", "repo": "AgentHub",
            "prompt": "fix the bug", "label": "Fix login", "baseRef": "main",
            "branchName": "agent/fix-login", "model": "opus",
            "permissionMode": "plan",
        }])
        sm.spawn.assert_called_once_with(
            "AgentHub", prompt="fix the bug", label="Fix login", base_ref="main",
            branch_name="agent/fix-login", model="opus", permission_mode="plan",
        )

    def test_unknown_type_and_poison_command_still_acked(self):
        sm = self.make_manager()
        sm.save = mock.Mock()
        sm.restart = mock.Mock(side_effect=RuntimeError("boom"))
        cmds = [
            {"cmdId": "u1", "type": "frobnicate"},
            {"cmdId": "p1", "type": "restart", "sessionId": "x"},
        ]
        self.assertTrue(sm.handle_commands(cmds))  # no exception escapes
        self.assertEqual(sm.acked, {"u1", "p1"})

    def test_empty_and_none(self):
        sm = self.make_manager()
        sm.save = mock.Mock()
        self.assertFalse(sm.handle_commands([]))
        self.assertFalse(sm.handle_commands(None))
        sm.save.assert_not_called()


class TestSessionLifecycle(ManagerMixin, unittest.TestCase):
    def make_spawn_ready_manager(self, repos):
        sm = self.make_manager()
        p = mock.patch.object(ha, "scan_repos", lambda: repos)
        p.start()
        self.addCleanup(p.stop)
        sm._launch_ttyd = mock.Mock()  # avoid the real Popen
        return sm

    def test_spawn_creates_registry_entry(self):
        repo = {"name": "AgentHub", "path": os.path.join(self.tmp, "AgentHub")}
        sm = self.make_spawn_ready_manager([repo])
        sm.spawn("AgentHub")
        self.assertEqual(len(sm.registry), 1)
        sess = sm.registry[0]
        self.assertEqual(sess["status"], "running")
        self.assertEqual(sess["repo"], "AgentHub")
        self.assertEqual(sess["branch"], f"agent/{sess['id']}")
        self.assertEqual(sess["ttydPort"], ha.TTYD_PORT_BASE)
        self.assertEqual(sess["tmuxName"], f"agent-{sess['id']}")
        self.assertTrue(sess["rcName"].endswith(f"-AgentHub-{sess['id']}"))
        self.assertEqual(
            sess["worktreePath"],
            os.path.join(ha.WORKTREES_ROOT, "AgentHub", sess["id"]),
        )
        # git worktree add -b agent/<id> went through run_ok
        self.assertTrue(any("worktree" in c and "-b" in c for c in self.run_ok_calls))

    def test_spawn_refused_at_max_sessions(self):
        repo = {"name": "AgentHub", "path": os.path.join(self.tmp, "AgentHub")}
        sm = self.make_spawn_ready_manager([repo])
        p = mock.patch.object(ha, "MAX_SESSIONS", 1)
        p.start()
        self.addCleanup(p.stop)
        sm.registry = [{"id": "aaaaa", "status": "running", "ttydPort": 7700}]
        sm.spawn("AgentHub")
        self.assertEqual(len(sm.registry), 1)  # unchanged

    def test_spawn_refused_for_unknown_repo(self):
        sm = self.make_spawn_ready_manager([])
        sm.spawn("NoSuchRepo")
        self.assertEqual(sm.registry, [])

    def test_kill_drops_record_but_keeps_no_branch_delete(self):
        repo = {"name": "AgentHub", "path": os.path.join(self.tmp, "AgentHub")}
        sm = self.make_spawn_ready_manager([repo])
        sm.spawn("AgentHub")
        sid = sm.registry[0]["id"]
        sm.usage_cache[sid] = {"totals": {}}
        sm.kill(sid)
        self.assertEqual(sm.registry, [])
        self.assertNotIn(sid, sm.usage_cache)
        # kill keeps the branch: no `git branch -D` may be issued
        self.assertFalse(
            any("branch" in c and "-D" in c for c in self.run_calls),
            f"kill must not delete the branch: {self.run_calls}",
        )

    def _stub_git_state(self, branch, *, pushed, ahead_remote="0", ahead_base="0"):
        """Overlay the blanket fake run with the git answers the delete guard
        asks for: the branch exists, the checkout sits on main, and the
        pushed/ahead state is as given."""
        local = f"refs/heads/{branch}"
        remote = f"refs/remotes/origin/{branch}"

        def fake_run(cmd, cwd=None):
            self.run_calls.append(cmd)
            joined = " ".join(cmd)
            if "rev-parse --abbrev-ref HEAD" in joined:
                return "main"
            if joined.endswith(f"--verify --quiet {local}"):
                return "abc123"
            if joined.endswith(f"--verify --quiet {remote}"):
                return "def456" if pushed else ""
            if f"rev-list --count {remote}..{local}" in joined:
                return ahead_remote
            if f"rev-list --count refs/heads/main..{local}" in joined:
                return ahead_base
            return ""

        p = mock.patch.object(ha, "run", fake_run)
        p.start()
        self.addCleanup(p.stop)

    def test_delete_hard_deletes_safe_branch(self):
        repo = {"name": "AgentHub", "path": os.path.join(self.tmp, "AgentHub")}
        sm = self.make_spawn_ready_manager([repo])
        sm.spawn("AgentHub")
        sid = sm.registry[0]["id"]
        branch = sm.registry[0]["branch"]
        self._stub_git_state(branch, pushed=True, ahead_remote="0")
        sm.delete(sid)
        self.assertEqual(sm.registry, [])
        self.assertTrue(
            any("-D" in c and branch in c for c in self.run_calls),
            f"pushed-and-in-sync branch must be hard-deleted: {self.run_calls}",
        )

    def test_delete_parks_unpushed_branch_in_trash(self):
        repo = {"name": "AgentHub", "path": os.path.join(self.tmp, "AgentHub")}
        sm = self.make_spawn_ready_manager([repo])
        sm.spawn("AgentHub")
        sid = sm.registry[0]["id"]
        branch = sm.registry[0]["branch"]
        self._stub_git_state(branch, pushed=False, ahead_base="3")
        sm.delete(sid)
        self.assertEqual(sm.registry, [])
        self.assertFalse(
            any("-D" in c and branch in c for c in self.run_calls),
            f"unpushed branch must not be hard-deleted: {self.run_calls}",
        )
        renames = [
            c for c in self.run_ok_calls
            if "-m" in c and branch in c
            and any(a.startswith(ha.TRASH_PREFIX) for a in c)
        ]
        self.assertTrue(
            renames,
            f"unpushed branch must be parked in trash: {self.run_ok_calls}",
        )

    def test_start_refuses_when_already_running_or_full(self):
        sm = self.make_manager()
        sm._launch_tmux = mock.Mock()
        sm._launch_ttyd = mock.Mock()
        sm.registry = [{"id": "aaaaa", "status": "running", "ttydPort": 7700,
                        "worktreePath": self.tmp, "tmuxName": "agent-aaaaa"}]
        sm.start("aaaaa")  # already running: no relaunch
        sm._launch_tmux.assert_not_called()

    def test_start_resumes_stopped_session(self):
        sm = self.make_manager()
        sm._launch_tmux = mock.Mock()
        sm._launch_ttyd = mock.Mock()
        sess = {"id": "aaaaa", "status": "stopped", "stoppedAt": "x",
                "errorMsg": "old", "ttydPort": 7700,
                "worktreePath": self.tmp, "tmuxName": "agent-aaaaa"}
        sm.registry = [sess]
        sm.start("aaaaa")
        self.assertEqual(sess["status"], "running")
        self.assertIsNone(sess["stoppedAt"])
        self.assertIsNone(sess["errorMsg"])
        sm._launch_tmux.assert_called_once()

    def test_error_is_captured_not_raised(self):
        sm = self.make_manager()
        sm._launch_tmux = mock.Mock(side_effect=RuntimeError("tmux exploded"))
        sess = {"id": "aaaaa", "status": "stopped", "stoppedAt": "x",
                "errorMsg": None, "ttydPort": 7700,
                "worktreePath": self.tmp, "tmuxName": "agent-aaaaa"}
        sm.registry = [sess]
        sm.start("aaaaa")  # must not raise
        self.assertEqual(sess["status"], "error")
        self.assertIn("tmux exploded", sess["errorMsg"])

    # --- spawn composer options (#11/#12/#13) ------------------------------

    def _worktree_add_cmd(self):
        return next(c for c in self.run_ok_calls if "worktree" in c and "add" in c)

    def _claude_cmd(self):
        """The claude command line _launch_tmux hands to `tmux new-session`."""
        newsess = next(c for c in self.run_ok_calls if "new-session" in c)
        return newsess[-1]

    def test_spawn_no_options_keeps_todays_command_shape(self):
        """Regression guard: a bare spawn must produce exactly the pre-existing
        worktree/launch commands — -b agent/<id> off HEAD (no trailing base),
        bypassPermissions, no --model, no positional prompt."""
        repo = {"name": "AgentHub", "path": os.path.join(self.tmp, "AgentHub")}
        sm = self.make_spawn_ready_manager([repo])
        sm.spawn("AgentHub")
        sess = sm.registry[0]
        self.assertEqual(sess["status"], "running")
        wt = self._worktree_add_cmd()
        self.assertEqual(wt[-2:], ["-b", f"agent/{sess['id']}"])  # nothing after the branch
        self.assertEqual(
            self._claude_cmd(),
            f"claude --remote-control '{sess['rcName']}' --permission-mode bypassPermissions",
        )

    def test_spawn_threads_all_options(self):
        repo = {"name": "AgentHub", "path": os.path.join(self.tmp, "AgentHub")}
        sm = self.make_spawn_ready_manager([repo])

        # Make the base ref resolve (branch_exists -> run rev-parse --verify).
        def fake_run(cmd, cwd=None):
            self.run_calls.append(cmd)
            return "sha" if " ".join(cmd).endswith("--verify --quiet develop") else ""

        p = mock.patch.object(ha, "run", fake_run)
        p.start()
        self.addCleanup(p.stop)

        sm.spawn("AgentHub", prompt="fix the bug", label="Fix Login",
                 base_ref="develop", branch_name="fix-login", model="opus",
                 permission_mode="acceptEdits")
        sess = sm.registry[0]
        self.assertEqual(sess["status"], "running")
        # Custom branch honored + agent/ prefix enforced.
        self.assertEqual(sess["branch"], "agent/fix-login")
        # Stored option fields.
        self.assertEqual(sess["label"], "Fix Login")
        self.assertEqual(sess["model"], "opus")
        self.assertEqual(sess["permissionMode"], "acceptEdits")
        self.assertEqual(sess["baseRef"], "develop")
        # Label (slugged) flavors the RC display name.
        self.assertTrue(sess["rcName"].endswith("-AgentHub-Fix-Login"), sess["rcName"])
        # worktree add forks off the base ref.
        wt = self._worktree_add_cmd()
        self.assertEqual(wt[-3:], ["-b", "agent/fix-login", "develop"])
        # Launch line carries model, permission mode, and the positional prompt.
        cmd = self._claude_cmd()
        self.assertIn("--model opus", cmd)
        self.assertIn("--permission-mode acceptEdits", cmd)
        self.assertNotIn("bypassPermissions", cmd)
        self.assertTrue(cmd.endswith(" -- 'fix the bug'"), cmd)

    def test_spawn_permission_mode_default_omits_flag(self):
        repo = {"name": "AgentHub", "path": os.path.join(self.tmp, "AgentHub")}
        sm = self.make_spawn_ready_manager([repo])
        sm.spawn("AgentHub", permission_mode="default")
        self.assertNotIn("--permission-mode", self._claude_cmd())

    def test_spawn_prompt_is_shell_quoted(self):
        repo = {"name": "AgentHub", "path": os.path.join(self.tmp, "AgentHub")}
        sm = self.make_spawn_ready_manager([repo])
        sm.spawn("AgentHub", prompt="rm -rf / ; echo $HOME `whoami`")
        cmd = self._claude_cmd()
        # The whole prompt is one shlex-quoted token after `--`; no metachar leaks.
        self.assertIn(" -- '", cmd)
        self.assertTrue(cmd.rstrip().endswith("'"))

    def test_spawn_rejects_bad_branch_name(self):
        repo = {"name": "AgentHub", "path": os.path.join(self.tmp, "AgentHub")}
        sm = self.make_spawn_ready_manager([repo])
        sm.spawn("AgentHub", branch_name="../evil")
        sess = sm.registry[0]
        self.assertEqual(sess["status"], "error")
        # Bad option fails before any worktree add is attempted.
        self.assertFalse(any("worktree" in c and "add" in c for c in self.run_ok_calls))

    def test_spawn_rejects_missing_base_ref(self):
        repo = {"name": "AgentHub", "path": os.path.join(self.tmp, "AgentHub")}
        sm = self.make_spawn_ready_manager([repo])
        # ManagerMixin's run() returns "" for everything, so no base ref resolves.
        sm.spawn("AgentHub", base_ref="does-not-exist")
        self.assertEqual(sm.registry[0]["status"], "error")

    def test_spawn_rejects_unknown_model(self):
        repo = {"name": "AgentHub", "path": os.path.join(self.tmp, "AgentHub")}
        sm = self.make_spawn_ready_manager([repo])
        sm.spawn("AgentHub", model="gpt-5")
        self.assertEqual(sm.registry[0]["status"], "error")


class TestNormalizeGithubRepo(unittest.TestCase):
    def test_plain_owner_repo(self):
        self.assertEqual(ha.normalize_github_repo("xerktech/AgentHub"), "xerktech/AgentHub")
        self.assertEqual(ha.normalize_github_repo("  xerktech/AgentHub  "), "xerktech/AgentHub")

    def test_urls_and_git_suffix(self):
        self.assertEqual(
            ha.normalize_github_repo("https://github.com/xerktech/AgentHub.git"),
            "xerktech/AgentHub")
        self.assertEqual(
            ha.normalize_github_repo("https://github.com/xerktech/AgentHub/"),
            "xerktech/AgentHub")
        self.assertEqual(
            ha.normalize_github_repo("git@github.com:xerktech/AgentHub.git"),
            "xerktech/AgentHub")

    def test_keeps_dots_and_dashes_in_names(self):
        self.assertEqual(ha.normalize_github_repo("my-org/re.po_name-1"), "my-org/re.po_name-1")

    def test_rejects_bad(self):
        for bad in ("", "   ", None, "noslash", "a/b/c", "../evil/x", "owner/..",
                    "-lead/repo", "owner/re po", "owner/re;po", "owner/re`po",
                    "owner/$x", "https://github.com/only-owner", "owner/"):
            with self.assertRaises(ValueError, msg=repr(bad)):
                ha.normalize_github_repo(bad)


class TestClone(ManagerMixin, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.repos_root = os.path.join(self.tmp, "root")
        os.makedirs(self.repos_root)
        p = mock.patch.object(ha, "REPOS_ROOT", self.repos_root)
        p.start()
        self.addCleanup(p.stop)

    def test_invalid_spec_records_error_without_popen(self):
        sm = self.make_manager()
        with mock.patch.object(ha.subprocess, "Popen") as popen:
            sm.clone("not a repo")
            popen.assert_not_called()
        jobs = sm._clones_payload()
        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0]["status"], "error")

    def test_existing_dest_refused_without_popen(self):
        sm = self.make_manager()
        os.makedirs(os.path.join(self.repos_root, "AgentHub"))
        with mock.patch.object(ha.subprocess, "Popen") as popen:
            sm.clone("xerktech/AgentHub")
            popen.assert_not_called()
        job = sm.clones["AgentHub"]
        self.assertEqual(job["status"], "error")
        self.assertIn("already exists", job["error"])

    def test_clone_launches_git_and_finishes_on_poll(self):
        sm = self.make_manager()
        dest = os.path.join(self.repos_root, "AgentHub")

        class FakeProc:
            def poll(self_inner):
                # Simulate git materializing the checkout, then exiting 0.
                os.makedirs(os.path.join(dest, ".git"), exist_ok=True)
                return 0

            def kill(self_inner):
                pass

        with mock.patch.object(ha.subprocess, "Popen", return_value=FakeProc()) as popen:
            sm.clone("xerktech/AgentHub")
            # git clone <url> <dest> was launched (not a session run_ok call).
            args = popen.call_args[0][0]
            self.assertEqual(args[:2], ["git", "clone"])
            self.assertIn("https://github.com/xerktech/AgentHub.git", args)
            self.assertIn(dest, args)
        self.assertEqual(sm.clones["AgentHub"]["status"], "cloning")
        sm._poll_clones()
        self.assertEqual(sm.clones["AgentHub"]["status"], "done")
        # The serializable view never leaks the Popen/file handles.
        payload = sm._clones_payload()[0]
        self.assertEqual(set(payload), {"name", "repo", "status", "error", "startedAt"})

    def test_failed_clone_captures_error(self):
        sm = self.make_manager()

        class FailProc:
            def poll(self_inner):
                return 1  # no .git created -> failure

            def kill(self_inner):
                pass

        with mock.patch.object(ha.subprocess, "Popen", return_value=FailProc()):
            sm.clone("xerktech/AgentHub")
        sm._poll_clones()
        self.assertEqual(sm.clones["AgentHub"]["status"], "error")


class TestScanRepos(unittest.TestCase):
    def test_scan_filters_dotdirs_and_non_git(self):
        tmp = tempfile.mkdtemp(prefix="hub-agent-scan-")
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        os.makedirs(os.path.join(tmp, "RepoA", ".git"))
        os.makedirs(os.path.join(tmp, "plainDir"))
        os.makedirs(os.path.join(tmp, ".agenthub", "worktrees"))
        os.makedirs(os.path.join(tmp, ".hidden", ".git"))
        with open(os.path.join(tmp, "afile"), "w") as f:
            f.write("x")
        # worktree-style .git FILE also counts (os.path.exists, not isdir)
        os.makedirs(os.path.join(tmp, "RepoB"))
        with open(os.path.join(tmp, "RepoB", ".git"), "w") as f:
            f.write("gitdir: elsewhere")
        with mock.patch.object(ha, "REPOS_ROOT", tmp):
            repos = ha.scan_repos()
        self.assertEqual(
            [r["name"] for r in repos], ["RepoA", "RepoB"]  # sorted, filtered
        )


if __name__ == "__main__":
    unittest.main()

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
        sm.spawn.assert_called_once_with("AgentHub")
        sm.kill.assert_called_once_with("ab123")
        sm.save.assert_called_once()
        self.assertEqual(sm.acked, {"c1", "c2"})

        # Re-delivery of the same cmdIds (at-least-once): nothing re-executes.
        sm.spawn.reset_mock()
        sm.kill.reset_mock()
        self.assertFalse(sm.handle_commands(cmds))
        sm.spawn.assert_not_called()
        sm.kill.assert_not_called()

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

    def test_delete_also_deletes_branch(self):
        repo = {"name": "AgentHub", "path": os.path.join(self.tmp, "AgentHub")}
        sm = self.make_spawn_ready_manager([repo])
        sm.spawn("AgentHub")
        sid = sm.registry[0]["id"]
        branch = sm.registry[0]["branch"]
        sm.delete(sid)
        self.assertEqual(sm.registry, [])
        self.assertTrue(
            any("-D" in c and branch in c for c in self.run_calls),
            f"delete must run git branch -D: {self.run_calls}",
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

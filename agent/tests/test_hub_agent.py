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
import io
import json
import os
import shlex
import shutil
import signal
import struct
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


class TestDeviceName(unittest.TestCase):
    """Host-identity resolution — auto-detected with no env/compose config.
    Order: DEVICE_NAME/COMPUTERNAME env (entrypoint-resolved or operator
    override) -> /host/etc/hostname -> `docker info` .Name -> SMB to the Windows
    host (Docker Desktop / WSL2) -> OS hostname. Never reports the
    kernel-assigned container id (the "fe0e38df73b4" bug) or a shared
    placeholder."""

    # A container-id gethostname() is the real in-container default; use it so a
    # test only reaches a later source when the earlier ones are genuinely empty.
    CONTAINER_ID = "fe0e38df73b4"

    def _run(self, *, host_file=None, docker_name="", smb_name="", env=None,
             gethostname=CONTAINER_ID):
        """Resolve device_name() with every source stubbed.
        host_file=None means /host/etc/hostname is absent (open raises);
        docker_name is what `docker info` returns, smb_name what the SMB probe
        of the Windows host returns ('' = unreachable/blocked)."""
        def fake_open(path, *a, **k):
            if path == "/host/etc/hostname" and host_file is not None:
                return io.StringIO(host_file)
            raise OSError("no such file")

        def fake_run(cmd, cwd=None):
            if cmd[:2] == ["docker", "info"]:
                return docker_name
            return ""

        with mock.patch.dict(os.environ, env or {}, clear=True), \
                mock.patch("builtins.open", fake_open), \
                mock.patch.object(ha, "run", fake_run), \
                mock.patch.object(ha, "smb_host_name", lambda: smb_name), \
                mock.patch.object(ha.socket, "gethostname", lambda: gethostname):
            return ha.device_name()

    def test_usable_hostname_rejects_container_ids_and_placeholders(self):
        for bad in ("", "  ", "localhost", "LOCALHOST", "docker-desktop",
                    "unknown-device", "fe0e38df73b4",
                    "a" * 64):  # short + full container id forms
            self.assertEqual(ha._usable_hostname(bad), "", bad)
        for good in ("truenas", "WIN-DESK01", "host.lab", "server-1"):
            self.assertEqual(ha._usable_hostname(good), good, good)

    def test_env_wins_first(self):
        # entrypoint.sh exports DEVICE_NAME after resolving once; it (or an
        # explicit operator override) is checked before any auto-detection.
        self.assertEqual(
            self._run(env={"DEVICE_NAME": "MAXAI"}, host_file="truenas\n",
                      docker_name="other", smb_name="smbname"),
            "MAXAI",
        )
        self.assertEqual(self._run(env={"COMPUTERNAME": "WIN-DESK01"}), "WIN-DESK01")
        self.assertEqual(
            self._run(env={"DEVICE_NAME": "explicit", "COMPUTERNAME": "win"}),
            "explicit",
        )

    def test_host_file_wins_over_docker_and_smb(self):
        self.assertEqual(
            self._run(host_file="truenas\n", docker_name="other", smb_name="x"),
            "truenas",
        )

    def test_docker_info_name_used_when_no_host_file(self):
        # bare Linux / Docker-in-WSL: the mounted socket's daemon name.
        self.assertEqual(self._run(docker_name="DESKTOP-AB12\n"), "DESKTOP-AB12")

    def test_smb_used_when_docker_desktop(self):
        # The Docker Desktop path: docker info is the shared VM name, so we fall
        # through to the SMB probe of the Windows host for the real name.
        self.assertEqual(
            self._run(docker_name="docker-desktop", smb_name="MAXAI"), "MAXAI")

    def test_smb_used_when_no_mount_no_docker(self):
        self.assertEqual(self._run(smb_name="MAXAI"), "MAXAI")

    def test_os_hostname_used_when_real(self):
        self.assertEqual(self._run(gethostname="bare-linux"), "bare-linux")

    def test_container_id_hostname_falls_back_to_placeholder(self):
        # The reported bug: no env, no mount, docker=docker-desktop, SMB blocked,
        # and gethostname() is the container id -> unknown-device, never the id.
        self.assertEqual(
            self._run(docker_name="docker-desktop", smb_name=""), "unknown-device")


class TestSmbHostName(unittest.TestCase):
    """The SMB2/NTLM computer-name extraction (Docker Desktop / WSL2 path)."""

    @staticmethod
    def _challenge(names):
        """Build a minimal NTLM CHALLENGE (type 2) with the given Target Info AV
        pairs {av_id: str}, wrapped in some leading bytes like a real SMB blob."""
        ti = b""
        for av_id, val in names.items():
            v = val.encode("utf-16-le")
            ti += struct.pack("<HH", av_id, len(v)) + v
        ti += struct.pack("<HH", 0, 0)  # MsvAvEOL
        ntlm = (
            b"NTLMSSP\x00" + struct.pack("<I", 2)
            + struct.pack("<HHI", 0, 0, 0)   # TargetName fields
            + struct.pack("<I", 0)           # NegotiateFlags
            + b"\x11" * 8                     # ServerChallenge
            + b"\x00" * 8                     # Reserved
            + struct.pack("<HHI", len(ti), len(ti), 48)  # TargetInfo @ offset 48
            + ti
        )
        return b"\x00" * 137 + ntlm  # arbitrary SMB2 header/prefix before NTLMSSP

    def test_extracts_netbios_computer_name(self):
        blob = self._challenge({1: "MAXAI", 2: "XERKTECH",
                                3: "MaxAI.xerktech.com"})
        self.assertEqual(ha._smb_parse_computer_name(blob), "MAXAI")

    def test_no_ntlmssp_returns_empty(self):
        self.assertEqual(ha._smb_parse_computer_name(b"not an ntlm response"), "")

    def test_no_computer_name_av_returns_empty(self):
        # Only a domain AV pair, no MsvAvNbComputerName(0x1).
        self.assertEqual(
            ha._smb_parse_computer_name(self._challenge({2: "XERKTECH"})), "")

    def test_request_packets_are_well_formed(self):
        # SMB2 header is exactly 64 bytes; the SESSION_SETUP security buffer
        # offset (88) must equal header + fixed body, or Windows rejects it.
        self.assertEqual(len(ha._smb2_header(0, 0)), 64)


class TestSpawnOptionHelpers(unittest.TestCase):
    """Validation for the composer's spawn options (#11/#12/#13) — everything
    that gets interpolated into a git/tmux command line is allowlist-checked."""

    def test_default_branch_name_prefers_origin_head(self):
        # origin/HEAD -> origin/main means the default branch is "main".
        with mock.patch.object(
                ha, "run",
                lambda cmd, cwd=None: "origin/main" if "symbolic-ref" in cmd else ""):
            self.assertEqual(ha.default_branch_name("/repo"), "main")

    def test_default_branch_name_falls_back_to_local_main(self):
        # No origin/HEAD; a local "main" exists -> use it.
        with mock.patch.object(ha, "run", lambda cmd, cwd=None: ""), \
             mock.patch.object(ha, "branch_exists",
                               lambda repo, ref: ref == "refs/heads/main"):
            self.assertEqual(ha.default_branch_name("/repo"), "main")

    def test_default_base_ref_fetches_latest_and_prefers_origin(self):
        # New sessions fork off the LATEST default branch: fetch, then origin/<d>.
        calls = []
        with mock.patch.object(
                ha, "run",
                lambda cmd, cwd=None: "origin/main" if "symbolic-ref" in cmd else ""), \
             mock.patch.object(ha, "run_ok",
                               lambda cmd, cwd=None: calls.append(cmd) or (0, "")), \
             mock.patch.object(ha, "branch_exists",
                               lambda repo, ref: ref == "refs/remotes/origin/main"):
            self.assertEqual(ha.default_base_ref("/repo"), "origin/main")
        self.assertTrue(any("fetch" in c for c in calls),
                        f"expected a git fetch for latest main, got {calls}")

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
        # Blank / HEAD -> the latest default branch (delegates to default_base_ref).
        with mock.patch.object(ha, "default_base_ref", lambda p: "origin/main"):
            self.assertEqual(ha.resolve_base_ref("/repo", ""), "origin/main")
            self.assertEqual(ha.resolve_base_ref("/repo", "HEAD"), "origin/main")

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

    WORKDIR = "/w/.turma/worktrees/repo"

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="hub-agent-test-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        patcher = mock.patch.object(ha, "PROJECTS_ROOT", self.tmp)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.proj = os.path.join(self.tmp, ha._project_slug(self.WORKDIR))
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
    PR1 = "https://github.com/xerktech/Turma/pull/34"
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

    def test_missing_project_dir_has_empty_tail_and_options(self):
        rep = ha.session_report("/absent/worktree", {})
        self.assertEqual(rep["tail"], [])
        self.assertEqual(rep["questionOptions"], [])

    def test_tail_reported_for_live_transcript(self):
        path = os.path.join(self.proj, "s.jsonl")
        write_jsonl(path, [
            {"uuid": "u1", "type": "user", "message": {"content": "hi"}},
            {"uuid": "u2", "type": "assistant",
             "message": {"content": [{"type": "text", "text": "hello back"}]}},
        ])
        rep = ha.session_report(self.WORKDIR, {})
        self.assertEqual(rep["tail"], [
            {"id": "u1", "role": "user", "text": "hi"},
            {"id": "u2", "role": "assistant", "text": "hello back"},
        ])

    def test_question_options_from_ask_user_question(self):
        path = os.path.join(self.proj, "s.jsonl")
        long_label = "L" * 100
        options = [{"label": long_label}, {"label": "b"}, {"label": "c"},
                   {"label": "d"}, {"label": "e"}]  # 5 options -> capped at 4
        write_jsonl(path, [{
            "type": "assistant",
            "message": {"content": [
                {"type": "tool_use", "name": "AskUserQuestion",
                 "input": {"questions": [{"question": "pick one", "options": options}]}},
            ]},
        }])
        rep = ha.session_report(self.WORKDIR, {})
        self.assertEqual(rep["questionOptions"], [long_label[:80], "b", "c", "d"])

    def test_question_options_empty_when_no_question(self):
        path = os.path.join(self.proj, "s.jsonl")
        write_jsonl(path, [self.entry_with_text("just chatting")])
        rep = ha.session_report(self.WORKDIR, {})
        self.assertEqual(rep["questionOptions"], [])

    def test_question_options_skips_non_string_labels(self):
        path = os.path.join(self.proj, "s.jsonl")
        options = [{"label": "ok"}, {"label": 42}, "not-a-dict"]
        write_jsonl(path, [{
            "type": "assistant",
            "message": {"content": [
                {"type": "tool_use", "name": "AskUserQuestion",
                 "input": {"questions": [{"question": "pick", "options": options}]}},
            ]},
        }])
        rep = ha.session_report(self.WORKDIR, {})
        self.assertEqual(rep["questionOptions"], ["ok"])


class TestTranscriptTail(ProjectDirMixin, unittest.TestCase):
    def test_missing_file(self):
        self.assertEqual(ha.transcript_tail(os.path.join(self.proj, "nope.jsonl")), [])

    def test_empty_file(self):
        path = os.path.join(self.proj, "empty.jsonl")
        open(path, "w").close()
        self.assertEqual(ha.transcript_tail(path), [])

    def test_mixed_entries_ansi_stripped_and_garbage_skipped(self):
        path = os.path.join(self.proj, "t.jsonl")
        ansi_text = "\x1b[31mred\x1b[0m alert"
        write_jsonl(path, [
            {"uuid": "u1", "type": "user", "message": {"content": "hello there"}},
            "not json {{{",  # garbage line, skipped
            {"uuid": "u2", "type": "assistant", "message": {"content": [
                {"type": "thinking", "thinking": "hmm, let me see"},
                {"type": "text", "text": ansi_text},
                {"type": "tool_use", "name": "Bash", "input": {}},
            ]}},
            {"uuid": "u3", "type": "user", "message": {"content": [
                {"type": "tool_result", "content": "some tool output"},
            ]}},  # tool_result-only -> dropped
            {"uuid": "u4", "type": "summary", "message": {"content": "not a turn"}},  # wrong type -> dropped
        ])
        tail = ha.transcript_tail(path)
        self.assertEqual([e["id"] for e in tail], ["u1", "u2"])
        self.assertEqual(tail[0], {"id": "u1", "role": "user", "text": "hello there"})
        self.assertEqual(tail[1]["role"], "assistant")
        self.assertEqual(tail[1]["text"], "red alert[Bash]")

    def test_oversize_message_truncated(self):
        path = os.path.join(self.proj, "big.jsonl")
        long_text = "x" * (ha.TAIL_MSG_CHARS + 50)
        write_jsonl(path, [{"uuid": "u1", "type": "user", "message": {"content": long_text}}])
        tail = ha.transcript_tail(path)
        self.assertEqual(len(tail[0]["text"]), ha.TAIL_MSG_CHARS)
        self.assertEqual(tail[0]["text"], long_text[:ha.TAIL_MSG_CHARS])

    def test_window_limited_to_tail_msgs(self):
        path = os.path.join(self.proj, "many.jsonl")
        entries = [
            {"uuid": f"u{i}", "type": "user", "message": {"content": f"msg {i}"}}
            for i in range(10)
        ]
        write_jsonl(path, entries)
        with mock.patch.object(ha, "TAIL_MSGS", 3):
            tail = ha.transcript_tail(path)
        self.assertEqual([e["id"] for e in tail], ["u7", "u8", "u9"])


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
            {"id": "ab123", "repo": "Turma", "status": "running", "ttydPort": 7700},
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
            {"cmdId": "c1", "type": "spawn", "repo": "Turma"},
            {"cmdId": "c2", "type": "kill", "sessionId": "ab123"},
            {"type": "kill", "sessionId": "no-cmd-id"},  # no cmdId -> ignored
            "not-a-dict",                                 # garbage -> ignored
        ]
        self.assertTrue(sm.handle_commands(cmds))
        # spawn now threads the composer options (all None for a bare command).
        sm.spawn.assert_called_once_with(
            "Turma", prompt=None, label=None, base_ref=None,
            model=None, permission_mode=None,
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
            "cmdId": "c9", "type": "spawn", "repo": "Turma",
            "prompt": "fix the bug", "label": "Fix login", "baseRef": "main",
            "model": "opus", "permissionMode": "plan",
        }])
        sm.spawn.assert_called_once_with(
            "Turma", prompt="fix the bug", label="Fix login", base_ref="main",
            model="opus", permission_mode="plan",
        )

    def test_prune_command_dispatches_to_prune_repo(self):
        sm = self.make_manager()
        sm.prune_repo = mock.Mock()
        sm.save = mock.Mock()
        sm.handle_commands([{"cmdId": "cp", "type": "prune", "repo": "Turma"}])
        sm.prune_repo.assert_called_once_with("Turma")
        self.assertIn("cp", sm.acked)

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
        repo = {"name": "Turma", "path": os.path.join(self.tmp, "Turma")}
        sm = self.make_spawn_ready_manager([repo])
        sm.spawn("Turma")
        self.assertEqual(len(sm.registry), 1)
        sess = sm.registry[0]
        self.assertEqual(sess["status"], "running")
        self.assertEqual(sess["repo"], "Turma")
        # The app creates no branch — the worktree is detached, the agent branches.
        self.assertIsNone(sess["branch"])
        self.assertEqual(sess["ttydPort"], ha.TTYD_PORT_BASE)
        self.assertEqual(sess["tmuxName"], f"agent-{sess['id']}")
        self.assertTrue(sess["rcName"].endswith(f"-Turma-{sess['id']}"))
        self.assertEqual(
            sess["worktreePath"],
            os.path.join(ha.WORKTREES_ROOT, "Turma", sess["id"]),
        )
        # git worktree add --detach (no -b) went through run_ok
        wt = next(c for c in self.run_ok_calls if "worktree" in c and "add" in c)
        self.assertIn("--detach", wt)
        self.assertNotIn("-b", wt)

    def test_spawn_refused_at_max_sessions(self):
        repo = {"name": "Turma", "path": os.path.join(self.tmp, "Turma")}
        sm = self.make_spawn_ready_manager([repo])
        p = mock.patch.object(ha, "MAX_SESSIONS", 1)
        p.start()
        self.addCleanup(p.stop)
        sm.registry = [{"id": "aaaaa", "status": "running", "ttydPort": 7700}]
        sm.spawn("Turma")
        self.assertEqual(len(sm.registry), 1)  # unchanged

    def test_spawn_refused_for_unknown_repo(self):
        sm = self.make_spawn_ready_manager([])
        sm.spawn("NoSuchRepo")
        self.assertEqual(sm.registry, [])

    def test_kill_drops_record_but_keeps_worktree(self):
        repo = {"name": "Turma", "path": os.path.join(self.tmp, "Turma")}
        sm = self.make_spawn_ready_manager([repo])
        sm.spawn("Turma")
        sid = sm.registry[0]["id"]
        sm.usage_cache[sid] = {"totals": {}}
        self.run_ok_calls.clear()
        self.run_calls.clear()
        sm.kill(sid)
        self.assertEqual(sm.registry, [])
        self.assertNotIn(sid, sm.usage_cache)
        # kill must KEEP the worktree (uncommitted work survives): no worktree
        # remove and no `git branch -D`.
        self.assertFalse(
            any("worktree" in c and "remove" in c
                for c in self.run_calls + self.run_ok_calls),
            f"kill must not remove the worktree: {self.run_calls}",
        )
        self.assertFalse(
            any("branch" in c and "-D" in c for c in self.run_calls),
            f"kill must not delete a branch: {self.run_calls}",
        )
        # It is offered for resume (closed history records it).
        self.assertTrue(any(c.get("id") == sid for c in sm.closed))

    def test_delete_removes_worktree_but_touches_no_branch(self):
        repo = {"name": "Turma", "path": os.path.join(self.tmp, "Turma")}
        sm = self.make_spawn_ready_manager([repo])
        sm.spawn("Turma")
        sid = sm.registry[0]["id"]
        os.makedirs(sm.registry[0]["worktreePath"], exist_ok=True)  # so it's removed
        self.run_calls.clear()
        self.run_ok_calls.clear()
        sm.delete(sid)
        self.assertEqual(sm.registry, [])
        # The worktree is removed...
        self.assertTrue(
            any("worktree" in c and "remove" in c
                for c in self.run_calls + self.run_ok_calls),
            f"delete must remove the worktree: {self.run_calls}",
        )
        # ...but the app owns no branch, so no branch is ever deleted or renamed
        # (the agent's own branch, and its committed work, survive untouched).
        allcalls = self.run_calls + self.run_ok_calls
        self.assertFalse(
            any("branch" in c and ("-D" in c or "-m" in c) for c in allcalls),
            f"delete must not touch any branch: {allcalls}",
        )
        # No stale resume offer is left behind.
        self.assertFalse(any(c.get("id") == sid for c in sm.closed))

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
        """Regression guard: a bare spawn adds a DETACHED worktree (no -b, no
        app branch) and launches with bypassPermissions, no --model, no
        positional prompt. (No default base resolves under the fake git, so the
        detach point is HEAD — nothing trails the worktree path.)"""
        repo = {"name": "Turma", "path": os.path.join(self.tmp, "Turma")}
        sm = self.make_spawn_ready_manager([repo])
        sm.spawn("Turma")
        sess = sm.registry[0]
        self.assertEqual(sess["status"], "running")
        wt = self._worktree_add_cmd()
        self.assertIn("--detach", wt)
        self.assertNotIn("-b", wt)
        self.assertEqual(wt[-1], sess["worktreePath"])  # nothing after the path
        settings = os.path.join(ha.REGISTRY_DIR, "guard-settings.json")
        self.assertEqual(
            self._claude_cmd(),
            f"claude --remote-control '{sess['rcName']}' "
            f"--permission-mode bypassPermissions --settings {shlex.quote(settings)}",
        )
        # The guard settings file was written and wires the Bash PreToolUse hook.
        loaded = json.loads(open(settings).read())
        self.assertEqual(loaded["hooks"]["PreToolUse"][0]["matcher"], "Bash")

    def test_spawn_threads_all_options(self):
        repo = {"name": "Turma", "path": os.path.join(self.tmp, "Turma")}
        sm = self.make_spawn_ready_manager([repo])

        # Make the base ref resolve (branch_exists -> run rev-parse --verify).
        def fake_run(cmd, cwd=None):
            self.run_calls.append(cmd)
            return "sha" if " ".join(cmd).endswith("--verify --quiet develop") else ""

        p = mock.patch.object(ha, "run", fake_run)
        p.start()
        self.addCleanup(p.stop)

        sm.spawn("Turma", prompt="fix the bug", label="Fix Login",
                 base_ref="develop", model="opus",
                 permission_mode="acceptEdits")
        sess = sm.registry[0]
        self.assertEqual(sess["status"], "running")
        # The app creates no branch — detached worktree, agent branches its work.
        self.assertIsNone(sess["branch"])
        # Stored option fields.
        self.assertEqual(sess["label"], "Fix Login")
        self.assertEqual(sess["model"], "opus")
        self.assertEqual(sess["permissionMode"], "acceptEdits")
        self.assertEqual(sess["baseRef"], "develop")
        # Label (slugged) flavors the RC display name.
        self.assertTrue(sess["rcName"].endswith("-Turma-Fix-Login"), sess["rcName"])
        # worktree add is detached and forks off the chosen base ref.
        wt = self._worktree_add_cmd()
        self.assertIn("--detach", wt)
        self.assertNotIn("-b", wt)
        self.assertEqual(wt[-1], "develop")
        # Launch line carries model, permission mode, and the positional prompt.
        cmd = self._claude_cmd()
        self.assertIn("--model opus", cmd)
        self.assertIn("--permission-mode acceptEdits", cmd)
        self.assertNotIn("bypassPermissions", cmd)
        self.assertTrue(cmd.endswith(" -- 'fix the bug'"), cmd)

    def test_spawn_permission_mode_default_omits_flag(self):
        repo = {"name": "Turma", "path": os.path.join(self.tmp, "Turma")}
        sm = self.make_spawn_ready_manager([repo])
        sm.spawn("Turma", permission_mode="default")
        self.assertNotIn("--permission-mode", self._claude_cmd())

    def test_spawn_prompt_is_shell_quoted(self):
        repo = {"name": "Turma", "path": os.path.join(self.tmp, "Turma")}
        sm = self.make_spawn_ready_manager([repo])
        sm.spawn("Turma", prompt="rm -rf / ; echo $HOME `whoami`")
        cmd = self._claude_cmd()
        # The whole prompt is one shlex-quoted token after `--`; no metachar leaks.
        self.assertIn(" -- '", cmd)
        self.assertTrue(cmd.rstrip().endswith("'"))

    def test_spawn_rejects_missing_base_ref(self):
        repo = {"name": "Turma", "path": os.path.join(self.tmp, "Turma")}
        sm = self.make_spawn_ready_manager([repo])
        # ManagerMixin's run() returns "" for everything, so no base ref resolves.
        sm.spawn("Turma", base_ref="does-not-exist")
        self.assertEqual(sm.registry[0]["status"], "error")

    def test_spawn_rejects_unknown_model(self):
        repo = {"name": "Turma", "path": os.path.join(self.tmp, "Turma")}
        sm = self.make_spawn_ready_manager([repo])
        sm.spawn("Turma", model="gpt-5")
        self.assertEqual(sm.registry[0]["status"], "error")

    # --- root (repos-root) sessions ---------------------------------------
    # A session spawned against ROOT_REPO_NAME runs directly at REPOS_ROOT with
    # no worktree and no branch; the worktree/branch machinery must be skipped
    # everywhere (spawn/kill/delete) so REPOS_ROOT and its repos are never
    # touched, and only one may run at a time.

    def _root_ready_manager(self):
        sm = self.make_spawn_ready_manager([])  # scan_repos irrelevant for root
        p = mock.patch.object(ha, "REPOS_ROOT", self.tmp)
        p.start()
        self.addCleanup(p.stop)
        return sm

    def test_root_repo_entry_advertises_root(self):
        p = mock.patch.object(ha, "REPOS_ROOT", self.tmp)
        p.start()
        self.addCleanup(p.stop)
        entry = ha.root_repo_entry()
        self.assertEqual(entry["name"], ha.ROOT_REPO_NAME)
        self.assertTrue(entry["isRoot"])
        self.assertEqual(entry["path"], self.tmp)
        self.assertEqual(entry["branches"], [])  # no base-branch walk for root

    def test_spawn_root_runs_in_repos_root_without_worktree(self):
        sm = self._root_ready_manager()
        sm.spawn(ha.ROOT_REPO_NAME)
        self.assertEqual(len(sm.registry), 1)
        sess = sm.registry[0]
        self.assertEqual(sess["status"], "running")
        self.assertTrue(sess["root"])
        self.assertIsNone(sess["branch"])
        self.assertEqual(sess["repo"], ha.ROOT_REPO_NAME)
        self.assertEqual(sess["worktreePath"], self.tmp)  # REPOS_ROOT itself
        # No worktree is ever added for a root session.
        self.assertFalse(any("worktree" in c and "add" in c for c in self.run_ok_calls))
        # claude still launches, and does so with cwd = REPOS_ROOT (tmux -c).
        newsess = next(c for c in self.run_ok_calls if "new-session" in c)
        self.assertIn(self.tmp, newsess)

    def test_spawn_root_ignores_base_but_keeps_model(self):
        sm = self._root_ready_manager()
        # base_ref would normally have to resolve in the repo; for root it does
        # not apply, so an unresolvable one must NOT fail the spawn.
        sm.spawn(ha.ROOT_REPO_NAME, base_ref="does-not-exist",
                 model="opus", permission_mode="acceptEdits")
        sess = sm.registry[0]
        self.assertEqual(sess["status"], "running")
        self.assertIsNone(sess["branch"])
        self.assertIsNone(sess["baseRef"])
        self.assertEqual(sess["model"], "opus")            # model still applies
        self.assertEqual(sess["permissionMode"], "acceptEdits")

    def test_spawn_root_refused_when_root_already_running(self):
        sm = self._root_ready_manager()
        sm.spawn(ha.ROOT_REPO_NAME)
        self.assertEqual(len(sm.registry), 1)
        sm.spawn(ha.ROOT_REPO_NAME)  # a second concurrent root is refused
        self.assertEqual(len(sm.registry), 1)

    def test_kill_root_keeps_repos_root_and_records_root(self):
        sm = self._root_ready_manager()
        sm.spawn(ha.ROOT_REPO_NAME)
        sid = sm.registry[0]["id"]
        sm.kill(sid)
        self.assertEqual(sm.registry, [])
        # REPOS_ROOT is not a worktree: never remove it, never delete a branch.
        self.assertFalse(any("worktree" in c and "remove" in c for c in self.run_calls))
        self.assertFalse(any("branch" in c and "-D" in c for c in self.run_calls))
        self.assertTrue(sm.closed[-1]["root"])  # resumable, flagged as root

    def test_delete_root_skips_worktree_and_branch(self):
        sm = self._root_ready_manager()
        sm.spawn(ha.ROOT_REPO_NAME)
        sid = sm.registry[0]["id"]
        sm.delete(sid)
        self.assertEqual(sm.registry, [])
        self.assertFalse(any("worktree" in c and "remove" in c
                             for c in self.run_calls + self.run_ok_calls))
        self.assertFalse(any("branch" in c and ("-D" in c or "-m" in c)
                             for c in self.run_calls + self.run_ok_calls))

    def test_session_payload_flags_root(self):
        sm = self._root_ready_manager()
        sm.spawn(ha.ROOT_REPO_NAME)
        payload = sm._session_payload(sm.registry[0])
        self.assertTrue(payload["root"])
        self.assertIsNone(payload["branch"])


class TestSendInput(ManagerMixin, unittest.TestCase):
    def make_manager(self):
        # __init__ itself issues run() calls (hostname, docker inspect, claude
        # --version); clear those so run_calls only reflects send_input.
        sm = super().make_manager()
        self.run_calls.clear()
        return sm

    def _running_session(self, sm, sid="abcde", status="running"):
        sess = {"id": sid, "status": status, "tmuxName": f"agent-{sid}"}
        sm.registry = [sess]
        return sess

    def test_exact_argvs_literal_send_then_enter(self):
        sm = self.make_manager()
        sess = self._running_session(sm)
        sm.send_input(sess["id"], "hello")
        self.assertEqual(self.run_calls, [
            ["tmux", "send-keys", "-t", "agent-abcde", "-l", "--", "hello"],
            ["tmux", "send-keys", "-t", "agent-abcde", "Enter"],
        ])

    def test_newlines_flattened_to_spaces(self):
        sm = self.make_manager()
        sess = self._running_session(sm)
        sm.send_input(sess["id"], "line1\r\nline2\rline3\nline4")
        self.assertEqual(self.run_calls[0], [
            "tmux", "send-keys", "-t", "agent-abcde", "-l", "--",
            "line1 line2 line3 line4",
        ])

    def test_dash_prefixed_text_sent_literally_after_option_terminator(self):
        # A dictated/typed reply that starts with '-' (or '--') must not be
        # parsed as a tmux send-keys option — the `--` terminator forces it
        # through as the literal key-list argument.
        sm = self.make_manager()
        sess = self._running_session(sm)
        sm.send_input(sess["id"], "-1 on that idea")
        self.assertEqual(self.run_calls, [
            ["tmux", "send-keys", "-t", "agent-abcde", "-l", "--", "-1 on that idea"],
            ["tmux", "send-keys", "-t", "agent-abcde", "Enter"],
        ])

        self.run_calls.clear()
        sm.send_input(sess["id"], "--force the deploy")
        self.assertEqual(self.run_calls, [
            ["tmux", "send-keys", "-t", "agent-abcde", "-l", "--", "--force the deploy"],
            ["tmux", "send-keys", "-t", "agent-abcde", "Enter"],
        ])

    def test_text_capped_at_input_max_chars(self):
        sm = self.make_manager()
        sess = self._running_session(sm)
        with mock.patch.object(ha, "INPUT_MAX_CHARS", 5):
            sm.send_input(sess["id"], "abcdefghij")
        self.assertEqual(self.run_calls[0][-1], "abcde")

    def test_noop_for_unknown_session(self):
        sm = self.make_manager()
        sm.registry = []
        sm.send_input("nope", "hello")
        self.assertEqual(self.run_calls, [])

    def test_noop_for_non_running_session(self):
        sm = self.make_manager()
        sess = self._running_session(sm, status="stopped")
        sm.send_input(sess["id"], "hello")
        self.assertEqual(self.run_calls, [])

    def test_noop_for_whitespace_only_text(self):
        sm = self.make_manager()
        sess = self._running_session(sm)
        sm.send_input(sess["id"], "   \t\n  ")
        self.assertEqual(self.run_calls, [])


class TestHistoryCommand(ManagerMixin, unittest.TestCase):
    WORKDIR = "/w/.turma/worktrees/repo"

    def _running_session(self, sm, sid="abcde", workdir=None):
        workdir = workdir or self.WORKDIR
        sess = {"id": sid, "status": "running", "worktreePath": workdir,
                "tmuxName": f"agent-{sid}"}
        sm.registry = [sess]
        return sess

    def _proj_dir(self, workdir=None):
        workdir = workdir or self.WORKDIR
        proj = os.path.join(ha.PROJECTS_ROOT, ha._project_slug(workdir))
        os.makedirs(proj, exist_ok=True)
        return proj

    def test_unknown_session_stages_empty_result(self):
        sm = self.make_manager()
        sm.registry = []
        sm._stage_history("nope")
        self.assertEqual(sm.history_results, [
            {"sessionId": "nope", "entries": [], "truncated": False},
        ])

    def test_fixture_transcript_entries_ids_roles_order(self):
        sm = self.make_manager()
        sess = self._running_session(sm)
        proj = self._proj_dir()
        write_jsonl(os.path.join(proj, "t.jsonl"), [
            {"uuid": "u1", "type": "user", "message": {"content": "hi"}},
            {"uuid": "u2", "type": "assistant",
             "message": {"content": [{"type": "text", "text": "hello back"}]}},
        ])
        sm._stage_history(sess["id"])
        self.assertEqual(sm.history_results, [{
            "sessionId": sess["id"],
            "entries": [
                {"id": "u1", "role": "user", "text": "hi"},
                {"id": "u2", "role": "assistant", "text": "hello back"},
            ],
            "truncated": False,
        }])

    def test_truncated_false_when_everything_fits(self):
        sm = self.make_manager()
        sess = self._running_session(sm)
        proj = self._proj_dir()
        write_jsonl(os.path.join(proj, "t.jsonl"), [
            {"uuid": f"u{i}", "type": "user", "message": {"content": f"msg {i}"}}
            for i in range(5)
        ])
        with mock.patch.object(ha, "HISTORY_MAX_MSGS", 10):
            sm._stage_history(sess["id"])
        self.assertEqual(len(sm.history_results[0]["entries"]), 5)
        self.assertFalse(sm.history_results[0]["truncated"])

    def test_truncated_true_when_exceeding_history_max_msgs(self):
        sm = self.make_manager()
        sess = self._running_session(sm)
        proj = self._proj_dir()
        write_jsonl(os.path.join(proj, "t.jsonl"), [
            {"uuid": f"u{i}", "type": "user", "message": {"content": f"msg {i}"}}
            for i in range(10)
        ])
        with mock.patch.object(ha, "HISTORY_MAX_MSGS", 3):
            sm._stage_history(sess["id"])
        result = sm.history_results[0]
        self.assertEqual([e["id"] for e in result["entries"]], ["u7", "u8", "u9"])
        self.assertTrue(result["truncated"])

    def test_empty_transcript_file(self):
        sm = self.make_manager()
        sess = self._running_session(sm)
        proj = self._proj_dir()
        open(os.path.join(proj, "t.jsonl"), "w").close()
        sm._stage_history(sess["id"])
        self.assertEqual(sm.history_results, [
            {"sessionId": sess["id"], "entries": [], "truncated": False},
        ])

    def test_missing_project_dir_stages_empty(self):
        sm = self.make_manager()
        sess = self._running_session(sm, workdir="/absent/worktree")
        sm._stage_history(sess["id"])
        self.assertEqual(sm.history_results, [
            {"sessionId": sess["id"], "entries": [], "truncated": False},
        ])

    def test_keeps_full_message_beyond_tail_preview_cap(self):
        # History is a reading path: a message longer than the heartbeat's
        # per-message preview (TAIL_MSG_CHARS) is kept in full up to the larger
        # TAIL_MSG_CHARS_FULL, so a long response isn't cut off mid-sentence.
        sm = self.make_manager()
        sess = self._running_session(sm)
        proj = self._proj_dir()
        long_text = "x" * (ha.TAIL_MSG_CHARS + 50)
        write_jsonl(os.path.join(proj, "t.jsonl"), [
            {"uuid": "u1", "type": "user", "message": {"content": long_text}},
        ])
        sm._stage_history(sess["id"])
        text = sm.history_results[0]["entries"][0]["text"]
        self.assertEqual(text, long_text)
        self.assertGreater(len(text), ha.TAIL_MSG_CHARS)

    def test_byte_cap_marks_truncated(self):
        sm = self.make_manager()
        sess = self._running_session(sm)
        proj = self._proj_dir()
        path = os.path.join(proj, "t.jsonl")
        with mock.patch.object(ha, "_read_tail_lines",
                                lambda p, n: [json.dumps(
                                    {"uuid": "u1", "type": "user",
                                     "message": {"content": "hi"}}
                                ).encode()]):
            with mock.patch("os.path.getsize", return_value=(1 << 22) + 1):
                open(path, "w").close()
                sm._stage_history(sess["id"])
        self.assertTrue(sm.history_results[0]["truncated"])


class TestHandleCommandsInputHistory(ManagerMixin, unittest.TestCase):
    def test_dispatches_input_and_history_and_acks_both(self):
        sm = self.make_manager()
        sm.save = mock.Mock()
        sm.send_input = mock.Mock()
        sm._stage_history = mock.Mock()
        cmds = [
            {"cmdId": "i1", "type": "input", "sessionId": "s1", "text": "hi"},
            {"cmdId": "h1", "type": "history", "sessionId": "s1"},
        ]
        self.assertTrue(sm.handle_commands(cmds))
        sm.send_input.assert_called_once_with("s1", "hi")
        sm._stage_history.assert_called_once_with("s1")
        self.assertEqual(sm.acked, {"i1", "h1"})


class TestHistoryStagingLifecycle(ManagerMixin, unittest.TestCase):
    """historyResults staging must mirror ackedCommands/pending_prs: appear in
    the next built payload, survive a failed heartbeat POST, and clear only
    after a successful one."""

    def test_immediate_extra_heartbeat_carries_staged_result(self):
        # Mirrors run_forever's "immediate extra heartbeat after executing
        # commands": handle_commands() runs (staging a history result), THEN
        # build_payload() is called for the follow-up beat — no extra wiring
        # needed for the staged result to ride along automatically.
        sm = self.make_manager()
        sm.registry = []  # unknown sessionId -> empty staged result
        sm.save = mock.Mock()
        did_work = sm.handle_commands(
            [{"cmdId": "h1", "type": "history", "sessionId": "s1"}]
        )
        self.assertTrue(did_work)
        extra_beat_payload = sm.build_payload(1)
        self.assertEqual(extra_beat_payload["historyResults"],
                          [{"sessionId": "s1", "entries": [], "truncated": False}])

    def test_absent_when_nothing_staged(self):
        sm = self.make_manager()
        payload = sm.build_payload(0)
        self.assertNotIn("historyResults", payload)

    def test_staged_result_appears_in_next_payload(self):
        sm = self.make_manager()
        sm.history_results.append({"sessionId": "s1", "entries": [], "truncated": False})
        payload = sm.build_payload(0)
        self.assertEqual(payload["historyResults"],
                          [{"sessionId": "s1", "entries": [], "truncated": False}])

    def test_cleared_only_after_successful_post(self):
        sm = self.make_manager()
        sm.history_results.append({"sessionId": "s1", "entries": [], "truncated": False})
        payload = sm.build_payload(0)

        # Failed POST: staged result must survive.
        with mock.patch.object(ha.urllib.request, "urlopen",
                                side_effect=OSError("network down")):
            reply = sm.post(payload)
        self.assertIsNone(reply)
        self.assertEqual(len(sm.history_results), 1)
        payload2 = sm.build_payload(1)
        self.assertEqual(payload2["historyResults"], payload["historyResults"])

        # Successful POST: staged result is cleared.
        class FakeResp:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self):
                return b"{}"

        with mock.patch.object(ha.urllib.request, "urlopen",
                                return_value=FakeResp()):
            reply = sm.post(payload2)
        self.assertEqual(reply, {})
        self.assertEqual(sm.history_results, [])
        self.assertNotIn("historyResults", sm.build_payload(2))

    def test_multiple_pending_requests_batch(self):
        sm = self.make_manager()
        sm.registry = []
        sm._stage_history("s1")
        sm._stage_history("s2")
        payload = sm.build_payload(0)
        self.assertEqual(
            [r["sessionId"] for r in payload["historyResults"]], ["s1", "s2"],
        )


class TestNormalizeGithubRepo(unittest.TestCase):
    def test_plain_owner_repo(self):
        self.assertEqual(ha.normalize_github_repo("xerktech/Turma"), "xerktech/Turma")
        self.assertEqual(ha.normalize_github_repo("  xerktech/Turma  "), "xerktech/Turma")

    def test_urls_and_git_suffix(self):
        self.assertEqual(
            ha.normalize_github_repo("https://github.com/xerktech/Turma.git"),
            "xerktech/Turma")
        self.assertEqual(
            ha.normalize_github_repo("https://github.com/xerktech/Turma/"),
            "xerktech/Turma")
        self.assertEqual(
            ha.normalize_github_repo("git@github.com:xerktech/Turma.git"),
            "xerktech/Turma")

    def test_keeps_dots_and_dashes_in_names(self):
        self.assertEqual(ha.normalize_github_repo("my-org/re.po_name-1"), "my-org/re.po_name-1")

    def test_rejects_bad(self):
        for bad in ("", "   ", None, "noslash", "a/b/c", "../evil/x", "owner/..",
                    "-lead/repo", "owner/re po", "owner/re;po", "owner/re`po",
                    "owner/$x", "https://github.com/only-owner", "owner/"):
            with self.assertRaises(ValueError, msg=repr(bad)):
                ha.normalize_github_repo(bad)


class TestListGithubRepos(unittest.TestCase):
    """The clone dropdown's repo discovery. `gh repo list` with no owner returns
    only the user's OWN repos, so org repos must come from an explicit org sweep
    — otherwise an org member sees an empty dropdown (the reported bug)."""

    def _fake_run(self, *, orgs, by_owner):
        def fake_run(cmd, cwd=None):
            joined = " ".join(cmd)
            if "user/orgs" in joined:
                return "\n".join(orgs)
            if cmd[:3] == ["gh", "repo", "list"]:
                owner = cmd[3] if len(cmd) > 3 and not cmd[3].startswith("-") else None
                return json.dumps(by_owner.get(owner, []))
            return ""
        return fake_run

    def test_sweeps_user_orgs_so_org_repos_appear(self):
        fake = self._fake_run(
            orgs=["xerktech"],
            by_owner={
                None: [],  # the login owns no personal repos (the org case)
                "xerktech": [
                    {"nameWithOwner": "xerktech/Turma", "updatedAt": "2026-07-02", "isPrivate": True},
                    {"nameWithOwner": "xerktech/DockerOps", "updatedAt": "2026-07-01"},
                ],
            },
        )
        with mock.patch.object(ha, "run", fake), \
                mock.patch.dict(os.environ, {}, clear=True):
            repos = ha.list_github_repos()
        names = [r["nameWithOwner"] for r in repos]
        self.assertEqual(names, ["xerktech/Turma", "xerktech/DockerOps"])  # newest first
        self.assertTrue(repos[0]["isPrivate"])
        self.assertEqual(repos[0]["name"], "Turma")

    def test_own_orgs_and_env_owners_merged_and_deduped(self):
        fake = self._fake_run(
            orgs=["orgA"],
            by_owner={
                None: [{"nameWithOwner": "me/dotfiles", "updatedAt": "2026-05-01"}],
                "orgA": [{"nameWithOwner": "orgA/app", "updatedAt": "2026-06-01"}],
                "orgB": [
                    {"nameWithOwner": "orgB/lib", "updatedAt": "2026-06-15"},
                    {"nameWithOwner": "orgA/app", "updatedAt": "2026-06-01"},  # dup across owners
                ],
            },
        )
        with mock.patch.object(ha, "run", fake), \
                mock.patch.dict(os.environ, {"GH_CLONE_OWNERS": "orgB"}, clear=True):
            repos = ha.list_github_repos()
        names = [r["nameWithOwner"] for r in repos]
        self.assertEqual(names, ["orgB/lib", "orgA/app", "me/dotfiles"])  # deduped, newest-first

    def test_no_creds_paths_return_empty(self):
        # run() returns "" for everything (no orgs, no repos) -> empty list, no raise.
        with mock.patch.object(ha, "run", lambda *a, **k: ""), \
                mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(ha.list_github_repos(), [])


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
        os.makedirs(os.path.join(self.repos_root, "Turma"))
        with mock.patch.object(ha.subprocess, "Popen") as popen:
            sm.clone("xerktech/Turma")
            popen.assert_not_called()
        job = sm.clones["Turma"]
        self.assertEqual(job["status"], "error")
        self.assertIn("already exists", job["error"])

    def test_clone_launches_git_and_finishes_on_poll(self):
        sm = self.make_manager()
        dest = os.path.join(self.repos_root, "Turma")

        class FakeProc:
            def poll(self_inner):
                # Simulate git materializing the checkout, then exiting 0.
                os.makedirs(os.path.join(dest, ".git"), exist_ok=True)
                return 0

            def kill(self_inner):
                pass

        with mock.patch.object(ha.subprocess, "Popen", return_value=FakeProc()) as popen:
            sm.clone("xerktech/Turma")
            # git clone <url> <dest> was launched (not a session run_ok call).
            args = popen.call_args[0][0]
            self.assertEqual(args[:2], ["git", "clone"])
            self.assertIn("https://github.com/xerktech/Turma.git", args)
            self.assertIn(dest, args)
        self.assertEqual(sm.clones["Turma"]["status"], "cloning")
        sm._poll_clones()
        self.assertEqual(sm.clones["Turma"]["status"], "done")
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
            sm.clone("xerktech/Turma")
        sm._poll_clones()
        self.assertEqual(sm.clones["Turma"]["status"], "error")


class TestCleanSummary(unittest.TestCase):
    def test_strips_quotes_and_trailing_punctuation(self):
        self.assertEqual(ha.clean_summary('"Adding Compose Flag."'), "Adding Compose Flag")
        self.assertEqual(ha.clean_summary("`Fix Login`"), "Fix Login")

    def test_takes_first_non_empty_line(self):
        self.assertEqual(ha.clean_summary("\n  Title Here \n more text"), "Title Here")

    def test_caps_words(self):
        self.assertEqual(
            ha.clean_summary("one two three four five six seven eight"),
            "one two three four five six")

    def test_empty_none_and_blank_return_none(self):
        self.assertIsNone(ha.clean_summary(""))
        self.assertIsNone(ha.clean_summary("   \n  "))
        self.assertIsNone(ha.clean_summary(None))


class TestSessionSummaries(ManagerMixin, unittest.TestCase):
    def _enable(self):
        p = mock.patch.object(ha, "SESSION_SUMMARY_ENABLED", True)
        p.start()
        self.addCleanup(p.stop)

    def test_disabled_never_launches(self):
        sm = self.make_manager()  # feature off by default (env unset)
        with mock.patch.object(ha.subprocess, "Popen") as popen:
            sm._start_summary({"id": "s1"}, "do a thing")
            popen.assert_not_called()
        self.assertEqual(sm.summaries, {})

    def test_missing_prompt_skipped(self):
        self._enable()
        sm = self.make_manager()
        with mock.patch.object(ha.subprocess, "Popen") as popen:
            sm._start_summary({"id": "s1"}, "   ")
            sm._start_summary({"id": "s1"}, None)
            popen.assert_not_called()
        self.assertEqual(sm.summaries, {})

    def test_launch_uses_claude_p_headless_off_the_worktree(self):
        self._enable()
        sm = self.make_manager()

        class FakeProc:
            def poll(self_i):
                return 0

            def kill(self_i):
                pass

        with mock.patch.object(ha.subprocess, "Popen", return_value=FakeProc()) as popen:
            sm._start_summary({"id": "s1"}, "Add a docker compose flag")
            args = popen.call_args[0][0]
            self.assertEqual(args[:4], ["claude", "-p", "--model", ha.SESSION_SUMMARY_MODEL])
            self.assertIn("Add a docker compose flag", args[-1])  # task in the prompt
            # Runs in the registry dir (not a worktree) and passes no --settings,
            # so it never loads the session safety guard.
            self.assertEqual(popen.call_args[1]["cwd"], ha.REGISTRY_DIR)
            self.assertNotIn("--settings", args)
        self.assertIn("s1", sm.summaries)

    def test_finish_sets_name_and_reaps_job(self):
        self._enable()
        sm = self.make_manager()
        sm.registry = [{"id": "s1", "status": "running", "summary": None}]
        sm.save = mock.Mock()

        class FakeProc:
            def poll(self_i):
                return 0

            def kill(self_i):
                pass

        with mock.patch.object(ha.subprocess, "Popen", return_value=FakeProc()):
            sm._start_summary(sm.registry[0], "Add a docker compose flag")
        out_path = sm.summaries["s1"]["outPath"]
        # The model's answer lands on the job's stdout file.
        with open(out_path, "w") as f:
            f.write("Adding Compose Flag\n")
        sm._poll_summaries()
        self.assertEqual(sm.registry[0]["summary"], "Adding Compose Flag")
        self.assertEqual(sm.summaries, {})            # reaped
        self.assertFalse(os.path.exists(out_path))    # temp output cleaned up
        sm.save.assert_called_once()

    def test_timeout_kills_and_leaves_unnamed(self):
        self._enable()
        sm = self.make_manager()
        sm.registry = [{"id": "s1", "status": "running", "summary": None}]
        killed = {"v": False}

        class HangProc:
            def poll(self_i):
                return None  # never exits

            def kill(self_i):
                killed["v"] = True

        with mock.patch.object(ha.subprocess, "Popen", return_value=HangProc()):
            sm._start_summary(sm.registry[0], "do a thing")
        sm.summaries["s1"]["startedMono"] -= ha.SUMMARY_TIMEOUT_SEC + 1  # force overrun
        sm._poll_summaries()
        self.assertTrue(killed["v"])
        self.assertEqual(sm.summaries, {})
        self.assertIsNone(sm.registry[0]["summary"])

    def test_session_deleted_mid_summary_is_safe(self):
        self._enable()
        sm = self.make_manager()
        sm.registry = []  # session killed/deleted while the summary ran

        class FakeProc:
            def poll(self_i):
                return 0

            def kill(self_i):
                pass

        with mock.patch.object(ha.subprocess, "Popen", return_value=FakeProc()):
            sm._start_summary({"id": "s1"}, "do a thing")
        with open(sm.summaries["s1"]["outPath"], "w") as f:
            f.write("Some Name")
        sm._poll_summaries()  # must not raise even with no matching session
        self.assertEqual(sm.summaries, {})


class TestProjectSlug(unittest.TestCase):
    def test_every_non_alphanumeric_becomes_dash(self):
        # Claude Code slugs dots too: /repos/.turma/... -> -repos--turma-...
        # (observed on disk; the old '/'-only mapping missed every worktree
        # transcript because of the '.turma' path segment).
        self.assertEqual(
            ha._project_slug("/repos/.turma/worktrees/CoinBox-46578"),
            "-repos--turma-worktrees-CoinBox-46578",
        )

    def test_plain_path_matches_old_rule(self):
        self.assertEqual(ha._project_slug("/w/repo"), "-w-repo")

    def test_windows_style_path(self):
        self.assertEqual(
            ha._project_slug(r"C:\Users\me/.switchboard"),
            "C--Users-me--switchboard",
        )


class TestScanRepos(unittest.TestCase):
    def test_scan_filters_dotdirs_and_non_git(self):
        tmp = tempfile.mkdtemp(prefix="hub-agent-scan-")
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        os.makedirs(os.path.join(tmp, "RepoA", ".git"))
        os.makedirs(os.path.join(tmp, "plainDir"))
        os.makedirs(os.path.join(tmp, ".turma", "worktrees"))
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


@unittest.skipUnless(
    hasattr(signal, "SIGUSR1"), "SIGUSR1 is POSIX-only; the agent runs on Linux"
)
class TestPokeHeartbeat(unittest.TestCase):
    """SIGUSR1 (sent by tunnel-agent.js on a control-channel poke) must cut the
    heartbeat loop's interval wait short so a just-queued command is picked up
    right away instead of up to a whole INTERVAL later."""

    def test_sigusr1_sets_the_poke_event_and_cuts_the_wait_short(self):
        prev = signal.getsignal(signal.SIGUSR1)
        signal.signal(signal.SIGUSR1, lambda *_: ha._poke.set())
        self.addCleanup(signal.signal, signal.SIGUSR1, prev)

        ha._poke.clear()
        # Without a poke, wait() blocks up to the timeout and returns False.
        self.assertFalse(ha._poke.wait(0.05))

        # A poke makes the same wait return True effectively immediately — the
        # heartbeat loop would beat now rather than after INTERVAL.
        os.kill(os.getpid(), signal.SIGUSR1)
        start = time.monotonic()
        self.assertTrue(ha._poke.wait(5))
        self.assertLess(time.monotonic() - start, 1.0)


class TestPruneRepo(unittest.TestCase):
    """prune_repo() over a REAL git repo + worktrees (the logic is git-heavy, so
    faking run() would prove little). Verifies only merged/clean worktrees and
    branches are swept and in-progress work is preserved."""

    def _git(self, *args, cwd=None):
        import subprocess
        return subprocess.run(["git", *args], cwd=cwd or self.repo,
                              capture_output=True, text=True, check=True)

    def setUp(self):
        import subprocess
        if not shutil.which("git"):
            self.skipTest("git not available")
        self.tmp = tempfile.mkdtemp(prefix="hub-agent-prune-")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.repo = os.path.join(self.tmp, "demo")
        os.makedirs(self.repo)
        env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
               "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"}
        run = lambda *a, cwd=None: subprocess.run(
            ["git", *a], cwd=cwd or self.repo, env=env, capture_output=True,
            text=True, check=True)
        self._run = run
        run("init", "-q", "-b", "main")
        run("commit", "-q", "--allow-empty", "-m", "c1")

        self.wt_root = os.path.join(self.tmp, "worktrees")
        patches = [
            ("REGISTRY_DIR", self.tmp),
            ("REGISTRY_PATH", os.path.join(self.tmp, "sessions.json")),
            ("CLOSED_PATH", os.path.join(self.tmp, "closed.json")),
            ("PROJECTS_ROOT", os.path.join(self.tmp, "projects")),
            ("WORKTREES_ROOT", self.wt_root),
            ("REPOS_ROOT", self.tmp),
            ("device_name", lambda: "test-host"),
            ("scan_repos", lambda: [{"name": "demo", "path": self.repo}]),
        ]
        for name, value in patches:
            p = mock.patch.object(ha, name, value)
            p.start()
            self.addCleanup(p.stop)

    def _add_worktree(self, sid, base="main"):
        path = os.path.join(self.wt_root, "demo", sid)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self._run("worktree", "add", "--detach", path, base)
        return path

    def test_prune_sweeps_merged_keeps_in_progress(self):
        sm = ha.SessionManager()

        merged_wt = self._add_worktree("merged")          # detached at main -> merged
        unmerged_wt = self._add_worktree("unmerged")
        self._run("commit", "-q", "--allow-empty", "-m", "wip", cwd=unmerged_wt)
        dirty_wt = self._add_worktree("dirty")
        with open(os.path.join(dirty_wt, "scratch.txt"), "w") as f:
            f.write("uncommitted")

        # feature-merged points at main's tip (merged -> deleted); feature-wip at
        # the unmerged worktree's commit, so it's ahead of main (kept).
        self._run("branch", "feature-merged", "main")
        wip_sha = self._run("rev-parse", "HEAD", cwd=unmerged_wt).stdout.strip()
        self._run("branch", "feature-wip", wip_sha)

        sm.prune_repo("demo")

        # Merged/clean worktree gone; unmerged + dirty kept.
        self.assertFalse(os.path.isdir(merged_wt))
        self.assertTrue(os.path.isdir(unmerged_wt))
        self.assertTrue(os.path.isdir(dirty_wt))

        branches = self._run("branch", "--format", "%(refname:short)").stdout.split()
        self.assertNotIn("feature-merged", branches)   # merged -> deleted
        self.assertIn("feature-wip", branches)         # unmerged -> kept
        self.assertIn("main", branches)                # default -> kept

        res = sm.prunes["demo"]
        self.assertEqual(res["status"], "done")
        self.assertEqual(res["removedWorktrees"], 1)
        self.assertEqual(res["deletedBranches"], 1)
        self.assertGreaterEqual(res["skippedWorktrees"], 2)

    def test_prune_unknown_repo_reports_error(self):
        sm = ha.SessionManager()
        sm.prune_repo("nope")
        self.assertEqual(sm.prunes["nope"]["status"], "error")


if __name__ == "__main__":
    unittest.main()
